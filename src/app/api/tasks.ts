import { apiClient } from "./client";

export type TaskItem = {
  id: string;
  node_id: string;
  service_type: string;
  model: string;
  status: "pending" | "success" | "error" | string;
  result_url: string;
  /** All asset URLs when one generation yields several (wan2.7 组图 / n>1);
   *  result_url === result_urls[0]. Absent for single-asset results. */
  result_urls?: string[];
  error_msg: string;
  duration_ms: number;
  created_at: string;
  /** SSE 事件专有：后端转存失败，result_url 仍是会过期/需鉴权的上游临时 URL，
   *  前端必须无条件二次转存，否则「生成成功但没有返图」。 */
  asset_temporary?: boolean;
};

/** Fetch a single task by its generation_log id (user-scoped server-side). */
export function getTask(id: string): Promise<TaskItem> {
  return apiClient.get<TaskItem>(`/api/app/tasks/${encodeURIComponent(id)}`);
}

/** Bulk: for each given canvas node id, return the most recent task row.
 *  The server caps the batch at 200; pass node ids beyond that across
 *  multiple calls if you have a very large canvas. */
export function batchTasksByNodeIds(nodeIds: string[]): Promise<TaskItem[]> {
  if (nodeIds.length === 0) return Promise.resolve([]);
  return apiClient.post<TaskItem[]>("/api/app/tasks/batch", { node_ids: nodeIds });
}

/** The current user's still-in-flight generations (queued/running/...).
 *  Called on app load to re-hydrate task tracking so a generation survives
 *  a localStorage wipe or a switch to a different browser (F10). */
export function listActiveTasks(): Promise<TaskItem[]> {
  return apiClient.get<TaskItem[]>("/api/app/tasks/active");
}
