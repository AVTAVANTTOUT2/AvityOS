import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import {
  RemoteAccountId,
  RemoteDeviceId,
  RemoteEncryptedEnvelope,
  RemoteRelayAckRequest,
  RemoteRelayRegisterDeviceRequest,
  RemoteRelayUpdateDeviceCertificateRequest,
} from "@avityos/contracts";
import {
  InMemoryRelayStore,
  RemoteRelayCapacityError,
  RemoteRelayConflictError,
  type RemoteRelayStore,
} from "./store.js";

const InboxParams = z.object({
  accountId: RemoteAccountId,
  deviceId: RemoteDeviceId,
}).strict();

const InboxQuery = z.object({
  after: z.coerce.number().int().nonnegative().safe().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  waitMs: z.coerce.number().int().min(0).max(25_000).default(0),
}).strict();

export interface RemoteRelayServerOptions {
  readonly accessToken: string;
  readonly version: string;
  readonly store?: RemoteRelayStore;
}

function apiError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

function tokensMatch(supplied: string, expected: string): boolean {
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  return tokensMatch(bearerToken(header), expected);
}

function bearerToken(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

function validAccessToken(value: string): boolean {
  return value.length >= 32 && value.length <= 4_096 && !/\s/.test(value);
}

export async function buildRemoteRelayServer(
  options: RemoteRelayServerOptions,
): Promise<FastifyInstance> {
  if (!validAccessToken(options.accessToken)) {
    throw new Error("remote relay access token must be 32-4096 non-whitespace characters");
  }
  const store = options.store ?? new InMemoryRelayStore();
  const startedAt = Date.now();
  const app = Fastify({
    logger: false,
    forceCloseConnections: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (
      path.startsWith("/v1/admin/") &&
      !bearerMatches(request.headers.authorization, options.accessToken)
    ) {
      await apiError(reply, 401, "policy_denied", "invalid or missing relay administrator token");
    }
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return apiError(
        reply,
        400,
        "validation_failed",
        error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    if (error instanceof RemoteRelayConflictError) {
      return apiError(reply, 409, "conflict", error.message);
    }
    if (error instanceof RemoteRelayCapacityError) {
      return apiError(reply, 429, "capacity_reached", error.message);
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 413
    ) {
      return apiError(reply, 413, "payload_too_large", "relay envelope exceeds the body limit");
    }
    return apiError(reply, 500, "internal", "unexpected relay error");
  });

  app.get("/v1/health", async () => ({
    status: "ok" as const,
    version: options.version,
    uptimeSeconds: (Date.now() - startedAt) / 1_000,
  }));

  app.post("/v1/relay/envelopes", async (request, reply) => {
    const suppliedToken = bearerToken(request.headers.authorization);
    if (!suppliedToken) {
      return apiError(reply, 401, "policy_denied", "invalid or revoked relay device credential");
    }
    const accountId = RemoteAccountId.parse(request.headers["x-avity-account-id"]);
    const deviceId = RemoteDeviceId.parse(request.headers["x-avity-device-id"]);
    if (!store.authorizeDevice(
      accountId,
      deviceId,
      suppliedToken,
    )) {
      return apiError(reply, 401, "policy_denied", "invalid or revoked relay device credential");
    }
    const envelope = RemoteEncryptedEnvelope.parse(request.body);
    if (envelope.accountId !== accountId || envelope.senderDeviceId !== deviceId) {
      return apiError(reply, 403, "policy_denied", "relay sender identity does not match its credential");
    }
    if (!store.isDeviceActive(envelope.accountId, envelope.recipientDeviceId)) {
      return apiError(reply, 403, "policy_denied", "relay recipient device is not active");
    }
    const result = store.publish(envelope);
    return reply.status(result.duplicate ? 200 : 202).send(result);
  });

  app.get("/v1/relay/accounts/:accountId/devices/:deviceId/inbox", async (request, reply) => {
    const params = InboxParams.parse(request.params);
    const query = InboxQuery.parse(request.query);
    if (!store.authorizeDevice(
      params.accountId,
      params.deviceId,
      bearerToken(request.headers.authorization),
    )) {
      return apiError(reply, 401, "policy_denied", "invalid or revoked relay device credential");
    }
    const controller = new AbortController();
    const onClose = (): void => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once("close", onClose);
    try {
      await store.waitForItems({
        accountId: params.accountId,
        deviceId: params.deviceId,
        afterCursor: query.after,
        waitMs: query.waitMs,
        signal: controller.signal,
      });
      return store.list(params.accountId, params.deviceId, query.after, query.limit);
    } finally {
      reply.raw.off("close", onClose);
    }
  });

  app.post("/v1/relay/accounts/:accountId/devices/:deviceId/ack", async (request, reply) => {
    const params = InboxParams.parse(request.params);
    if (!store.authorizeDevice(
      params.accountId,
      params.deviceId,
      bearerToken(request.headers.authorization),
    )) {
      return apiError(reply, 401, "policy_denied", "invalid or revoked relay device credential");
    }
    const body = RemoteRelayAckRequest.parse(request.body);
    return store.acknowledge(
      params.accountId,
      params.deviceId,
      body.throughCursor,
    );
  });

  app.post("/v1/admin/devices", async (request, reply) => {
    const body = RemoteRelayRegisterDeviceRequest.parse(request.body);
    if (tokensMatch(body.accessToken, options.accessToken)) {
      return apiError(
        reply,
        400,
        "validation_failed",
        "relay administrator and device credentials must be distinct",
      );
    }
    return reply.status(200).send(store.registerDevice(body));
  });

  app.put(
    "/v1/admin/accounts/:accountId/devices/:deviceId/certificate",
    async (request, reply) => {
      const params = InboxParams.parse(request.params);
      const body = RemoteRelayUpdateDeviceCertificateRequest.parse(request.body);
      if (
        body.certificate.accountId !== params.accountId ||
        body.certificate.deviceId !== params.deviceId
      ) {
        return apiError(
          reply,
          400,
          "validation_failed",
          "certificate identity does not match the relay device path",
        );
      }
      const record = store.updateDeviceCertificate(body);
      if (!record) {
        return apiError(reply, 404, "not_found", "relay device is not registered");
      }
      return record;
    },
  );

  app.post("/v1/admin/accounts/:accountId/devices/:deviceId/revoke", async (request, reply) => {
    const params = InboxParams.parse(request.params);
    const record = store.revokeDevice(params.accountId, params.deviceId);
    if (!record) {
      return apiError(reply, 404, "not_found", "relay device is not registered");
    }
    return record;
  });

  return app;
}
