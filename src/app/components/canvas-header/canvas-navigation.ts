import { useStore } from '../../store';
import { useAgentCanvasActivityStore } from '../agent/agent-canvas-activity';

const generationFields = new Set(['status', 'taskId', 'queuedAfterTimeout', 'taskPhase', 'error', 'output', 'content',
  'url', 'originalUrl', 'versions', 'activeVersionId', 'activeVersionTimestamp', 'assetStatus', 'assetSyncing',
  'lastGenerationError', 'lastGenerationFailedAt', 'runningStartedAt', 'generationOwnerId', 'sourceKind']);
function onlyGenerationChanged(before: ReturnType<typeof useStore.getState>, after: ReturnType<typeof useStore.getState>) {
  const running = new Set(before.nodes.filter(n => ['running', 'generating'].includes(String(n.data.status))).map(n => n.id));
  if (!running.size || before.edges !== after.edges || before.groups !== after.groups) return false;
  const stableNodes = (nodes: typeof before.nodes) => nodes.filter(n => !n.id.startsWith('node-multi-')).map(n => running.has(n.id)
    ? { ...n, data: Object.fromEntries(Object.entries(n.data).filter(([key]) => !generationFields.has(key))) } : n);
  return JSON.stringify(stableNodes(before.nodes)) === JSON.stringify(stableNodes(after.nodes));
}

/** Keep project navigation from discarding edits or applying a live Agent to another canvas. */
export async function prepareCanvasNavigation(options?: { logout?: boolean }) {
  const activity = useAgentCanvasActivityStore.getState();
  if (activity.runId && !activity.finished) throw new Error('Agent 正在执行，请先停止任务或等待完成后再切换画布。');
  const state = useStore.getState();
  if (options?.logout && (state.activeRun || [state.nodes, ...Object.values(state.projectStateById).map(p => p.nodes)]
    .some(nodes => nodes.some(n => ['running', 'generating'].includes(String(n.data.status)))))) {
    throw new Error('生成期间可以切换画布或页面；退出账号前请等待任务完成或停止任务。');
  }
  if (!state.activeBackendProjectId) return;
  if (state.backendSyncing || !state.canvasHydrated) throw new Error('画布尚未加载完成，请稍后重试。');
  // View-only collaborators must never issue a save request.
  const project = state.backendProjects.find(p => p.id === state.activeBackendProjectId);
  if (project?.my_role === 'visitor') return;
  await state.saveCanvasToBackend({ force: true });
  const latest = useStore.getState();
  const latestActivity = useAgentCanvasActivityStore.getState();
  if (latestActivity.runId && !latestActivity.finished) throw new Error('Agent 正在执行，请先停止任务或等待完成后再切换画布。');
  if (latest.canvasSaveStatus === 'error') throw new Error('当前画布保存失败，已取消切换。请先重试保存。');
  if ((latest.nodes !== state.nodes || latest.edges !== state.edges || latest.groups !== state.groups) && !onlyGenerationChanged(state, latest)) {
    throw new Error('保存时画布又有修改，请再次点击切换以保存最新内容。');
  }
}

export async function switchHeaderProject(id: string, remote: boolean) {
  const before = useStore.getState();
  if (id === (remote ? before.activeBackendProjectId : before.activeProjectId) && (!remote || before.canvasHydrated)) return;
  await prepareCanvasNavigation();
  if (!remote) { useStore.getState().switchProject(id); return; }
  const saved = useStore.getState();
  await saved.switchBackendProject(id);
  if (!useStore.getState().canvasHydrated) {
    const latest = useStore.getState();
    const restored = latest.projectStateById[saved.activeProjectId] ?? saved;
    useStore.setState({
      activeBackendProjectId: saved.activeBackendProjectId, activeProjectId: saved.activeProjectId,
      nodes: restored.nodes, edges: restored.edges, groups: restored.groups, canvasRevision: saved.canvasRevision,
      canvasHydrated: saved.canvasHydrated, canvasSaveStatus: saved.canvasSaveStatus,
      canvasSaveError: saved.canvasSaveError, undoStack: saved.undoStack,
      projectStateById: latest.projectStateById, copiedCanvasSelection: saved.copiedCanvasSelection,
      activeRun: saved.activeRun && restored.nodes.some(n => n.id === saved.activeRun?.nodeId && ['running', 'generating'].includes(String(n.data.status))) ? saved.activeRun : null,
    });
    throw new Error('目标画布加载失败，已保留当前画布，请重试。');
  }
}

export async function createHeaderProject(remote: boolean, name: string) {
  await prepareCanvasNavigation();
  if (remote) {
    const created = await useStore.getState().createBackendProject(name);
    if (!created) throw new Error('新建画布失败，请检查连接后重试。');
  } else {
    useStore.getState().createProject(name);
  }
}
