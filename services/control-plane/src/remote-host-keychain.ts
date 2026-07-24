import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import type {
  RemoteHostSecretConfiguration,
  RemoteHostSecretStore,
} from "./remote-host.js";

const DEFAULT_SERVICE = "com.avityos.remote-host";
const CONFIGURATION_ACCOUNT = "configuration";

type KeychainRunner = (
  args: readonly string[],
  input?: string,
) => string;

function defaultRunner(args: readonly string[], input?: string): string {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  };
  return execFileSync("/usr/bin/security", [...args], options);
}

function isMissingKeychainItem(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 44
  );
}

/**
 * macOS Keychain-backed storage for the account/device private keys and both
 * relay credentials. Public certificates and replay state stay in SQLite.
 */
export class MacOSRemoteHostKeychainStore implements RemoteHostSecretStore {
  constructor(
    private readonly service = DEFAULT_SERVICE,
    private readonly runner: KeychainRunner = defaultRunner,
  ) {}

  load(): RemoteHostSecretConfiguration | null {
    let serialized: string;
    try {
      serialized = this.runner([
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        CONFIGURATION_ACCOUNT,
        "-w",
      ]).trim();
    } catch (error) {
      if (isMissingKeychainItem(error)) return null;
      throw new Error("remote host secrets could not be loaded from Keychain");
    }
    try {
      return JSON.parse(serialized) as RemoteHostSecretConfiguration;
    } catch {
      throw new Error("remote host Keychain configuration is invalid");
    }
  }

  save(configuration: RemoteHostSecretConfiguration): void {
    const serialized = JSON.stringify(configuration);
    try {
      this.runner([
        "add-generic-password",
        "-U",
        "-s",
        this.service,
        "-a",
        CONFIGURATION_ACCOUNT,
        "-w",
      ], `${serialized}\n${serialized}\n`);
    } catch {
      throw new Error("remote host secrets could not be saved to Keychain");
    }
  }
}
