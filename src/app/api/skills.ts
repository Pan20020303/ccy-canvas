import { apiClient } from "./client";

// ─── Types ──────────────────────────────────────────────────────────────────

export type SkillScope = "global" | "personal" | "team";
export type SkillKind  = "http" | "prompt" | "code";

export type Skill = {
  id: string;
  scope: SkillScope;
  owner_id?: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  kind: SkillKind;
  spec: Record<string, unknown>;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type SkillUpsert = {
  name: string;
  description?: string;
  category?: string;
  icon?: string;
  kind: SkillKind;
  spec: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  enabled: boolean;
};

export type InvokeResult = {
  type: "text" | "url" | "json";
  content: string;
  raw?: unknown;
  run_id: string;
  duration_ms: number;
};

// ─── User CRUD (sees globals + own personals) ───────────────────────────────

export function listSkills(): Promise<Skill[]> {
  return apiClient.get<Skill[]>("/api/app/skills");
}
export function createSkill(payload: SkillUpsert): Promise<Skill> {
  return apiClient.post<Skill>("/api/app/skills", payload);
}
export function updateSkill(id: string, payload: SkillUpsert): Promise<Skill> {
  return apiClient.put<Skill>(`/api/app/skills/${id}`, payload);
}
export function deleteSkill(id: string): Promise<void> {
  return apiClient.delete(`/api/app/skills/${id}`);
}
export function invokeSkill(id: string, inputs: Record<string, unknown>): Promise<InvokeResult> {
  return apiClient.post<InvokeResult>(`/api/app/skills/${id}/invoke`, { inputs });
}

// ─── Admin CRUD (any scope) ─────────────────────────────────────────────────

export function adminListSkills(): Promise<Skill[]> {
  return apiClient.get<Skill[]>("/api/admin/skills");
}
export function adminCreateSkill(payload: SkillUpsert): Promise<Skill> {
  return apiClient.post<Skill>("/api/admin/skills", payload);
}
export function adminUpdateSkill(id: string, payload: SkillUpsert): Promise<Skill> {
  return apiClient.put<Skill>(`/api/admin/skills/${id}`, payload);
}
export function adminDeleteSkill(id: string): Promise<void> {
  return apiClient.delete(`/api/admin/skills/${id}`);
}

// ─── Agents (Phase 3 will wire run/SSE; CRUD stubs in place now) ────────────

export type AgentScope = SkillScope;

export type Agent = {
  id: string;
  scope: AgentScope;
  owner_id?: string;
  name: string;
  description: string;
  avatar: string;
  system_prompt: string;
  model: string;
  skill_ids: string[];
  canvas_tools: boolean;
  strategy: "reactive" | "scripted";
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type AgentUpsert = {
  name: string;
  description?: string;
  avatar?: string;
  system_prompt: string;
  model: string;
  skill_ids?: string[];
  canvas_tools: boolean;
  strategy?: "reactive" | "scripted";
  enabled: boolean;
};

export function listAgents(): Promise<Agent[]> {
  return apiClient.get<Agent[]>("/api/app/agents");
}
export function createAgent(payload: AgentUpsert): Promise<Agent> {
  return apiClient.post<Agent>("/api/app/agents", payload);
}
export function updateAgent(id: string, payload: AgentUpsert): Promise<Agent> {
  return apiClient.put<Agent>(`/api/app/agents/${id}`, payload);
}
export function deleteAgent(id: string): Promise<void> {
  return apiClient.delete(`/api/app/agents/${id}`);
}

export function adminListAgents(): Promise<Agent[]> {
  return apiClient.get<Agent[]>("/api/admin/agents");
}
export function adminCreateAgent(payload: AgentUpsert): Promise<Agent> {
  return apiClient.post<Agent>("/api/admin/agents", payload);
}
export function adminUpdateAgent(id: string, payload: AgentUpsert): Promise<Agent> {
  return apiClient.put<Agent>(`/api/admin/agents/${id}`, payload);
}
export function adminDeleteAgent(id: string): Promise<void> {
  return apiClient.delete(`/api/admin/agents/${id}`);
}
