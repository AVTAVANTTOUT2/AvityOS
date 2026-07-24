import { describe, expect, it } from "vitest";
import {
  generateRemoteAccountIdentity,
  generateRemoteDeviceIdentity,
  issueRemoteDeviceCertificate,
} from "@avityos/remote-bridge";
import { MacOSRemoteHostKeychainStore } from "./remote-host-keychain.js";
import type { RemoteHostSecretConfiguration } from "./remote-host.js";

function configuration(): RemoteHostSecretConfiguration {
  const account = generateRemoteAccountIdentity();
  const hostIdentity = generateRemoteDeviceIdentity();
  return {
    relayUrl: "https://relay.example",
    relayAdminToken: "admin-token-".padEnd(32, "x"),
    hostDeviceToken: "host-token-".padEnd(32, "x"),
    account,
    hostIdentity,
    hostCertificate: issueRemoteDeviceCertificate({
      account,
      device: hostIdentity,
      name: "Host",
      issuedAt: "2026-07-24T13:00:00.000Z",
    }),
  };
}

describe("macOS remote host Keychain store", () => {
  it("round-trips the single protected configuration without shell expansion", () => {
    let serialized = "";
    const calls: Array<{ args: string[]; input?: string }> = [];
    const store = new MacOSRemoteHostKeychainStore("test.service", (args, input) => {
      calls.push({ args: [...args], input });
      if (args[0] === "add-generic-password") {
        serialized = input!.split("\n")[0]!;
        return "";
      }
      return `${serialized}\n`;
    });
    const value = configuration();

    store.save(value);

    expect(store.load()).toEqual(value);
    expect(calls[0]).toEqual({
      args: [
        "add-generic-password",
        "-U",
        "-s",
        "test.service",
        "-a",
        "configuration",
        "-w",
      ],
      input: `${JSON.stringify(value)}\n${JSON.stringify(value)}\n`,
    });
    expect(calls[0]!.args.join(" ")).not.toContain(value.relayAdminToken);
    expect(calls[0]!.args.join(" ")).not.toContain(value.account.signingPrivateKey);
    expect(calls[1]).toEqual({
      args: [
        "find-generic-password",
        "-s",
        "test.service",
        "-a",
        "configuration",
        "-w",
      ],
      input: undefined,
    });
  });

  it("treats only the Keychain not-found status as unconfigured", () => {
    const missing = new MacOSRemoteHostKeychainStore("test.service", () => {
      throw { status: 44 };
    });
    expect(missing.load()).toBeNull();

    const inaccessible = new MacOSRemoteHostKeychainStore("test.service", () => {
      throw { status: 36 };
    });
    expect(() => inaccessible.load()).toThrow(/could not be loaded/i);
  });
});
