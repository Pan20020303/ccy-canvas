import { Activity, BarChart3, BookKey, BookMarked, Bot, BrainCircuit, Coins, FileText, Layers3, Logs, Megaphone, Monitor, Settings2, Sparkles, UserCog, Users, type LucideIcon } from 'lucide-react';

export type AdminNavItem = { to: string; label: string; icon: LucideIcon };
export type AdminNavGroup = { id: string; label: string; icon: LucideIcon; items: AdminNavItem[] };

export const adminOverview: AdminNavItem = { to: '/admin/overview', label: '概览', icon: BarChart3 };
export const adminNavGroups: AdminNavGroup[] = [
  { id: 'operations', label: '平台运营', icon: Layers3, items: [
    { to: '/admin/members', label: '成员管理', icon: Users },
    { to: '/admin/credits', label: '积分流水', icon: Coins },
    { to: '/admin/invitations', label: '邀请码', icon: BookKey },
    { to: '/admin/announcements', label: '公告管理', icon: Megaphone },
  ] },
  { id: 'models', label: '模型与提示词', icon: Settings2, items: [
    { to: '/admin', label: '模型服务', icon: Monitor },
    { to: '/admin/prompts', label: '提示词管理', icon: FileText },
    { to: '/admin/prompt-templates', label: '提示词模板', icon: BookMarked },
  ] },
  { id: 'agents', label: 'Agent 管理', icon: Bot, items: [
    { to: '/admin/agents', label: 'Agent 配置', icon: UserCog },
    { to: '/admin/skills', label: '技能管理', icon: Sparkles },
    { to: '/admin/memory', label: 'Agent 记忆', icon: BrainCircuit },
  ] },
  { id: 'monitoring', label: '运行监控', icon: Activity, items: [
    { to: '/admin/agent-runs', label: 'Agent 调度台', icon: Bot },
    { to: '/admin/logs', label: '日志', icon: Logs },
  ] },
];

export function getAdminNavGroup(pathname: string) {
  const path = pathname.replace(/\/+$/, '') || '/';
  return adminNavGroups.find((group) => group.items.some((item) => item.to === path));
}

export const ADMIN_COLLAPSED_KEY = 'ccy-admin-sidebar-collapsed';
export const ADMIN_GROUPS_KEY = 'ccy-admin-nav-groups';

export function readAdminCollapsed() {
  try { return localStorage.getItem(ADMIN_COLLAPSED_KEY) === 'true'; } catch { return false; }
}

export function readAdminGroups(activeId?: string): Record<string, boolean> {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ADMIN_GROUPS_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch { /* 存储不可用时仍可正常导航。 */ }
  return Object.fromEntries(adminNavGroups.map(({ id }) => [id, id === activeId || (typeof saved[id] === 'boolean' ? saved[id] : id === 'operations')]));
}
