/** Typed client for the AvityOS control-plane API. */

export const API_BASE =
  (import.meta as { env?: Record<string, string> }).env?.VITE_AVITY_API ?? "http://127.0.0.1:7717";

export class ApiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    ...(body !== undefined
      ? { headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }
      : { headers }),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiRequestError(res.status, detail?.error?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface ApiProject {
  id: string;
  workspaceId: string;
  name: string;
  status: string;
  autonomyProfile: string;
  description: string;
  repoPath: string | null;
  repoRemoteUrl: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  clarificationId?: string | null;
}

export interface ApiObjective {
  id: string;
  revision: number;
  text: string;
  acceptanceCriteria: string[];
}

export interface ApiBudget {
  limitUsd: number;
  spentUsd: number;
  warnAtFraction: number;
}

export interface ApiProjectConfiguration {
  project: ApiProject;
  objective: ApiObjective | null;
  budget: ApiBudget | null;
}

export interface ProjectOnboardingInput {
  name: string;
  description?: string;
  repoPath: string | null;
  repoRemoteUrl: string | null;
  defaultBranch: string;
  objective: string;
  acceptanceCriteria: string[];
  autonomyProfile: string;
  budgetUsd: number | null;
  budgetWarnAtFraction?: number;
}

export interface ApiMission {
  id: string;
  projectId: string;
  title: string;
  role: string;
  state: string;
  priority: number;
  branchName: string | null;
  createdAt: string;
  updatedAt: string;
  contract: { objective: string; acceptanceCriteria: string[] };
}

export interface ApiRun {
  id: string;
  projectId: string;
  missionId: string;
  model: string | null;
  state: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: string;
}

export interface ApiApproval {
  id: string;
  projectId: string;
  missionId: string | null;
  status: string;
  title: string;
  description: string;
}

export interface ApiClarificationQuestion {
  id: string;
  logicalKey: string;
  category: string;
  question: string;
  reason: string;
  answerType: string;
  options: { key: string; label: string }[];
  required: boolean;
  displayOrder: number;
  status: string;
  answer: string | null;
  answerValue: unknown;
}

export interface ApiClarification {
  id: string;
  projectId: string;
  objectiveId: string;
  status: string;
  schemaVersion: number;
  round: number;
  provenance: string;
  providerId: string | null;
  model: string | null;
  questions: ApiClarificationQuestion[];
}

export interface ApiProjectPauseState {
  projectId: string;
  status: "active" | "pausing" | "paused" | "resuming";
  reason: string | null;
  actor: string | null;
  previousStatus: string | null;
  generation: number;
  pausedAt: string | null;
  resumedAt: string | null;
  cancellingRunIds: string[];
}

export interface ApiEvent {
  seq: number;
  type: string;
  projectId: string | null;
  missionId: string | null;
  runId: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface ApiProvider {
  name: string;
  healthy: boolean;
  models: string[];
  default: boolean;
}

export interface ApiPr {
  id: string;
  projectId: string;
  number: number | null;
  branch: string;
  title: string;
  state: string;
  url: string | null;
}

export interface ApiBrainRun {
  id: string;
  step: string;
  state: string;
  attempt: number;
  providerId: string | null;
  model: string | null;
  provenance: string;
  errorCategory: string | null;
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiBrainState {
  projectId: string;
  objectiveId: string | null;
  status: string;
  currentStep: string | null;
  runs: ApiBrainRun[];
  analysis: {
    summary: string;
    objectiveClarity: string;
    feasibility: string;
    risks: { title: string; severity: string; detail: string }[];
  } | null;
  architecture: { overview: string } | null;
  plan: {
    id: string;
    version: number;
    summary: string;
    provenance: string | null;
    providerId: string | null;
    model: string | null;
    snapshotHash: string | null;
    replanTrigger: string | null;
    replanCause: string | null;
  } | null;
  dependencies: { missionId: string; dependsOnMissionId: string }[];
  replanCount: number;
  lastReplan: { trigger: string; cause: string; sources: string[]; planVersion: number } | null;
}

export interface ApiTerminal {
  id: string;
  projectId: string;
  command: string[];
  state: string;
  exitCode: number | null;
}

export const api = {
  health: () => request<{ status: string; version: string }>("GET", "/v1/health"),
  projects: () => request<{ items: ApiProject[] }>("GET", "/v1/projects"),
  projectConfiguration: (projectId: string) =>
    request<ApiProjectConfiguration>("GET", `/v1/projects/${projectId}/configuration`),
  usage: (projectId: string) =>
    request<{ inputTokens: number; outputTokens: number; costUsd: number; budget: { limitUsd: number; spentUsd: number } | null }>(
      "GET",
      `/v1/projects/${projectId}/usage`,
    ),
  missions: (projectId: string) => request<{ items: ApiMission[] }>("GET", `/v1/projects/${projectId}/missions`),
  runs: () => request<{ items: ApiRun[] }>("GET", "/v1/runs"),
  approvals: () => request<{ items: ApiApproval[] }>("GET", "/v1/approvals?status=open"),
  clarifications: (projectId: string, status = "open") =>
    request<{ items: ApiClarification[] }>(
      "GET",
      `/v1/projects/${projectId}/clarifications${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  clarification: (id: string) => request<ApiClarification>("GET", `/v1/clarifications/${id}`),
  events: (afterSeq = 0) => request<{ items: ApiEvent[] }>("GET", `/v1/events?afterSeq=${afterSeq}`),
  providers: () => request<{ items: ApiProvider[] }>("GET", "/v1/providers"),
  brainState: (projectId: string) => request<ApiBrainState>("GET", `/v1/projects/${projectId}/brain/state`),
  pauseState: (projectId: string) => request<ApiProjectPauseState>("GET", `/v1/projects/${projectId}/pause`),
  prs: () => request<{ items: ApiPr[] }>("GET", "/v1/prs"),
  terminals: () => request<{ items: ApiTerminal[] }>("GET", "/v1/terminals"),
  terminalDetail: (id: string) =>
    request<ApiTerminal & { logs: { seq: number; text: string }[] }>("GET", `/v1/terminals/${id}`),
  login: (token: string) => request<{ ok: boolean }>("POST", "/v1/session", undefined, { authorization: `Bearer ${token}` }),
  logout: () => request<{ ok: boolean }>("DELETE", "/v1/session"),

  createProject: (input: ProjectOnboardingInput) =>
    request<ApiProject>("POST", "/v1/projects", input),
  updateProject: (projectId: string, input: ProjectOnboardingInput) =>
    request<ApiProjectConfiguration>("PATCH", `/v1/projects/${projectId}`, input),
  submitObjective: (projectId: string, text: string, acceptanceCriteria: string[] = []) =>
    request<{ objective: { id: string }; clarificationId: string | null }>(
      "POST",
      `/v1/projects/${projectId}/objectives`,
      { text, acceptanceCriteria },
    ),
  answerClarification: (
    id: string,
    answers: { questionId: string; answer?: string; value?: unknown }[],
    idempotencyKey?: string,
  ) => request("POST", `/v1/clarifications/${id}/answers`, { answers, idempotencyKey }),
  pauseProject: (projectId: string, reason = "", idempotencyKey?: string) =>
    request<ApiProjectPauseState>("POST", `/v1/projects/${projectId}/pause`, { reason, idempotencyKey }),
  resumeProject: (projectId: string, idempotencyKey?: string) =>
    request<ApiProjectPauseState>("POST", `/v1/projects/${projectId}/resume`, { idempotencyKey }),
  resolveApproval: (id: string, decision: "approved" | "rejected", note = "") =>
    request("POST", `/v1/approvals/${id}/resolve`, { decision, note }),
  transitionMission: (id: string, to: string, reason = "") =>
    request("POST", `/v1/missions/${id}/transition`, { to, reason }),
  cancelTerminal: (id: string) => request<ApiTerminal>("POST", `/v1/terminals/${id}/cancel`, {}),
};

export function eventStream(onEvent: (ev: ApiEvent) => void, afterSeq = 0): () => void {
  const source = new EventSource(`${API_BASE}/v1/events/stream?afterSeq=${afterSeq}`, { withCredentials: true });
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data as string) as ApiEvent);
    } catch {
      // malformed frame: ignore
    }
  };
  return () => source.close();
}
