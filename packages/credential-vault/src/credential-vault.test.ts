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
  openCredentialRecovery,
  credentialVaultKeyId,
  sealCredentialRecovery,
  sealCredentialVault,
  readCredentialRecoveryFile,
  writeCredentialRecoveryFileAtomic,
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
    const tamperedCiphertext = Buffer.from(envelope.ciphertext, "base64url");
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 0x01;
    expect(() => openCredentialVault({
      ...envelope,
      ciphertext: tamperedCiphertext.toString("base64url"),
    }, key)).toThrow(/authentication/i);
    expect(() => decodeCredentialVaultKey("short")).toThrow(/32-byte/i);
    expect(decodeCredentialVaultKey(encodeCredentialVaultKey(key))).toEqual(key);
  });

  it("protects a portable recovery key with strict scrypt + AES-GCM", () => {
    const key = Buffer.alloc(32, 0x5a);
    const passphrase = "correct horse battery staple";
    const envelope = sealCredentialRecovery(key, passphrase, {
      salt: Buffer.alloc(16, 0x6b),
      nonce: Buffer.alloc(12, 0x7c),
    });

    expect(JSON.stringify(envelope)).not.toContain(encodeCredentialVaultKey(key));
    expect(envelope.keyId).toBe(credentialVaultKeyId(key));
    expect(openCredentialRecovery(envelope, passphrase)).toEqual(key);
    expect(() => openCredentialRecovery(envelope, "wrong passphrase value")).toThrow(
      /authentication failed/i,
    );
    expect(() => openCredentialRecovery({
      ...envelope,
      tag: `${envelope.tag.slice(0, -1)}A`,
    }, passphrase)).toThrow(/authentication failed/i);
    expect(() => sealCredentialRecovery(key, "too-short")).toThrow(
      /between 16 and 1024/i,
    );

    const root = mkdtempSync(join(tmpdir(), "avity-recovery-"));
    const path = join(root, "private", "vault.recovery.json");
    writeCredentialRecoveryFileAtomic(path, envelope);
    expect(readCredentialRecoveryFile(path)).toEqual(envelope);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeCredentialRecoveryFileAtomic(path, envelope)).toThrow(
      /already exists/i,
    );
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

  it("rotates the master key without changing credential metadata or values", () => {
    const root = mkdtempSync(join(tmpdir(), "avity-vault-rekey-"));
    const path = join(root, "credentials.vault");
    const firstKey = Buffer.alloc(32, 0x31);
    const nextKey = Buffer.alloc(32, 0x32);
    const vault = new EncryptedCredentialVault(path, firstKey, {
      now: () => NOW,
    });
    vault.initialize();
    const before = vault.set("OPENAI_API_KEY", "provider-secret");

    const rotated = vault.rotateMasterKey(nextKey);

    expect(rotated.generation).toBe(before.generation + 1);
    expect(rotated.keyId).toBe(credentialVaultKeyId(nextKey));
    expect(rotated.entries).toEqual(before.entries);
    expect(vault.snapshot()).toEqual(rotated);
    expect(vault.environmentFor("control-plane")).toEqual({
      OPENAI_API_KEY: "provider-secret",
    });
    expect(() =>
      new EncryptedCredentialVault(path, firstKey).snapshot()
    ).toThrow(/master key does not match/i);
    expect(
      new EncryptedCredentialVault(path, nextKey).environmentFor("control-plane"),
    ).toEqual({ OPENAI_API_KEY: "provider-secret" });
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
    chmodSync(path, 0o600);
    const next = randomBytes(32);
    expect(store.replace(first, next)).toEqual(next);
    expect(() => store.replace(first, randomBytes(32))).toThrow(/changed/i);
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

    const next = randomBytes(32);
    expect(store.replace(key, next)).toEqual(next);
    const update = calls.find((call) =>
      call.args[0] === "add-generic-password" && call.args.includes("-U")
    );
    expect(update?.args.at(-1)).toBe("-w");
    expect(update?.args.join(" ")).not.toContain(encodeCredentialVaultKey(next));
    expect(() => store.replace(key, randomBytes(32))).toThrow(/changed/i);
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
