import { apiClient } from "./client";

// ─── 画布版本历史(Versions)────────────────────────────────────────────
// 手动/关键操作打点的画布快照,协作误操作后可一键回滚。

export type CanvasVersion = {
  id: string;
  label: string;
  author_name: string;
  created_at: string;
};

/** 某项目的版本列表(时间倒序)。 */
export function listVersions(projectId: string): Promise<CanvasVersion[]> {
  return apiClient.get<CanvasVersion[]>(`/api/app/projects/${projectId}/versions`);
}

/** 把当前画布存为一个版本(可带标签)。 */
export function saveVersion(projectId: string, label: string): Promise<{ id: string }> {
  return apiClient.post<{ id: string }>(`/api/app/projects/${projectId}/versions`, { label });
}

/** 恢复到某版本(后端会先自动备份当前画布,故恢复本身可撤销)。 */
export function restoreVersion(versionId: string): Promise<void> {
  return apiClient.post(`/api/app/versions/${versionId}/restore`, {});
}
