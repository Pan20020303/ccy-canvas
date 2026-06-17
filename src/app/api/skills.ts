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
  deploy_key?: string;
  parent_deploy_key?: string;
  model_name?: string;
  provider_id?: string;
  temperature?: number;
  max_output_tokens?: number;
  runtime?: string;
  metadata?: Record<string, unknown>;
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
  deploy_key?: string;
  parent_deploy_key?: string;
  model_name?: string;
  provider_id?: string;
  temperature?: number;
  max_output_tokens?: number;
  runtime?: string;
  metadata?: Record<string, unknown>;
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

export type AgentUseMode = 0 | 1;

export function adminGetAgentUseMode(): Promise<{ mode: AgentUseMode }> {
  return apiClient.get<{ mode: AgentUseMode }>("/api/admin/agent-settings/use-mode");
}

export function adminUpdateAgentUseMode(mode: AgentUseMode): Promise<{ mode: AgentUseMode }> {
  return apiClient.put<{ mode: AgentUseMode }>("/api/admin/agent-settings/use-mode", { mode });
}

export type AgentMemorySettings = {
  messagesPerSummary: number;
  shortTermLimit: number;
  summaryMaxLength: number;
  summaryLimit: number;
  ragLimit: number;
  deepRetrieveSummaryLimit: number;
  modelOnnxFile: string;
  modelDtype: string;
};

export function adminGetAgentMemorySettings(): Promise<AgentMemorySettings> {
  return apiClient.get<AgentMemorySettings>("/api/admin/agent-memory-settings");
}

export function adminUpdateAgentMemorySettings(payload: AgentMemorySettings): Promise<AgentMemorySettings> {
  return apiClient.put<AgentMemorySettings>("/api/admin/agent-memory-settings", payload);
}

export type CreatorSuiteSeedReport = {
  total: number;
  created: number;
  existing: number;
  updated: number;
};

export function adminSeedCreatorSuiteAgents(): Promise<CreatorSuiteSeedReport> {
  return apiClient.post<CreatorSuiteSeedReport>("/api/admin/agents/seed-suite", {});
}

// ─── Agent run audit log (admin-only) ───────────────────────────────────────

export type AgentRun = {
  id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  agent_id: string;
  agent_name: string;
  user_input: string;
  final_reply: string;
  tool_calls: number;
  steps: number;
  status: "pending" | "success" | "error" | "cancelled";
  error_msg: string;
  duration_ms: number;
  created_at: string;
};

export function adminListAgentRuns(limit = 100, offset = 0): Promise<AgentRun[]> {
  return apiClient.get<AgentRun[]>(`/api/admin/agent-runs?limit=${limit}&offset=${offset}`);
}

export type AgentConversationHistoryItem = {
  user_input: string;
  final_reply: string;
  created_at: string;
};

export function listAgentConversationHistory(
  agentId: string,
  limit = 12,
  conversationId?: string,
): Promise<AgentConversationHistoryItem[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (conversationId) params.set("conversation_id", conversationId);
  return apiClient.get<AgentConversationHistoryItem[]>(`/api/app/agents/${agentId}/conversation?${params.toString()}`);
}

export function clearAgentConversationHistory(agentId: string): Promise<void> {
  return apiClient.delete(`/api/app/agents/${agentId}/conversation`);
}

// ─── Multi-thread conversation management ───────────────────────────────────

export type AgentConversationSummary = {
  id: string;
  title: string;
  message_count: number;
  last_message_at: string;
  created_at: string;
  updated_at: string;
};

export function listAgentConversations(agentId: string): Promise<AgentConversationSummary[]> {
  return apiClient.get<AgentConversationSummary[]>(`/api/app/agents/${agentId}/conversations`);
}

export function createAgentConversation(agentId: string, title?: string): Promise<AgentConversationSummary> {
  return apiClient.post<AgentConversationSummary>(`/api/app/agents/${agentId}/conversations`, { title: title ?? "" });
}

export function deleteAgentConversation(agentId: string, conversationId: string): Promise<void> {
  return apiClient.delete(`/api/app/agents/${agentId}/conversations/${conversationId}`);
}
