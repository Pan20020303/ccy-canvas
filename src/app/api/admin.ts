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

// ─── Logs ───────────────────────────────────────────────────────────────────

export type GenerationLog = {
  id: string;
  user_id: string;
  service_type: string;
  model: string;
  prompt: string;
  status: "success" | "error";
  result_url: string;
  error_msg: string;
  duration_ms: number;
  created_at: string;
};

export type LogsResponse = {
  data: GenerationLog[];
  total: number;
};

export function listLogs(limit = 50, offset = 0): Promise<GenerationLog[]> {
  return apiClient.get<GenerationLog[]>(`/api/admin/logs?limit=${limit}&offset=${offset}`);
}
