import { apiClient } from "./client";

// ─── 画布评论批注(Comments)────────────────────────────────────────────
// 锚定到画布节点的线程式评论,支持回复与「解决」。协作审阅闭环。

export type Comment = {
  id: string;
  node_id: string;
  author_id: string;
  author_name: string;
  parent_id: string;
  body: string;
  resolved: boolean;
  created_at: string;
};

/** 某项目全部评论(时间正序)。 */
export function listComments(projectId: string): Promise<Comment[]> {
  return apiClient.get<Comment[]>(`/api/app/projects/${projectId}/comments`);
}

/** 新增评论或回复(parent_id 非空即回复;node_id 空为项目级)。 */
export function createComment(
  projectId: string,
  payload: { node_id: string; body: string; parent_id?: string },
): Promise<Comment> {
  return apiClient.post<Comment>(`/api/app/projects/${projectId}/comments`, {
    node_id: payload.node_id,
    body: payload.body,
    parent_id: payload.parent_id ?? "",
  });
}

/** 切换「已解决」。 */
export function resolveComment(commentId: string, resolved: boolean): Promise<void> {
  return apiClient.patch(`/api/app/comments/${commentId}/resolve`, { resolved });
}

/** 删除评论(作者或项目所有者)。 */
export function deleteComment(commentId: string): Promise<void> {
  return apiClient.delete(`/api/app/comments/${commentId}`);
}
