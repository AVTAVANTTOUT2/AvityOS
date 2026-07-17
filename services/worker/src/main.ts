#!/usr/bin/env node
import { WorkerAgent } from "./agent.js";

async function main(): Promise<void> {
  const config = {
    controlPlaneUrl: process.env.AVITY_CONTROL_PLANE_URL ?? "http://127.0.0.1:7717",
    name: process.env.AVITY_WORKER_NAME ?? "",
    pollMs: Number(process.env.AVITY_WORKER_POLL_MS ?? 1000),
    capabilities: (process.env.AVITY_WORKER_CAPABILITIES ?? "shell,git,node").split(","),
    maxConcurrentRuns: Number(process.env.AVITY_WORKER_MAX_CONCURRENT_RUNS ?? 4),
    ...(process.env.AVITY_API_TOKEN ? { apiToken: process.env.AVITY_API_TOKEN } : {}),
    ...(process.env.AVITY_WORKER_ID ? { workerId: process.env.AVITY_WORKER_ID } : {}),
    ...(process.env.AVITY_WORKER_TOKEN ? { workerToken: process.env.AVITY_WORKER_TOKEN } : {}),
    ...(process.env.AVITY_ALLOW_INSECURE === "1" ? { allowInsecureTransport: true } : {}),
  };

  // Remote control planes require TLS: worker credentials must never cross
  // the network in cleartext. Loopback is exempt for local development.
  const url = new URL(config.controlPlaneUrl);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopback && !config.allowInsecureTransport) {
    console.error(
      `refusing plain HTTP to non-loopback control plane ${config.controlPlaneUrl}; use https or set AVITY_ALLOW_INSECURE=1 (not recommended)`,
    );
    process.exit(1);
  }

  const agent = new WorkerAgent(config);
  if (!config.workerId || !config.workerToken) {
    const { id, token } = await agent.enroll();
    console.log(`enrolled as ${id}`);
    console.log(`export AVITY_WORKER_ID=${id}`);
    console.log(`export AVITY_WORKER_TOKEN=${token}  # shown once; store it securely`);
  }
  agent.start();
  console.log(`AvityOS worker polling ${config.controlPlaneUrl} every ${config.pollMs}ms`);

  const shutdown = async () => {
    await agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("worker failed to start:", err);
  process.exit(1);
});
