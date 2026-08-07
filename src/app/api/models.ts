import { apiClient } from "./client";
import { publishRuntimeInvalidation } from "../runtimeInvalidation";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelCapability = "text" | "image" | "video" | "audio";
export type ModelStatus = "draft" | "enabled" | "disabled";

/** Full model definition returned to admin. */
export type AdminModel = {
  id: string;
  provider_id: string;
  external_model_name: string;
  display_name: string;
  capability: ModelCapability;
  status: ModelStatus;
  parameter_schema: Record<string, unknown>;
  default_parameters: Record<string, unknown>;
  pricing_rule: Record<string, unknown>;
  has_pricing: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Trimmed model returned to the user app — no pricing internals. */
export type UserModel = {
  id: string;
  external_model_name: string;
  display_name: string;
  capability: ModelCapability;
  parameter_schema: Record<string, unknown>;
  default_parameters: Record<string, unknown>;
};

/** Demasked relay provider status — API key is never returned in plaintext. */
export type ProviderStatus = {
  has_provider: boolean;
  base_url: string;
  api_key_set: boolean;
  api_key_hint: string;
  status: string;
  last_sync_at: string | null;
};

// ---------------------------------------------------------------------------
// Admin: Relay Provider
// ---------------------------------------------------------------------------

export function getRelayProvider(): Promise<ProviderStatus> {
  return apiClient.get<ProviderStatus>("/api/admin/relay-provider");
}

export async function putRelayProvider(payload: {
  base_url: string;
  api_key?: string;
}): Promise<ProviderStatus> {
  const provider = await apiClient.put<ProviderStatus>("/api/admin/relay-provider", payload);
  publishRuntimeInvalidation(["models"]);
  return provider;
}

export function testRelayProvider(payload?: {
  base_url?: string;
  api_key?: string;
}): Promise<{ ok: boolean }> {
  return apiClient.post<{ ok: boolean }>("/api/admin/relay-provider/test", payload);
}

// ---------------------------------------------------------------------------
// Admin: Models
// ---------------------------------------------------------------------------

export function listAdminModels(): Promise<AdminModel[]> {
  return apiClient.get<AdminModel[]>("/api/admin/models");
}

export async function syncModels(): Promise<{ inserted: number }> {
  const result = await apiClient.post<{ inserted: number }>("/api/admin/models/sync");
  publishRuntimeInvalidation(["models"]);
  return result;
}

export async function patchModel(
  id: string,
  payload: Partial<{
    display_name: string;
    capability: ModelCapability;
    parameter_schema: Record<string, unknown>;
    default_parameters: Record<string, unknown>;
    pricing_rule: Record<string, unknown>;
    sort_order: number;
  }>,
): Promise<AdminModel> {
  const model = await apiClient.patch<AdminModel>(`/api/admin/models/${id}`, payload);
  publishRuntimeInvalidation(["models"]);
  return model;
}

export async function enableModel(id: string): Promise<AdminModel> {
  const model = await apiClient.post<AdminModel>(`/api/admin/models/${id}/enable`);
  publishRuntimeInvalidation(["models"]);
  return model;
}

export async function disableModel(id: string): Promise<AdminModel> {
  const model = await apiClient.post<AdminModel>(`/api/admin/models/${id}/disable`);
  publishRuntimeInvalidation(["models"]);
  return model;
}

// ---------------------------------------------------------------------------
// User App: Models
// ---------------------------------------------------------------------------

export function listUserModels(): Promise<UserModel[]> {
  return apiClient.get<UserModel[]>("/api/app/models");
}
