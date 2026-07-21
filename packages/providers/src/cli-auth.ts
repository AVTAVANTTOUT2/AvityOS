import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SandboxCredentialFile } from "@avityos/policy";

/**
 * Explicit per-CLI sandbox auth policy.
 *
 * Each provider declares only the environment variables and credential files
 * it is allowed to receive inside the throwaway HOME. Nothing else from the
 * host HOME (SSH keys, Git config, other providers' credentials) is exposed.
 */
export interface CliProviderSandboxPolicy {
  providerId: "codex" | "claude-code" | "cursor" | "command";
  /** Env var *names* this provider may receive (values taken from the control-plane env). */
  allowedEnvironment: readonly string[];
  /**
   * Credential paths relative to the real user HOME that may be staged
   * read-only into the throwaway HOME (same relative path).
   */
  allowedCredentialFiles: readonly string[];
  allowNetwork: boolean;
  /**
   * When true, a run fails closed with category `auth` if neither an allowlisted
   * env var nor a readable allowlisted credential file is present.
   */
  requireAuth: boolean;
}

export interface ResolvedCliAuth {
  policy: CliProviderSandboxPolicy;
  /** Exact env vars to forward (subset of allowedEnvironment that are present). */
  env: Record<string, string>;
  /** Minimal credential files to stage into the throwaway HOME. */
  credentialFiles: SandboxCredentialFile[];
  /** True when at least one supported auth material was resolved. */
  authenticated: boolean;
  /** Human-readable reason when not authenticated. */
  reason?: string;
}

/** Codex CLI (`codex exec`): API key for non-interactive runs, or `~/.codex/auth.json`. */
export const CODEX_SANDBOX_POLICY: CliProviderSandboxPolicy = {
  providerId: "codex",
  allowedEnvironment: ["CODEX_API_KEY"],
  allowedCredentialFiles: [".codex/auth.json"],
  allowNetwork: true,
  requireAuth: true,
};

/**
 * Claude Code (`claude -p`): `ANTHROPIC_API_KEY` for deterministic sandboxed auth.
 * Linux may also use `~/.claude/.credentials.json`. macOS Keychain / claude.ai
 * subscription login is intentionally NOT claimed as sandbox-portable.
 */
export const CLAUDE_CODE_SANDBOX_POLICY: CliProviderSandboxPolicy = {
  providerId: "claude-code",
  allowedEnvironment: ["ANTHROPIC_API_KEY"],
  allowedCredentialFiles: [".claude/.credentials.json"],
  allowNetwork: true,
  requireAuth: true,
};

/**
 * Cursor Agent (`cursor-agent` / `agent`): `CURSOR_API_KEY` only.
 * Interactive `login` stores tokens in the macOS Keychain / IDE state, which is
 * not mounted into the throwaway HOME.
 */
export const CURSOR_SANDBOX_POLICY: CliProviderSandboxPolicy = {
  providerId: "cursor",
  allowedEnvironment: ["CURSOR_API_KEY"],
  allowedCredentialFiles: [],
  allowNetwork: true,
  requireAuth: true,
};

/**
 * Generic command adapter: only names listed in `AVITY_COMMAND_ENV_ALLOWLIST`
 * are forwarded. No credential files are staged unless the operator lists env
 * vars that already hold secrets.
 */
export const COMMAND_SANDBOX_POLICY: CliProviderSandboxPolicy = {
  providerId: "command",
  allowedEnvironment: [], // filled dynamically from AVITY_COMMAND_ENV_ALLOWLIST
  allowedCredentialFiles: [],
  allowNetwork: false,
  requireAuth: false,
};

export const CLI_PROVIDER_SANDBOX_POLICIES = {
  codex: CODEX_SANDBOX_POLICY,
  "claude-code": CLAUDE_CODE_SANDBOX_POLICY,
  cursor: CURSOR_SANDBOX_POLICY,
  command: COMMAND_SANDBOX_POLICY,
} as const;

function isReadableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Resolve auth material for a CLI provider against an explicit policy.
 *
 * Prefer allowlisted environment variables over credential files. Never copies
 * the real HOME. Never includes another provider's secrets.
 */
export function resolveCliProviderAuth(
  policy: CliProviderSandboxPolicy,
  env: NodeJS.ProcessEnv,
  options: { realHome?: string; allowedEnvironmentNames?: readonly string[] } = {},
): ResolvedCliAuth {
  const realHome = options.realHome ?? homedir();
  const allowedNames = options.allowedEnvironmentNames ?? policy.allowedEnvironment;

  const forwarded: Record<string, string> = {};
  for (const name of allowedNames) {
    const value = env[name];
    if (value !== undefined && value.length > 0) {
      forwarded[name] = value;
    }
  }

  const credentialFiles: SandboxCredentialFile[] = [];
  // Prefer env auth: only stage files when no allowlisted env secret is present.
  if (Object.keys(forwarded).length === 0) {
    for (const relative of policy.allowedCredentialFiles) {
      const sourcePath = join(realHome, relative);
      if (!existsSync(sourcePath)) continue;
      if (!isReadableFile(sourcePath)) {
        return {
          policy,
          env: {},
          credentialFiles: [],
          authenticated: false,
          reason: `${policy.providerId} credential file is unreadable: ${relative}`,
        };
      }
      credentialFiles.push({
        sourcePath,
        homeRelativePath: relative,
        readonly: true,
      });
      // Stage only the first matching minimal credential file.
      break;
    }
  }

  const authenticated = Object.keys(forwarded).length > 0 || credentialFiles.length > 0;
  if (!authenticated && policy.requireAuth) {
    const envHint = allowedNames.length ? allowedNames.join(", ") : "(none)";
    const fileHint = policy.allowedCredentialFiles.length
      ? policy.allowedCredentialFiles.join(", ")
      : "(none)";
    return {
      policy,
      env: forwarded,
      credentialFiles,
      authenticated: false,
      reason:
        `${policy.providerId} is not authenticated for sandboxed execution: ` +
        `set one of [${envHint}] or provide a readable credential file [${fileHint}]. ` +
        `The real HOME is never used as a fallback.`,
    };
  }

  return { policy, env: forwarded, credentialFiles, authenticated };
}

/**
 * Build the generic `command` provider policy from operator allowlists.
 */
export function resolveCommandProviderAuth(env: NodeJS.ProcessEnv): ResolvedCliAuth {
  const names = (env.AVITY_COMMAND_ENV_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const policy: CliProviderSandboxPolicy = {
    ...COMMAND_SANDBOX_POLICY,
    allowedEnvironment: names,
    allowNetwork: env.AVITY_COMMAND_ALLOW_NETWORK === "1",
  };
  return resolveCliProviderAuth(policy, env, { allowedEnvironmentNames: names });
}
