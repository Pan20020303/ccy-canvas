import { apiClient } from "./client";
import type { HistoryItem } from "../store";

// Server-side persistence for generation history (previously localStorage-only).
// All calls are user-scoped on the backend. These are best-effort from the
// store's perspective — callers swallow errors so a backend hiccup never blocks
// the local-first UX.

export type HistoryQuery = {
  spaceId?: string;
  projectId?: string;
  type?: string;
};

export async function listHistoryFromServer(query: HistoryQuery = {}): Promise<HistoryItem[]> {
  const qs = new URLSearchParams();
  if (query.spaceId) qs.set("spaceId", query.spaceId);
  if (query.projectId) qs.set("projectId", query.projectId);
  if (query.type) qs.set("type", query.type);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiClient.get<HistoryItem[]>(`/api/app/history${suffix}`);
}

export async function saveHistoryToServer(item: HistoryItem): Promise<void> {
  await apiClient.post<{ ok: boolean }>("/api/app/history", item);
}

export async function deleteHistoryFromServer(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await apiClient.delete<{ ok: boolean }>("/api/app/history", { ids });
}
