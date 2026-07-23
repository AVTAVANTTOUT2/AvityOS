const SECRET_KEY_PATTERN = /(token|secret|password|authorization|cookie|api[_-]?key)/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[a-z0-9_-]{8,}\b/gi,
  /\bghp_[^\s]+\b/gi,
  /\bgithub_pat_[^\s]+\b/gi,
  /\bBearer\s+[a-z0-9._-]{8,}\b/gi,
];
const SECRET_QUERY_PARAMETER_PATTERN =
  /(?:token|key|secret|auth|password|passwd|credential|signature|session)/i;

function sanitizeUrl(input: string): string {
  if (!/^https?:\/\//i.test(input)) return input;
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_PARAMETER_PATTERN.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return input;
  }
}

function redactString(input: string): string {
  let output = sanitizeUrl(input);
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, "[REDACTED]");
  }
  return output;
}

export function redactValue(value: unknown, keyHint?: string): unknown {
  if (keyHint && SECRET_KEY_PATTERN.test(keyHint)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      redactValue(entry, key),
    ]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function redactText(input: string): string {
  return redactString(input);
}
