import type {
  BrainClarificationProposal,
  ClarificationAnswerValue,
  ClarificationQuestion,
} from "@avityos/contracts";

const SECRET_PATTERNS =
  /\b(api[_-]?key|secret|password|passwd|token|credential|private[_-]?key|ssh[_-]?key|bearer)\b/i;
const COMMAND_PATTERNS =
  /\b(curl|wget|rm\s+-rf|sudo|eval|exec|bash\s+-c|powershell|Invoke-Expression)\b/i;
const OUT_OF_SCOPE =
  /\b(outside the (repo|repository)|absolute path|\/etc\/|\/var\/|C:\\\\|credentials? store)\b/i;

/**
 * Robust secret detection for FREE-TEXT ANSWERS. Unlike the question gate,
 * merely mentioning the word "token" or "password" is not a secret — an answer
 * like "use token-based auth" must be accepted. A real leaked secret looks like
 * a value, so we flag: a labelled assignment with a non-trivial value, a PEM
 * private-key block, a Bearer credential, or a recognizable provider key
 * shape. This keeps false positives low while still refusing pasted secrets.
 */
const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|secret|password|passwd|token|credential|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*\S{6,}/i;
const SECRET_VALUE_SHAPES: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._\-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub token
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
];

export function looksLikeSecret(text: string): boolean {
  if (SECRET_ASSIGNMENT.test(text)) return true;
  return SECRET_VALUE_SHAPES.some((pattern) => pattern.test(text));
}

export interface ClarificationPolicyIssue {
  path: string;
  message: string;
}

/**
 * Deterministic gate on model-proposed clarifications. The model may not ask
 * for secrets, out-of-repo paths, arbitrary shell commands, or information
 * already present in the objective / prior answers.
 */
export function validateClarificationProposal(
  proposal: BrainClarificationProposal,
  context: {
    objectiveText: string;
    acceptanceCriteria: string[];
    priorAnswerKeys: ReadonlySet<string>;
    priorAnswerBodies: readonly string[];
    maxQuestions: number;
  },
): ClarificationPolicyIssue[] {
  const issues: ClarificationPolicyIssue[] = [];
  if (!proposal.needsClarification) return issues;
  if (proposal.questions.length > context.maxQuestions) {
    issues.push({
      path: "questions",
      message: `at most ${context.maxQuestions} questions are allowed per round`,
    });
  }

  const knownAnswers = context.priorAnswerBodies.map((line) => line.toLowerCase());

  for (const [index, question] of proposal.questions.entries()) {
    const base = `questions.${index}`;
    if (context.priorAnswerKeys.has(question.key)) {
      issues.push({
        path: `${base}.key`,
        message: `question key ${question.key} was already answered`,
      });
    }
    const blob = `${question.question}\n${question.reason}`.toLowerCase();
    if (SECRET_PATTERNS.test(blob)) {
      issues.push({
        path: `${base}.question`,
        message: "questions must not request secrets, API keys, passwords or tokens",
      });
    }
    if (COMMAND_PATTERNS.test(blob)) {
      issues.push({
        path: `${base}.question`,
        message: "questions must not ask the user to execute arbitrary commands",
      });
    }
    if (OUT_OF_SCOPE.test(blob) || (question.answerType === "path_scope" && /(?:^|[\s"])\.\.\//.test(blob))) {
      issues.push({
        path: `${base}.question`,
        message: "questions must not request out-of-repository paths or actions",
      });
    }
    // A question is redundant when a prior answer body already contains its topic key.
    if (knownAnswers.some((answer) => answer.startsWith(`${question.key.toLowerCase()} →`))) {
      issues.push({
        path: `${base}.question`,
        message: "question restates information already present in the objective or prior answers",
      });
    }
  }
  return issues;
}

export function serializeAnswerValue(value: ClarificationAnswerValue): string {
  switch (value.type) {
    case "text":
      return value.value;
    case "boolean":
      return value.value ? "true" : "false";
    case "single_choice":
      return value.value;
    case "multi_choice":
      return value.value.join(",");
    case "number":
    case "budget":
      return String(value.value);
    case "path_scope":
      return value.value.join("\n");
  }
}

export function validateAnswerForQuestion(
  question: ClarificationQuestion,
  value: ClarificationAnswerValue,
): ClarificationPolicyIssue[] {
  const issues: ClarificationPolicyIssue[] = [];
  if (value.type !== question.answerType) {
    issues.push({
      path: "value.type",
      message: `expected ${question.answerType}, got ${value.type}`,
    });
    return issues;
  }
  const optionKeys = new Set(question.options.map((option) => option.key));
  if (value.type === "single_choice" && !optionKeys.has(value.value)) {
    issues.push({ path: "value", message: `choice ${value.value} is not an allowed option` });
  }
  if (value.type === "multi_choice") {
    const seen = new Set<string>();
    for (const key of value.value) {
      if (!optionKeys.has(key)) {
        issues.push({ path: "value", message: `choice ${key} is not an allowed option` });
      }
      if (seen.has(key)) {
        issues.push({ path: "value", message: `choice ${key} is duplicated` });
      }
      seen.add(key);
    }
  }
  if (value.type === "path_scope") {
    for (const path of value.value) {
      const reason = repositoryScopeViolation(path);
      if (reason) issues.push({ path: "value", message: `path ${path}: ${reason}` });
    }
  }
  if (value.type === "text" && looksLikeSecret(value.value)) {
    issues.push({
      path: "value",
      message: "answers must not contain secrets, API keys, passwords or tokens",
    });
  }
  return issues;
}

/**
 * Reject anything that is not a repository-relative path. Covers POSIX
 * absolute paths, Windows drive-letter and UNC paths, backslash separators,
 * `..` traversal (raw or percent-encoded), URL-encoded separators and NUL.
 * Returns a reason string when the path is rejected, or null when it is safe.
 */
export function repositoryScopeViolation(rawPath: string): string | null {
  const path = rawPath.trim();
  if (path.length === 0) return "empty path";
  if (path.includes("\0")) return "contains a NUL byte";
  if (path.includes("\\")) return "uses a Windows/UNC path separator";
  if (/^[A-Za-z]:/.test(path)) return "is a Windows drive-absolute path";
  if (path.startsWith("/")) return "is an absolute path";
  if (path.startsWith("~")) return "references a home directory";
  // Decode percent-encoding once so encoded traversals cannot slip through.
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return "contains invalid percent-encoding";
  }
  if (decoded.includes("\\") || decoded.startsWith("/") || /^[A-Za-z]:/.test(decoded)) {
    return "resolves to an absolute or Windows path once decoded";
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "..")) return "traverses outside the repository";
  return null;
}

/** Normalize legacy free-text answers into typed values when possible. */
export function coerceLegacyAnswer(
  question: ClarificationQuestion,
  answer: string,
): ClarificationAnswerValue | null {
  const trimmed = answer.trim();
  if (!trimmed) return null;
  switch (question.answerType) {
    case "text":
      return { type: "text", value: trimmed };
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (["true", "yes", "y", "1", "oui"].includes(lower)) return { type: "boolean", value: true };
      if (["false", "no", "n", "0", "non"].includes(lower)) return { type: "boolean", value: false };
      return null;
    }
    case "single_choice": {
      const byKey = question.options.find((option) => option.key === trimmed);
      if (byKey) return { type: "single_choice", value: byKey.key };
      const byLabel = question.options.find(
        (option) => option.label.toLowerCase() === trimmed.toLowerCase(),
      );
      return byLabel ? { type: "single_choice", value: byLabel.key } : null;
    }
    case "multi_choice": {
      const parts = trimmed.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean);
      const keys: string[] = [];
      for (const part of parts) {
        const byKey = question.options.find((option) => option.key === part);
        const byLabel = question.options.find(
          (option) => option.label.toLowerCase() === part.toLowerCase(),
        );
        const key = byKey?.key ?? byLabel?.key;
        if (!key) return null;
        keys.push(key);
      }
      return keys.length > 0 ? { type: "multi_choice", value: keys } : null;
    }
    case "number": {
      const n = Number(trimmed);
      return Number.isFinite(n) ? { type: "number", value: n } : null;
    }
    case "budget": {
      const n = Number(trimmed.replace(/^\$/, ""));
      return Number.isFinite(n) && n >= 0 ? { type: "budget", value: n } : null;
    }
    case "path_scope": {
      const paths = trimmed.split(/\n|;/).map((part) => part.trim()).filter(Boolean);
      return paths.length > 0 ? { type: "path_scope", value: paths } : null;
    }
  }
}
