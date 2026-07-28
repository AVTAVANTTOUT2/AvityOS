import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../app/App";
import { isNativeShell } from "./native-shell";

describe("native shell helpers", () => {
  afterEach(() => {
    delete window.__AVITY_NATIVE__;
  });

  it("detects the injected macOS bridge", () => {
    expect(isNativeShell()).toBe(false);
    window.__AVITY_NATIVE__ = {
      shell: true,
      platform: "macos",
      openNativeSettings: () => undefined,
    };
    expect(isNativeShell()).toBe(true);
  });
});

describe("native shell authentication gate", () => {
  beforeEach(() => {
    window.__AVITY_NATIVE__ = {
      shell: true,
      platform: "macos",
      openNativeSettings: vi.fn(),
    };
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "invalid or missing API token" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ));
  });

  afterEach(() => {
    delete window.__AVITY_NATIVE__;
    vi.unstubAllGlobals();
  });

  it("routes unauthorized native sessions to Keychain settings instead of a web token form", async () => {
    render(<App />);
    expect(await screen.findByTestId("screen.auth-native")).toBeInTheDocument();
    expect(screen.queryByLabelText("Token du control plane")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("auth.open-native-settings"));
    expect(window.__AVITY_NATIVE__?.openNativeSettings).toHaveBeenCalled();
  });
});
