/* @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasLibrary } from '../CanvasLibrary';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ createFolder: vi.fn(), deleteFolder: vi.fn(), deleteProject: vi.fn(), duplicateProject: vi.fn(), listFolders: vi.fn(), listTemplates: vi.fn(), setProjectTemplate: vi.fn(), updateProject: vi.fn(), uploadFile: vi.fn(), refreshProjects: vi.fn(), createProject: vi.fn(), switchProject: vi.fn(), refreshCredits: vi.fn(), navigate: vi.fn() }));
let backendProjects = [{ id: 'p1', name: '星际画布', created_at: '2026-09-14', updated_at: '2026-09-14', is_collaborative: false, folder_id: '' }, { id: 'p2', name: '协作画布', created_at: '2026-09-13', updated_at: '2026-09-13', is_collaborative: true, folder_id: '' }, { id: 'p3', name: '文件夹内画布', created_at: '2026-09-12', updated_at: '2026-09-12', is_collaborative: false, folder_id: 'f1' }];
const store = () => ({ language: 'zh', theme: 'dark', projects: [{ id: 'local', name: '旧本地项目不得混入', createdAt: 1, updatedAt: 1 }], backendProjects, activeProjectId: null, activeBackendProjectId: null, switchProject: api.switchProject, switchBackendProject: api.switchProject, createProject: api.createProject, createBackendProject: api.createProject, loadBackendProjects: api.refreshProjects, refreshBackendProjects: api.refreshProjects });
vi.mock('../../store', () => ({ useStore: (select: (s: ReturnType<typeof store>) => unknown) => select(store()) }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'admin' }, refreshCredits: api.refreshCredits }) }));
vi.mock('../../api/projects', () => api);
vi.mock('react-router', async () => ({ ...await vi.importActual('react-router'), useNavigate: () => api.navigate }));
vi.mock('../reactbits/BorderGlow', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

describe('canvas library preservation', () => {
  let host: HTMLDivElement; let root: Root;
  const button = (name: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(b => b.getAttribute('aria-label') === name || b.textContent?.trim() === name)!;
  const click = async (name: string) => { expect(button(name), name).toBeTruthy(); await act(async () => button(name).click()); };
  const render = async () => { await act(async () => root.render(<MemoryRouter><CanvasLibrary /></MemoryRouter>)); };
  const fill = async (label: string, value: string) => { const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); };
  beforeEach(() => { vi.clearAllMocks(); api.listFolders.mockResolvedValue([{ id: 'f1', name: '作品集', created_at: '2026-09-14' }]); api.listTemplates.mockResolvedValue([]); api.createFolder.mockResolvedValue({ id: 'f2' }); api.createProject.mockResolvedValue({ id: 'created' }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });

  it('uses server projects, supports collaboration/search filters, and opens real folders', async () => {
    await render(); expect(host.textContent).not.toContain('旧本地项目不得混入'); expect(host.querySelectorAll('.group\\/card')).toHaveLength(2);
    await click('协作'); expect(host.querySelectorAll('.group\\/card')).toHaveLength(1); expect(host.textContent).toContain('协作画布');
    await click('全部'); await fill('搜索所有画布', '星际'); expect(host.querySelectorAll('.group\\/card')).toHaveLength(1);
    await fill('搜索所有画布', ''); await click('打开文件夹：作品集'); expect(host.textContent).toContain('文件夹内画布'); expect(host.querySelectorAll('.group\\/card')).toHaveLength(1);
  });
  it('does not fall back to stale local projects when the authenticated account has no projects', async () => {
    const saved = backendProjects; backendProjects = [];
    try { await render(); expect(host.textContent).not.toContain('旧本地项目不得混入'); expect(host.textContent).toContain('暂无画布'); expect(button('新建文件夹')).toBeTruthy(); } finally { backendProjects = saved; }
  });
  it('preserves folder input after errors and submits the correct name', async () => {
    api.createFolder.mockRejectedValueOnce(new Error('offline')); await render(); await click('新建文件夹'); await fill('文件夹名称', '新的作品集'); await click('创建');
    expect(host.querySelector<HTMLInputElement>('[aria-label="文件夹名称"]')?.value).toBe('新的作品集');
    await click('创建'); expect(api.createFolder).toHaveBeenLastCalledWith('新的作品集'); expect(host.querySelector('[aria-label="文件夹名称"]')).toBeNull();
  });
  it('keeps duplication connected to the original API', async () => {
    api.duplicateProject.mockResolvedValue({ id: 'copy' }); await render(); await click('星际画布更多操作'); await click('创建副本'); expect(api.duplicateProject).toHaveBeenCalledWith('p1'); expect(api.refreshProjects).toHaveBeenCalled();
  });
  it('does not navigate or fabricate a local canvas after creation fails', async () => {
    api.createProject.mockResolvedValueOnce(null); await render(); await click('新建无限画布');
    expect(api.createProject).toHaveBeenCalledOnce(); expect(api.navigate).not.toHaveBeenCalled(); expect(host.querySelector('[data-testid="creation-mode-dialog"]')).toBeNull();
  });
});
