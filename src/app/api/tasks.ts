import { apiClient } from "./client";

export type TaskItem = {
  id: string;
  node_id: string;
  service_type: string;
  model: string;
  status: "pending" | "success" | "error" | string;
  result_url: string;
  error_msg: string;
  duration_ms: number;
  created_at: string;
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
