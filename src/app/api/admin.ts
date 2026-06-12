import { apiClient } from "./client";

// ─── Users ──────────────────────────────────────────────────────────────────

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  status: "active" | "disabled";
  last_login_at: string | null;
  created_at: string;
  daily_quota: number;
  current_balance: number;
};

export function listUsers(): Promise<AdminUser[]> {
  return apiClient.get<AdminUser[]>("/api/admin/users");
}

export function updateUserRole(id: string, role: "admin" | "member"): Promise<AdminUser> {
  return apiClient.patch<AdminUser>(`/api/admin/users/${id}/role`, { role });
}

export function updateUserStatus(id: string, status: "active" | "disabled"): Promise<AdminUser> {
  return apiClient.patch<AdminUser>(`/api/admin/users/${id}/status`, { status });
}

export function deleteUser(id: string): Promise<void> {
  return apiClient.delete(`/api/admin/users/${id}`);
}

export function resetUserPassword(id: string, password: string): Promise<{ user_id: string }> {
  return apiClient.post<{ user_id: string }>(`/api/admin/users/${id}/password`, { password });
}

export type AdjustCreditsPayload = {
  add_balance?: number;
  set_quota?: number;
  reason?: string;
};

export type CreditResult = {
  user_id: string;
  daily_quota: number;
  current_balance: number;
};

export function adjustCredits(id: string, payload: AdjustCreditsPayload): Promise<CreditResult> {
  return apiClient.post<CreditResult>(`/api/admin/users/${id}/credits`, payload);
}

// ─── Invitations ────────────────────────────────────────────────────────────

export type AdminInvitation = {
  id: string;
  role: string;
  initial_daily_quota: number;
  max_uses: number;
  used_count: number;
  expires_at: string;
  created_by: string;
  creator_name: string;
  note: string;
  created_at: string;
  revoked_at: string | null;
  status: "active" | "used" | "expired" | "revoked";
};

export function listInvitations(): Promise<AdminInvitation[]> {
  return apiClient.get<AdminInvitation[]>("/api/admin/invitations");
}

export function revokeInvitation(id: string): Promise<AdminInvitation> {
  return apiClient.post<AdminInvitation>(`/api/admin/invitations/${id}/revoke`);
}

export type CreateInvitationPayload = {
  role: "admin" | "member";
  initial_daily_quota: number;
  max_uses: number;
  expires_at: string; // ISO 8601
  note?: string;
};

export type CreateInvitationResult = {
  invitation: {
    id: string;
    code: string;
    role: string;
    initial_daily_quota: number;
    max_uses: number;
    expires_at: string;
  };
};

export function createInvitation(payload: CreateInvitationPayload): Promise<CreateInvitationResult> {
  return apiClient.post<CreateInvitationResult>("/api/admin/invitations", payload);
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export type AdminStats = {
  total_users: number;
  admin_users: number;
  active_users: number;
  total_providers: number;
  enabled_providers: number;
  generations_today: number;
  success_today: number;
  errors_today: number;
  credits_consumed_today: number;
};

export function getAdminStats(): Promise<AdminStats> {
  return apiClient.get<AdminStats>("/api/admin/stats");
}

export type AdminAlert = {
  id: string;
  provider_config_id?: string;
  generation_log_id?: string;
  provider_name?: string;
  service_type: string;
  model: string;
  error_code: string;
  error_message: string;
  source: string;
  severity: "low" | "medium" | "high";
  status: "unread" | "read" | "resolved";
  created_at: string;
  last_seen_at: string;
};

export function getUnreadAlertCount(): Promise<{ count: number }> {
  return apiClient.get<{ count: number }>("/api/admin/alerts/unread-count");
}

export function listAdminAlerts(status = "", limit = 20): Promise<AdminAlert[]> {
  const params = new URLSearchParams({ limit: String(limit), offset: "0" });
  if (status) params.set("status", status);
  return apiClient.get<AdminAlert[]>(`/api/admin/alerts?${params.toString()}`);
}

export function markAdminAlertRead(id: string): Promise<{ ok: boolean }> {
  return apiClient.post<{ ok: boolean }>(`/api/admin/alerts/${id}/read`);
}

export function markAllAdminAlertsRead(): Promise<{ ok: boolean }> {
  return apiClient.post<{ ok: boolean }>("/api/admin/alerts/read-all");
}

// ─── Logs ───────────────────────────────────────────────────────────────────

export type GenerationLog = {
  id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  node_id: string;
  service_type: string;
  model: string;
  prompt: string;
  status: "pending" | "success" | "error";
  result_url: string;
  error_msg: string;
  duration_ms: number;
  created_at: string;
};

export type LogsResponse = {
  data: GenerationLog[];
  total: number;
};

export type AdminLogFilters = {
  status?: "" | "pending" | "success" | "error";
  user?: string;
  model?: string;
};

function resolveAdminUrl(input: string) {
  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");
  if (/^https?:\/\//.test(input) || !apiBaseUrl) {
    return input;
  }
  return `${apiBaseUrl}${input.startsWith("/") ? input : `/${input}`}`;
}

export async function listLogs(limit = 50, offset = 0, filters: AdminLogFilters = {}): Promise<LogsResponse> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });

  if (filters.status) {
    params.set("status", filters.status);
  }
  if (filters.user?.trim()) {
    params.set("user", filters.user.trim());
  }
  if (filters.model?.trim()) {
    params.set("model", filters.model.trim());
  }

  const response = await fetch(resolveAdminUrl(`/api/admin/logs?${params.toString()}`), {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  const body = await response.json() as Partial<LogsResponse> & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(body.error?.message ?? "加载任务日志失败");
  }
  return {
    data: Array.isArray(body.data) ? body.data : [],
    total: typeof body.total === "number" ? body.total : Array.isArray(body.data) ? body.data.length : 0,
  };
}
