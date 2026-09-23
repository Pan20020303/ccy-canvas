// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasRecoveryPanel, type CanvasRecoveryPanelProps } from './CanvasRecoveryPanel';
import { SaveStatusIndicator } from './Navbar';

const holder = vi.hoisted(() => ({ state: {} as Record<string, any> }));
vi.mock('../store', () => ({ useStore: Object.assign((selector: (state: any) => any) => selector(holder.state), { getState: () => holder.state }) }));
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({}) }));
vi.mock('./TaskQueue', () => ({ TaskQueue: () => null }));
vi.mock('./CollaborationControls', () => ({ CollaborationControls: () => null }));
vi.mock('./CreditLedgerModal', () => ({ CreditLedgerModal: () => null }));
vi.mock('./UserAvatar', () => ({ UserAvatar: () => null }));

let root: Root;
const recovery = { id: 'r1', projectName: '山海变第一集', savedAt: Date.parse('2026-09-06T06:30:00.000Z') };
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('UI tests must not access the network')));
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  holder.state = {
    canvasSaveStatus: 'idle', canvasSaveConflict: false, canvasSaveError: null,
    canvasRecovery: null, canvasRecoveryError: null, activeBackendProjectId: 'p1',
    backendProjects: [{ id: 'p1', my_role: 'creator' }], retryCanvasSave: vi.fn(),
    saveCanvasRecovery: vi.fn().mockResolvedValue(true), downloadCanvasRecovery: vi.fn().mockReturnValue(true),
    reloadActiveCanvas: vi.fn().mockResolvedValue(undefined), restoreCanvasRecoveryCopy: vi.fn().mockResolvedValue(true),
  };
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const renderStatus = async () => { await act(async () => root.render(<SaveStatusIndicator language="zh" />)); };

describe('save/recovery status entry', () => {
  it('shows a 409 conflict and actual error without retrying online', async () => {
    Object.assign(holder.state, { canvasSaveStatus: 'error', canvasSaveConflict: true, canvasSaveError: '画布已被另一窗口更新，请保留当前编辑。' });
    await renderStatus();
    expect(document.querySelector('[data-status="conflict"]')).not.toBeNull();
    expect(document.body.textContent).toContain('服务器已有新版本（409）');
    expect(document.body.textContent).toContain('画布已被另一窗口更新，请保留当前编辑。');
    expect(button('重试保存')).toBeUndefined();
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(holder.state.retryCanvasSave).not.toHaveBeenCalled();
  });

  it('retries an ordinary online save error once', async () => {
    Object.assign(holder.state, { canvasSaveStatus: 'error', canvasSaveError: '网络超时' });
    await renderStatus();
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(holder.state.retryCanvasSave).toHaveBeenCalledTimes(1);
    expect(button('重试保存')).toBeDefined();
  });

  it.each(['saved', 'idle'])('keeps the recovery entry after %s, including project and timestamp', async status => {
    Object.assign(holder.state, { canvasSaveStatus: status, canvasRecovery: recovery });
    await renderStatus();
    expect(document.querySelector('[data-status="recovery"]')).not.toBeNull();
    await act(async () => button('本地恢复').click());
    expect(document.body.textContent).toContain('山海变第一集');
    expect(document.body.textContent).toContain('2026');
    expect(button('恢复为新项目')).toBeDefined();
  });

  it('hides ordinary visitor save errors but keeps recovery and never retries online', async () => {
    Object.assign(holder.state, { canvasSaveStatus: 'error', canvasSaveError: '只读项目无权保存', backendProjects: [{ id: 'p1', my_role: 'visitor' }] });
    await renderStatus();
    expect(document.querySelector('[data-testid="save-status"]')).toBeNull();
    holder.state.canvasRecovery = recovery;
    await renderStatus();
    await act(async () => button('本地恢复').click());
    expect(document.body.textContent).not.toContain('只读项目无权保存');
    expect(button('恢复为新项目')).toBeDefined();
    expect(button('备份后加载服务器')).toBeUndefined();
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(holder.state.retryCanvasSave).not.toHaveBeenCalled();
  });

  it('keeps a backup failure visible even with idle status and no recovery record', async () => {
    holder.state.canvasRecoveryError = '浏览器存储空间不足';
    await renderStatus();
    expect(document.body.textContent).toContain('本地备份失败：浏览器存储空间不足');
    expect(document.body.textContent).toContain('请先下载快照');
    await act(async () => button('下载本地快照').click());
    expect(holder.state.downloadCanvasRecovery).toHaveBeenCalledTimes(1);
  });
});

describe('recovery panel actions', () => {
  const props = (): CanvasRecoveryPanelProps => ({
    zh: true, online: true, readOnly: false, activeProject: true, conflict: true,
    saveError: '保存冲突', recoveryError: null, recovery,
    onRetry: vi.fn(), onSaveBackup: vi.fn().mockResolvedValue(true), onDownload: vi.fn().mockReturnValue(true),
    onReload: vi.fn().mockResolvedValue(undefined), onRestore: vi.fn().mockResolvedValue(true), onClose: vi.fn(),
  });
  const renderPanel = async (p: CanvasRecoveryPanelProps) => { await act(async () => root.render(<CanvasRecoveryPanel {...p} />)); };

  it('keeps download usable offline when browser backup fails', async () => {
    const p = { ...props(), online: false, recoveryError: 'QuotaExceededError' };
    await renderPanel(p);
    expect(button('备份后加载服务器').disabled).toBe(true);
    expect(button('恢复为新项目').disabled).toBe(true);
    expect(button('下载本地快照').disabled).toBe(false);
    await act(async () => button('下载本地快照').click());
    expect(p.onDownload).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('快照下载已发起');
  });

  it('dispatches guarded reload once and displays failure without claiming success', async () => {
    const p = { ...props(), onReload: vi.fn().mockRejectedValue(new Error('备份失败，保留当前编辑')) };
    await renderPanel(p);
    await act(async () => button('备份后加载服务器').click());
    expect(p.onReload).toHaveBeenCalledOnce();
    expect(p.onSaveBackup).not.toHaveBeenCalled();
    expect(p.onRestore).not.toHaveBeenCalled();
    expect(p.onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('备份失败，保留当前编辑');
  });

  it('restores a separate project and closes only on success', async () => {
    const p = props();
    await renderPanel(p);
    await act(async () => button('恢复为新项目').click());
    expect(p.onRestore).toHaveBeenCalledOnce();
    expect(p.onReload).not.toHaveBeenCalled();
    expect(p.onClose).toHaveBeenCalledOnce();
  });

  it('shows failed backup and keeps the download action available', async () => {
    const p = { ...props(), onSaveBackup: vi.fn().mockResolvedValue(false) };
    await renderPanel(p);
    await act(async () => button('保存本地备份').click());
    expect(document.body.textContent).toContain('本地备份失败时请下载快照');
    expect(button('下载本地快照').disabled).toBe(false);
    expect(p.onReload).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('本地快照已保存');
  });
});
