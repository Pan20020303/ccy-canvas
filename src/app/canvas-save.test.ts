import { beforeEach, describe, expect, it, vi } from 'vitest';

const { saveMock, getMock, createMock, listMock } = vi.hoisted(() => ({ saveMock: vi.fn(), getMock: vi.fn(), createMock: vi.fn(), listMock: vi.fn() }));
vi.mock('./api/projects', async (load) => ({ ...await load<object>(), saveCanvas: saveMock, getCanvas: getMock, createProject: createMock, listProjects: listMock }));

async function editor(data = new Map<string, string>()) {
  vi.resetModules();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string,v: string) => data.set(k,v), removeItem: (k: string) => data.delete(k),
  } });
  const { useStore } = await import('./store');
  useStore.setState({ activeBackendProjectId: 'project-a', activeProjectId: 'project-a', canvasRevision: 14,
    canvasHydrated: true, canvasSaveStatus: 'idle', nodes: [{ id:'n1',type:'textNode',position:{x:0,y:0},data:{content:'first'} }],edges:[],groups:[] });
  return useStore;
}

describe('versioned canvas persistence', () => {
  beforeEach(() => { saveMock.mockReset(); getMock.mockReset(); createMock.mockReset(); listMock.mockReset(); });

  it('keeps a newly created empty project clean without an unnecessary PUT', async () => {
    const store = await editor();
    saveMock.mockResolvedValue({ version: 15 });
    createMock.mockResolvedValue({ id: 'new-project', name: 'New', created_at: '', updated_at: '' });
    await store.getState().createBackendProject('New');
    expect(store.getState().hasUnsavedCanvasChanges()).toBe(false);
    await store.getState().saveCanvasToBackend();
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it('does not dirty a saved document for selection or automatic React Flow measurements', async () => {
    const store = await editor();
    store.setState({ edges: [{ id: 'e1', source: 'n1', target: 'n2' }] });
    saveMock.mockResolvedValue({ version: 15 });
    await store.getState().saveCanvasToBackend();
    store.getState().onNodesChange([{ type: 'select', id: 'n1', selected: true },
      { type: 'dimensions', id: 'n1', dimensions: { width: 320, height: 180 } }]);
    store.getState().onEdgesChange([{ type: 'select', id: 'e1', selected: true }]);
    expect(store.getState().hasUnsavedCanvasChanges()).toBe(false);
    await store.getState().saveCanvasToBackend();
    expect(saveMock).toHaveBeenCalledTimes(1);
    store.getState().onNodesChange([{ type: 'dimensions', id: 'n1', dimensions: { width: 480, height: 270 }, setAttributes: true }]);
    expect(store.getState().hasUnsavedCanvasChanges()).toBe(true);
  });

  it('checks dirty state during a drag without serializing the graph and saves the final coordinates', async () => {
    const store = await editor();
    const { setCanvasInteractionActive } = await import('./store');
    saveMock.mockResolvedValue({ version: 15 });
    await store.getState().saveCanvasToBackend();
    setCanvasInteractionActive(true);
    try {
      for (let x = 1; x <= 60; x++) {
        store.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x, y: x }, dragging: true }]);
        const stringify = vi.spyOn(JSON, 'stringify');
        const dirty = store.getState().hasUnsavedCanvasChanges();
        const calls = stringify.mock.calls.length;
        stringify.mockRestore();
        expect(dirty).toBe(true);
        expect(calls).toBe(0);
      }
    } finally { setCanvasInteractionActive(false); }
    store.getState().onNodesChange([{ type: 'position', id: 'n1', position: { x: 60, y: 60 }, dragging: false }]);
    await store.getState().saveCanvasToBackend();
    expect(saveMock.mock.calls.at(-1)?.[1][0]).toMatchObject({ position: { x: 60, y: 60 } });
    expect(saveMock.mock.calls.at(-1)?.[1][0]).not.toHaveProperty('dragging');
    expect(store.getState().hasUnsavedCanvasChanges()).toBe(false);
  });

  it('serializes overlapping edits using the version returned by the preceding save', async () => {
    const store=await editor();
    let complete!: (v: unknown) => void;
    saveMock.mockImplementationOnce(() => new Promise(resolve => { complete=resolve; }));
    saveMock.mockResolvedValueOnce({ version:16 });
    const first=store.getState().saveCanvasToBackend();
    store.setState({nodes:[{id:'n1',type:'textNode',position:{x:0,y:0},data:{content:'latest'}}]});
    const second=store.getState().saveCanvasToBackend();
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock.mock.calls[0][4].expectedVersion).toBe(14);
    complete({version:15});
    await Promise.all([first,second]);
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls[1][4].expectedVersion).toBe(15);
    expect(saveMock.mock.calls[1][1][0].data.content).toBe('latest');
    expect(store.getState().canvasRevision).toBe(16);
  });

  it('preserves the editor and prevents project switching after a save conflict', async () => {
    const store=await editor();
    saveMock.mockRejectedValue(new Error('画布已被另一窗口更新'));
    expect(await store.getState().switchBackendProject('project-b')).toBe(false);
    expect(getMock).not.toHaveBeenCalled();
    expect(store.getState().activeBackendProjectId).toBe('project-a');
    expect(store.getState().nodes[0].data.content).toBe('first');
    expect(store.getState().canvasSaveStatus).toBe('error');
    expect(store.getState().canvasRevision).toBe(14);
  });

  it('never saves a visitor canvas and allows leaving it even after an old 403', async () => {
    const store = await editor();
    store.setState({ backendProjects: [{ id: 'project-a', name: 'Shared', my_role: 'visitor', created_at: '', updated_at: '' }],
      canvasSaveStatus: 'error', canvasSaveError: '403' });
    getMock.mockResolvedValue({ nodes: [], edges: [], groups: [], version: 4 });
    expect(await store.getState().saveCanvasToBackend()).toBe(true);
    expect(await store.getState().switchBackendProject('project-b')).toBe(true);
    expect(saveMock).not.toHaveBeenCalled();
    expect(store.getState().activeBackendProjectId).toBe('project-b');
  });

  it('keeps the outgoing editor and reports a failed target fetch to the caller', async () => {
    const store = await editor();
    saveMock.mockResolvedValue({ version: 15 });
    getMock.mockRejectedValue(new Error('offline'));
    expect(await store.getState().switchBackendProject('project-b')).toBe(false);
    expect(store.getState().activeBackendProjectId).toBe('project-a');
    expect(store.getState().nodes[0].data.content).toBe('first');
    expect(store.getState().canvasHydrated).toBe(true);
  });

  it('saves edits made while a project switch is waiting for its first PUT', async () => {
    const store = await editor();
    let complete!: (value: unknown) => void;
    saveMock.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    saveMock.mockResolvedValueOnce({ version: 16 });
    getMock.mockResolvedValue({ nodes: [], edges: [], groups: [], version: 2 });
    const switching = store.getState().switchBackendProject('project-b');
    store.setState({ nodes: [{ id: 'n1', position: { x: 0, y: 0 }, data: { content: 'typed during save' } }] });
    complete({ version: 15 });
    expect(await switching).toBe(true);
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls[1][1][0].data.content).toBe('typed during save');
    expect(saveMock.mock.calls[1][4].expectedVersion).toBe(15);
  });

  it('stages the latest full snapshot before an unload flush waits for an earlier PUT', async () => {
    const data = new Map<string, string>();
    const store = await editor(data);
    let complete!: (value: unknown) => void;
    saveMock.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    saveMock.mockResolvedValueOnce({ version: 16 });
    const first = store.getState().saveCanvasToBackend();
    const heavy = 'data:image/png;base64,' + 'A'.repeat(20_000);
    store.setState({ nodes: [{ id: 'n1', position: { x: 0, y: 0 }, data: { content: 'last edit', url: heavy } }] });
    const closing = store.getState().saveCanvasToBackend({ keepalive: true });
    // No network completion or microtask is needed for the synchronous backup.
    expect(saveMock).toHaveBeenCalledTimes(1);
    const written = [...data.entries()].filter(([key]) => key.startsWith('ccy-canvas-recovery:')).map(([, raw]) => JSON.parse(raw));
    expect(written.some(record => record.nodes[0].data.content === 'last edit' && record.nodes[0].data.url === heavy)).toBe(true);
    complete({ version: 15 });
    await Promise.all([first, closing]);
    expect(saveMock.mock.calls[1][4]).toMatchObject({ keepalive: true, expectedVersion: 15 });
  });

  it('retains a 409 draft, stops retries, and keeps it after loading and saving the server version', async () => {
    const data = new Map<string, string>();
    const store = await editor(data);
    const { ApiClientError } = await import('./api/client');
    saveMock.mockRejectedValueOnce(new ApiClientError({ status: 409, code: 'CONFLICT', message: 'another editor saved' }));
    expect(await store.getState().saveCanvasToBackend()).toBe(false);
    expect(store.getState().canvasSaveConflict).toBe(true);
    expect(store.getState().canvasRecovery?.nodes[0].data.content).toBe('first');
    expect(await store.getState().saveCanvasToBackend({ force: true })).toBe(false);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(store.getState().canvasRevision).toBe(14);
    getMock.mockResolvedValue({ version: 19, nodes: [{ id: 'remote', position: { x: 0, y: 0 }, data: { content: 'server' } }], edges: [], groups: [] });
    await store.getState().reloadActiveCanvas();
    expect(store.getState().canvasRevision).toBe(19);
    expect(store.getState().canvasSaveConflict).toBe(false);
    expect(store.getState().nodes[0].id).toBe('remote');
    expect(store.getState().canvasRecovery?.nodes[0].data.content).toBe('first');
    expect(await store.getState().saveCanvasToBackend()).toBe(true);
    expect(saveMock).toHaveBeenCalledTimes(1); // no unnecessary PUT after hydration
    store.setState({ nodes: [{ id: 'remote', position: { x: 0, y: 0 }, data: { content: 'new edit on server base' } }] });
    saveMock.mockResolvedValue({ version: 20 });
    await store.getState().saveCanvasToBackend();
    const { readCanvasRecovery } = await import('./canvas-recovery');
    expect((await readCanvasRecovery('', 'project-a'))?.nodes[0].data.content).toBe('first');
  });

  it('refuses both server reload and frontend refresh when durable backup fails', async () => {
    const store = await editor();
    localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
    await store.getState().reloadActiveCanvas();
    expect(getMock).not.toHaveBeenCalled();
    expect(store.getState().nodes[0].data.content).toBe('first');
    expect(store.getState().canvasHydrated).toBe(true);
    expect(store.getState().canvasRecoveryError).toContain('下载本地快照');
    expect(await store.getState().prepareCanvasPageReload()).toBe(false);
    const { canSafelyReloadChunks } = await import('./chunk-recovery');
    expect(await canSafelyReloadChunks()).toBe(false);
  });

  it('recovers into a new project using version zero and never restarts copied jobs', async () => {
    const store = await editor();
    const { ApiClientError } = await import('./api/client');
    store.setState({ nodes: [{ id: 'n1', position: { x: 0, y: 0 }, data: { content: 'local', status: 'running', taskId: 'old-job', queuedAfterTimeout: true } }] });
    saveMock.mockRejectedValueOnce(new ApiClientError({ status: 409, code: 'CONFLICT', message: 'conflict' }));
    await store.getState().saveCanvasToBackend();
    createMock.mockResolvedValue({ id: 'recovery-copy', name: 'Recovered', created_at: '', updated_at: '' });
    saveMock.mockResolvedValueOnce({ version: 1 });
    expect(await store.getState().restoreCanvasRecoveryCopy()).toBe(true);
    expect(saveMock).toHaveBeenCalledTimes(2);
    expect(saveMock.mock.calls[1][0]).toBe('recovery-copy');
    expect(saveMock.mock.calls[1][4].expectedVersion).toBe(0);
    expect(saveMock.mock.calls[1][1][0].data).toMatchObject({ status: 'idle', queuedAfterTimeout: false });
    expect(saveMock.mock.calls[1][1][0].data.taskId).toBeUndefined();
    expect(store.getState().activeBackendProjectId).toBe('recovery-copy');
  });

  it('offers a previous session recovery snapshot after loading the current server canvas', async () => {
    const data = new Map<string, string>();
    const first = await editor(data);
    expect(await first.getState().prepareCanvasPageReload()).toBe(true);
    const reopened = await editor(data);
    listMock.mockResolvedValue([{ id: 'project-a', name: 'Original', created_at: '', updated_at: '' }]);
    getMock.mockResolvedValue({ version: 18, nodes: [], edges: [], groups: [] });
    await reopened.getState().loadBackendProjects();
    expect(reopened.getState().canvasRecovery?.nodes[0].data.content).toBe('first');
    expect(reopened.getState().canvasRevision).toBe(18);
    expect(reopened.getState().hasUnsavedCanvasChanges()).toBe(false);
    expect(saveMock).not.toHaveBeenCalled();
  });
});
