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
  name: string;
  status: string;
  autonomyProfile: string;
  description: string;
  createdAt: string;
  updatedAt: string;
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

export interface ApiClarification {
  id: string;
  projectId: string;
  status: string;
  questions: { id: string; question: string; options: string[]; answer: string | null }[];
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
  usage: (projectId: string) =>
    request<{ inputTokens: number; outputTokens: number; costUsd: number; budget: { limitUsd: number; spentUsd: number } | null }>(
      "GET",
      `/v1/projects/${projectId}/usage`,
    ),
  missions: (projectId: string) => request<{ items: ApiMission[] }>("GET", `/v1/projects/${projectId}/missions`),
  runs: () => request<{ items: ApiRun[] }>("GET", "/v1/runs"),
  approvals: () => request<{ items: ApiApproval[] }>("GET", "/v1/approvals?status=open"),
  clarifications: (projectId: string) =>
    request<{ items: ApiClarification[] }>("GET", `/v1/projects/${projectId}/clarifications?status=open`),
  events: (afterSeq = 0) => request<{ items: ApiEvent[] }>("GET", `/v1/events?afterSeq=${afterSeq}`),
  providers: () => request<{ items: ApiProvider[] }>("GET", "/v1/providers"),
  prs: () => request<{ items: ApiPr[] }>("GET", "/v1/prs"),
  terminals: () => request<{ items: ApiTerminal[] }>("GET", "/v1/terminals"),
  terminalDetail: (id: string) =>
    request<ApiTerminal & { logs: { seq: number; text: string }[] }>("GET", `/v1/terminals/${id}`),
  login: (token: string) => request<{ ok: boolean }>("POST", "/v1/session", undefined, { authorization: `Bearer ${token}` }),
  logout: () => request<{ ok: boolean }>("DELETE", "/v1/session"),

  createProject: (input: { name: string; description?: string; autonomyProfile?: string }) =>
    request<ApiProject>("POST", "/v1/projects", input),
  submitObjective: (projectId: string, text: string, acceptanceCriteria: string[] = []) =>
    request<{ objective: { id: string }; clarificationId: string | null }>(
      "POST",
      `/v1/projects/${projectId}/objectives`,
      { text, acceptanceCriteria },
    ),
  answerClarification: (id: string, answers: { questionId: string; answer: string }[]) =>
    request("POST", `/v1/clarifications/${id}/answers`, { answers }),
  resolveApproval: (id: string, decision: "approved" | "rejected", note = "") =>
    request("POST", `/v1/approvals/${id}/resolve`, { decision, note }),
  transitionMission: (id: string, to: string, reason = "") =>
    request("POST", `/v1/missions/${id}/transition`, { to, reason }),
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
