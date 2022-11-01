// Copyright Metatype under the Elastic License 2.0.

import type * as ast from "graphql/ast";
import { Kind } from "graphql";
import { ComputeStage } from "./engine.ts";
import * as graphql from "./graphql.ts";
import { FragmentDefs } from "./graphql.ts";
import { DenoRuntime } from "./runtimes/deno.ts";
import { GoogleapisRuntime } from "./runtimes/googleapis.ts";
import { GraphQLRuntime } from "./runtimes/graphql.ts";
import { HTTPRuntime } from "./runtimes/http.ts";
import { PrismaRuntime } from "./runtimes/prisma.ts";
import { RandomRuntime } from "./runtimes/random.ts";
import { Runtime } from "./runtimes/Runtime.ts";
import { Code } from "./runtimes/utils/codes.ts";
import { ensure, envOrFail, mapo } from "./utils.ts";
import { compileCodes } from "./utils/swc.ts";
// import { v4 as uuid } from "std/uuid/mod.ts";

import { Auth, AuthDS, nextAuthorizationHeader } from "./auth.ts";
import * as semver from "std/semver/mod.ts";

import { ArrayNode, ObjectNode, TypeNode } from "./type_node.ts";
import config from "./config.ts";
import {
  Batcher,
  ComputeArg,
  PolicyStages,
  PolicyStagesFactory,
  Resolver,
  RuntimeInit,
  RuntimesConfig,
} from "./types.ts";

interface TypePolicy {
  name: string;
  materializer: number;
}

export interface TypeMaterializer {
  name: string;
  runtime: number;
  data: Record<string, unknown>;
}

export interface TypeRuntime {
  name: string;
  data: Record<string, unknown>;
}

export interface Rate {
  window_limit: number;
  window_sec: number;
  query_limit: number;
  local_excess: number;
  context_identifier: string;
}

export interface TypeMeta {
  secrets: Array<string>;
  cors: {
    allow_origin: Array<string>;
    allow_methods: Array<string>;
    allow_headers: Array<string>;
    expose_headers: Array<string>;
    allow_credentials: boolean;
    max_age: number | null;
  };
  auths: Array<AuthDS>;
  rate: Rate | null;
  version: string;
}

export interface TypeGraphDS {
  types: Array<TypeNode>;
  materializers: Array<TypeMaterializer>;
  runtimes: Array<TypeRuntime>;
  policies: Array<TypePolicy>;
  codes: Array<Code>;
  meta: TypeMeta;
}

export type RuntimeResolver = Record<string, Runtime>;

const dummyStringTypeNode: TypeNode = {
  // FIXME: remove dummy
  title: "string",
  type: "string",
  policies: [],
  runtime: -1,
};

const runtimeInit: RuntimeInit = {
  graphql: GraphQLRuntime.init,
  prisma: PrismaRuntime.init,
  http: HTTPRuntime.init,
  deno: DenoRuntime.init,
  googleapis: GoogleapisRuntime.init,
  random: RandomRuntime.init,
  //typegraph: TypeGraphRuntime.init,
};

const typegraphVersion = "0.0.1";
const typegraphChangelog: Record<
  string,
  { next: string; transform: (x: TypeGraphDS) => TypeGraphDS }
> = {
  "0.0.0": {
    "next": "0.0.1",
    "transform": (x) => x,
  },
};

export class TypeGraph {
  static readonly emptyArgs: ast.ArgumentNode[] = [];
  static emptyFields: ast.SelectionSetNode = {
    kind: Kind.SELECTION_SET,
    selections: [],
  };

  tg: TypeGraphDS;
  runtimeReferences: Runtime[];
  root: TypeNode;
  introspection: TypeGraph | null;
  typeByName: Record<string, TypeNode>;
  secrets: Record<string, string>;
  auths: Map<string, Auth>;
  cors: Record<string, string>;

  private constructor(
    typegraph: TypeGraphDS,
    runtimeReferences: Runtime[],
    secrets: Record<string, string>,
    cors: Record<string, string>,
    auths: Map<string, Auth>,
    introspection: TypeGraph | null,
  ) {
    this.tg = typegraph;
    this.runtimeReferences = runtimeReferences;
    this.root = this.type(0);
    this.secrets = secrets;
    this.cors = cors;
    this.auths = auths;
    this.introspection = introspection;
    // this.typeByName = this.tg.types.reduce((agg, tpe) => ({ ...agg, [tpe.name]: tpe }), {});
    const typeByName: Record<string, TypeNode> = {};
    typegraph.types.forEach((tpe) => {
      typeByName[tpe.title] = tpe;
    });
    this.typeByName = typeByName;
  }

  static async init(
    typegraph: TypeGraphDS,
    staticReference: RuntimeResolver,
    introspection: TypeGraph | null,
    runtimeConfig: RuntimesConfig,
  ): Promise<TypeGraph> {
    const typegraphName = typegraph.types[0].title;
    const { meta, runtimes } = typegraph;

    let currentVersion = meta.version;
    while (semver.neq(typegraphVersion, currentVersion)) {
      const migration = typegraphChangelog[currentVersion];
      if (!migration) {
        throw Error(
          `typegate ${config.version} supports typegraph ${typegraphVersion} which is incompatible with ${typegraphName} ${meta.version} (max auto upgrade was ${currentVersion})`,
        );
      }
      typegraph = migration.transform(typegraph);
      currentVersion = migration.next;
    }

    const secrets = meta.secrets.sort().reduce(
      (agg, secretName) => {
        return { ...agg, [secretName]: envOrFail(typegraphName, secretName) };
      },
      {},
    );

    const cors = (() => {
      if (meta.cors.allow_origin.length === 0) {
        return {};
      }
      const ret: Record<string, string> = {
        "Access-Control-Allow-Origin": meta.cors.allow_origin.join(","),
        "Access-Control-Allow-Methods": "POST,OPTIONS",
        "Access-Control-Allow-Headers": [nextAuthorizationHeader].concat(
          meta.cors.allow_headers,
        ).join(","),
        "Access-Control-Expose-Headers": meta.cors.expose_headers.join(","),
        "Access-Control-Allow-Credentials": meta.cors.allow_credentials
          .toString(),
      };
      if (meta.cors.max_age) {
        ret["Access-Control-Max-Age"] = meta.cors.max_age.toString();
      }
      return ret;
    })();

    const auths = new Map<string, Auth>();
    for (const auth of meta.auths) {
      auths.set(
        auth.name,
        await Auth.init(typegraphName, auth),
      );
    }

    const runtimeReferences = await Promise.all(
      runtimes.map((runtime, idx) => {
        if (runtime.name in staticReference) {
          return staticReference[runtime.name];
        }

        ensure(
          runtime.name in runtimeInit,
          `cannot find runtime "${runtime.name}" in ${
            Object.keys(
              runtimeInit,
            ).join(", ")
          }`,
        );

        console.log(`init ${runtime.name} (${idx})`);
        return runtimeInit[runtime.name]({
          typegraph,
          materializers: typegraph.materializers.filter(
            (mat) => mat.runtime === idx,
          ),
          args: runtime.data,
          config: runtimeConfig[runtime.name] ?? {},
        });
      }),
    );

    compileCodes(typegraph);

    return new TypeGraph(
      typegraph,
      runtimeReferences,
      secrets,
      cors,
      auths,
      introspection,
    );
  }

  async deinit(): Promise<void> {
    for await (
      const [idx, runtime] of this.runtimeReferences.map(
        (rt, i) => [i, rt] as const,
      )
    ) {
      console.log(`deinit runtime ${idx}`);
      await runtime.deinit();
    }
    if (this.introspection) {
      await this.introspection.deinit();
    }
  }

  type(idx: number): TypeNode {
    ensure(
      typeof idx === "number" && idx < this.tg.types.length,
      `cannot find type with "${idx}" index`,
    );
    return this.tg.types[idx];
  }

  materializer(idx: number): TypeMaterializer {
    return this.tg.materializers[idx];
  }

  runtime(idx: number): TypeRuntime {
    return this.tg.runtimes[idx];
  }

  policy(idx: number): TypePolicy {
    return this.tg.policies[idx];
  }

  // value, policies, dependencies
  collectArg(
    fieldArg: ast.ArgumentNode | ast.ObjectFieldNode | undefined,
    argIdx: number,
    parentContext: Record<string, number>,
    noDefault = false,
  ): [
    ComputeArg,
    Record<string, string[]>,
    string[],
  ] | null {
    const arg = this.tg.types[argIdx];

    if (!arg) {
      throw Error(`${argIdx} not found in type`);
    }

    let policies = arg.policies.length > 0
      ? {
        [arg.title]: arg.policies.map((p) => this.policy(p).name),
      }
      : {};

    if ("injection" in arg) {
      const { injection, inject } = arg;
      ensure(!fieldArg, "cannot set injected arg");

      switch (injection) {
        case "raw": {
          const value = JSON.parse(inject as string);
          // typecheck
          return [() => value, policies, []];
        }
        case "secret": {
          const name = inject as string;
          const value = this.secrets[name];
          if (
            value === undefined &&
            (value === null && arg.type !== "optional")
          ) {
            // manage default?
            throw new Error(`injection ${name} was not found in secrets`);
          }
          return [
            () => {
              return value;
            },
            policies,
            [],
          ];
        }
        case "context": {
          const name = inject as string;
          return [
            (_parent, _variables, { [name]: value }) => {
              if (
                value === undefined &&
                (value === null && arg.type !== "optional")
              ) {
                // manage default?
                throw new Error(`injection ${name} was not found in context`);
              }
              return value;
            },
            policies,
            [],
          ];
        }
        case "parent": {
          const ref = inject as number;
          const name = Object.keys(parentContext).find(
            (name) => parentContext[name] === ref,
          );
          if (!name) {
            throw Error(
              `cannot find injection ${
                JSON.stringify(
                  arg,
                )
              } in parent ${JSON.stringify(parentContext)}`,
            );
          }
          return [
            ({ [name]: value }) => {
              if (
                value === undefined &&
                (value === null && arg.type !== "optional")
              ) {
                // manage default?
                throw new Error(`injection ${name} was not found in parent`);
              }
              return value;
            },
            policies,
            [name],
          ];
        }
        default:
          ensure(false, "cannot happen");
      }
    }

    if (!fieldArg) {
      if (arg.type === "optional") {
        const { default_value: defaultValue } = arg;
        return !noDefault && defaultValue
          ? [() => defaultValue, policies, []]
          : null;
      }

      if (arg.type === "object") {
        const argSchema = arg.properties;
        const values: Record<string, any> = {};
        const deps = [];

        for (const [fieldName, fieldIdx] of Object.entries(argSchema)) {
          const nested = this.collectArg(
            undefined,
            fieldIdx,
            parentContext,
            true,
          );
          if (!nested) {
            continue;
          }
          const [value, nestedPolicies, nestedDeps] = nested;
          deps.push(...nestedDeps);
          values[fieldName] = value;
          policies = { ...policies, ...nestedPolicies };
        }

        if (Object.values(values).length < 1) {
          throw Error(`mandatory arg ${JSON.stringify(arg)} not found`);
        }

        return [
          (ctx, vars) => mapo(values, (e) => e(ctx, vars)),
          policies,
          deps,
        ];
      }

      throw Error(`mandatory arg ${JSON.stringify(arg)} not found`);
    }

    if (arg.type === "optional") {
      return this.collectArg(fieldArg, arg.item, parentContext);
    }

    const { value: argValue } = fieldArg;
    const { kind } = argValue;

    if (kind === Kind.VARIABLE) {
      const { kind: _, value: varName } = (argValue as ast.VariableNode).name;
      return [
        (_ctx, vars) =>
          vars == null
            ? (vars: Record<string, unknown> | null) =>
              vars == null ? varName : vars[varName]
            : vars[varName],
        policies,
        [],
      ];
    }

    if (arg.type === "object") {
      ensure(
        kind === Kind.OBJECT,
        `type mismatch, got ${kind} but expected OBJECT for ${arg.title}`,
      );
      const { fields } = argValue as ast.ObjectValueNode;
      const argSchema = arg.properties as Record<string, number>;

      const fieldArgsIdx: Record<string, ast.ObjectFieldNode> = fields.reduce(
        (agg, fieldArg) => ({ ...agg, [fieldArg.name.value]: fieldArg }),
        {},
      );

      const values: Record<string, any> = {};
      const deps = [];

      for (const [fieldName, fieldIdx] of Object.entries(argSchema)) {
        const nested = this.collectArg(
          fieldArgsIdx[fieldName],
          fieldIdx,
          parentContext,
        );
        if (!nested) {
          continue;
        }
        const [value, nestedPolicies, nestedDeps] = nested;
        deps.push(...nestedDeps);
        // FIXME
        // const renames = arg.renames ?? {}
        const renames = {} as Record<string, string>;
        values[renames[fieldName] ?? fieldName] = value;
        delete fieldArgsIdx[fieldName];
        policies = { ...policies, ...nestedPolicies };
      }

      for (const name of Object.keys(fieldArgsIdx)) {
        throw Error(`${name} input as field but unknown`);
      }

      return [(ctx, vars) => mapo(values, (e) => e(ctx, vars)), policies, deps];
    }

    if (arg.type === "array") {
      ensure(
        kind === Kind.LIST,
        `type mismatch, got ${kind} but expected LIST for ${arg.title}`,
      );
      const { values: valueOfs } = argValue as ast.ListValueNode;
      const valueIdx = arg.items as number;

      const values: any[] = [];
      const deps = [];

      // likely optimizable as type should be shared
      for (const valueOf of valueOfs) {
        const nested = this.collectArg(
          { value: valueOf } as unknown as ast.ArgumentNode,
          valueIdx,
          parentContext,
        );
        if (!nested) {
          throw Error("unknown subtype");
        }
        const [value, nestedPolicies, nestedDeps] = nested;
        deps.push(...nestedDeps);
        values.push(value);
        policies = { ...policies, ...nestedPolicies };
      }

      return [(ctx, vars) => values.map((e) => e(ctx, vars)), policies, deps];
    }

    if (arg.type === "integer") {
      ensure(
        kind === Kind.INT,
        `type mismatch, got ${kind} but expected INT for ${arg.title}`,
      );
      const { value } = argValue as ast.IntValueNode;
      const parsed = Number(value);
      return [() => parsed, policies, []];
    }

    if (arg.type === "number") {
      ensure(
        kind === Kind.FLOAT || kind === Kind.INT,
        `type mismatch, got ${kind} but expected FLOAT for ${arg.title}`,
      );
      const { value } = argValue as ast.FloatValueNode;
      const parsed = Number(value);
      return [() => parsed, policies, []];
    }

    if (arg.type === "boolean") {
      ensure(
        kind === Kind.BOOLEAN,
        `type mismatch, got ${kind} but expected BOOLEAN for ${arg.title}`,
      );
      const { value } = argValue as ast.BooleanValueNode;
      const parsed = Boolean(value);
      return [() => parsed, policies, []];
    }

    // TODO arg.type === "json"
    if (arg.type === "string") {
      ensure(
        kind === Kind.STRING,
        `type mismatch, got ${kind} but expected STRING for ${arg.title}`,
      );
      const { value } = argValue as ast.StringValueNode;
      const parsed = String(value);
      return [() => parsed, policies, []];
    }

    throw Error(
      `unknown variable value ${JSON.stringify(arg)} ${JSON.stringify(fieldArg)}
      (${kind}) for ${arg.title}`,
    );
  }

  traverse(
    fragments: FragmentDefs,
    parentName: string,
    parentArgs: readonly ast.ArgumentNode[],
    parentSelectionSet: ast.SelectionSetNode,
    verbose: boolean,
    queryPath: string[] = [],
    parentIdx = 0,
    parentStage: ComputeStage | undefined = undefined,
    serial = false,
  ): ComputeStage[] {
    const parentType = this.type(parentIdx) as ObjectNode;
    const stages: ComputeStage[] = [];

    const parentSelection = graphql.resolveSelection(
      parentSelectionSet,
      fragments,
    );
    const fieldSchema = (parentType.properties ?? {}) as Record<string, number>;
    verbose &&
      console.log(
        this.root.title,
        parentName,
        parentArgs.map((n) => n.name?.value),
        parentSelection.map((n) => n.name?.value),
        parentType.type,
        Object.entries(fieldSchema).reduce(
          (agg, [k, v]) => ({ ...agg, [k]: this.type(v).type }),
          {},
        ),
      );

    if (parentType.type === "object" && parentSelection.length < 1) {
      throw Error(`struct "${parentName}" must a field selection`);
    }

    for (const field of parentSelection) {
      const {
        name: { value: fieldName },
        alias,
        arguments: fieldArgs,
        selectionSet: fieldFields,
      } = field;
      const { value: aliasName } = alias ?? {};
      let policies: Record<string, string[]> = {};

      // introspection cases
      if (
        queryPath.length < 1 &&
        this.introspection &&
        (fieldName === "__schema" || fieldName === "__type")
      ) {
        stages.push(
          ...this.introspection.traverse(
            fragments,
            parentName,
            parentArgs,
            {
              kind: Kind.SELECTION_SET,
              selections: [field],
            },
            verbose,
          ).map((stage) => {
            // disable rate limiting for introspection
            stage.props.rateWeight = 0;
            return stage;
          }),
        );
        continue;
      }

      // typename case
      if (fieldName == "__typename") {
        if (fieldArgs && fieldArgs.length > 0) {
          throw Error(
            `__typename cannot have args ${JSON.stringify(fieldArgs)}`,
          );
        }

        stages.push(
          new ComputeStage({
            dependencies: [],
            parent: parentStage,
            args: {},
            policies,
            outType: dummyStringTypeNode,
            // singleton
            runtime: DenoRuntime.init({
              typegraph: this.tg,
              materializers: [],
              args: {},
              config: {},
            }),
            batcher: this.nextBatcher(dummyStringTypeNode),
            node: fieldName,
            path: [...queryPath, aliasName ?? fieldName],
            rateCalls: true,
            rateWeight: 0,
          }),
        );

        continue;
      }

      const fieldIdx = fieldSchema[fieldName];
      if (!fieldIdx) {
        throw Error(
          `${fieldName} not found in ${JSON.stringify(this.type(parentIdx))}`,
        );
      }
      const fieldType = this.type(fieldIdx);
      const checksField = fieldType.policies.map((p) => this.policy(p).name);
      if (checksField.length > 0) {
        policies[fieldType.title] = checksField;
      }

      // value case
      if (fieldType.type !== "function") {
        if (fieldArgs && fieldArgs.length > 0) {
          throw Error(
            `unexpected args=${JSON.stringify(fieldArgs)} for ${fieldType}`,
          );
        }

        const runtime = this.runtimeReferences[fieldType.runtime];

        const stage = new ComputeStage({
          dependencies: parentStage ? [parentStage.id()] : [],
          parent: parentStage,
          args: {},
          policies,
          outType: fieldType,
          runtime,
          batcher: this.nextBatcher(fieldType),
          node: fieldName,
          path: [...queryPath, aliasName ?? fieldName],
          rateCalls: true,
          rateWeight: 0,
        });
        stages.push(stage);

        if (fieldType.type === "object") {
          stages.push(
            ...this.traverse(
              fragments,
              fieldName,
              fieldArgs ?? TypeGraph.emptyArgs,
              fieldFields ?? TypeGraph.emptyFields,
              verbose,
              [...queryPath, aliasName ?? fieldName],
              fieldIdx,
              stage,
            ),
          );
        } else if (
          fieldType.type === "optional" &&
          this.type(fieldType.item).type === "array"
        ) {
          const subTypeIdx = fieldType.item;
          const subType = this.type(subTypeIdx) as ArrayNode;
          const subSubTypeIdx = subType.items;
          const subSubType = this.type(subSubTypeIdx);

          if (subSubType.type === "string") {
            stages.push(
              ...this.traverse(
                fragments,
                fieldName,
                fieldArgs ?? TypeGraph.emptyArgs,
                fieldFields ?? TypeGraph.emptyFields,
                verbose,
                [...queryPath, aliasName ?? fieldName],
                subSubTypeIdx,
                stage,
              ),
            );
          }
        } else if (
          fieldType.type === "array" ||
          fieldType.type === "optional"
        ) {
          const subTypeIdx = fieldType.type === "array"
            ? fieldType.items
            : fieldType.item;
          const subType = this.type(subTypeIdx);

          if (subType.type === "object") {
            stages.push(
              ...this.traverse(
                fragments,
                fieldName,
                fieldArgs ?? TypeGraph.emptyArgs,
                fieldFields ?? TypeGraph.emptyFields,
                verbose,
                [...queryPath, aliasName ?? fieldName],
                subTypeIdx,
                stage,
              ),
            );
          }
        } else {
          //verbose && console.log("no stage for", fieldType.typedef);
        }
        continue;
      }

      // func case

      const dependencies = [];
      if (parentStage) {
        dependencies.push(parentStage.id());
      }

      const { input: inputIdx, output: outputIdx, rate_calls, rate_weight } =
        fieldType;
      const outputType = this.type(outputIdx);
      const checks = outputType.policies.map((p) => this.policy(p).name);
      if (checks.length > 0) {
        policies[outputType.title] = checks;
      }
      const args: Record<string, ComputeArg> = {};

      const argSchema = (this.tg.types[inputIdx] as ObjectNode).properties;
      const fieldArgsIdx: Record<string, ast.ArgumentNode> = (
        fieldArgs ?? []
      ).reduce(
        (agg, fieldArg) => ({ ...agg, [fieldArg.name.value]: fieldArg }),
        {},
      );

      const nestedDepsUnion = [];
      for (const [argName, argIdx] of Object.entries(argSchema ?? {})) {
        const nested = this.collectArg(
          fieldArgsIdx[argName],
          argIdx,
          fieldSchema,
        );
        if (!nested) {
          continue;
        }
        const [value, inputPolicies, nestedDeps] = nested;
        nestedDepsUnion.push(...nestedDeps);
        args[argName] = value;
        policies = { ...policies, ...inputPolicies };
        // else variable
      }

      // check that no unnecessary arg is given
      for (const fieldArg of fieldArgs ?? []) {
        const name = fieldArg.name.value;
        if (!(name in args)) {
          throw Error(`${name} input as field but unknown`);
        }
      }

      dependencies.push(
        ...Array.from(new Set(nestedDepsUnion)).map((dep) =>
          [...queryPath, dep].join(".")
        ),
      );

      const mat = this.tg.materializers[fieldType.materializer];
      const runtime = this.runtimeReferences[mat.runtime];

      if (!serial && mat.data.serial) {
        throw Error(
          `${fieldType.title} via ${mat.name} can only be executed in mutation`,
        );
      }

      const stage = new ComputeStage({
        dependencies,
        parent: parentStage,
        args,
        policies,
        outType: outputType,
        runtime,
        materializer: mat,
        batcher: this.nextBatcher(outputType),
        node: fieldName,
        path: [...queryPath, aliasName ?? fieldName],
        rateCalls: rate_calls,
        rateWeight: rate_weight as number, // FIXME what is the right type?
      });
      stages.push(stage);

      if (outputType.type === "object") {
        stages.push(
          ...this.traverse(
            fragments,
            fieldName,
            fieldArgs ?? TypeGraph.emptyArgs,
            fieldFields ?? TypeGraph.emptyFields,
            verbose,
            [...queryPath, fieldName],
            outputIdx,
            stage,
          ),
        );
      } else if (
        outputType.type === "optional" &&
        this.type(outputType.item).type === "array"
      ) {
        const subTypeIdx = outputType.item;
        const subType = this.type(subTypeIdx) as ArrayNode;
        const subSubTypeIdx = subType.items;
        const subSubType = this.type(subSubTypeIdx);

        if (subSubType.type === "object") {
          stages.push(
            ...this.traverse(
              fragments,
              fieldName,
              fieldArgs ?? TypeGraph.emptyArgs,
              fieldFields ?? TypeGraph.emptyFields,
              verbose,
              [...queryPath, aliasName ?? fieldName],
              subSubTypeIdx,
              stage,
            ),
          );
        }
      } else if (
        outputType.type === "array" ||
        outputType.type === "optional"
      ) {
        const subTypeIdx = outputType.type === "array"
          ? outputType.items
          : outputType.item;
        const subType = this.type(subTypeIdx);
        if (subType.type === "object") {
          stages.push(
            ...this.traverse(
              fragments,
              fieldName,
              fieldArgs ?? TypeGraph.emptyArgs,
              fieldFields ?? TypeGraph.emptyFields,
              verbose,
              [...queryPath, aliasName ?? fieldName],
              subTypeIdx,
              stage,
            ),
          );
        }
      }
    }

    return stages;
  }

  preparePolicies(stages: ComputeStage[]): PolicyStagesFactory {
    const policies = Array.from(
      new Set(
        stages.flatMap((stage) => Object.values(stage.props.policies).flat()),
      ),
    ).map((policyName) => {
      // bug-prone, lookup first for policies in introspection, then in current typegraph
      if (this.introspection) {
        const introPolicy = this.introspection.tg.policies.find(
          (p) => p.name === policyName,
        );

        if (introPolicy) {
          const mat = this.introspection.tg.materializers[
            introPolicy.materializer as number
          ];
          const rt = this.introspection
            .runtimeReferences[mat.runtime] as DenoRuntime;
          return [introPolicy.name, rt.delegate(mat, false)] as [
            string,
            Resolver,
          ];
        }
      }

      const policy = this.tg.policies.find((p) => p.name === policyName);
      if (!policy) {
        throw Error(`cannot find policy ${policyName}`);
      }

      const mat = this.tg.materializers[policy.materializer as number];
      const rt = this.runtimeReferences[mat.runtime] as DenoRuntime;
      ensure(
        rt.constructor === DenoRuntime,
        "runtime for policy must be a DenoRuntime",
      );
      return [policy.name, rt.delegate(mat, false)] as [string, Resolver];
    });

    return (context: Record<string, any>) => {
      const ret: PolicyStages = {};
      for (const [policyName, resolver] of policies) {
        // for policies, the context becomes the args
        ret[policyName] = async () =>
          await lazyResolver<boolean | null>(resolver)({
            ...context,
            _: {
              parent: {},
              context: {},
              variables: {},
            },
          });
      }
      return ret;
    };
  }

  nextBatcher = (type: TypeNode): Batcher => {
    // convenience check to be removed
    const ensureArray = (x: []) => {
      ensure(Array.isArray(x), `${JSON.stringify(x)} not an array`);
      return x;
    };

    if (type.type === "array") {
      if (this.type(type.items).type === "optional") {
        throw Error("D");
        //return (x: any) => x.flat().filter((c: any) => !!c);
      }
      return (x: any) => ensureArray(x).flat();
    }
    if (type.type === "optional") {
      if (this.type(type.item).type === "array") {
        return (x: any) =>
          ensureArray(x)
            .filter((c: any) => !!c)
            .flat();
      }
      return (x: any) => ensureArray(x).filter((c: any) => !!c);
    }
    ensure(
      type.type === "object" ||
        // type.type === "enum" ||
        type.type === "integer" ||
        type.type === "number" ||
        type.type === "boolean" ||
        type.type === "function" ||
        type.type === "string",
      `object expected but got ${type.type}`,
    );
    return (x: any) => ensureArray(x);
  };

  typeByNameOrIndex(nameOrIndex: string | number): TypeNode {
    if (typeof nameOrIndex === "number") {
      return this.type(nameOrIndex);
    }
    const tpe = this.typeByName[nameOrIndex];
    if (tpe == null) {
      if (nameOrIndex.endsWith("Inp")) {
        // Input types are suffixed with "Inp" on the playground docs
        return this.typeByNameOrIndex(nameOrIndex.slice(0, -3));
      }
      throw new Error(`type ${nameOrIndex} not found`);
    }
    return tpe;
  }

  validateValueType(
    nameOrIndex: string | number,
    value: unknown,
    label: string,
  ) {
    const tpe = this.typeByNameOrIndex(nameOrIndex);

    if (tpe.type === "optional") {
      if (value == null) return;
      this.validateValueType(tpe.item as number, value, label);
      return;
    }

    if (value == null) {
      throw new Error(`variable ${label} cannot be null`);
    }

    switch (tpe.type) {
      case "object":
        if (typeof value !== "object") {
          throw new Error(`variable ${label} must be an object`);
        }
        Object.entries(tpe.properties).forEach(
          ([key, typeIdx]) => {
            this.validateValueType(
              typeIdx,
              (value as Record<string, unknown>)[key],
              `${label}.${key}`,
            );
          },
        );
        return;
      case "array":
        if (!Array.isArray(value)) {
          throw new Error(`variable ${label} must be an array`);
        }
        value.forEach((item, idx) => {
          this.validateValueType(
            tpe.items,
            item,
            `${label}[${idx}]`,
          );
        });
        return;
      case "integer":
      case "number":
        if (typeof value !== "number") {
          throw new Error(`variable ${label} must be a number`);
        }
        return;
      case "boolean":
        if (typeof value !== "boolean") {
          throw new Error(`variable ${label} must be a boolean`);
        }
        return;
      case "string":
        if (typeof value !== "string") {
          throw new Error(`variable ${label} must be a string`);
        }
        return;
      // case "uuid":
      //   if (!uuid.validate(value as string)) {
      //     throw new Error(`variable ${label} must be a valid UUID`);
      //   }
      //   return;
      default:
        throw new Error(`unsupported type ${tpe.type}`);
    }
  }
}

const lazyResolver = <T>(
  fn: Resolver,
): Resolver => {
  let memo: Promise<T> | undefined = undefined;
  // deno-lint-ignore require-await
  return async (args) => {
    if (!memo) {
      // no need to wait, the resolver executor will
      memo = fn(args);
    }
    return memo;
  };
};
