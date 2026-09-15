/* @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminShell } from './AdminShell';
import { AdminAnnouncementsPage } from './AdminAnnouncementsPage';
import { ADMIN_COLLAPSED_KEY, ADMIN_GROUPS_KEY, adminNavGroups, adminOverview, getAdminNavGroup, readAdminGroups } from './admin-navigation';

const api = vi.hoisted(() => ({
  count: vi.fn(), alerts: vi.fn(), mark: vi.fn(), markAll: vi.fn(),
  announcements: vi.fn(), create: vi.fn(), remove: vi.fn(),
}));
vi.mock('./useAdminWorkbenchMotion', () => ({ useAdminWorkbenchMotion: () => undefined }));
vi.mock('../../api/admin', () => ({
  getUnreadAlertCount: api.count, listAdminAlerts: api.alerts,
  markAdminAlertRead: api.mark, markAllAdminAlertsRead: api.markAll,
}));
vi.mock('../../api/announcements', () => ({
  listAdminAnnouncements: api.announcements, createAnnouncement: api.create, deleteAnnouncement: api.remove,
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.count.mockResolvedValue({ count: 0 });
  api.alerts.mockResolvedValue([]);
  api.announcements.mockResolvedValue([{ id: 'a1', title: '现有公告', content: '原有正文', created_at: '2026-09-14T00:00:00Z', creator_name: 'Admin' }]);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function render(path = '/admin/announcements', element?: React.ReactNode) {
  await act(async () => root.render(<MemoryRouter initialEntries={[path]}>{element ?? <AdminShell title="测试页面" description="保留页面说明" action={<button onClick={api.create}>页面操作</button>}><p>原有页面内容</p></AdminShell>}</MemoryRouter>));
}
function button(name: string, scope: ParentNode = container) {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.getAttribute('aria-label') === name || el.textContent?.trim() === name);
  if (!result) throw new Error(`Missing button: ${name}`);
  return result;
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
function sidebarLink(path: string) { return container.querySelector<HTMLAnchorElement>(`.admin-navigation a[href="${path}"]`)!; }
async function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('后台分级导航', () => {
  it('保留全部 13 个原有路由且每个只出现一次', () => {
    const routes = [adminOverview, ...adminNavGroups.flatMap((group) => group.items)].map((item) => item.to);
    expect(routes).toHaveLength(13);
    expect(new Set(routes).size).toBe(13);
    expect(routes.sort()).toEqual(['/admin', '/admin/overview', '/admin/members', '/admin/credits', '/admin/invitations', '/admin/announcements', '/admin/agents', '/admin/prompts', '/admin/skills', '/admin/memory', '/admin/agent-runs', '/admin/prompt-templates', '/admin/logs'].sort());
  });
  it('准确匹配所属分组，不把所有后台页都归为模型服务', () => {
    expect(getAdminNavGroup('/admin')?.id).toBe('models');
    expect(getAdminNavGroup('/admin/announcements/')?.id).toBe('operations');
    expect(getAdminNavGroup('/admin/agents')?.id).toBe('agents');
    expect(getAdminNavGroup('/admin/logs')?.id).toBe('monitoring');
    expect(getAdminNavGroup('/admin/unknown')).toBeUndefined();
  });
  it('损坏的偏好不会阻止导航，非法值使用默认设置', () => {
    localStorage.setItem(ADMIN_GROUPS_KEY, 'broken-json');
    expect(readAdminGroups('agents').agents).toBe(true);
    localStorage.setItem(ADMIN_GROUPS_KEY, '{"operations":"false","models":false}');
    expect(readAdminGroups()).toMatchObject({ operations: true, models: false });
  });
  it('深链接自动展开所属分组，只高亮当前页面', async () => {
    localStorage.setItem(ADMIN_GROUPS_KEY, '{"agents":false}');
    await render('/admin/agents');
    expect(button('Agent 管理').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.admin-navigation [aria-current="page"]')).toHaveLength(1);
    expect(sidebarLink('/admin/agents').getAttribute('aria-current')).toBe('page');
    expect(sidebarLink('/admin').getAttribute('aria-current')).toBeNull();
  });
  it('分组可以独立收起和展开，并记住设置', async () => {
    await render();
    await click(button('平台运营'));
    expect(container.querySelector<HTMLElement>('#admin-group-operations')!.hidden).toBe(true);
    expect(JSON.parse(localStorage.getItem(ADMIN_GROUPS_KEY)!).operations).toBe(false);
    await click(button('Agent 管理'));
    expect(button('Agent 管理').getAttribute('aria-expanded')).toBe('true');
    expect(button('平台运营').getAttribute('aria-expanded')).toBe('false');
  });
  it('页面切换更新当前项并自动展开新分组', async () => {
    await render();
    await click(button('运行监控'));
    await click(sidebarLink('/admin/logs'));
    expect(sidebarLink('/admin/logs').getAttribute('aria-current')).toBe('page');
    expect(button('运行监控').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.admin-breadcrumb')!.textContent).toContain('运行监控');
    expect(api.create).not.toHaveBeenCalled();
  });
  it('整栏收起状态持久化，点击图标分组可以直接展开', async () => {
    await render();
    await click(button('收起后台侧边栏'));
    expect(localStorage.getItem(ADMIN_COLLAPSED_KEY)).toBe('true');
    expect(container.querySelector('.admin-workbench')!.getAttribute('data-collapsed')).toBe('true');
    await click(button('Agent 管理'));
    expect(localStorage.getItem(ADMIN_COLLAPSED_KEY)).toBe('false');
    expect(button('Agent 管理').getAttribute('aria-expanded')).toBe('true');
  });
  it('重新进入后台恢复桌面收起状态', async () => {
    localStorage.setItem(ADMIN_COLLAPSED_KEY, 'true');
    await render();
    expect(button('展开后台侧边栏').getAttribute('aria-expanded')).toBe('false');
  });
  it('手机默认图标栏，展开时遮住内容并支持 Escape 关闭', async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    await render();
    await click(button('展开后台侧边栏'));
    expect(container.querySelector('main')!.hasAttribute('inert')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    await act(async () => button('收起后台侧边栏').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('main')!.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('');
    expect(localStorage.getItem(ADMIN_COLLAPSED_KEY)).toBeNull();
  });
  it('手机选择子菜单后关闭遮罩，不改变桌面偏好', async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    localStorage.setItem(ADMIN_COLLAPSED_KEY, 'false');
    await render();
    await click(button('平台运营'));
    await click(sidebarLink('/admin/members'));
    expect(container.querySelector('.admin-nav-backdrop')).toBeNull();
    expect(localStorage.getItem(ADMIN_COLLAPSED_KEY)).toBe('false');
  });
});

describe('后台外框和公告窗口', () => {
  it('保留页面内容、说明、操作和返回入口', async () => {
    await render();
    expect(container.textContent).toContain('原有页面内容');
    expect(container.textContent).toContain('保留页面说明');
    expect(container.querySelector('.admin-return-home')!.getAttribute('href')).toBe('/home');
    expect(container.querySelector('.admin-back-workspace')!.getAttribute('href')).toBe('/app');
    await click(button('页面操作'));
    expect(api.create).toHaveBeenCalledOnce();
  });
  it('显示真实未读告警数量，打开窗口不会自动标记已读', async () => {
    api.count.mockResolvedValue({ count: 3 });
    await render();
    await click(button('渠道告警，3 条未读'));
    expect(container.querySelector('[role="dialog"]')!.textContent).toContain('渠道告警');
    expect(api.markAll).not.toHaveBeenCalled();
    expect(api.mark).not.toHaveBeenCalled();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.activeElement).toBe(button('渠道告警，3 条未读'));
  });
  it('公告显示原有数据和条数，打开并关闭发布窗口不产生写入', async () => {
    await render('/admin/announcements', <AdminAnnouncementsPage />);
    expect(container.textContent).toContain('现有公告');
    expect(container.textContent).toContain('共 1 条');
    await click(button('发布公告'));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await click(button('关闭发布公告'));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });
  it('空公告校验仍生效且不调用发布接口', async () => {
    await render('/admin/announcements', <AdminAnnouncementsPage />);
    await click(button('发布公告'));
    await click(button('发布公告', container.querySelector('[role="dialog"]')!));
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('标题和内容不能为空');
    expect(api.create).not.toHaveBeenCalled();
  });
  it('发布失败时保留输入并展示错误，取消恢复触发按钮焦点', async () => {
    api.create.mockRejectedValueOnce(new Error('服务暂时不可用，请稍后重试'));
    await render('/admin/announcements', <AdminAnnouncementsPage />);
    await click(button('发布公告'));
    await setValue(container.querySelector('#admin-announcement-title')!, '新公告');
    await setValue(container.querySelector('#admin-announcement-content')!, '公告内容');
    await click(button('发布公告', container.querySelector('[role="dialog"]')!));
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('服务暂时不可用');
    expect(container.querySelector<HTMLInputElement>('#admin-announcement-title')!.value).toBe('新公告');
    await click(button('取消'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.activeElement).toBe(button('发布公告'));
  });
});
