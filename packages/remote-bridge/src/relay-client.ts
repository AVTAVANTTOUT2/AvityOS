import {
  RemoteAccountId,
  RemoteDeviceId,
  RemoteEncryptedEnvelope,
  RemoteRelayAckResult,
  RemoteRelayInbox,
  RemoteRelayPublishResult,
  type RemoteEncryptedEnvelope as RemoteEncryptedEnvelopeType,
  type RemoteRelayAckResult as RemoteRelayAckResultType,
  type RemoteRelayInbox as RemoteRelayInboxType,
  type RemoteRelayPublishResult as RemoteRelayPublishResultType,
} from "@avityos/contracts";

export interface RemoteRelayClient {
  publish(
    envelope: RemoteEncryptedEnvelopeType,
    signal?: AbortSignal,
  ): Promise<RemoteRelayPublishResultType>;
  poll(input: {
    readonly accountId: string;
    readonly deviceId: string;
    readonly afterCursor: number;
    readonly limit?: number;
    readonly waitMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<RemoteRelayInboxType>;
  acknowledge(input: {
    readonly accountId: string;
    readonly deviceId: string;
    readonly throughCursor: number;
    readonly signal?: AbortSignal;
  }): Promise<RemoteRelayAckResultType>;
}

export interface RemoteRelayHttpClientOptions {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly fetchImpl?: typeof fetch;
}

export class RemoteRelayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteRelayHttpError";
  }
}

function assertAccessToken(value: string): void {
  if (value.length < 32 || value.length > 4_096 || /\s/.test(value)) {
    throw new Error("remote relay access token must be 32-4096 non-whitespace characters");
  }
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validatedBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("remote relay URL must not contain credentials, query parameters, or a fragment");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("remote relay transport must use HTTPS outside loopback");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RemoteRelayHttpError(response.status, "remote relay returned invalid JSON");
  }
}

function serverErrorMessage(value: unknown): string | null {
  if (
    value &&
    typeof value === "object" &&
    "error" in value &&
    value.error &&
    typeof value.error === "object" &&
    "message" in value.error &&
    typeof value.error.message === "string"
  ) {
    return value.error.message.slice(0, 300);
  }
  return null;
}

export class RemoteRelayHttpClient implements RemoteRelayClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RemoteRelayHttpClientOptions) {
    assertAccessToken(options.accessToken);
    this.baseUrl = validatedBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const basePath = this.baseUrl.pathname === "/" ? "" : this.baseUrl.pathname;
    const url = new URL(`${basePath}${path}`, `${this.baseUrl.origin}/`);
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.options.accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const payload = await responseJson(response);
    if (!response.ok) {
      const detail = serverErrorMessage(payload);
      throw new RemoteRelayHttpError(
        response.status,
        detail
          ? `remote relay request failed (${response.status}): ${detail}`
          : `remote relay request failed (${response.status})`,
      );
    }
    return payload;
  }

  async publish(
    envelopeInput: RemoteEncryptedEnvelopeType,
    signal?: AbortSignal,
  ): Promise<RemoteRelayPublishResultType> {
    const envelope = RemoteEncryptedEnvelope.parse(envelopeInput);
    return RemoteRelayPublishResult.parse(await this.request("/v1/relay/envelopes", {
      method: "POST",
      body: JSON.stringify(envelope),
      signal,
    }));
  }

  async poll(input: {
    readonly accountId: string;
    readonly deviceId: string;
    readonly afterCursor: number;
    readonly limit?: number;
    readonly waitMs?: number;
    readonly signal?: AbortSignal;
  }): Promise<RemoteRelayInboxType> {
    const accountId = RemoteAccountId.parse(input.accountId);
    const deviceId = RemoteDeviceId.parse(input.deviceId);
    const afterCursor = boundedInteger(
      input.afterCursor,
      "relay cursor",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const limit = boundedInteger(input.limit ?? 25, "relay poll limit", 1, 100);
    const waitMs = boundedInteger(input.waitMs ?? 0, "relay poll wait", 0, 25_000);
    const params = new URLSearchParams({
      after: String(afterCursor),
      limit: String(limit),
      waitMs: String(waitMs),
    });
    return RemoteRelayInbox.parse(await this.request(
      `/v1/relay/accounts/${accountId}/devices/${deviceId}/inbox?${params.toString()}`,
      { method: "GET", signal: input.signal },
    ));
  }

  async acknowledge(input: {
    readonly accountId: string;
    readonly deviceId: string;
    readonly throughCursor: number;
    readonly signal?: AbortSignal;
  }): Promise<RemoteRelayAckResultType> {
    const accountId = RemoteAccountId.parse(input.accountId);
    const deviceId = RemoteDeviceId.parse(input.deviceId);
    const throughCursor = boundedInteger(
      input.throughCursor,
      "relay acknowledgement cursor",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    return RemoteRelayAckResult.parse(await this.request(
      `/v1/relay/accounts/${accountId}/devices/${deviceId}/ack`,
      {
        method: "POST",
        body: JSON.stringify({ throughCursor }),
        signal: input.signal,
      },
    ));
  }
}
