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
  readonly serviceConfigDir: string;
  readonly runDir: string;
  readonly logsDir: string;
  readonly reportsDir: string;
  readonly operatorEnvPath: string;
  readonly serviceEnvPaths: {
    readonly controlPlane: string;
    readonly worker: string;
  };
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
  readonly serviceConfigDir?: string;
}

export function resolveOperatorPaths(options: ResolveOperatorPathsOptions): OperatorPaths {
  const home = homedir();
  const rootDir = options.operatorHome ?? process.env.AVITY_OPERATOR_HOME ?? join(home, ".avity", "operator");
  const configDir = join(rootDir, "config");
  const serviceConfigDir = options.serviceConfigDir
    ?? (options.operatorHome === undefined
      ? join(home, ".config", "avityos")
      : join(rootDir, "service-config"));
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
    serviceConfigDir,
    runDir,
    logsDir,
    reportsDir,
    operatorEnvPath: join(configDir, "operator.env"),
    serviceEnvPaths: {
      controlPlane: join(serviceConfigDir, "control-plane.env"),
      worker: join(serviceConfigDir, "worker.env"),
    },
    setupStatePath: join(configDir, "setup.json"),
    services: {
      controlPlane: createService("control-plane"),
      web: createService("web"),
      worker: createService("worker"),
    },
  };
}
