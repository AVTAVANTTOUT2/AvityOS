import { homedir } from "node:os";
import { join } from "node:path";

export type OperatorServiceName = "control-plane" | "web" | "worker";

export interface OperatorServicePaths {
  readonly name: OperatorServiceName;
  readonly pidFilePath: string;
  readonly logFilePath: string;
}

export interface OperatorPaths {
  readonly repositoryRoot: string;
  readonly rootDir: string;
  readonly configDir: string;
  readonly runDir: string;
  readonly logsDir: string;
  readonly reportsDir: string;
  readonly operatorEnvPath: string;
  readonly setupStatePath: string;
  readonly services: {
    readonly controlPlane: OperatorServicePaths;
    readonly web: OperatorServicePaths;
    readonly worker: OperatorServicePaths;
  };
}

export interface ResolveOperatorPathsOptions {
  readonly repositoryRoot: string;
  readonly operatorHome?: string;
}

export function resolveOperatorPaths(options: ResolveOperatorPathsOptions): OperatorPaths {
  const rootDir = options.operatorHome ?? process.env.AVITY_OPERATOR_HOME ?? join(homedir(), ".avity", "operator");
  const configDir = join(rootDir, "config");
  const runDir = join(rootDir, "run");
  const logsDir = join(rootDir, "logs");
  const reportsDir = join(rootDir, "reports");
  const createService = (name: OperatorServiceName): OperatorServicePaths => ({
    name,
    pidFilePath: join(runDir, `${name}.pid`),
    logFilePath: join(logsDir, `${name}.log`),
  });
  return {
    repositoryRoot: options.repositoryRoot,
    rootDir,
    configDir,
    runDir,
    logsDir,
    reportsDir,
    operatorEnvPath: join(configDir, "operator.env"),
    setupStatePath: join(configDir, "setup.json"),
    services: {
      controlPlane: createService("control-plane"),
      web: createService("web"),
      worker: createService("worker"),
    },
  };
}
