#!/usr/bin/env node
import {
  installProcessSignalAbort,
  resolveWorkerCredentials,
  WorkerAgent,
} from "./agent.js";
import {
  createSecureFetchTransport,
  loadClientTlsConfiguration,
} from "@avityos/transport-security";

async function main(): Promise<void> {
  const tlsConfiguration = loadClientTlsConfiguration(process.env);
  const tlsTransport = tlsConfiguration
    ? createSecureFetchTransport(tlsConfiguration)
    : null;
  const config = {
    controlPlaneUrl: process.env.AVITY_CONTROL_PLANE_URL ?? "http://127.0.0.1:7717",
    name: process.env.AVITY_WORKER_NAME ?? "",
    pollMs: Number(process.env.AVITY_WORKER_POLL_MS ?? 1000),
    capabilities: (process.env.AVITY_WORKER_CAPABILITIES ?? "shell,git,node").split(","),
    maxConcurrentRuns: Number(process.env.AVITY_WORKER_MAX_CONCURRENT_RUNS ?? 4),
    credentialsPath: process.env.AVITY_WORKER_CREDENTIALS_PATH,
    ...(process.env.AVITY_API_TOKEN ? { apiToken: process.env.AVITY_API_TOKEN } : {}),
    ...(process.env.AVITY_WORKER_ID ? { workerId: process.env.AVITY_WORKER_ID } : {}),
    ...(process.env.AVITY_WORKER_TOKEN ? { workerToken: process.env.AVITY_WORKER_TOKEN } : {}),
    ...(process.env.AVITY_ALLOW_INSECURE === "1" ? { allowInsecureTransport: true } : {}),
    ...(tlsTransport ? { fetchImpl: tlsTransport.fetch } : {}),
  };

  // Remote control planes require TLS: worker credentials must never cross
  // the network in cleartext. Loopback is exempt for local development.
  const url = new URL(config.controlPlaneUrl);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback && !config.allowInsecureTransport) {
    tlsTransport?.close();
    console.error(
      `refusing plain HTTP to non-loopback control plane ${config.controlPlaneUrl}; use https or set AVITY_ALLOW_INSECURE=1 (not recommended)`,
    );
    process.exitCode = 1;
    return;
  }
  if (tlsTransport && url.protocol !== "https:") {
    tlsTransport.close();
    throw new Error(
      "AVITY_TLS_* client material requires an HTTPS control-plane URL",
    );
  }

  try {
    const enrollmentAgent = new WorkerAgent(config);
    const credentials = await resolveWorkerCredentials(
      {
        workerId: config.workerId,
        workerToken: config.workerToken,
        credentialsPath: config.credentialsPath,
      },
      enrollmentAgent,
      (line) => console.log(line),
    );

    const runtimeAgent = new WorkerAgent({
      ...config,
      workerId: credentials.workerId,
      workerToken: credentials.workerToken,
    });

    const controller = new AbortController();
    const disposeSignals = installProcessSignalAbort(controller);
    console.log(`AvityOS worker polling ${config.controlPlaneUrl} every ${config.pollMs}ms`);

    try {
      await runtimeAgent.run(controller.signal);
      process.exitCode = 0;
    } catch (err) {
      console.error("worker failed:", err);
      process.exitCode = 1;
      if (!controller.signal.aborted) controller.abort();
      await runtimeAgent.stop();
    } finally {
      disposeSignals();
    }
  } finally {
    tlsTransport?.close();
  }
}

main().catch((err) => {
  console.error("worker failed to start:", err);
  process.exitCode = 1;
});
