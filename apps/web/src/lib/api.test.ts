import { describe, expect, it, vi } from "vitest";
import { api } from "./api";

describe("browser authentication", () => {
  it("exchanges the bearer for a credentialed HttpOnly session request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.login("top-secret");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url).endsWith("/v1/session")).toBe(true);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { authorization: "Bearer top-secret" },
    });
    expect(String(url)).not.toContain("top-secret");
  });
});
