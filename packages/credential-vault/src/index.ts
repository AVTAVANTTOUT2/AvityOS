import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";

export const CREDENTIAL_VAULT_SCHEMA_VERSION = 1 as const;
export const CREDENTIAL_VAULT_CIPHER = "aes-256-gcm" as const;
export const MAX_CREDENTIAL_VAULT_BYTES = 2 * 1024 * 1024;
export const MAX_CREDENTIAL_VALUE_BYTES = 64 * 1024;
export const CREDENTIAL_RECOVERY_SCHEMA_VERSION = 1 as const;
export const CREDENTIAL_RECOVERY_KDF_N = 32_768;
export const CREDENTIAL_RECOVERY_KDF_R = 8;
export const CREDENTIAL_RECOVERY_KDF_P = 1;

export const VaultService = z.enum(["control-plane", "worker"]);
export type VaultService = z.infer<typeof VaultService>;

export const VaultSecretName = z.enum([
  "ANTHROPIC_API_KEY",
  "AVITY_API_TOKEN",
  "AVITY_WORKER_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_API_KEY",
  "CURSOR_API_KEY",
  "DEEPSEEK_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "OPENAI_API_KEY",
]);
export type VaultSecretName = z.infer<typeof VaultSecretName>;

const SECRET_SCOPES: Readonly<Record<VaultSecretName, VaultService>> = {
  ANTHROPIC_API_KEY: "control-plane",
  AVITY_API_TOKEN: "control-plane",
  AVITY_WORKER_TOKEN: "worker",
  CLAUDE_CODE_OAUTH_TOKEN: "control-plane",
  CODEX_API_KEY: "control-plane",
  CURSOR_API_KEY: "control-plane",
  DEEPSEEK_API_KEY: "control-plane",
  GH_TOKEN: "control-plane",
  GITHUB_TOKEN: "control-plane",
  OPENAI_API_KEY: "control-plane",
};

export function vaultSecretService(name: VaultSecretName): VaultService {
  return SECRET_SCOPES[name];
}

export function isVaultSecretName(value: string): value is VaultSecretName {
  return VaultSecretName.safeParse(value).success;
}

const Timestamp = z.string().datetime({ offset: true });
const VaultEntry = z.object({
  name: VaultSecretName,
  value: z.string()
    .min(1)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= MAX_CREDENTIAL_VALUE_BYTES,
      "credential exceeds 64 KiB",
    )
    .refine(
      (value) => !/[\u0000\r\n]/.test(value),
      "credential must be a single environment value",
    ),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).strict();
type VaultEntry = z.infer<typeof VaultEntry>;

const VaultPlaintext = z.object({
  schemaVersion: z.literal(CREDENTIAL_VAULT_SCHEMA_VERSION),
  generation: z.number().int().nonnegative().safe(),
  entries: z.array(VaultEntry).max(VaultSecretName.options.length),
}).strict().superRefine((value, context) => {
  const names = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    if (names.has(entry.name)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "credential names must be unique",
        path: ["entries", index, "name"],
      });
    }
    names.add(entry.name);
  }
});
type VaultPlaintext = z.infer<typeof VaultPlaintext>;

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const VaultEnvelope = z.object({
  schemaVersion: z.literal(CREDENTIAL_VAULT_SCHEMA_VERSION),
  cipher: z.literal(CREDENTIAL_VAULT_CIPHER),
  keyId: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: Base64Url,
  ciphertext: Base64Url,
  tag: Base64Url,
}).strict();
type VaultEnvelope = z.infer<typeof VaultEnvelope>;

const CredentialRecoveryEnvelope = z.object({
  schemaVersion: z.literal(CREDENTIAL_RECOVERY_SCHEMA_VERSION),
  kdf: z.literal("scrypt"),
  kdfN: z.literal(CREDENTIAL_RECOVERY_KDF_N),
  kdfR: z.literal(CREDENTIAL_RECOVERY_KDF_R),
  kdfP: z.literal(CREDENTIAL_RECOVERY_KDF_P),
  cipher: z.literal(CREDENTIAL_VAULT_CIPHER),
  keyId: z.string().regex(/^[a-f0-9]{64}$/),
  salt: Base64Url,
  nonce: Base64Url,
  ciphertext: Base64Url,
  tag: Base64Url,
}).strict();
export type CredentialRecoveryEnvelope = z.infer<
  typeof CredentialRecoveryEnvelope
>;

export function parseCredentialRecoveryEnvelope(
  value: unknown,
): CredentialRecoveryEnvelope {
  try {
    return CredentialRecoveryEnvelope.parse(value);
  } catch {
    throw new CredentialVaultError(
      "invalid_vault",
      "credential recovery envelope is invalid",
    );
  }
}

export interface CredentialVaultEntryMetadata {
  readonly name: VaultSecretName;
  readonly service: VaultService;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CredentialVaultSnapshot {
  readonly schemaVersion: typeof CREDENTIAL_VAULT_SCHEMA_VERSION;
  readonly generation: number;
  readonly keyId: string;
  readonly entries: readonly CredentialVaultEntryMetadata[];
}

export class CredentialVaultError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "invalid_key"
      | "invalid_vault"
      | "not_initialized"
      | "locked"
      | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "CredentialVaultError";
  }
}

function validatedMasterKey(value: Uint8Array): Buffer {
  const key = Buffer.from(value);
  if (key.byteLength !== 32) {
    throw new CredentialVaultError(
      "invalid_key",
      "credential vault master key must contain exactly 32 bytes",
    );
  }
  return key;
}

export function credentialVaultKeyId(value: Uint8Array): string {
  return createHash("sha256")
    .update(validatedMasterKey(value))
    .digest("hex");
}

export function encodeCredentialVaultKey(value: Uint8Array): string {
  return validatedMasterKey(value).toString("base64url");
}

export function decodeCredentialVaultKey(value: string): Buffer {
  const encoded = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new CredentialVaultError(
      "invalid_key",
      "credential vault key must be a canonical 32-byte base64url value",
    );
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.toString("base64url") !== encoded) {
    throw new CredentialVaultError(
      "invalid_key",
      "credential vault key encoding is not canonical",
    );
  }
  return validatedMasterKey(key);
}

function additionalAuthenticatedData(keyId: string): Buffer {
  return Buffer.from(
    `AvityOS credential vault\u0000v${CREDENTIAL_VAULT_SCHEMA_VERSION}\u0000${keyId}`,
    "utf8",
  );
}

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("non-canonical base64url");
  }
  return decoded;
}

function validatedRecoveryPassphrase(value: string): Buffer {
  if (/[\u0000\r\n]/.test(value)) {
    throw new CredentialVaultError(
      "invalid_input",
      "recovery passphrase must be a single line",
    );
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength < 16 || bytes.byteLength > 1_024) {
    throw new CredentialVaultError(
      "invalid_input",
      "recovery passphrase must contain between 16 and 1024 UTF-8 bytes",
    );
  }
  return bytes;
}

function recoveryAdditionalAuthenticatedData(keyId: string): Buffer {
  return Buffer.from(
    [
      "AvityOS credential recovery",
      `v${CREDENTIAL_RECOVERY_SCHEMA_VERSION}`,
      `scrypt:${CREDENTIAL_RECOVERY_KDF_N}:${CREDENTIAL_RECOVERY_KDF_R}:${CREDENTIAL_RECOVERY_KDF_P}`,
      keyId,
    ].join("\u0000"),
    "utf8",
  );
}

function deriveRecoveryKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(validatedRecoveryPassphrase(passphrase), salt, 32, {
    N: CREDENTIAL_RECOVERY_KDF_N,
    r: CREDENTIAL_RECOVERY_KDF_R,
    p: CREDENTIAL_RECOVERY_KDF_P,
    maxmem: 64 * 1024 * 1024,
  });
}

export function sealCredentialRecovery(
  masterKeyValue: Uint8Array,
  passphrase: string,
  options: {
    readonly salt?: Uint8Array;
    readonly nonce?: Uint8Array;
  } = {},
): CredentialRecoveryEnvelope {
  const masterKey = validatedMasterKey(masterKeyValue);
  const salt = Buffer.from(options.salt ?? randomBytes(16));
  const nonce = Buffer.from(options.nonce ?? randomBytes(12));
  if (salt.byteLength !== 16 || nonce.byteLength !== 12) {
    throw new CredentialVaultError(
      "invalid_input",
      "recovery salt/nonce lengths are invalid",
    );
  }
  const keyId = credentialVaultKeyId(masterKey);
  const recoveryKey = deriveRecoveryKey(passphrase, salt);
  const cipher = createCipheriv(CREDENTIAL_VAULT_CIPHER, recoveryKey, nonce);
  cipher.setAAD(recoveryAdditionalAuthenticatedData(keyId));
  const ciphertext = Buffer.concat([
    cipher.update(masterKey),
    cipher.final(),
  ]);
  return CredentialRecoveryEnvelope.parse({
    schemaVersion: CREDENTIAL_RECOVERY_SCHEMA_VERSION,
    kdf: "scrypt",
    kdfN: CREDENTIAL_RECOVERY_KDF_N,
    kdfR: CREDENTIAL_RECOVERY_KDF_R,
    kdfP: CREDENTIAL_RECOVERY_KDF_P,
    cipher: CREDENTIAL_VAULT_CIPHER,
    keyId,
    salt: salt.toString("base64url"),
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

export function openCredentialRecovery(
  value: unknown,
  passphrase: string,
): Buffer {
  let envelope: CredentialRecoveryEnvelope;
  envelope = parseCredentialRecoveryEnvelope(value);
  try {
    const salt = decodeCanonicalBase64Url(envelope.salt);
    const nonce = decodeCanonicalBase64Url(envelope.nonce);
    const ciphertext = decodeCanonicalBase64Url(envelope.ciphertext);
    const tag = decodeCanonicalBase64Url(envelope.tag);
    if (
      salt.byteLength !== 16 ||
      nonce.byteLength !== 12 ||
      ciphertext.byteLength !== 32 ||
      tag.byteLength !== 16
    ) {
      throw new Error("invalid recovery parameters");
    }
    const recoveryKey = deriveRecoveryKey(passphrase, salt);
    const decipher = createDecipheriv(
      CREDENTIAL_VAULT_CIPHER,
      recoveryKey,
      nonce,
    );
    decipher.setAAD(recoveryAdditionalAuthenticatedData(envelope.keyId));
    decipher.setAuthTag(tag);
    const masterKey = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (
      masterKey.byteLength !== 32 ||
      credentialVaultKeyId(masterKey) !== envelope.keyId
    ) {
      throw new Error("recovered key identifier mismatch");
    }
    return masterKey;
  } catch (error) {
    if (
      error instanceof CredentialVaultError &&
      error.code === "invalid_input"
    ) {
      throw error;
    }
    throw new CredentialVaultError(
      "invalid_vault",
      "credential recovery authentication failed",
    );
  }
}

export function sealCredentialVault(
  value: VaultPlaintext,
  masterKeyValue: Uint8Array,
  nonceValue: Uint8Array = randomBytes(12),
): VaultEnvelope {
  const masterKey = validatedMasterKey(masterKeyValue);
  const plaintext = VaultPlaintext.parse(value);
  const nonce = Buffer.from(nonceValue);
  if (nonce.byteLength !== 12) {
    throw new CredentialVaultError(
      "invalid_input",
      "credential vault nonce must contain exactly 12 bytes",
    );
  }
  const keyId = credentialVaultKeyId(masterKey);
  const cipher = createCipheriv(CREDENTIAL_VAULT_CIPHER, masterKey, nonce);
  cipher.setAAD(additionalAuthenticatedData(keyId));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plaintext), "utf8")),
    cipher.final(),
  ]);
  return VaultEnvelope.parse({
    schemaVersion: CREDENTIAL_VAULT_SCHEMA_VERSION,
    cipher: CREDENTIAL_VAULT_CIPHER,
    keyId,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

export function openCredentialVault(
  value: unknown,
  masterKeyValue: Uint8Array,
): VaultPlaintext {
  let envelope: VaultEnvelope;
  try {
    envelope = VaultEnvelope.parse(value);
  } catch {
    throw new CredentialVaultError(
      "invalid_vault",
      "credential vault envelope is invalid",
    );
  }
  const masterKey = validatedMasterKey(masterKeyValue);
  const keyId = credentialVaultKeyId(masterKey);
  if (envelope.keyId !== keyId) {
    throw new CredentialVaultError(
      "invalid_key",
      "credential vault master key does not match",
    );
  }
  try {
    const nonce = decodeCanonicalBase64Url(envelope.nonce);
    const ciphertext = decodeCanonicalBase64Url(envelope.ciphertext);
    const tag = decodeCanonicalBase64Url(envelope.tag);
    if (nonce.byteLength !== 12 || tag.byteLength !== 16) {
      throw new Error("invalid AES-GCM parameters");
    }
    const decipher = createDecipheriv(
      CREDENTIAL_VAULT_CIPHER,
      masterKey,
      nonce,
    );
    decipher.setAAD(additionalAuthenticatedData(keyId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return VaultPlaintext.parse(JSON.parse(plaintext.toString("utf8")));
  } catch {
    throw new CredentialVaultError(
      "invalid_vault",
      "credential vault authentication or plaintext validation failed",
    );
  }
}

function ensureAbsoluteNonRootPath(path: string, label: string): void {
  if (!isAbsolute(path) || path === "/") {
    throw new CredentialVaultError(
      "invalid_input",
      `${label} must be an absolute non-root path`,
    );
  }
}

function ensurePrivateDirectory(path: string): void {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  const expectedUid = process.getuid?.();
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (stats.mode & 0o200) === 0 ||
    (expectedUid !== undefined && stats.uid !== expectedUid)
  ) {
    throw new CredentialVaultError(
      "invalid_vault",
      "credential vault directory must be private, writable, non-symlinked and owned by this user",
    );
  }
  if (!existed) chmodSync(path, 0o700);
}

function readBoundedPrivateFile(path: string, label: string): Buffer {
  const stats = lstatSync(path);
  const expectedUid = process.getuid?.();
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (stats.mode & 0o777) !== 0o600 ||
    (expectedUid !== undefined && stats.uid !== expectedUid)
  ) {
    throw new CredentialVaultError(
      "invalid_vault",
      `${label} must be a mode 0600 regular file owned by this user`,
    );
  }
  if (stats.size < 1 || stats.size > MAX_CREDENTIAL_VAULT_BYTES) {
    throw new CredentialVaultError(
      "invalid_vault",
      `${label} size is outside the allowed range`,
    );
  }
  return readFileSync(path);
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Some filesystems reject directory fsync. The file itself is always
    // fsynced before rename; this best-effort step preserves portability.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

interface VaultLock {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

function parseLock(path: string): VaultLock {
  const stats = lstatSync(path);
  const expectedUid = process.getuid?.();
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    (stats.mode & 0o077) !== 0 ||
    stats.size < 1 ||
    stats.size > 4_096 ||
    (expectedUid !== undefined && stats.uid !== expectedUid)
  ) {
    throw new CredentialVaultError(
      "locked",
      "credential vault lock is not a private file owned by this user",
    );
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<VaultLock>;
    if (
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) < 1 ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{32}$/.test(value.token) ||
      typeof value.createdAt !== "string"
    ) {
      throw new Error("invalid lock");
    }
    return value as VaultLock;
  } catch {
    throw new CredentialVaultError(
      "locked",
      "credential vault lock is invalid and requires operator inspection",
    );
  }
}

function acquireLock(path: string): {
  readonly release: () => void;
} {
  const value: VaultLock = {
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  const create = (): void => {
    const descriptor = openSync(path, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  };
  try {
    create();
  } catch (error) {
    if (
      error === null ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
    const current = parseLock(path);
    if (processIsAlive(current.pid)) {
      throw new CredentialVaultError(
        "locked",
        `credential vault is locked by active process ${current.pid}`,
      );
    }
    renameSync(
      path,
      `${path}.stale-${Date.now()}-${current.pid}-${current.token}`,
    );
    create();
  }
  return {
    release: () => {
      try {
        const current = parseLock(path);
        if (current.token === value.token && current.pid === value.pid) {
          unlinkSync(path);
        }
      } catch {
        // Never remove a lock that was replaced or altered while held.
      }
    },
  };
}

export interface EncryptedCredentialVaultOptions {
  readonly now?: () => Date;
  readonly nonce?: () => Uint8Array;
}

export class EncryptedCredentialVault {
  private masterKey: Buffer;
  private readonly now: () => Date;
  private readonly nonce: () => Uint8Array;

  constructor(
    readonly path: string,
    masterKey: Uint8Array,
    options: EncryptedCredentialVaultOptions = {},
  ) {
    ensureAbsoluteNonRootPath(path, "credential vault path");
    this.masterKey = validatedMasterKey(masterKey);
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? (() => randomBytes(12));
  }

  get keyId(): string {
    return credentialVaultKeyId(this.masterKey);
  }

  initialize(): { readonly created: boolean; readonly snapshot: CredentialVaultSnapshot } {
    ensurePrivateDirectory(dirname(this.path));
    const lock = acquireLock(`${this.path}.lock`);
    try {
      if (existsSync(this.path)) {
        return { created: false, snapshot: this.snapshotFrom(this.read()) };
      }
      const empty: VaultPlaintext = {
        schemaVersion: CREDENTIAL_VAULT_SCHEMA_VERSION,
        generation: 0,
        entries: [],
      };
      this.write(empty, true);
      return { created: true, snapshot: this.snapshotFrom(empty) };
    } finally {
      lock.release();
    }
  }

  snapshot(): CredentialVaultSnapshot {
    return this.snapshotFrom(this.read());
  }

  environmentFor(service: VaultService): Record<string, string> {
    VaultService.parse(service);
    const plaintext = this.read();
    return Object.fromEntries(
      plaintext.entries
        .filter((entry) => vaultSecretService(entry.name) === service)
        .map((entry) => [entry.name, entry.value]),
    );
  }

  set(nameValue: string, secretValue: string): CredentialVaultSnapshot {
    return this.setMany({ [nameValue]: secretValue });
  }

  setMany(values: Readonly<Record<string, string>>): CredentialVaultSnapshot {
    const parsed = Object.entries(values).map(([name, value]) =>
      VaultEntry.pick({ name: true, value: true }).parse({ name, value })
    );
    if (parsed.length < 1) {
      throw new CredentialVaultError(
        "invalid_input",
        "at least one credential is required",
      );
    }
    ensurePrivateDirectory(dirname(this.path));
    const lock = acquireLock(`${this.path}.lock`);
    try {
      const current = this.read();
      const now = this.now().toISOString();
      const entries = new Map(current.entries.map((entry) => [entry.name, entry]));
      for (const value of parsed) {
        const previous = entries.get(value.name);
        entries.set(value.name, {
          ...value,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
        });
      }
      const next = VaultPlaintext.parse({
        schemaVersion: CREDENTIAL_VAULT_SCHEMA_VERSION,
        generation: current.generation + 1,
        entries: [...entries.values()].sort((left, right) =>
          left.name.localeCompare(right.name)
        ),
      });
      this.write(next, false);
      return this.snapshotFrom(next);
    } finally {
      lock.release();
    }
  }

  /**
   * Replace one existing credential only if its encrypted current value still
   * matches the caller's snapshot. This prevents an activation rollback from
   * clobbering a newer concurrent operator rotation.
   */
  compareAndSwap(
    nameValue: string,
    expectedValue: string,
    nextValue: string,
  ): CredentialVaultSnapshot {
    const expected = VaultEntry.pick({ name: true, value: true }).parse({
      name: nameValue,
      value: expectedValue,
    });
    const next = VaultEntry.pick({ name: true, value: true }).parse({
      name: nameValue,
      value: nextValue,
    });
    ensurePrivateDirectory(dirname(this.path));
    const lock = acquireLock(`${this.path}.lock`);
    try {
      const current = this.read();
      const entries = new Map(current.entries.map((entry) => [entry.name, entry]));
      const previous = entries.get(expected.name);
      if (!previous || previous.value !== expected.value) {
        throw new CredentialVaultError(
          "conflict",
          `credential ${expected.name} changed concurrently`,
        );
      }
      if (previous.value === next.value) {
        return this.snapshotFrom(current);
      }
      entries.set(next.name, {
        ...previous,
        value: next.value,
        updatedAt: this.now().toISOString(),
      });
      const rotated = VaultPlaintext.parse({
        schemaVersion: CREDENTIAL_VAULT_SCHEMA_VERSION,
        generation: current.generation + 1,
        entries: [...entries.values()].sort((left, right) =>
          left.name.localeCompare(right.name)
        ),
      });
      this.write(rotated, false);
      return this.snapshotFrom(rotated);
    } finally {
      lock.release();
    }
  }

  remove(nameValue: string): CredentialVaultSnapshot {
    const name = VaultSecretName.parse(nameValue);
    ensurePrivateDirectory(dirname(this.path));
    const lock = acquireLock(`${this.path}.lock`);
    try {
      const current = this.read();
      const entries = current.entries.filter((entry) => entry.name !== name);
      if (entries.length === current.entries.length) {
        return this.snapshotFrom(current);
      }
      const next = VaultPlaintext.parse({
        schemaVersion: CREDENTIAL_VAULT_SCHEMA_VERSION,
        generation: current.generation + 1,
        entries,
      });
      this.write(next, false);
      return this.snapshotFrom(next);
    } finally {
      lock.release();
    }
  }

  rotateMasterKey(nextMasterKeyValue: Uint8Array): CredentialVaultSnapshot {
    const nextMasterKey = validatedMasterKey(nextMasterKeyValue);
    if (credentialVaultKeyId(nextMasterKey) === this.keyId) {
      return this.snapshot();
    }
    ensurePrivateDirectory(dirname(this.path));
    const lock = acquireLock(`${this.path}.lock`);
    try {
      const current = this.read();
      const next = VaultPlaintext.parse({
        ...current,
        generation: current.generation + 1,
      });
      this.write(next, false, nextMasterKey);
      this.masterKey = nextMasterKey;
      return this.snapshotFrom(next, nextMasterKey);
    } finally {
      lock.release();
    }
  }

  private read(): VaultPlaintext {
    if (!existsSync(this.path)) {
      throw new CredentialVaultError(
        "not_initialized",
        "credential vault is not initialized",
      );
    }
    const raw = readBoundedPrivateFile(this.path, "credential vault");
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new CredentialVaultError(
        "invalid_vault",
        "credential vault is not valid JSON",
      );
    }
    return openCredentialVault(envelope, this.masterKey);
  }

  private write(
    plaintext: VaultPlaintext,
    exclusive: boolean,
    masterKey: Uint8Array = this.masterKey,
  ): void {
    const parent = dirname(this.path);
    ensurePrivateDirectory(parent);
    if (!exclusive && existsSync(this.path)) {
      const stats = lstatSync(this.path);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new CredentialVaultError(
          "invalid_vault",
          "refusing to replace a non-regular credential vault path",
        );
      }
    }
    const envelope = sealCredentialVault(
      plaintext,
      masterKey,
      this.nonce(),
    );
    const bytes = Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    if (bytes.byteLength > MAX_CREDENTIAL_VAULT_BYTES) {
      throw new CredentialVaultError(
        "invalid_vault",
        "credential vault exceeds its size limit",
      );
    }
    if (exclusive) {
      const descriptor = openSync(this.path, "wx", 0o600);
      try {
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      chmodSync(this.path, 0o600);
      fsyncDirectory(parent);
      return;
    }
    const tempPath = `${this.path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    const descriptor = openSync(tempPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, this.path);
    fsyncDirectory(parent);
  }

  private snapshotFrom(
    plaintext: VaultPlaintext,
    masterKey: Uint8Array = this.masterKey,
  ): CredentialVaultSnapshot {
    return {
      schemaVersion: CREDENTIAL_VAULT_SCHEMA_VERSION,
      generation: plaintext.generation,
      keyId: credentialVaultKeyId(masterKey),
      entries: plaintext.entries.map((entry) => ({
        name: entry.name,
        service: vaultSecretService(entry.name),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      })),
    };
  }
}

export {
  FileCredentialVaultKeyStore,
  MacOSCredentialVaultKeyStore,
  loadOrCreateCredentialVaultKey,
  type CredentialVaultKeyStore,
  type KeychainRunner,
} from "./key-store.js";
export {
  readCredentialRecoveryFile,
  writeCredentialRecoveryFileAtomic,
} from "./recovery-file.js";
