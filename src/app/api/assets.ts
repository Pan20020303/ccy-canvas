import { apiClient } from "./client";
import type { SavedAsset, AssetFolder } from "../store";

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

// ─── 素材库文件夹 ────────────────────────────────────────────────────────────

export async function listAssetFoldersFromServer(): Promise<AssetFolder[]> {
  return apiClient.get<AssetFolder[]>("/api/app/asset-folders");
}

/** Create or rename a folder (idempotent by id server-side). */
export async function saveAssetFolderToServer(folder: AssetFolder): Promise<void> {
  await apiClient.post<{ ok: boolean }>("/api/app/asset-folders", folder);
}

export async function deleteAssetFolderFromServer(id: string): Promise<void> {
  await apiClient.delete<{ ok: boolean }>("/api/app/asset-folders", { id });
}

// ─── 协作:按用户名/邮箱查真实用户(邀请用)──────────────────────────────

export type CollabUserLookup = { uid: string; name: string; email: string };

/** 按用户名或邮箱精确解析真实用户(用于协作邀请)。找不到返回空数组。 */
export async function lookupUsers(query: string): Promise<CollabUserLookup[]> {
  const q = query.trim();
  if (!q) return [];
  return apiClient.get<CollabUserLookup[]>(`/api/app/users/lookup?q=${encodeURIComponent(q)}`);
}
