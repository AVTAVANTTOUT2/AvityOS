import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CredentialVaultError,
  EncryptedCredentialVault,
  FileCredentialVaultKeyStore,
  MacOSCredentialVaultKeyStore,
  decodeCredentialVaultKey,
  encodeCredentialVaultKey,
  openCredentialVault,
  sealCredentialVault,
} from "./index.js";

const NOW = new Date("2026-07-24T15:30:00.000Z");

function emptyPlaintext() {
  return {
    schemaVersion: 1 as const,
    generation: 0,
    entries: [],
  };
}

describe("credential vault cryptography", () => {
  it("authenticates a strict AES-256-GCM envelope without plaintext leakage", () => {
    const key = Buffer.alloc(32, 0x11);
    const value = {
      schemaVersion: 1 as const,
      generation: 1,
      entries: [{
        name: "DEEPSEEK_API_KEY" as const,
        value: "provider-secret-value",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      }],
    };
    const envelope = sealCredentialVault(value, key, Buffer.alloc(12, 0x22));

    expect(JSON.stringify(envelope)).not.toContain("provider-secret-value");
    expect(openCredentialVault(envelope, key)).toEqual(value);
  });

  it("rejects the wrong key, tampering and malformed key material", () => {
    const key = randomBytes(32);
    const envelope = sealCredentialVault(
      emptyPlaintext(),
      key,
      Buffer.alloc(12, 0x33),
    );
    expect(() => openCredentialVault(envelope, randomBytes(32))).toThrow(
      /master key does not match/i,
    );
    expect(() => openCredentialVault({
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -1)}A`,
    }, key)).toThrow(/authentication/i);
    expect(() => decodeCredentialVaultKey("short")).toThrow(/32-byte/i);
    expect(decodeCredentialVaultKey(encodeCredentialVaultKey(key))).toEqual(key);
  });
});

describe("encrypted credential vault file", () => {
  it("initializes, scopes, rotates and removes credentials atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "avity-vault-"));
    const path = join(root, "config", "credentials.vault");
    const key = Buffer.alloc(32, 0x44);
    let nonceByte = 1;
    const vault = new EncryptedCredentialVault(path, key, {
      now: () => NOW,
      nonce: () => Buffer.alloc(12, nonceByte++),
    });

    expect(vault.initialize().created).toBe(true);
    expect(vault.initialize().created).toBe(false);
    let snapshot = vault.setMany({
      DEEPSEEK_API_KEY: "deepseek-secret",
      AVITY_WORKER_TOKEN: "worker-secret",
    });
    expect(snapshot.generation).toBe(1);
    expect(snapshot.entries.map((entry) => [entry.name, entry.service])).toEqual([
      ["AVITY_WORKER_TOKEN", "worker"],
      ["DEEPSEEK_API_KEY", "control-plane"],
    ]);
    expect(vault.environmentFor("control-plane")).toEqual({
      DEEPSEEK_API_KEY: "deepseek-secret",
    });
    expect(vault.environmentFor("worker")).toEqual({
      AVITY_WORKER_TOKEN: "worker-secret",
    });

    snapshot = vault.set("DEEPSEEK_API_KEY", "rotated-secret");
    expect(snapshot.generation).toBe(2);
    expect(vault.environmentFor("control-plane")).toEqual({
      DEEPSEEK_API_KEY: "rotated-secret",
    });
    snapshot = vault.remove("AVITY_WORKER_TOKEN");
    expect(snapshot.generation).toBe(3);
    expect(vault.environmentFor("worker")).toEqual({});
    expect(JSON.stringify(snapshot)).not.toContain("rotated-secret");
    expect(readFileSync(path, "utf8")).not.toContain("rotated-secret");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(root, "config")).mode & 0o777).toBe(0o700);
  });

  it("rejects unknown names, multiline values and unsafe vault files", () => {
    const root = mkdtempSync(join(tmpdir(), "avity-vault-"));
    const path = join(root, "credentials.vault");
    const vault = new EncryptedCredentialVault(path, randomBytes(32));
    vault.initialize();
    expect(() => vault.set("NODE_OPTIONS", "--require bad.js")).toThrow();
    expect(() => vault.set("OPENAI_API_KEY", "line-one\nline-two")).toThrow();

    chmodSync(path, 0o644);
    expect(() => vault.snapshot()).toThrow(/mode 0600/i);
    const symlinkPath = join(root, "linked.vault");
    symlinkSync(path, symlinkPath);
    const linked = new EncryptedCredentialVault(symlinkPath, randomBytes(32));
    expect(() => linked.snapshot()).toThrow(CredentialVaultError);

    const publicDirectory = join(root, "public");
    mkdirSync(publicDirectory, { mode: 0o755 });
    chmodSync(publicDirectory, 0o755);
    const unsafe = new EncryptedCredentialVault(
      join(publicDirectory, "credentials.vault"),
      randomBytes(32),
    );
    expect(() => unsafe.initialize()).toThrow(/private, writable/i);
    expect(lstatSync(publicDirectory).mode & 0o777).toBe(0o755);
  });

  it("fails closed on an active lock and preserves a recovered stale lock", () => {
    const root = mkdtempSync(join(tmpdir(), "avity-vault-"));
    const path = join(root, "credentials.vault");
    const vault = new EncryptedCredentialVault(path, randomBytes(32));
    vault.initialize();
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, `${JSON.stringify({
      pid: process.pid,
      token: "a".repeat(32),
      createdAt: NOW.toISOString(),
    })}\n`, { mode: 0o600 });
    expect(() => vault.set("OPENAI_API_KEY", "secret")).toThrow(/active process/i);

    writeFileSync(lockPath, `${JSON.stringify({
      pid: 2_147_483_647,
      token: "b".repeat(32),
      createdAt: NOW.toISOString(),
    })}\n`, { mode: 0o600 });
    expect(vault.set("OPENAI_API_KEY", "secret").generation).toBe(1);
    expect(readdirSync(root).some((name) =>
      name.startsWith("credentials.vault.lock.stale-")
    )).toBe(true);
  });
});

describe("credential vault key stores", () => {
  it("creates and validates an owner-only file key", () => {
    const root = mkdtempSync(join(tmpdir(), "avity-vault-key-"));
    const path = join(root, "secret", "master.key");
    const store = new FileCredentialVaultKeyStore(path);
    const first = store.create();
    expect(first).toHaveLength(32);
    expect(store.create()).toEqual(first);
    expect(store.load()).toEqual(first);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);

    chmodSync(path, 0o644);
    expect(() => store.load()).toThrow(/private regular file/i);
    chmodSync(path, 0o400);
    expect(() => store.load()).toThrow(/private regular file/i);
  });

  it("keeps the generated macOS key out of argv and verifies the readback", () => {
    let persisted: string | undefined;
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const missing = Object.assign(new Error("missing"), { status: 44 });
    const store = new MacOSCredentialVaultKeyStore(
      "test.service",
      "test.account",
      (args, input) => {
        calls.push({ args, input });
        if (args[0] === "find-generic-password") {
          if (!persisted) throw missing;
          return `${persisted}\n`;
        }
        if (args[0] === "add-generic-password") {
          persisted = input?.trim().split(/\r?\n/)[0];
          return "";
        }
        throw new Error("unexpected command");
      },
    );

    const key = store.create();
    expect(key).toHaveLength(32);
    expect(store.load()).toEqual(key);
    const add = calls.find((call) => call.args[0] === "add-generic-password");
    expect(add?.args).toEqual([
      "add-generic-password",
      "-s",
      "test.service",
      "-a",
      "test.account",
      "-w",
    ]);
    expect(add?.args.join(" ")).not.toContain(persisted);
    expect(add?.input?.split(/\r?\n/).filter(Boolean)).toEqual([
      persisted,
      persisted,
    ]);
  });

  it("rejects a symlinked file key", () => {
    const root = mkdtempSync(join(tmpdir(), "avity-vault-key-"));
    const target = join(root, "target");
    const link = join(root, "link");
    writeFileSync(target, `${encodeCredentialVaultKey(randomBytes(32))}\n`, {
      mode: 0o600,
    });
    symlinkSync(target, link);
    expect(() => new FileCredentialVaultKeyStore(link).load()).toThrow(
      /private regular file/i,
    );
  });

  it("never changes permissions on a permissive pre-existing key directory", () => {
    const root = mkdtempSync(join(tmpdir(), "avity-vault-key-"));
    const publicDirectory = join(root, "public");
    mkdirSync(publicDirectory, { mode: 0o755 });
    chmodSync(publicDirectory, 0o755);
    const store = new FileCredentialVaultKeyStore(
      join(publicDirectory, "master.key"),
    );
    expect(() => store.create()).toThrow(/private, writable/i);
    expect(lstatSync(publicDirectory).mode & 0o777).toBe(0o755);
  });
});
