/* @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from '../HomePage';
import { HomeBanners } from './HomeBanners';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), logout: vi.fn(), refresh: vi.fn(), listTemplates: vi.fn(), useTemplate: vi.fn(), ledger: vi.fn(), announcements: vi.fn(), create: vi.fn(), addNode: vi.fn(), save: vi.fn(), switchProject: vi.fn(), refreshProjects: vi.fn(), setProfileOpen: vi.fn(), toggleLanguage: vi.fn(), toggleTheme: vi.fn() }));
const projects = [
  { id: 'p1', name: '星际远航', is_collaborative: false, updated_at: '2026-09-14', created_at: '2026-09-14' },
  { id: 'p2', name: '云上之境', is_collaborative: true, updated_at: '2026-09-12', created_at: '2026-09-12' },
];
const state = { language: 'zh', theme: 'dark', backendProjects: projects, refreshBackendProjects: mocks.refreshProjects, setProfileOpen: mocks.setProfileOpen, toggleLanguage: mocks.toggleLanguage, toggleTheme: mocks.toggleTheme, createBackendProject: mocks.create, addNode: mocks.addNode, saveCanvasToBackend: mocks.save, switchBackendProject: mocks.switchProject, canvasHydrated: true, canvasSaveStatus: 'saved', activeBackendProjectId: 'p1' };
vi.mock('../../store', () => ({ useStore: Object.assign((select: (s: typeof state) => unknown) => select(state), { getState: () => state }) }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'user-123', email: 'creator@example.test', name: '测试创作者', role: 'admin' }, creditSummary: { current_balance: 321, daily_quota: 500, consumed_today: 179 }, logout: mocks.logout, refreshCredits: mocks.refresh }) }));
vi.mock('../../api/projects', () => ({ listTemplates: mocks.listTemplates, useTemplate: mocks.useTemplate }));
vi.mock('../../api/credits', () => ({ listMyCreditLedger: mocks.ledger }));
vi.mock('../../api/announcements', () => ({ listAnnouncements: mocks.announcements }));
vi.mock('react-router', async () => ({ ...await vi.importActual('react-router'), useNavigate: () => mocks.navigate }));
vi.mock('../CanvasLibrary', () => ({ CanvasLibrary: () => <div data-testid="canvas-library">画布列表</div> }));
vi.mock('../ProfileSettingsModal', () => ({ ProfileSettingsModal: () => null }));
vi.mock('../MediaThumb', () => ({ MediaThumb: ({ src, alt, className }: { src: string; alt: string; className: string }) => <img src={src} alt={alt} className={className} /> }));

describe('home and account contracts', () => {
  let root: Root;
  let host: HTMLDivElement;
  const button = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)!;
  const click = async (name: string) => { const target = button(name); expect(target, name).toBeTruthy(); await act(async () => target.click()); };
  const fill = async (label: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
  };
  const renderHome = async () => { await act(async () => root.render(<MemoryRouter><HomePage /></MemoryRouter>)); };
  beforeEach(() => {
    vi.clearAllMocks(); window.localStorage.clear();
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    mocks.listTemplates.mockResolvedValue([]); mocks.ledger.mockResolvedValue([]); mocks.announcements.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ id: 'new-project' }); mocks.save.mockResolvedValue(undefined); mocks.refreshProjects.mockResolvedValue(undefined); mocks.switchProject.mockResolvedValue(undefined);
    mocks.useTemplate.mockResolvedValue({ id: 'template-copy' }); mocks.logout.mockResolvedValue(undefined);
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('renders real account data and supports persistent sidebar collapse', async () => {
    await renderHome(); expect(host.textContent).toContain('测试创作者'); expect(host.textContent).toContain('321');
    await click('收起侧边栏'); expect(host.querySelector('.home-page')?.classList.contains('is-collapsed')).toBe(true);
    expect(window.localStorage.getItem('ccy-home-sidebar-collapsed')).toBe('true');
    await click('展开侧边栏'); expect(host.querySelector('.home-page')?.classList.contains('is-collapsed')).toBe(false);
  });
  it('filters recent canvases by collaboration and by search', async () => {
    await renderHome(); expect(host.querySelectorAll('.home-recent-card')).toHaveLength(2);
    await click('协作'); expect(host.querySelectorAll('.home-recent-card')).toHaveLength(1); expect(host.querySelector('.home-recent-card')?.textContent).toContain('云上之境');
    await fill('搜索最近画布', '不存在'); expect(host.querySelectorAll('.home-recent-card')).toHaveLength(0); expect(host.textContent).toContain('没有匹配的画布');
  });
  it('opens the canvas view without losing the shared navigation', async () => {
    await renderHome(); await click('无限画布'); expect(host.querySelector('[data-testid="canvas-library"]')).toBeTruthy(); expect(host.querySelector('#home-sidebar')).toBeTruthy();
    await click('首页'); expect(host.querySelector('.home-hero')).toBeTruthy();
  });
  it('prefills prompt chips and saves a submitted idea as a text node without generation', async () => {
    await renderHome(); await click('角色设定'); expect(host.querySelector<HTMLInputElement>('[aria-label="你的创意"]')?.value).toContain('角色设定');
    await fill('你的创意', '一位旅人来到云上的城市'); await click('用这个创意创建画布');
    expect(mocks.create).toHaveBeenCalledWith('一位旅人来到云上的城市');
    expect(mocks.addNode).toHaveBeenCalledWith(expect.objectContaining({ type: 'textNode', data: expect.objectContaining({ content: '一位旅人来到云上的城市' }) }));
    expect(mocks.save).toHaveBeenCalledWith({ force: true }); expect(mocks.navigate).toHaveBeenCalledWith('/app');
  });
  it('keeps the idea and stays on home when project creation fails', async () => {
    mocks.create.mockResolvedValue(null); await renderHome(); await fill('你的创意', '不要丢失这段创意'); await click('用这个创意创建画布');
    expect(mocks.addNode).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled(); expect(host.querySelector<HTMLInputElement>('[aria-label="你的创意"]')?.value).toBe('不要丢失这段创意');
    expect(button('用这个创意创建画布').disabled).toBe(false);
  });
  it('keeps real template copy behavior and reports empty filtered results', async () => {
    mocks.listTemplates.mockResolvedValue([{ id: 't1', name: '测试公开模板', cover_url: '' }]); await renderHome();
    await click('精选模板'); expect(host.querySelectorAll('[data-testid="template-card"]')).toHaveLength(1);
    await click('使用模板：测试公开模板'); expect(mocks.useTemplate).toHaveBeenCalledWith('t1'); expect(mocks.switchProject).toHaveBeenCalledWith('template-copy');
    await fill('搜索作品与模板', '不存在'); expect(host.textContent).toContain('没有找到匹配的作品');
  });
  it('opens inspiration in a preview, without creating a project', async () => {
    await renderHome(); await click('预览：想象，不止于此'); expect(document.querySelector('[role="dialog"]')).toBeTruthy(); expect(mocks.create).not.toHaveBeenCalled();
    await click('关闭预览'); expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('opens account as an accessible modal with real balance, Escape close and no fake subscription', async () => {
    await renderHome(); await click('我的账户'); const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('creator@example.test'); expect(dialog.textContent).toContain('321'); expect(dialog.textContent).toContain('500'); expect(dialog.textContent).toContain('179');
    expect(button('升级会员').disabled).toBe(true); expect(dialog.textContent).not.toContain('FREE');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('loads the credit ledger and supports retry after a service error', async () => {
    mocks.ledger.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([{ id: 'e1', type: 'refund', amount: 7, balance_after: 321, reason: '退款', created_at: '2026-09-14' }]);
    await renderHome(); await click('我的账户'); await click('积分账单'); expect(document.querySelector('[role="alert"]')?.textContent).toContain('账单加载失败');
    await click('重试'); expect(mocks.ledger).toHaveBeenLastCalledWith(30, 0); expect(document.querySelector('tbody')?.textContent).toContain('+7'); expect(button('上一页').disabled).toBe(true);
  });
  it('loads real announcements and opens profile editing without losing the existing editor', async () => {
    mocks.announcements.mockResolvedValue([{ id: 'a1', title: '新公告', content: '真实公告内容', created_at: '2026-09-14' }]);
    await renderHome(); await click('我的账户'); await click('站内消息'); expect(document.querySelector('[role="dialog"]')?.textContent).toContain('真实公告内容');
    await click('个人信息'); await click('编辑个人资料'); expect(mocks.setProfileOpen).toHaveBeenCalledWith(true); expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('supports navigating from my works and creating a canvas directly', async () => {
    await renderHome(); await click('我的账户'); await click('我的作品'); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(host.querySelector('[data-testid="canvas-library"]')).toBeTruthy();
    await click('新建画布'); expect(host.querySelector('[data-testid="creation-mode-dialog"]')).toBeNull(); expect(mocks.create).toHaveBeenCalledOnce(); expect(mocks.navigate).toHaveBeenCalledWith('/app');
  });
  it('supports account sign-out without changing auth behavior', async () => {
    await renderHome(); await click('我的账户'); await click('退出账号');
    expect(mocks.logout).not.toHaveBeenCalled(); expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
    await click('取消'); expect(mocks.logout).not.toHaveBeenCalled(); expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await click('退出账号'); await click('确定登出'); expect(mocks.logout).toHaveBeenCalledOnce(); expect(mocks.navigate).toHaveBeenCalledWith('/login');
  });
  it('replaces legacy studio entries with the try-on library', async () => {
    await renderHome(); await click('工作室');
    expect(button('模特试衣库')).toBeTruthy();
    expect(host.textContent).not.toContain('全自动');
    expect(host.textContent).not.toContain('图片 / 视频画布');
  });
  it('opens legacy automation projects in the regular canvas without deleting their data', async () => {
    localStorage.setItem('ccy-automation-workflow:p1', '{"script":"保留内容"}');
    await renderHome(); await click('打开画布：星际远航');
    expect(mocks.navigate).toHaveBeenCalledWith('/app');
    expect(localStorage.getItem('ccy-automation-workflow:p1')).toContain('保留内容');
  });
  it('rotates banners and supports pausing and manual switching', async () => {
    vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    await act(async () => root.render(<HomeBanners zh onCreate={vi.fn()} onGallery={vi.fn()} />));
    expect(button('切换到推荐 2').getAttribute('aria-pressed')).toBe('true');
    await act(async () => vi.advanceTimersByTime(7000)); expect(button('切换到推荐 3').getAttribute('aria-pressed')).toBe('true');
    await click('暂停推荐轮播'); await act(async () => vi.advanceTimersByTime(21000)); expect(button('切换到推荐 3').getAttribute('aria-pressed')).toBe('true');
    await click('下一条推荐'); expect(button('切换到推荐 1').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps reduced-motion banners static while allowing manual selection', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<HomeBanners zh onCreate={vi.fn()} onGallery={vi.fn()} />));
    await act(async () => vi.advanceTimersByTime(21000));
    expect(button('切换到推荐 2').getAttribute('aria-pressed')).toBe('true');
    expect(button('暂停推荐轮播').disabled).toBe(true);
    await click('下一条推荐'); expect(button('切换到推荐 3').getAttribute('aria-pressed')).toBe('true');
  });
});
