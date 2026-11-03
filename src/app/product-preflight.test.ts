import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), stream: vi.fn(), upload: vi.fn(), cancel: vi.fn(), getTask: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: { info: mocks.info, error: mocks.error, warning: vi.fn() } }));
vi.mock('./api/providerConfigs', async load => ({ ...await load<object>(), generate: mocks.generate, generateStream: mocks.stream }));
vi.mock('./api/projects', async load => ({ ...await load<object>(), uploadFile: mocks.upload }));
vi.mock('./api/tasks', async load => ({ ...await load<object>(), cancelTask: mocks.cancel, getTask: mocks.getTask,
  listActiveTasks: vi.fn().mockResolvedValue([]), batchTasksByNodeIds: vi.fn().mockResolvedValue([]) }));

async function editor() {
  vi.resetModules();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k), key: (i: number) => [...values.keys()][i] ?? null, get length() { return values.size; } });
  const { useStore } = await import('./store');
  useStore.setState({ activeBackendProjectId: 'p', activeProjectId: 'p', confirmBeforeGenerate: true,
    nodes: [
      { id: 'audio', type: 'referenceAudioNode', position: { x: 0, y: 0 }, data: { url: '/uploads/voice.wav' } },
      { id: 'image', type: 'referenceImageNode', position: { x: 0, y: 0 }, data: { url: '/uploads/start.jpg' } },
      { id: 'text', type: 'textNode', position: { x: 0, y: 0 }, data: { content: 'Camera moves slowly.' } },
      { id: 'video', type: 'videoNode', position: { x: 0, y: 0 }, data: { generationParams: { model: 'custom-video', durationSeconds: 5, resolution: '1440p', aspectRatio: '16:9' } } },
    ],
    edges: [ { id: 'ea', source: 'audio', target: 'video' }, { id: 'ei', source: 'image', target: 'video' }, { id: 'et', source: 'text', target: 'video' } ], groups: [],
    backendModels: [{ id: 'provider', service_type: 'video', vendor: 'Test', name: 'Test channel', model_list: ['custom-video'], status: 'enabled',
      parameter_schema: { resolution_options: ['1440p'], duration_options: [5] } } as never],
  });
  return useStore;
}

const runningTask = { id: 'task', node_id: 'video', project_id: 'p', service_type: 'video', model: 'custom-video', status: 'running', result_url: '', error_msg: '', duration_ms: 0, created_at: '' };

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.generate.mockRejectedValue(new Error('fixture: no generator')); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('generation context isolation', () => {
  it('rechecks the context after awaiting media persistence', async () => {
    const store = await editor();
    const upload = deferred<{ url: string }>();
    mocks.upload.mockReturnValueOnce(upload.promise);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['media'], { type: 'video/mp4' }) }));
    mocks.generate.mockResolvedValueOnce({ type: 'url', content: 'https://example.com/generated.mp4' });
    const run = store.getState().runNode('video', { prompt: 'Original', model: 'custom-video', skipConfirm: true });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(mocks.upload).toHaveBeenCalledOnce();
    store.setState({ activeBackendProjectId: 'other', activeProjectId: 'other', history: [],
      nodes: [{ id: 'video', position: { x: 0, y: 0 }, data: { url: '/uploads/current.mp4' } }] });
    upload.resolve({ url: '/uploads/old-persisted.mp4' });
    await run;
    expect(store.getState().nodes[0].data).toEqual({ url: '/uploads/current.mp4' });
    expect(store.getState().history).toEqual([]);
  });

  it('retains project scope in SSE and ignores old-account stream callbacks', async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      onmessage: ((message: { data: string }) => void) | null = null;
      onopen = null;
      onerror = null;
      close = vi.fn();
      constructor() { FakeEventSource.instances.push(this); }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    const store = await editor();
    const oldStream = FakeEventSource.instances[0];
    const event = { task_id: 'task', node_id: 'video', project_id: 'other', service_type: 'video', status: 'queued', result_url: '', error_msg: '', duration_ms: 0 };
    oldStream.onmessage?.({ data: JSON.stringify(event) });
    expect(store.getState().nodes.find(n => n.id === 'video')?.data.taskId).toBeUndefined();
    oldStream.onmessage?.({ data: JSON.stringify({ ...event, project_id: 'p' }) });
    expect(store.getState().nodes.find(n => n.id === 'video')?.data.taskId).toBe('task');
    const { bindStorageToUser } = await import('./store');
    bindStorageToUser('new-account');
    store.setState({ activeBackendProjectId: 'p', nodes: [{ id: 'video', position: { x: 0, y: 0 }, data: { taskId: 'task', status: 'running' } }] });
    oldStream.onmessage?.({ data: JSON.stringify({ ...event, project_id: 'p', status: 'success', result_url: '/uploads/old.mp4' }) });
    expect(oldStream.close).toHaveBeenCalledOnce();
    expect(store.getState().nodes[0].data).toEqual({ taskId: 'task', status: 'running' });
  });

  it('discards in-flight poll results after a space switch', async () => {
    const store = await editor();
    const lookup = deferred<unknown>();
    mocks.getTask.mockReturnValueOnce(lookup.promise);
    store.setState({ nodes: [{ id: 'video', position: { x: 0, y: 0 }, data: { taskId: 'task', status: 'running' } }] });
    await vi.advanceTimersByTimeAsync(8000);
    expect(mocks.getTask).toHaveBeenCalledWith('task');
    store.setState({ activeSpaceId: 'other-space' });
    lookup.resolve({ ...runningTask, status: 'success', result_url: '/uploads/old.mp4' });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(store.getState().nodes[0].data).toEqual({ taskId: 'task', status: 'running' });
  });
  it.each(['project', 'space', 'account'] as const)('discards a delayed media result after switching %s', async boundary => {
    const store = await editor();
    const response = deferred<unknown>();
    mocks.generate.mockReturnValueOnce(response.promise);
    const run = store.getState().runNode('video', { prompt: 'Original request', model: 'custom-video', skipConfirm: true });
    expect(mocks.generate.mock.calls[0][0].project_id).toBe('p');
    if (boundary === 'project') store.setState({ activeBackendProjectId: 'other', activeProjectId: 'other' });
    if (boundary === 'space') store.setState({ activeSpaceId: 'other-space' });
    if (boundary === 'account') {
      const { bindStorageToUser } = await import('./store');
      // Returning to the same account must not revive a request from before logout.
      bindStorageToUser('other-account');
      bindStorageToUser('');
    }
    const untouched = { status: 'done', url: '/uploads/current-project.mp4', prompt: 'Current project' };
    store.setState({ nodes: [{ id: 'video', type: 'videoNode', position: { x: 0, y: 0 }, data: untouched }],
      history: [], activeRun: { nodeId: 'new-run', startedAt: 42 } });
    response.resolve({ type: 'url', content: '/uploads/original-result.mp4', task_id: 'original-task' });
    await run;
    expect(store.getState().nodes[0].data).toEqual(untouched);
    expect(store.getState().history).toEqual([]);
    expect(store.getState().activeRun).toEqual({ nodeId: 'new-run', startedAt: 42 });
  });

  it('does not write a late error or task ID onto another canvas', async () => {
    const store = await editor();
    for (const fail of [false, true]) {
      store.setState({ activeBackendProjectId: 'p', activeProjectId: 'p' });
      const response = deferred<unknown>();
      mocks.generate.mockReturnValueOnce(response.promise);
      const run = store.getState().runNode('video', { prompt: 'Original', model: 'custom-video', skipConfirm: true });
      store.setState({ activeBackendProjectId: 'other', activeProjectId: 'other',
        nodes: [{ id: 'video', type: 'videoNode', position: { x: 0, y: 0 }, data: { content: 'preserve' } }] });
      if (fail) response.reject(new Error('late failure'));
      else response.resolve({ type: 'queued', task_id: 'late-task' });
      await run;
      expect(store.getState().nodes[0].data).toEqual({ content: 'preserve' });
    }
  });

  it('guards the delayed precise lookup after a queued submit has returned', async () => {
    const store = await editor();
    const lookup = deferred<unknown>();
    mocks.generate.mockResolvedValueOnce({ type: 'queued', task_id: 'task' });
    mocks.getTask.mockReturnValueOnce(lookup.promise);
    await store.getState().runNode('video', { prompt: 'Original', model: 'custom-video', skipConfirm: true });
    store.setState({ activeSpaceId: 'other-space', nodes: [{ id: 'video', type: 'videoNode', position: { x: 0, y: 0 }, data: { taskId: 'task', status: 'running' } }] });
    lookup.resolve({ ...runningTask, status: 'success', result_url: '/uploads/old.mp4' });
    await lookup.promise;
    await Promise.resolve();
    expect(store.getState().nodes[0].data).toEqual({ taskId: 'task', status: 'running' });
  });

  it('keeps the newer same-ID run alive when the old project request finishes', async () => {
    const store = await editor();
    const oldResponse = deferred<unknown>();
    const newResponse = deferred<unknown>();
    mocks.generate.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    const first = store.getState().runNode('video', { prompt: 'First', model: 'custom-video', skipConfirm: true });
    const firstSignal = mocks.generate.mock.calls[0][1] as AbortSignal;
    store.setState({ activeBackendProjectId: 'other', activeProjectId: 'other', history: [] });
    const second = store.getState().runNode('video', { prompt: 'Second', model: 'custom-video', skipConfirm: true });
    expect(firstSignal.aborted).toBe(false);
    oldResponse.resolve({ type: 'url', content: '/uploads/old.mp4' });
    await first;
    newResponse.resolve({ type: 'url', content: '/uploads/new.mp4' });
    await second;
    expect(store.getState().nodes.find(n => n.id === 'video')?.data).toMatchObject({ status: 'done', url: '/uploads/new.mp4' });
    expect(store.getState().history).toHaveLength(1);
    expect(store.getState().history[0].title).toBe('Second');
  });

  it('does not stream tokens into a copied text node after a project switch', async () => {
    const store = await editor();
    const read = deferred<{ value: Uint8Array; done: boolean }>();
    const cancel = vi.fn().mockResolvedValue(undefined);
    mocks.stream.mockResolvedValueOnce({ ok: true, body: { getReader: () => ({ read: () => read.promise, cancel }) } });
    const run = store.getState().runNode('text', { prompt: 'Original text', model: 'text-model', skipConfirm: true });
    await Promise.resolve();
    expect(mocks.stream.mock.calls[0][0].project_id).toBe('p');
    store.setState({ activeBackendProjectId: 'other', activeProjectId: 'other',
      nodes: [{ id: 'text', type: 'textNode', position: { x: 0, y: 0 }, data: { content: 'Current draft' } }] });
    read.resolve({ value: new TextEncoder().encode('data: {"type":"token","content":"Old result"}\n\n'), done: false });
    await run;
    expect(store.getState().nodes[0].data).toEqual({ content: 'Current draft' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('ignores an unscoped old event until a task is precisely bound', async () => {
    const store = await editor();
    const { publishTaskUpdate } = await import('./task-events');
    publishTaskUpdate({ ...runningTask, project_id: undefined });
    expect(store.getState().nodes.find(n => n.id === 'video')?.data.taskId).toBeUndefined();
    publishTaskUpdate(runningTask);
    expect(store.getState().nodes.find(n => n.id === 'video')?.data.taskId).toBe('task');
  });

  it('rejects cancellation broadcasts from the previous account session', async () => {
    const store = await editor();
    const { apiClient } = await import('./api/client');
    const response = deferred<unknown>();
    vi.spyOn(apiClient, 'post').mockReturnValueOnce(response.promise as never);
    const realTasks = await vi.importActual<typeof import('./api/tasks')>('./api/tasks');
    const request = realTasks.cancelTask('task');
    const { bindStorageToUser } = await import('./store');
    bindStorageToUser('new-account');
    store.setState({ activeBackendProjectId: 'p', nodes: [{ id: 'video', position: { x: 0, y: 0 }, data: { taskId: 'task', status: 'running' } }] });
    response.resolve({ cancelled: true, reason: 'cancelled', task: { ...runningTask, status: 'cancelled' } });
    await request;
    expect(store.getState().nodes[0].data.status).toBe('running');
  });
});

describe('resolved input inspection', () => {
  it.each([true, false])('preserves a visitor’s tracked task when checkOnly=%s', async checkOnly => {
    const store = await editor();
    store.setState({ backendProjects: [{ id: 'p', my_role: 'visitor' } as never],
      nodes: [{ id: 'video', type: 'videoNode', position: { x: 0, y: 0 }, data: { taskId: 'task', status: 'running', queuedAfterTimeout: true } }] });
    await store.getState().runNode('video', { prompt: 'Draft', model: 'custom-video', checkOnly, skipConfirm: true });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(store.getState().nodes[0].data).toEqual({ taskId: 'task', status: 'running', queuedAfterTimeout: true });
  });
  it('shows ordered audio/image and upstream text without submitting or entering running state', async () => {
    const store = await editor();
    await store.getState().runNode('video', { prompt: 'Ocean', model: 'custom-video', checkOnly: true });
    const pending = store.getState().pendingRunConfirm[0];
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(store.getState().nodes.find(n => n.id === 'video')?.data.status).toBeUndefined();
    expect(pending.checkOnly).toBe(true);
    expect(pending.preview).toMatchObject({ images: ['/uploads/start.jpg'], audios: ['/uploads/voice.wav'], videos: [],
      prompt: 'Camera moves slowly.\n\nOcean', parameters: { resolution: '1440p', duration: 5 } });
  });

  it('uses the channel capability override in both preview and request', async () => {
    const store = await editor();
    await store.getState().runNode('video', { prompt: 'Ocean', model: 'custom-video' });
    const pending = store.getState().pendingRunConfirm[0];
    await store.getState().runNode('video', { ...pending.payload, expectedInputs: pending.expectedInputs, skipConfirm: true });
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(mocks.generate.mock.calls[0][0]).toMatchObject({ provider_config_id: 'provider', resolution: '1440p', duration: 5,
      reference_images: ['/uploads/start.jpg'], reference_audio: '/uploads/voice.wav', prompt: pending.preview?.prompt });
  });

  it('requires a refreshed review if a referenced audio changes after confirmation opens', async () => {
    const store = await editor();
    await store.getState().runNode('video', { prompt: 'Ocean', model: 'custom-video' });
    const first = store.getState().pendingRunConfirm[0];
    store.setState({ nodes: store.getState().nodes.map(n => n.id === 'audio' ? { ...n, data: { url: '/uploads/new.wav' } } : n) });
    await store.getState().runNode('video', { ...first.payload, expectedInputs: first.expectedInputs, skipConfirm: true });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(store.getState().pendingRunConfirm[0].preview?.audios).toEqual(['/uploads/new.wav']);
    expect(mocks.info).toHaveBeenCalled();
  });

  it('rejects an empty connected audio on a non-Seedance model before any submission', async () => {
    const store = await editor();
    store.setState({ nodes: store.getState().nodes.map(n => n.id === 'audio' ? { ...n, data: {} } : n) });
    await store.getState().runNode('video', { prompt: 'Ocean', model: 'custom-video', skipConfirm: true });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(store.getState().nodes.find(n => n.id === 'video')?.data.error).toContain('尚无可用输出');
  });

  it('does not overwrite a running task when inspecting an invalid draft', async () => {
    const store = await editor();
    store.setState({ nodes: store.getState().nodes.map(n => n.id === 'audio' ? { ...n, data: {} }
      : n.id === 'video' ? { ...n, data: { ...n.data, taskId: 'old-task', status: 'running' } } : n) });
    await store.getState().runNode('video', { prompt: 'Ocean', model: 'custom-video', checkOnly: true });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalled();
    expect(store.getState().nodes.find(n => n.id === 'video')?.data).toMatchObject({ taskId: 'old-task', status: 'running' });
  });
});

describe('server-confirmed cancellation', () => {
  it('keeps tracking until confirmation, then rejects stale queued events', async () => {
    const store = await editor();
    store.setState({ nodes: [{ id: 'video', position: { x: 0, y: 0 }, data: { status: 'running', taskId: 'task', queuedAfterTimeout: true } }] });
    let finish!: (result: unknown) => void;
    mocks.cancel.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const cancelling = store.getState().cancelNode('video');
    expect(store.getState().nodes[0].data).toMatchObject({ status: 'running', taskId: 'task' });
    finish({ cancelled: true, reason: 'cancelled', task: { ...runningTask, status: 'cancelled' } });
    await cancelling;
    expect(store.getState().nodes[0].data).toMatchObject({ status: 'cancelled', taskId: 'task', queuedAfterTimeout: false });
    const { publishTaskUpdate } = await import('./task-events');
    publishTaskUpdate({ ...runningTask, status: 'queued' });
    expect(store.getState().nodes[0].data.status).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(8000);
    expect(mocks.getTask).not.toHaveBeenCalled();
  });

  it('preserves a running task after a network error or unsupported cancellation', async () => {
    const store = await editor();
    store.setState({ nodes: [{ id: 'video', position: { x: 0, y: 0 }, data: { status: 'running', taskId: 'task' } }] });
    mocks.cancel.mockRejectedValueOnce(new Error('offline'));
    await store.getState().cancelNode('video');
    expect(store.getState().nodes[0].data).toMatchObject({ status: 'running', taskId: 'task' });
    mocks.cancel.mockResolvedValueOnce({ cancelled: false, reason: 'already_started', task: runningTask });
    await store.getState().cancelNode('video');
    expect(store.getState().nodes[0].data).toMatchObject({ status: 'running', taskId: 'task' });
  });

  it('never applies a task to a same-ID node in another project', async () => {
    const store = await editor();
    store.setState({ nodes: [{ id: 'video', position: { x: 0, y: 0 }, data: {} }] });
    const { publishTaskUpdate } = await import('./task-events');
    publishTaskUpdate({ ...runningTask, project_id: 'another-project' });
    expect(store.getState().nodes[0].data).toEqual({});
  });
});
