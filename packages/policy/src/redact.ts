/**
 * Secret redaction applied before any text is persisted, displayed or
 * shipped to a provider. Patterns cover common credential shapes; redaction
 * is conservative (prefers false positives over leaks).
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI/Anthropic-style API keys
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?<=(?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"']{6,}/gi,
];

export const REDACTED = "[REDACTED]";

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(text);
  });
}
