import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

describe("authentication gate", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "invalid or missing API token" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ));
  });

  it("presents an accessible secure-token form when the session is unauthorized", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connecter AvityOS" })).toBeInTheDocument();
    expect(screen.getByLabelText("Token du control plane")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Se connecter" })).toBeEnabled();
  });

  it("shows an honest offline state instead of demo fixtures when the backend is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("network unavailable");
    }));
    render(<App />);
    expect(await screen.findByTitle("Control plane indisponible — aucune donnée de démonstration injectée")).toHaveTextContent("Hors ligne");
    expect(screen.queryByText("SaaS Facturation")).not.toBeInTheDocument();
  });
});
