import { apiClient } from "./client";
import type { SavedAsset } from "../store";

// Server-side persistence for the user asset library (素材库 / 我的素材, previously
// localStorage-only). All calls are user-scoped on the backend and best-effort
// from the store's perspective — callers swallow errors so a backend hiccup
// never blocks the local-first UX. Mirrors api/history.ts.

export type AssetQuery = {
  category?: string;
};

export async function listAssetsFromServer(query: AssetQuery = {}): Promise<SavedAsset[]> {
  const qs = new URLSearchParams();
  if (query.category) qs.set("category", query.category);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiClient.get<SavedAsset[]>(`/api/app/assets${suffix}`);
}

export async function saveAssetToServer(asset: SavedAsset): Promise<void> {
  await apiClient.post<{ ok: boolean }>("/api/app/assets", asset);
}

export async function deleteAssetsFromServer(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await apiClient.delete<{ ok: boolean }>("/api/app/assets", { ids });
}
