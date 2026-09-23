import { apiClient } from "./client";

// ─── 提示词模板库(Prompt Templates)──────────────────────────────────────
// 文本节点全屏编辑器的「提示词库」弹窗:全站共享模板池,人人可上传/点赞/踩,
// 上传者可删自己的;管理端 /admin 有上传记录页(含邮箱)+ 违规删除。

export type PromptTemplate = {
  id: string;
  title: string;
  content: string;
  owner_name: string;
  owner_email?: string;
  is_mine: boolean;
  upvotes: number;
  downvotes: number;
  /** 当前用户的投票:1 赞 / -1 踩 / 0 未投。 */
  my_vote: number;
  created_at: string;
};

/** 共享模板列表(带票数与我的投票)。 */
export function listPromptTemplates(): Promise<PromptTemplate[]> {
  return apiClient.get<PromptTemplate[]>("/api/app/prompt-templates");
}

/** 上传模板(即刻对所有人可见)。 */
export function createPromptTemplate(payload: { title: string; content: string }): Promise<PromptTemplate> {
  return apiClient.post<PromptTemplate>("/api/app/prompt-templates", payload);
}

/** 删除自己上传的模板。 */
export function deletePromptTemplate(id: string): Promise<void> {
  return apiClient.delete(`/api/app/prompt-templates/${id}`);
}

/** 投票:1 赞 / -1 踩 / 0 取消。 */
export function votePromptTemplate(id: string, vote: 1 | -1 | 0): Promise<void> {
  return apiClient.post(`/api/app/prompt-templates/${id}/vote`, { vote });
}

/** 管理端:全部上传记录(含上传者邮箱)。 */
export function listAdminPromptTemplates(): Promise<PromptTemplate[]> {
  return apiClient.get<PromptTemplate[]>("/api/admin/prompt-templates");
}

/** 管理端:删除任意模板。 */
export function deleteAdminPromptTemplate(id: string): Promise<void> {
  return apiClient.delete(`/api/admin/prompt-templates/${id}`);
}
