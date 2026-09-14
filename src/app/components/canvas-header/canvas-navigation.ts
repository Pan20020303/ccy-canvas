import { useStore } from '../../store';
import { useAgentCanvasActivityStore } from '../agent/agent-canvas-activity';

/** Keep project navigation from discarding edits or applying a live Agent to another canvas. */
export async function prepareCanvasNavigation() {
  const activity = useAgentCanvasActivityStore.getState();
  if (activity.runId && !activity.finished) throw new Error('Agent 正在执行，请先停止任务或等待完成后再切换画布。');
  const state = useStore.getState();
  if (state.activeRun) throw new Error('当前画布仍有生成任务，请等待完成后再切换。');
  if (!state.activeBackendProjectId) return;
  if (state.backendSyncing || !state.canvasHydrated) throw new Error('画布尚未加载完成，请稍后重试。');
  // View-only collaborators must never issue a save request.
  const project = state.backendProjects.find(p => p.id === state.activeBackendProjectId);
  if (project?.my_role === 'visitor') return;
  await state.saveCanvasToBackend({ force: true });
  const latest = useStore.getState();
  const latestActivity = useAgentCanvasActivityStore.getState();
  if ((latestActivity.runId && !latestActivity.finished) || latest.activeRun) throw new Error('保存期间启动了新任务，请等待完成后再切换画布。');
  if (latest.canvasSaveStatus === 'error') throw new Error('当前画布保存失败，已取消切换。请先重试保存。');
  if (latest.nodes !== state.nodes || latest.edges !== state.edges || latest.groups !== state.groups) {
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
    useStore.setState({
      activeBackendProjectId: saved.activeBackendProjectId, activeProjectId: saved.activeProjectId,
      nodes: saved.nodes, edges: saved.edges, groups: saved.groups, canvasRevision: saved.canvasRevision,
      canvasHydrated: saved.canvasHydrated, canvasSaveStatus: saved.canvasSaveStatus,
      canvasSaveError: saved.canvasSaveError, undoStack: saved.undoStack,
      projectStateById: saved.projectStateById, copiedCanvasSelection: saved.copiedCanvasSelection,
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
