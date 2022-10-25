// Copyright Metatype under the Elastic License 2.0.

import { Context } from "../../types.ts";

export interface Code {
  name: string;
  source: string;
  type: "module" | "func";
}

export interface TaskContext {
  parent?: Record<string, unknown>;
  context?: Context;
}

export interface FunctionMaterializerData {
  script: string;
}

export interface ImportFuncMaterializerData {
  mod: number;
  name: string;
}

interface TaskBase {
  type: "func" | "import_func" | "predefined_func";
  id: number;
  args: Record<string, unknown>;
  internals: TaskContext;
  verbose: boolean;
}

export interface ImportFuncTask extends TaskBase {
  type: "import_func";
  moduleId: number;
  moduleCode?: string;
  name: string;
}

export interface FuncTask extends TaskBase {
  type: "func";
  fnId: number;
  code?: string;
}

export interface PredefinedFuncTask extends TaskBase {
  type: "predefined_func";
  name: string;
}

export type Task = ImportFuncTask | FuncTask | PredefinedFuncTask;

export interface TaskExec {
  (args: Record<string, unknown>, context: TaskContext): unknown;
}

export const predefinedFuncs: Record<string, TaskExec> = {
  identity: (args) => args,
};
