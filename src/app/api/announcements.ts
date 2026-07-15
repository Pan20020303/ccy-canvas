import { apiClient } from "./client";

// ─── 公告(Announcements)─────────────────────────────────────────────────
// 管理端在 /admin/announcements 发布;全体登录用户经右上角铃铛查看。

export type Announcement = {
  id: string;
  title: string;
  content: string;
  creator_name: string;
  created_at: string;
};

/** 全体登录用户可见的公告列表(铃铛弹层用)。 */
export function listAnnouncements(): Promise<Announcement[]> {
  return apiClient.get<Announcement[]>("/api/app/announcements");
}

/** 管理端:公告列表。 */
export function listAdminAnnouncements(): Promise<Announcement[]> {
  return apiClient.get<Announcement[]>("/api/admin/announcements");
}

/** 管理端:发布公告(立即对全体用户可见)。 */
export function createAnnouncement(payload: { title: string; content: string }): Promise<Announcement> {
  return apiClient.post<Announcement>("/api/admin/announcements", payload);
}

/** 管理端:删除公告。 */
export function deleteAnnouncement(id: string): Promise<void> {
  return apiClient.delete(`/api/admin/announcements/${id}`);
}
