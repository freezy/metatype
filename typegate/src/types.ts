// Copyright Metatype under the Elastic License 2.0.

import { ComputeStage } from "./engine.ts";
import { Runtime } from "./runtimes/Runtime.ts";
import type { TypeGraphDS, TypeMaterializer } from "./typegraph.ts";
import { TypeNode } from "./type_node.ts";

export interface Parents {
  [key: string]: (() => Promise<unknown> | unknown) | unknown;
}

export interface Variables {
  [key: string]: unknown;
}

export interface Context {
  [key: string]: unknown;
}

export type Resolver = (
  args: {
    _: {
      parent: Parents;
      // FIXME : variables really needed?
      variables: Variables;
      context: Context;
      [dep: string]: unknown;
    };
    [arg: string]: any;
  },
) => Promise<any> | any;

export type Batcher = (x: any) => any;

export type RuntimeConfig = Record<string, unknown>;
export type RuntimesConfig = Record<string, RuntimeConfig>;
export interface RuntimeInitParams {
  typegraph: TypeGraphDS;
  materializers: TypeMaterializer[];
  args: Record<string, unknown>;
  config: RuntimeConfig;
}
export type RuntimeInit = Record<
  string,
  (params: RuntimeInitParams) => Promise<Runtime> | Runtime
>;

/**
 * A function that computes argument from parent, variables and context
 * Pass null `variables` to get a FromVars<_> that computes the argument value
 * from variables or returns the variable name if the `variables` param is null.
 */
export interface ComputeArg {
  (
    parent: Parents,
    variables: Variables | null,
    context: Context,
  ): unknown;
}

export interface ComputeStageProps {
  dependencies: string[];
  parent?: ComputeStage;
  args: Record<string, ComputeArg>;
  policies: Record<string, string[]>;
  resolver?: Resolver;
  outType: TypeNode; // only temp
  runtime: Runtime;
  materializer?: TypeMaterializer;
  batcher: Batcher;
  node: string;
  path: string[];
  rateCalls: boolean;
  rateWeight: number;
}

export type PolicyStage = () => Promise<boolean | null>;
export type PolicyStages = Record<string, PolicyStage>;
export type PolicyStagesFactory = (
  context: Context,
) => PolicyStages;