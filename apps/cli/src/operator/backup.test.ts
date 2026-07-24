import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EncryptedCredentialVault, FileCredentialVaultKeyStore } from "@avityos/credential-vault";
import { openDatabase, Store } from "@avityos/control-plane";
import { describe, expect, it } from "vitest";
import {
  createOperatorBackup,
  restoreOperatorBackup,
  verifyOperatorBackup,
} from "./backup.js";
import { resolveOperatorPaths } from "./paths.js";
import { exportOperatorVaultRecovery } from "./vault.js";

function privateRoot(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(path, 0o700);
  return path;
}

describe("certified operator backup and restore", () => {
  it("captures live WAL state, verifies integrity/audit/recovery and restores to a fresh root", () => {
    const sourceRoot = privateRoot("avity-backup-source-");
    const repositoryRoot = join(sourceRoot, "repository");
    mkdirSync(repositoryRoot, { mode: 0o700 });
    const paths = resolveOperatorPaths({
      repositoryRoot,
      operatorHome: join(sourceRoot, "operator"),
    });
    mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });

    const keyRoot = privateRoot("avity-backup-key-");
    const keyPath = join(keyRoot, "master.key");
    const recoveryPath = join(keyRoot, "vault.recovery.json");
    const key = new FileCredentialVaultKeyStore(keyPath).create();
    const vault = new EncryptedCredentialVault(paths.credentialVaultPath, key);
    vault.initialize();
    vault.set("OPENAI_API_KEY", "backup-provider-secret");
    const passphrase = "backup recovery passphrase";
    exportOperatorVaultRecovery(paths, recoveryPath, passphrase, {
      keyFile: keyPath,
    });

    const databasePath = join(sourceRoot, "avity.sqlite");
    const db = openDatabase(databasePath);
    chmodSync(databasePath, 0o600);
    const store = new Store(db);
    const project = store.createProject({
      name: "certified backup project",
      description: "live WAL evidence",
      repoPath: null,
      repoRemoteUrl: null,
      autonomyProfile: "autonomous_with_checkpoints",
    });

    const backupParent = privateRoot("avity-backup-bundles-");
    const backupPath = join(backupParent, "checkpoint");
    const created = createOperatorBackup({
      paths,
      databasePath,
      outputPath: backupPath,
      recoveryPath,
      recoveryPassphrase: passphrase,
    });
    expect(created.databaseIntegrity).toBe("ok");
    expect(created.auditChain).toBe("ok");
    expect(created.recoveryKey).toBe("verified");
    expect(created.manifest.database.projectCount).toBe(1);
    expect(created.manifest.database.auditEntries).toBe(1);
    expect(created.manifest.vault.entries).toBe(1);
    expect(lstatSync(backupPath).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(backupPath, "avity.sqlite")).mode & 0o777).toBe(
      0o600,
    );
    const serializedManifest = readFileSync(
      join(backupPath, "backup-manifest.json"),
      "utf8",
    );
    expect(serializedManifest).not.toContain("backup-provider-secret");
    expect(serializedManifest).not.toContain(key.toString("base64url"));

    expect(verifyOperatorBackup({
      paths,
      backupPath,
      recoveryPath,
      recoveryPassphrase: passphrase,
    }).manifest).toEqual(created.manifest);

    const restoreParent = privateRoot("avity-backup-restores-");
    const destinationPath = join(restoreParent, "restored");
    expect(() => restoreOperatorBackup({
      paths,
      backupPath,
      destinationPath,
      recoveryPath,
      recoveryPassphrase: passphrase,
      confirmBundleId: "bkp_00000000000000000000000000000000",
    })).toThrow(/confirm-bundle-id/);
    const restored = restoreOperatorBackup({
      paths,
      backupPath,
      destinationPath,
      recoveryPath,
      recoveryPassphrase: passphrase,
      confirmBundleId: created.manifest.bundleId,
    });
    expect(restored.databaseIntegrity).toBe("ok");
    expect(restored.databasePath).toBe(join(destinationPath, "avity.sqlite"));
    expect(restored.vaultPath).toBe(
      join(destinationPath, "operator", "config", "credentials.vault"),
    );
    const restoredDatabase = new DatabaseSync(restored.databasePath, {
      readOnly: true,
    });
    try {
      expect(
        restoredDatabase.prepare("SELECT name FROM projects WHERE id = ?").get(
          project.id,
        ),
      ).toEqual({ name: "certified backup project" });
    } finally {
      restoredDatabase.close();
    }
    expect(
      new EncryptedCredentialVault(restored.vaultPath, key).environmentFor(
        "control-plane",
      ),
    ).toEqual({ OPENAI_API_KEY: "backup-provider-secret" });

    const descriptor = openSync(join(backupPath, "avity.sqlite"), "r+");
    try {
      writeSync(descriptor, Buffer.from([0xff]), 0, 1, 128);
    } finally {
      closeSync(descriptor);
    }
    expect(() => verifyOperatorBackup({
      paths,
      backupPath,
      recoveryPath,
      recoveryPassphrase: passphrase,
    })).toThrow(/hash\/size/i);
    db.close();
  });
});
