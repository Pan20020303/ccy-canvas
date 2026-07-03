import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { toast } from 'sonner';
import {
  Connection,
  Edge,
  EdgeChange,
  Node,
  NodeChange,
  addEdge,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react';

import type { AppProviderConfig, GenerateResult } from './api/providerConfigs';
import { generate as apiGenerate } from './api/providerConfigs';
import { ApiClientError } from './api/client';
import { batchTasksByNodeIds, getTask, listActiveTasks, type TaskItem } from './api/tasks';
import { saveHistoryToServer, deleteHistoryFromServer, listHistoryFromServer } from './api/history';
import { saveAssetToServer, deleteAssetsFromServer, listAssetsFromServer } from './api/assets';
import type { BackendProject } from './api/projects';
import { createProject as apiCreateProject, getCanvas, listProjects, saveCanvas, uploadFile } from './api/projects';
import {
  buildCanvasClipboardSelection,
  remapClipboardSelectionForPaste,
  type CanvasClipboardSelection,
} from './canvas-clipboard';
import { computeGroupBounds } from './group-routing';
import { clearReferencePayloadValue, getReferencePayloadValue, isPublicHttpAssetUrl, isTransientBrowserMediaUrl, resolveBackendAssetUrl } from './reference-media';
import { getModelTemplate } from './model-templates';
import {
  REFERENCE_MODE_SPECS,
  modesForModel,
  isModeSatisfied,
  type ReferenceModeKey,
} from './reference-modes';

type Language = 'en' | 'zh';
type Theme = 'dark' | 'light';

export type HistoryMediaType = 'text' | 'image' | 'video' | 'audio';

/** 节点生成历史的一个版本. 用户每跑一次生成,旧的 url 进 versions[0],
 *  新的 url 提升为当前. 用户点 "主图" 按钮可以把任一历史版本提回当前. */
export type NodeVersion = {
  id: string;
  url: string;
  prompt?: string;
  model?: string;
  timestamp: number;
  /** 视频独有:海报封面,用于缩略图(没有的话用 url 自身的第一帧或占位). */
  thumbnail?: string;
};
export type HistoryAspectRatio = 'portrait' | 'square' | 'landscape' | 'text';

export type HistoryItem = {
  id: string;
  spaceId: string;
  spaceType: SpaceType;
  projectId: string;
  title: string;
  type: string;
  mediaType: HistoryMediaType;
  timestamp: number;
  thumbnail?: string;
  content?: string;
  aspectRatio: HistoryAspectRatio;
  promptExcerpt?: string;
  sourceNodeId?: string;
  derivationAction?: string;
};

export type HistoryDraft = Omit<HistoryItem, 'spaceId' | 'spaceType' | 'projectId' | 'mediaType' | 'aspectRatio'> &
  Partial<Pick<HistoryItem, 'spaceId' | 'spaceType' | 'projectId' | 'mediaType' | 'aspectRatio'>>;

export type Project = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type Group = {
  id: string;
  nodeIds: string[];
  name: string;
  position?: { x: number; y: number };
  width?: number;
  height?: number;
  /** Optional shell tint (rgba string). Undefined → default neutral shell. */
  color?: string;
};
type ProjectCanvasState = { nodes: Node[]; edges: Edge[]; groups: Group[] };

export type SavedAssetCategory = 'character' | 'scene' | 'object' | 'style' | 'sound' | 'project' | 'other';

export type SavedAsset = {
  id: string;
  name: string;
  category: SavedAssetCategory;
  thumbnail: string;
  url: string;
  kind: 'image' | 'video' | 'audio' | 'text';
  text?: string;
  createdAt: number;
};

export const ASSET_CATEGORIES: { key: SavedAssetCategory | 'all'; zh: string; en: string }[] = [
  { key: 'all', zh: '全部', en: 'All' },
  { key: 'other', zh: '其它', en: 'Other' },
  { key: 'character', zh: '人物', en: 'Character' },
  { key: 'scene', zh: '场景', en: 'Scene' },
  { key: 'object', zh: '物品', en: 'Object' },
  { key: 'style', zh: '风格', en: 'Style' },
  { key: 'sound', zh: '音效', en: 'Sound' },
  { key: 'project', zh: '项目空间', en: 'Project' },
];
export type SpaceType = 'personal' | 'team';
export type SpaceRole = 'owner' | 'editor' | 'viewer';
export type WorkspaceSpace = {
  id: string;
  name: string;
  type: SpaceType;
  role: SpaceRole;
  createdAt: number;
};
type SpaceSnapshot = {
  projects: Project[];
  activeProjectId: string;
  projectStateById: Record<string, ProjectCanvasState>;
  history: HistoryItem[];
};
export type SpaceMember = {
  userId: string;
  name: string;
  email: string;
  globalRole: 'admin' | 'member';
  role: SpaceRole;
  spaceId: string;
};
export type AdminInvitation = {
  id: string;
  code: string;
  status: 'active' | 'used' | 'revoked';
  defaultSpaceId: string;
  usageCount: number;
};

export type TaskStatus = 'generating' | 'completed' | 'failed';

export type Task = {
  id: string;
  type: string;
  status: TaskStatus;
  progress: number;
};

export type NodeGenerationParams = {
  vendor?: string;
  model?: string;
  mode?: string;
  resolution?: string;
  quality?: string;
  aspectRatio?: string;
  durationSeconds?: number;
  /** HappyHorse video-edit audio: "auto" (default) / "origin" (keep source audio). */
  audioSetting?: string;
  /** Random seed [0, 2147483647]; unset → provider picks a random seed. */
  seed?: number;
  editOperation?: string;
  maskImage?: string;
  outputCount?: number;
  expandDirection?: string;
  deriveFromNodeId?: string;
  trimRange?: { start: number; end: number };
  cropRect?: { x: number; y: number; width: number; height: number };
  targetTracks?: string[];
  outputFormat?: string;
  gridPreset?: string;
  splitPreset?: string;
  lightingPreset?: string;
  anglePreset?: string;
  referenceImages?: string[];
  referenceVideo?: string;
  referenceVideos?: string[];
  // Video reference variant (Seedance 2.0 tabs). Drives the prompt panel's
  // reference-slot layout; passed through to the backend as a hint about
  // how upstream media should be interpreted.
  referenceVariant?: string;
};

type UpstreamReferenceMedia = {
  imageUrls: string[];
  videoUrls: string[];
};

type AppState = {
  language: Language;
  toggleLanguage: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  // Agent "pick from canvas" mode: when active, the next canvas node click is
  // captured as a reference for the agent composer instead of normal selection.
  // Whether the agent side-drawer is open (lifted here so the app shell can
  // push the canvas left / pull the navbar in to make room — no overlap).
  agentPanelOpen: boolean;
  setAgentPanelOpen: (open: boolean) => void;
  agentNodePickActive: boolean;
  agentPickedNode: { id: string; label: string; thumb: string } | null;
  startAgentNodePick: () => void;
  cancelAgentNodePick: () => void;
  resolveAgentNodePick: (nodeId: string) => void;
  clearAgentPickedNode: () => void;
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  addNode: (node: Node) => void;
  tasks: Task[];
  addTask: (task: Task) => void;
  isDashboardOpen: boolean;
  setDashboardOpen: (open: boolean) => void;
  isProfileOpen: boolean;
  setProfileOpen: (open: boolean) => void;
  history: HistoryItem[];
  addHistory: (item: HistoryDraft) => void;
  removeHistoryItems: (ids: string[]) => void;
  reuseHistoryItems: (ids: string[]) => void;
  hydrateHistory: () => void;
  spaces: WorkspaceSpace[];
  activeSpaceId: string;
  activeSpaceType: SpaceType;
  switchSpace: (id: string) => void;
  projects: Project[];
  activeProjectId: string;
  projectStateById: Record<string, ProjectCanvasState>;
  spaceSnapshotsById: Record<string, SpaceSnapshot>;
  createProject: (name?: string) => void;
  switchProject: (id: string) => void;
  /** Provider configs loaded from the backend — replaces the old local modelConfigs. */
  backendModels: AppProviderConfig[];
  setBackendModels: (models: AppProviderConfig[]) => void;
  /** Backend project integration */
  backendProjects: BackendProject[];
  activeBackendProjectId: string | null;
  backendSyncing: boolean;
  /** True only after the active project's canvas has been successfully
   *  loaded from (or confirmed empty on) the backend. The auto-save gate:
   *  we must NOT auto-save until this is true, otherwise a refresh could
   *  write the heavy-media-stripped localStorage canvas back over the full
   *  backend snapshot before the real canvas finishes loading (data loss). */
  canvasHydrated: boolean;
  loadBackendProjects: () => Promise<void>;
  /** Refresh ONLY the project list (rename/cover/folder/delete on the
   *  homepage) — never touches the live canvas. */
  refreshBackendProjects: () => Promise<void>;
  createBackendProject: (name: string) => Promise<BackendProject | null>;
  switchBackendProject: (id: string) => Promise<void>;
  saveCanvasToBackend: (options?: { keepalive?: boolean }) => Promise<void>;
  spaceMembers: SpaceMember[];
  invitations: AdminInvitation[];
  groups: Group[];
  createGroup: (nodeIds: string[]) => void;
  removeGroup: (groupId: string) => void;
  ungroupNodes: (groupId: string) => void;
  setGroupMembers: (groupId: string, nodeIds: string[]) => void;
  renameGroup: (groupId: string, name: string) => void;
  moveGroup: (groupId: string, delta: { x: number; y: number }, options?: { captureUndo?: boolean }) => void;
  resizeGroup: (groupId: string, size: { width: number; height: number }, options?: { captureUndo?: boolean }) => void;
  setGroupColor: (groupId: string, color?: string) => void;
  arrangeGroupNodes: (groupId: string, mode: 'grid' | 'horizontal' | 'vertical') => void;
  commitCanvasMirrors: () => void;
  // Multi-node layout actions (operate on currently `selected: true` nodes).
  // No-op when fewer than 2 nodes are selected. Alignment snaps every
  // selected node to a shared edge; distribute spreads them evenly.
  alignSelectedNodes: (mode: 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom') => void;
  distributeSelectedNodes: (axis: 'horizontal' | 'vertical') => void;
  arrangeSelectedNodes: (mode: 'grid' | 'horizontal' | 'vertical') => void;
  // Auto-arrange the whole canvas into a tidy left-to-right layered flow
  // based on edges (sources on the left, derived nodes flow rightward).
  // Disconnected nodes are packed into their own trailing column. Group
  // rectangles are recomputed to wrap their members afterward.
  tidyCanvas: () => void;
  // Lock toggles `data.locked` and ReactFlow's `draggable` per node so a
  // locked node can't be dragged/deleted accidentally. Pass an empty list
  // to toggle all currently selected nodes.
  toggleNodeLock: (nodeIds?: string[]) => void;
  // Z-order: array tail renders on top in ReactFlow. We swap positions so
  // "bring forward" moves toward the end, "send backward" moves toward the
  // start, and bring-to-front / send-to-back jump the node entirely.
  bringNodeForward: (nodeId: string) => void;
  sendNodeBackward: (nodeId: string) => void;
  bringNodeToFront: (nodeId: string) => void;
  sendNodeToBack: (nodeId: string) => void;
  savedAssets: SavedAsset[];
  saveAsset: (asset: Omit<SavedAsset, 'id' | 'createdAt'>) => SavedAsset;
  removeAsset: (id: string) => void;
  hydrateAssets: () => void;
  saveAssetDialogNodeId: string | null;
  /** Which directorStageNode currently has its full-screen overlay open.
   *  null = closed. The overlay component reads this and renders accordingly. */
  directorStageNodeId: string | null;
  openDirectorStage: (nodeId: string) => void;
  closeDirectorStage: () => void;
  openSaveAssetDialog: (nodeId: string) => void;
  closeSaveAssetDialog: () => void;
  isAssetLibraryOpen: boolean;
  setAssetLibraryOpen: (open: boolean) => void;
  undoStack: ProjectCanvasState[];
  redoStack: ProjectCanvasState[];
  pushUndoSnapshot: () => void;
  undoCanvas: () => void;
  redoCanvas: () => void;
  /** Delete the currently-selected node(s) + their edges (Del / Backspace). */
  deleteSelectedNodes: () => void;
  copiedCanvasSelection: CanvasClipboardSelection | null;
  copySelectedNodes: () => void;
  pasteCopiedNodes: () => void;
  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  /** 把指定版本调回成当前主图 —— 现在的 url 反过来进 versions[] 顶端,
   *  选中的 version.url 提升为当前 url. 节点其他 metadata (prompt 等)
   *  也一起切换,让面板里看到的提示词跟图对上. */
  setActiveVersion: (nodeId: string, versionId: string) => void;
  updateNodeGenerationParams: (nodeId: string, patch: Partial<NodeGenerationParams>) => void;
  runNode: (nodeId: string, payload: { prompt: string; model?: string; skipConfirm?: boolean }) => void;
  cancelNode: (nodeId: string) => void;
  activeRun: { nodeId: string; startedAt: number; timedOut?: boolean } | null;
  /** 使用偏好:生成前确认(设置 → 使用偏好)。开启后每次调用模型先弹窗确认。 */
  confirmBeforeGenerate: boolean;
  setConfirmBeforeGenerate: (v: boolean) => void;
  /** 待确认的生成请求队列 —— 弹窗一次确认一个;做成队列是因为批量流程
   *  (如分镜派生)会连续调用 runNode,单槽会互相覆盖丢单。 */
  pendingRunConfirm: Array<{ nodeId: string; payload: { prompt: string; model?: string } }>;
  setPendingRunConfirm: (v: Array<{ nodeId: string; payload: { prompt: string; model?: string } }>) => void;
  shortcuts: Record<string, string>;
  setShortcut: (action: string, combo: string) => void;
  resetShortcuts: () => void;
  isSettingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  isHistoryAssetsOpen: boolean;
  setHistoryAssetsOpen: (open: boolean) => void;
  isTaskQueueCollapsed: boolean;
  setTaskQueueCollapsed: (v: boolean) => void;
  showMiniMap: boolean;
  setShowMiniMap: (value: boolean) => void;
  snapToGrid: boolean;
  setSnapToGrid: (value: boolean) => void;
  isConnectionDragging: boolean;
  setConnectionDragging: (value: boolean) => void;
};

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  zoom_in: 'Ctrl+=',
  zoom_out: 'Ctrl+-',
  fit_view: 'F',
  toggle_minimap: 'M',
  pan_drag: 'Space',
  multi_select: 'Tab',
  guide_snap: 'J',
  grid_toggle: 'L',
  show_grid: '.',
  duplicate_node: 'Ctrl+C',
  duplicate_image: 'Ctrl+Shift+C',
  cut_node: 'Ctrl+X',
  drag_clone: 'Alt',
  paste_node: 'Ctrl+V',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Y',
  delete_node: 'Delete',
  select_all: 'Ctrl+A',
};

/**
 * Serialize a keyboard event into a canonical combo string ("Ctrl+Shift+Z",
 * "Delete", "F"). This is the SINGLE source of truth shared by the settings
 * recorder and the live canvas handler, so a recorded shortcut and a live
 * keypress compare equal. Order is always Ctrl → Shift → Alt → Key, and
 * ctrl/meta both normalize to "Ctrl" (cross-platform).
 */
export const formatShortcutCombo = (e: KeyboardEvent): string => {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  const key = e.key;
  if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
    parts.push(key.length === 1 ? key.toUpperCase() : key);
  }
  return parts.join('+');
};

/** Whether a keyboard event matches the (possibly user-customized) combo for
 *  `action`. Falls back to the default binding when unset. */
export const eventMatchesShortcut = (
  e: KeyboardEvent,
  action: string,
  shortcuts: Record<string, string>,
): boolean => {
  const combo = shortcuts[action] || DEFAULT_SHORTCUTS[action];
  if (!combo) return false;
  return formatShortcutCombo(e) === combo;
};

const initialNodes: Node[] = [
  {
    id: '1',
    type: 'textNode',
    position: { x: 250, y: 150 },
    data: { content: 'Script: The hero walks into the dark alley...' },
  },
  {
    id: '2',
    type: 'imageNode',
    position: { x: 650, y: 150 },
    data: {
      url: 'https://images.unsplash.com/photo-1478827536114-da961b7f86d2?w=800&q=80',
      caption: 'Concept Art',
      sourceKind: 'generated',
    },
  },
];

const initialEdges: Edge[] = [{ id: 'e1-2', source: '1', target: '2', type: 'flow' }];

const createCanvasSnapshot = (
  nodes: Node[] = [],
  edges: Edge[] = [],
  groups: Group[] = [],
): ProjectCanvasState => ({
  nodes: nodes.map((node) => ({ ...node, position: { ...node.position }, data: { ...(node.data ?? {}) } })),
  edges: edges.map((edge) => ({ ...edge, style: edge.style ? { ...edge.style } : edge.style })),
  groups: groups.map((group) => ({
    ...group,
    nodeIds: [...group.nodeIds],
    position: group.position ? { ...group.position } : group.position,
  })),
});

const cloneCanvasState = (state: Pick<AppState, 'nodes' | 'edges' | 'groups'>): ProjectCanvasState =>
  createCanvasSnapshot(state.nodes, state.edges, state.groups);

// Cap the undo stack so long sessions can't accumulate hundreds of full-canvas
// clones in memory (each entry deep-copies every node/edge/group).
const MAX_UNDO_STACK = 50;
const pushUndoState = (state: AppState) => {
  const next = [...state.undoStack, cloneCanvasState(state)];
  return next.length > MAX_UNDO_STACK ? next.slice(-MAX_UNDO_STACK) : next;
};

// Position + dimension changes are NOT auto-captured for undo: a single drag
// emits dozens of per-frame 'position' changes, and capturing each one made
// Ctrl+Z crawl the node back frame-by-frame. Instead, a drag is snapshotted
// exactly once at drag START (Canvas.onNodeDragStart → pushUndoSnapshot), so a
// whole drag collapses to one undo step. (select/dimensions are never edits.)
const shouldCaptureNodeChangesForUndo = (changes: NodeChange[]) =>
  changes.some((change) =>
    change.type !== 'select' && change.type !== 'position' && change.type !== 'dimensions',
  );

const shouldCaptureEdgeChangesForUndo = (changes: EdgeChange[]) =>
  changes.some((change) => change.type !== 'select');

const createEmptyCanvasState = (): ProjectCanvasState => createCanvasSnapshot();

const createProjectRecord = (id: string, name: string, timestamp: number): Project => ({
  id,
  name,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const createSpaceSnapshot = (
  projects: Project[],
  activeProjectId: string,
  projectStateById: Record<string, ProjectCanvasState>,
  history: HistoryItem[] = [],
): SpaceSnapshot => ({
  projects: projects.map((project) => ({ ...project })),
  activeProjectId,
  projectStateById: Object.fromEntries(
    Object.entries(projectStateById).map(([key, value]) => [key, createCanvasSnapshot(value.nodes, value.edges, value.groups)]),
  ),
  history: history.map((item) => ({ ...item })),
});

const createPersonalInitialSnapshot = (): SpaceSnapshot => {
  const defaultProject = createProjectRecord('p-default', 'Untitled', Date.now());
  return createSpaceSnapshot(
    [defaultProject],
    defaultProject.id,
    { [defaultProject.id]: createCanvasSnapshot(initialNodes, initialEdges, []) },
    [],
  );
};

const createTeamInitialSnapshot = (projectName: string): SpaceSnapshot => {
  const project = createProjectRecord(`p-${Date.now()}-${Math.floor(Math.random() * 1000)}`, projectName, Date.now());
  return createSpaceSnapshot([project], project.id, { [project.id]: createEmptyCanvasState() }, []);
};

const syncActiveProjectState = (
  state: Pick<AppState, 'activeProjectId' | 'projectStateById' | 'nodes' | 'edges' | 'groups'>,
  nextCanvas?: Partial<ProjectCanvasState>,
) => {
  const nodes = nextCanvas?.nodes ?? state.nodes;
  const edges = nextCanvas?.edges ?? state.edges;
  const groups = nextCanvas?.groups ?? state.groups;

  return {
    projectStateById: {
      ...state.projectStateById,
      [state.activeProjectId]: createCanvasSnapshot(nodes, edges, groups),
    },
  };
};

const syncActiveSpaceSnapshot = (
  state: Pick<AppState, 'activeSpaceId' | 'spaceSnapshotsById' | 'projects' | 'activeProjectId' | 'projectStateById' | 'history'>,
  nextState?: Partial<Pick<AppState, 'projects' | 'activeProjectId' | 'projectStateById' | 'history'>>,
) => {
  const projects = nextState?.projects ?? state.projects;
  const activeProjectId = nextState?.activeProjectId ?? state.activeProjectId;
  const projectStateById = nextState?.projectStateById ?? state.projectStateById;
  const history = nextState?.history ?? state.history;

  return {
    spaceSnapshotsById: {
      ...state.spaceSnapshotsById,
      [state.activeSpaceId]: createSpaceSnapshot(projects, activeProjectId, projectStateById, history),
    },
  };
};

const normalizeHistoryItem = (
  item: HistoryDraft,
  activeSpaceId: string,
  activeSpaceType: SpaceType,
  activeProjectId: string,
): HistoryItem => {
  const mediaType = (item.mediaType ?? item.type) as HistoryMediaType;
  const aspectRatio = item.aspectRatio ?? (
    mediaType === 'image'
      ? 'square'
      : mediaType === 'text'
        ? 'text'
        : 'landscape'
  );

  return {
    ...item,
    spaceId: item.spaceId ?? activeSpaceId,
    spaceType: item.spaceType ?? activeSpaceType,
    projectId: item.projectId ?? activeProjectId,
    mediaType,
    aspectRatio,
  };
};

const insufficientCreditsMessages: Record<Language, string> = {
  zh: '积分不足请联系管理员',
  en: 'Insufficient credits. Please contact an administrator.',
};

function isInsufficientCreditsError(err: unknown): boolean {
  return err instanceof ApiClientError
    && (err.status === 402 || /insufficient/i.test(err.code));
}

function getGenerationErrorMessage(err: unknown, language: Language): string {
  if (isInsufficientCreditsError(err)) {
    return insufficientCreditsMessages[language];
  }

  return err instanceof Error ? err.message : 'Generation failed';
}

const createReferenceNodeFromHistoryItem = (
  item: HistoryItem,
  index: number,
): Node | null => {
  const type = item.mediaType === 'image'
    ? 'referenceImageNode'
    : item.mediaType === 'video'
      ? 'referenceVideoNode'
      : item.mediaType === 'audio'
        ? 'referenceAudioNode'
        : null;
  const url = item.thumbnail || item.content;

  if (!type || !url) {
    return null;
  }

  return {
    id: `history-ref-${item.id}-${Date.now()}-${index}`,
    type,
    position: { x: 160 + index * 48, y: 160 + index * 48 },
    data: {
      url,
      sourceName: item.title,
      status: 'done',
    },
  };
};

const createdAt = Date.now();

// seedModelConfigs removed — models are now loaded from the backend via GET /api/app/models.

const seedSpaces: WorkspaceSpace[] = [
  { id: 'space-personal', name: '我的空间', type: 'personal', role: 'owner', createdAt: createdAt },
  { id: 'space-team-alpha', name: '团队空间 A', type: 'team', role: 'editor', createdAt: createdAt },
  { id: 'space-team-studio', name: '品牌工作室', type: 'team', role: 'viewer', createdAt: createdAt },
];

const seedSpaceSnapshotsById: Record<string, SpaceSnapshot> = {
  'space-personal': createPersonalInitialSnapshot(),
  'space-team-alpha': createTeamInitialSnapshot('团队故事板'),
  'space-team-studio': createTeamInitialSnapshot('共享灵感板'),
};

const seedSpaceMembers: SpaceMember[] = [
  { userId: 'u-admin', name: 'Admin', email: 'admin@qq.com', globalRole: 'admin', role: 'owner', spaceId: 'space-team-alpha' },
  { userId: 'u-admin', name: 'Admin', email: 'admin@qq.com', globalRole: 'admin', role: 'owner', spaceId: 'space-team-studio' },
  { userId: 'u-member-a', name: '林夏', email: 'linxia@qq.com', globalRole: 'member', role: 'editor', spaceId: 'space-team-alpha' },
  { userId: 'u-member-b', name: '陈默', email: 'chenmo@qq.com', globalRole: 'member', role: 'viewer', spaceId: 'space-team-studio' },
];

const seedInvitations: AdminInvitation[] = [
  { id: 'inv-1', code: 'D9BKWK08MIGBRSA7', status: 'used', defaultSpaceId: 'space-team-alpha', usageCount: 1 },
  { id: 'inv-2', code: 'TEAMALPHA2026', status: 'active', defaultSpaceId: 'space-team-alpha', usageCount: 0 },
  { id: 'inv-3', code: 'STUDIOVIEW', status: 'active', defaultSpaceId: 'space-team-studio', usageCount: 0 },
];

const runAborters: Record<string, AbortController> = {};
const runTokens: Record<string, string> = {};
const generationTimeoutMs = 900 * 1000;
const TASK_RESULT_RECOVERY_WINDOW_MS = generationTimeoutMs + 60 * 1000;

// ─── Task recovery polling (Stage 2) ─────────────────────────────────────
//
// When a generation hits the client-side timeout, the upstream task may
// still finish on the server (Stage 1 detaches it from the client ctx).
// The poller runs every TASK_POLL_INTERVAL_MS and asks the backend for
// the latest status of every node that's currently marked as running.
// On 'success' / 'error' it flips the node's data accordingly and stops
// tracking it. Singleton timer; starts on first runNode and survives
// across multiple runs.

const TASK_POLL_INTERVAL_MS = 8000;
let taskPollerTimer: ReturnType<typeof setInterval> | null = null;
// Tracks nodes the poller should watch. We need this because the store's
// node list is the source of truth but we don't want to scan all nodes
// every tick; the set is the working subset.
const trackedTaskNodes = new Set<string>();
const activeTaskStatuses = new Set(['queued', 'pending', 'running', 'retrying', 'persisting']);
const successTaskStatuses = new Set(['success', 'succeeded', 'completed', 'done']);
const errorTaskStatuses = new Set(['error', 'failed', 'failure', 'cancelled', 'canceled']);

function normalizeTaskStatus(status: string): 'active' | 'success' | 'error' | 'unknown' {
  const normalized = status.trim().toLowerCase();
  if (activeTaskStatuses.has(normalized)) return 'active';
  if (successTaskStatuses.has(normalized)) return 'success';
  if (errorTaskStatuses.has(normalized)) return 'error';
  return 'unknown';
}

/** True for remote media URLs that look SIGNED/EXPIRING (provider result
 *  buckets like DashScope OSS attach Expires/signature query params). Our own
 *  durable URLs are either relative /uploads paths or query-less COS public
 *  objects, so they don't match — this is the trigger for the second-chance
 *  client-side re-host on the SSE/poller delivery path (P0-8). */
function isLikelyExpiringMediaUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  return /[?&](Expires|expires|X-Amz-Expires|x-oss-expires|OSSAccessKeyId|Signature|signature|sign|token|st)=/.test(url);
}

/** Second-chance durability for queued/SSE results: the backend normally
 *  re-hosts to COS before publishing, but when its staging failed the event
 *  carries a short-lived provider URL. Re-host it client-side and swap the
 *  node's url in place — guarded so a stale swap can't clobber a newer run. */
function upgradeExpiringNodeMedia(nodeId: string, appliedUrl: string, setStore: (updater: (state: AppState) => Partial<AppState>) => void) {
  if (!isLikelyExpiringMediaUrl(appliedUrl)) return;
  void rehostToStableUrl(appliedUrl).then((stable) => {
    if (!stable || stable === appliedUrl) return;
    setStore((state) => {
      const nodes = state.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const data = (node.data ?? {}) as Record<string, unknown>;
        if (data.url !== appliedUrl) return node; // superseded — leave it
        return { ...node, data: { ...data, url: stable, output: stable } };
      });
      const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
      return { nodes, projectStateById, ...syncActiveSpaceSnapshot(state, { projectStateById }) };
    });
  }).catch(() => {});
}

/** Fan the extra assets of a multi-image generation (wan2.7 组图 / n>1) out as
 *  sibling image nodes in a grid beside the source node. Ids are deterministic
 *  per (taskId, index) so a double delivery (SSE + poller race) can't create
 *  duplicates. Returns only the nodes that don't already exist. */
function buildExtraImageNodes(sourceNode: Node | undefined, existing: Node[], urls: string[], taskId: string): Node[] {
  if (!urls || urls.length <= 1) return [];
  const baseX = (sourceNode?.position.x ?? 200) + 380;
  const baseY = sourceNode?.position.y ?? 200;
  const cols = Math.max(1, Math.ceil(Math.sqrt(urls.length - 1)));
  const existingIds = new Set(existing.map((n) => n.id));
  const extras: Node[] = [];
  for (let i = 1; i < urls.length; i += 1) {
    const url = (urls[i] ?? '').trim();
    if (!url) continue;
    const id = `node-multi-${taskId}-${i}`;
    if (existingIds.has(id)) continue;
    const slot = i - 1;
    extras.push({
      id,
      type: 'imageNode',
      position: {
        x: baseX + (slot % cols) * 340,
        y: baseY + Math.floor(slot / cols) * 320,
      },
      data: {
        url,
        output: url,
        originalUrl: url,
        status: 'done',
        sourceKind: 'generated',
        sourceName: `组图 ${i + 1}/${urls.length}`,
      },
    } as Node);
  }
  return extras;
}

/** Apply a task lookup result back onto its node. Called from the poller
 *  for each non-pending row the backend returns. */
function applyTaskResultToNode(task: TaskItem, getStore: () => AppState, setStore: (updater: (state: AppState) => Partial<AppState>) => void) {
  const normalizedStatus = normalizeTaskStatus(task.status);
  if (normalizedStatus !== 'success' && normalizedStatus !== 'error') {
    if (normalizedStatus === 'active') {
      const targetNode = getStore().nodes.find((n) => n.id === task.node_id);
      const targetData = targetNode?.data as Record<string, unknown> | undefined;
      const nodeTaskId = typeof targetData?.taskId === 'string' ? targetData.taskId : undefined;
      if (targetNode && (!nodeTaskId || nodeTaskId === task.id)) {
        setStore((state) => {
          const nodes = state.nodes.map((node) => node.id === task.node_id
            ? {
                ...node,
                data: {
                  ...node.data,
                  status: 'running',
                  taskId: task.id,
                  queuedAfterTimeout: true,
                  // 真实任务阶段（排队中/生成中/返回中），生成覆盖层按它切文案。
                  taskPhase: task.status === 'queued' || task.status === 'pending'
                    ? 'queued'
                    : task.status === 'persisting'
                      ? 'persisting'
                      : 'generating',
                  error: undefined,
                  ...(task.result_url
                    ? {
                        // Store the raw upstream URL. Wrapping for proxy-based
                        // rendering happens at the render boundary, so the
                        // persisted value stays env-agnostic and download /
                        // capture paths don't double-wrap it.
                        url: task.result_url,
                        output: task.result_url,
                        assetStatus: task.status,
                        assetSyncing: true,
                      }
                    : {}),
                },
              }
            : node);
          const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
          return {
            nodes,
            projectStateById,
            ...syncActiveSpaceSnapshot(state, { projectStateById }),
          };
        });
      }
    }
    return; // still pending — leave node alone
  }
  const targetNode = getStore().nodes.find((n) => n.id === task.node_id);
  if (!targetNode) {
    trackedTaskNodes.delete(task.node_id);
    return;
  }
  const targetData = targetNode.data as Record<string, unknown>;
  const currentStatus = targetData?.status;
  const nodeTaskId = typeof targetData?.taskId === 'string' ? (targetData.taskId as string) : undefined;
  // F4: stale-write guard. If the node is now bound to a *different* task
  // id than this incoming result, the result belongs to a superseded run
  // (e.g. the user re-ran the node while the old task was still finishing,
  // and an SSE/poll event for the old task arrived late). Dropping it stops
  // an old generation from clobbering the node's current one. We leave
  // tracking intact — the current task is still in flight.
  if (nodeTaskId && task.id && nodeTaskId !== task.id) {
    return;
  }
  if (!nodeTaskId) {
    const runningStartedAt = typeof targetData?.runningStartedAt === 'number' ? targetData.runningStartedAt : 0;
    const taskCreatedAt = task.created_at ? Date.parse(task.created_at) : NaN;
    const taskHasComparableTimestamp = Number.isFinite(taskCreatedAt);
    const taskMatchesCurrentRunWindow =
      runningStartedAt <= 0 ||
      (taskHasComparableTimestamp && taskCreatedAt + TASK_RESULT_RECOVERY_WINDOW_MS >= runningStartedAt) ||
      (!taskHasComparableTimestamp && targetData?.queuedAfterTimeout === true);
    if ((currentStatus !== 'running' && currentStatus !== 'generating') || !taskMatchesCurrentRunWindow) {
      return;
    }
  }
  const queuedAfterTimeout = targetData?.queuedAfterTimeout === true;
  const isSameQueuedTask = queuedAfterTimeout && (!nodeTaskId || nodeTaskId === task.id);
  // Orphan recovery: the node has the same taskId on file but never got
  // its result url back (e.g. browser closed before SSE arrived). In
  // that case the result is FOR this node — apply it even though
  // status drifted back to idle/pending while the user was away.
  const hasUrl = typeof targetData?.url === 'string' && (targetData.url as string).length > 0;
  const hasContent = typeof targetData?.content === 'string' && (targetData.content as string).length > 0;
  const isOrphanedRecovery = Boolean(nodeTaskId) && nodeTaskId === task.id && !hasUrl && !hasContent;
  if (currentStatus !== 'running' && currentStatus !== 'generating' && !isSameQueuedTask && !isOrphanedRecovery) {
    // The node has already moved on (user ran a new generation, or the
    // success path already handled it). Drop tracking and skip.
    trackedTaskNodes.delete(task.node_id);
    return;
  }

  setStore((state) => {
    const nodes = state.nodes.map((node) => {
      if (node.id !== task.node_id) return node;
      const isUrl = task.service_type === 'image' || task.service_type === 'video' || task.service_type === 'audio';
      if (normalizedStatus === 'success') {
        if (!task.result_url) {
          return {
            ...node,
            data: {
              ...node.data,
              status: 'error',
              taskId: task.id,
              queuedAfterTimeout: false,
              error: '生成任务已完成，但后端没有返回图片地址。',
            },
          };
        }
        // 把当前 url (如果有) 压进 versions 顶端, 把新 url 提为当前.
        // 只对 image / video / audio 这种 url 型节点维护历史.
        // Persist the raw upstream URL; proxy wrapping is applied at render time.
        const resultUrl = task.result_url;
        const prevData = (node.data ?? {}) as Record<string, unknown>;
        let nextVersions: NodeVersion[] | undefined;
        let nextActiveVersionId: string | undefined;
        const nextTs = Date.now();
        if (isUrl) {
          const prevUrl = typeof prevData.url === 'string' ? prevData.url : '';
          const existing = Array.isArray(prevData.versions) ? (prevData.versions as NodeVersion[]) : [];
          if (prevUrl && prevUrl !== resultUrl) {
            const snapshot: NodeVersion = {
              id: typeof prevData.activeVersionId === 'string' ? prevData.activeVersionId as string : `v-${nextTs - 1}-${Math.random().toString(36).slice(2, 6)}`,
              url: prevUrl,
              prompt: typeof prevData.prompt === 'string' ? prevData.prompt as string : undefined,
              model: typeof prevData.model === 'string' ? prevData.model as string : undefined,
              timestamp: typeof prevData.activeVersionTimestamp === 'number' ? prevData.activeVersionTimestamp as number : nextTs - 1,
            };
            nextVersions = [snapshot, ...existing];
          } else {
            nextVersions = existing;
          }
          nextActiveVersionId = `v-${nextTs}-${Math.random().toString(36).slice(2, 6)}`;
        }
        return {
          ...node,
          data: {
            ...node.data,
            status: 'done',
            taskId: task.id,
            queuedAfterTimeout: false,
            taskPhase: undefined,
            error: undefined,
            assetStatus: 'ready',
            assetSyncing: false,
            ...(isUrl
              ? {
                  url: resultUrl,
                  output: resultUrl,
                  originalUrl: task.result_url,
                  versions: nextVersions,
                  activeVersionId: nextActiveVersionId,
                  activeVersionTimestamp: nextTs,
                }
              : { content: resultUrl, output: resultUrl }),
          },
        };
      }
      return {
        ...node,
        data: {
          ...node.data,
          status: 'error',
          taskId: task.id,
          queuedAfterTimeout: false,
          taskPhase: undefined,
          error: `Queued task failed: ${task.error_msg || 'Generation failed'}`,
        },
      };
    });
    // Multi-image generations (wan2.7 组图 / n>1): the node keeps the first
    // asset; the rest fan out as sibling image nodes in a grid. Deterministic
    // ids make a double delivery (SSE + poller) idempotent.
    const withExtras = normalizedStatus === 'success' && task.service_type === 'image' && (task.result_urls?.length ?? 0) > 1
      ? [...nodes, ...buildExtraImageNodes(nodes.find((n) => n.id === task.node_id), nodes, task.result_urls as string[], task.id)]
      : nodes;
    const projectStateById = syncActiveProjectState(state, { nodes: withExtras }).projectStateById;
    return {
      activeRun: state.activeRun?.nodeId === task.node_id ? null : state.activeRun,
      nodes: withExtras,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  });
  // P0-8 second chance: if the delivered URL looks signed/expiring (backend
  // re-host failed and published the provider URL), re-host client-side.
  if (normalizedStatus === 'success' && task.result_url
    && (task.service_type === 'image' || task.service_type === 'video' || task.service_type === 'audio')) {
    upgradeExpiringNodeMedia(task.node_id, task.result_url, setStore);
  }
  // 历史资产: the QUEUED delivery path never recorded history — addHistory only
  // ran in runNode's synchronous success block, so with the task queue enabled
  // (SSE/poller completion) generated media silently skipped the 历史资产 panel.
  // Record it here with a task-deterministic id so a double delivery (SSE +
  // poller race) dedupes locally and server-side (upsert by client_id).
  if (normalizedStatus === 'success' && task.result_url
    && (task.service_type === 'image' || task.service_type === 'video' || task.service_type === 'audio')) {
    const store = getStore();
    const historyId = `gen-task-${task.id}`;
    if (!store.history.some((h) => h.id === historyId)) {
      const nodeData = (store.nodes.find((n) => n.id === task.node_id)?.data ?? {}) as Record<string, unknown>;
      const prompt = typeof nodeData.prompt === 'string' ? (nodeData.prompt as string) : '';
      store.addHistory({
        id: historyId,
        title: prompt.slice(0, 60) || (task.model || task.service_type),
        type: task.service_type,
        mediaType: task.service_type as 'image' | 'video' | 'audio',
        timestamp: Date.now(),
        thumbnail: task.result_url,
        promptExcerpt: prompt.slice(0, 120) || undefined,
        sourceNodeId: task.node_id,
      } as never);
    }
  }
  trackedTaskNodes.delete(task.node_id);
}

/** One tick of the task poller. Fetches the latest status for every
 *  tracked node and calls applyTaskResultToNode on each non-pending row.
 *  Silent on network errors — a failed poll just leaves nodes in their
 *  current 'running' state until the next tick. */
async function pollTrackedTasks(getStore: () => AppState, setStore: (updater: (state: AppState) => Partial<AppState>) => void) {
  // Reconcile the tracked set with what's actually in the store: keep
  // actively running nodes and queued-after-timeout nodes that may have
  // been restored as idle from a saved canvas snapshot.
  //
  // ALSO include "orphan" nodes — ones that have a taskId on file but
  // never received a result url. These happen when a long generation
  // (4 min+ video) completes while the user has the tab closed or has
  // already refreshed past the snapshot: the SSE event is missed and
  // the snapshot says status='idle', so without this clause the result
  // would silently fall through the cracks and the node would stay
  // empty forever even though the backend succeeded.
  const runningNodeIds = getStore().nodes
    .filter((n) => {
      const data = n.data as Record<string, unknown>;
      const status = data?.status;
      if (status === 'running' || status === 'generating') return true;
      if (data?.queuedAfterTimeout === true) return true;
      const taskId = typeof data?.taskId === 'string' ? (data.taskId as string) : '';
      const url = typeof data?.url === 'string' ? (data.url as string) : '';
      const content = typeof data?.content === 'string' ? (data.content as string) : '';
      const errored = status === 'error';
      // Has a taskId on file, no settled output (url / content), and not
      // already shown as a hard error → still waiting on a backend task.
      return Boolean(taskId) && !url && !content && !errored;
    })
    .map((n) => n.id);

  // Add any that aren't yet tracked (covers reload recovery).
  for (const id of runningNodeIds) trackedTaskNodes.add(id);
  // Drop any that have left running state.
  for (const id of [...trackedTaskNodes]) {
    if (!runningNodeIds.includes(id)) trackedTaskNodes.delete(id);
  }

  if (trackedTaskNodes.size === 0) return;

  // Prefer per-task lookup for nodes that have a taskId saved (precise
  // and avoids ambiguity if the user ran multiple generations on the
  // same node). Fall back to batch-by-node-id for nodes without one.
  const nodes = getStore().nodes;
  const withTaskId: string[] = [];   // taskIds to fetch one-by-one
  const nodeIdToTaskId = new Map<string, string>();
  const withoutTaskId: string[] = [];

  for (const nodeId of trackedTaskNodes) {
    const node = nodes.find((n) => n.id === nodeId);
    const taskId = (node?.data as Record<string, unknown> | undefined)?.taskId as string | undefined;
    if (taskId) {
      withTaskId.push(taskId);
      nodeIdToTaskId.set(nodeId, taskId);
    } else {
      withoutTaskId.push(nodeId);
    }
  }

  const requests: Promise<TaskItem[]>[] = [];
  if (withoutTaskId.length > 0) {
    requests.push(batchTasksByNodeIds(withoutTaskId).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[taskPoller] batchTasksByNodeIds failed', err);
      return [];
    }));
  }
  for (const taskId of withTaskId) {
    requests.push(getTask(taskId).then((t) => [t]).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[taskPoller] getTask failed', { taskId, error: err });
      return [];
    }));
  }

  const results = await Promise.all(requests);
  for (const tasks of results) {
    for (const task of tasks) {
      applyTaskResultToNode(task, getStore, setStore);
    }
  }
}

/** Start the recovery poller (idempotent — calling twice is a no-op).
 *  Bound to the store's get/set so the tick function can read & mutate
 *  state without taking the store as a parameter every call. */
function ensureTaskPollerStarted(getStore: () => AppState, setStore: (updater: (state: AppState) => Partial<AppState>) => void) {
  if (taskPollerTimer) return;
  void pollTrackedTasks(getStore, setStore);
  taskPollerTimer = setInterval(() => {
    // Keep polling as a safety net even when SSE is connected. If a browser
    // misses an event while the worker fails fast, the node still reconciles.
    void pollTrackedTasks(getStore, setStore);
  }, TASK_POLL_INTERVAL_MS);
}

// ─── SSE task-completion stream (Stage 3) ────────────────────────────────
//
// Subscribes once to /api/app/tasks/stream and converts each TaskEvent
// into the same node-state mutation the poller would apply. When the
// stream is healthy we let it push results in real time; when it
// reconnects after an error we let the 8 s poller fill the gap until
// the next event arrives.

type TaskEventPayload = {
  task_id: string;
  node_id: string;
  service_type: string;
  status: string;
  result_url: string;
  result_urls?: string[];
  error_msg: string;
  duration_ms: number;
};

let taskEventSource: EventSource | null = null;
let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function applyTaskEventToNode(event: TaskEventPayload, getStore: () => AppState, setStore: (updater: (state: AppState) => Partial<AppState>) => void) {
  // Reuse the poller's per-task application — they share semantics.
  applyTaskResultToNode(
    {
      id: event.task_id,
      node_id: event.node_id,
      service_type: event.service_type,
      model: '',
      status: event.status,
      result_url: event.result_url,
      result_urls: event.result_urls,
      error_msg: event.error_msg,
      duration_ms: event.duration_ms,
      created_at: '',
    },
    getStore,
    setStore,
  );
}

function ensureTaskStreamStarted(getStore: () => AppState, setStore: (updater: (state: AppState) => Partial<AppState>) => void) {
  if (taskEventSource) return;

  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
  const url = `${apiBaseUrl}/api/app/tasks/stream`;
  try {
    taskEventSource = new EventSource(url, { withCredentials: true });
  } catch {
    return; // EventSource not supported (e.g. SSR) — poller remains the safety net
  }

  taskEventSource.onopen = () => {
    if (sseReconnectTimer) {
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
    }
  };

  taskEventSource.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as TaskEventPayload;
      if (event && typeof event === 'object' && event.node_id) {
        applyTaskEventToNode(event, getStore, setStore);
      }
    } catch {
      // Malformed frame — ignore; the poller will catch up on next tick.
    }
  };

  taskEventSource.onerror = () => {
    // Browser EventSource auto-retries by default, but if the server
    // closed cleanly (4xx/auth) the connection goes back to CLOSED and
    // never reopens. Close + reopen with backoff to cover both cases.
    try { taskEventSource?.close(); } catch { /* */ }
    taskEventSource = null;
    if (sseReconnectTimer) return;
    sseReconnectTimer = setTimeout(() => {
      sseReconnectTimer = null;
      ensureTaskStreamStarted(getStore, setStore);
    }, 5000);
  };
}

// ─── Active-task hydration on load (F10) ─────────────────────────────────
//
// Frontend task tracking used to rely entirely on the persisted node
// snapshot (status:'running' nodes re-tracked on reload). If localStorage
// was cleared — or the user opened the app in a different browser — an
// in-flight generation became orphaned: the result landed in the DB but the
// UI never reconciled it. This asks the backend "what's still running for
// me?" and re-binds each active task to its canvas node, so the existing
// poller/SSE machinery picks it back up. Nodes that haven't loaded yet
// (canvas snapshot arrives async) are re-applied via a short-lived store
// subscription.
let activeTasksHydrated = false;

// Reentrancy guard: applyActiveTasksToNodes calls setStore SYNCHRONOUSLY,
// which notifies every store subscriber in the same tick. One of those
// subscribers (registered by hydrateActiveTasks below) re-runs this very
// function — and would infinitely recur through it. The guard makes any
// reentrant call a no-op so the outer call can finish, its caller can
// remove the applied ids from `pending`, and the next subscribe firing
// will see an empty pending set and unsubscribe.
let applyActiveTasksInFlight = false;

function applyActiveTasksToNodes(
  tasks: TaskItem[],
  getStore: () => AppState,
  setStore: (updater: (state: AppState) => Partial<AppState>) => void,
): Set<string> {
  if (applyActiveTasksInFlight) return new Set();
  applyActiveTasksInFlight = true;
  try {
    const appliedNodeIds = new Set<string>();
    const nodes = getStore().nodes;
    for (const task of tasks) {
      const node = nodes.find((n) => n.id === task.node_id);
      if (!node) continue; // node not loaded yet — caller retries on change
      appliedNodeIds.add(task.node_id);
      trackedTaskNodes.add(task.node_id);
    }
    if (appliedNodeIds.size === 0) return appliedNodeIds;
    const taskByNode = new Map(tasks.map((t) => [t.node_id, t]));
    setStore((state) => {
      const nodes = state.nodes.map((node) => {
        const task = taskByNode.get(node.id);
        if (!task) return node;
        const data = (node.data ?? {}) as Record<string, unknown>;
        // Don't disturb a node that already finished or is already tracking
        // this exact task.
        if (data.status === 'running' && data.taskId === task.id) return node;
        // Resume the timer from when the backend task actually started, not
        // from "now" — otherwise refreshing the page resets the elapsed
        // counter back to 0 even though the upstream task has been running
        // for minutes. Falls back to current time if the timestamp can't be
        // parsed.
        const parsedStart = task.created_at ? Date.parse(task.created_at) : NaN;
        const runningStartedAt = Number.isFinite(parsedStart) ? parsedStart : Date.now();
        const taskPhase = task.status === 'queued' || task.status === 'pending'
          ? 'queued'
          : task.status === 'persisting'
            ? 'persisting'
            : 'generating';
        return {
          ...node,
          data: { ...node.data, status: 'running', taskId: task.id, queuedAfterTimeout: true, taskPhase, error: undefined, runningStartedAt },
        };
      });
      const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
      return {
        nodes,
        projectStateById,
        ...syncActiveSpaceSnapshot(state, { projectStateById }),
      };
    });
    return appliedNodeIds;
  } finally {
    applyActiveTasksInFlight = false;
  }
}

async function hydrateActiveTasks(
  getStore: () => AppState,
  setStore: (updater: (state: AppState) => Partial<AppState>) => void,
) {
  if (activeTasksHydrated) return;
  activeTasksHydrated = true;
  let tasks: TaskItem[];
  try {
    tasks = await listActiveTasks();
  } catch {
    return; // best-effort; the poller still covers locally-running nodes
  }
  if (!tasks || tasks.length === 0) return;

  const pending = new Map(tasks.map((t) => [t.node_id, t]));
  const applied = applyActiveTasksToNodes([...pending.values()], getStore, setStore);
  for (const id of applied) pending.delete(id);
  if (pending.size === 0) return;

  // Some target nodes haven't loaded yet (canvas snapshot is async). Re-apply
  // as the store changes, then give up after a bounded window.
  const unsubscribe = useStore.subscribe(() => {
    if (pending.size === 0) { unsubscribe(); return; }
    const applied = applyActiveTasksToNodes([...pending.values()], getStore, setStore);
    for (const id of applied) pending.delete(id);
    if (pending.size === 0) unsubscribe();
  });
  setTimeout(() => unsubscribe(), 30000);
}

let storageUserId = '';

function storageKey(name: string): string {
  return storageUserId ? `${name}-${storageUserId}` : name;
}

/** Strip large inline payloads from a single node's data before persisting.
 *  Keeps the canvas snapshot small enough to fit in localStorage (5MB).
 *  Network-hosted URLs are kept; data URLs / base64 are dropped. */
const MAX_PERSISTED_NODE_VERSIONS = 20;
const MAX_PERSISTED_HISTORY_ITEMS = 100;
const MAX_PERSISTED_SAVED_ASSETS = 80;

function isHeavyMediaString(value: unknown): value is string {
  return typeof value === 'string' && isTransientBrowserMediaUrl(value);
}

function stripHeavyMediaString(value: unknown): unknown {
  return isHeavyMediaString(value) ? '' : value;
}

function stripHeavyFromVersion(version: NodeVersion): NodeVersion {
  return {
    ...version,
    url: isHeavyMediaString(version.url) ? '' : version.url,
    thumbnail: isHeavyMediaString(version.thumbnail) ? '' : version.thumbnail,
  };
}

function stripHeavyFromGenerationParams(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params;
  const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
  if (Array.isArray(out.referenceImages)) {
    out.referenceImages = out.referenceImages.map((url) => stripHeavyMediaString(url)).filter(Boolean);
  }
  if (Array.isArray(out.referenceVideos)) {
    out.referenceVideos = out.referenceVideos.map((url) => stripHeavyMediaString(url)).filter(Boolean);
  }
  out.referenceVideo = stripHeavyMediaString(out.referenceVideo);
  out.maskImage = stripHeavyMediaString(out.maskImage);
  return out;
}

function stripHeavyFromNodeData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const key of ['url', 'output', 'thumbnail', 'poster', 'referenceValue', 'maskImage'] as const) {
    out[key] = stripHeavyMediaString(out[key]);
  }
  if (Array.isArray(out.versions)) {
    out.versions = (out.versions as NodeVersion[])
      .map(stripHeavyFromVersion)
      .filter((version) => version.url)
      .slice(0, MAX_PERSISTED_NODE_VERSIONS);
  }
  if (out.generationParams) {
    out.generationParams = stripHeavyFromGenerationParams(out.generationParams);
  }
  return out;
}

function stripHeavyFromNodes(nodes: Node[]): Node[] {
  return nodes.map((node) => ({ ...node, data: stripHeavyFromNodeData(node.data) as never }));
}

function stripHeavyFromHistory(history: HistoryItem[]): HistoryItem[] {
  return history.slice(0, MAX_PERSISTED_HISTORY_ITEMS).map((item) => ({
    ...item,
    thumbnail: isHeavyMediaString(item.thumbnail) ? '' : item.thumbnail,
    content: item.mediaType === 'text'
      ? item.content
      : isHeavyMediaString(item.content)
        ? ''
        : item.content,
  }));
}

function stripHeavyFromProjectStateById(projectStateById: Record<string, ProjectCanvasState>): Record<string, ProjectCanvasState> {
  const out: Record<string, ProjectCanvasState> = {};
  for (const [key, snapshot] of Object.entries(projectStateById)) {
    out[key] = { ...snapshot, nodes: stripHeavyFromNodes(snapshot.nodes) };
  }
  return out;
}

function stripHeavyFromSpaceSnapshots<T extends { projectStateById?: Record<string, ProjectCanvasState>; history?: HistoryItem[] }>(
  snapshots: Record<string, T>,
): Record<string, T> {
  const out: Record<string, T> = {} as Record<string, T>;
  for (const [key, snap] of Object.entries(snapshots)) {
    out[key] = {
      ...snap,
      projectStateById: snap.projectStateById ? stripHeavyFromProjectStateById(snap.projectStateById) : snap.projectStateById,
      history: snap.history ? stripHeavyFromHistory(snap.history) : snap.history,
    };
  }
  return out;
}

function stripHeavyFromSavedAssets(savedAssets: unknown): SavedAsset[] {
  if (!Array.isArray(savedAssets)) {
    return [];
  }

  return savedAssets.slice(0, MAX_PERSISTED_SAVED_ASSETS).map((asset) => ({
    ...asset,
    thumbnail: isHeavyMediaString(asset.thumbnail) ? '' : asset.thumbnail,
    url: isHeavyMediaString(asset.url) ? '' : asset.url,
  }));
}

function sanitizePersistedAppState<T extends {
  nodes?: Node[];
  history?: HistoryItem[];
  projectStateById?: Record<string, ProjectCanvasState>;
  spaceSnapshotsById?: Record<string, SpaceSnapshot>;
  savedAssets?: SavedAsset[];
}>(persistedState: T): T {
  return {
    ...persistedState,
    nodes: Array.isArray(persistedState.nodes) ? stripHeavyFromNodes(persistedState.nodes) : persistedState.nodes,
    history: Array.isArray(persistedState.history) ? stripHeavyFromHistory(persistedState.history) : persistedState.history,
    projectStateById: persistedState.projectStateById
      ? stripHeavyFromProjectStateById(persistedState.projectStateById)
      : persistedState.projectStateById,
    spaceSnapshotsById: persistedState.spaceSnapshotsById
      ? stripHeavyFromSpaceSnapshots(persistedState.spaceSnapshotsById)
      : persistedState.spaceSnapshotsById,
    savedAssets: stripHeavyFromSavedAssets(persistedState.savedAssets),
  };
}

// ── Persist throttling (drag-smoothness P0) ────────────────────────────────
// zustand's persist middleware runs partialize → stringify → storage.setItem on
// EVERY set(). During a node drag that's once per pointermove frame: stripping
// heavy media across every project/space, stringifying MBs and synchronously
// writing localStorage — 5-30ms per frame, the #1 cause of drag jank.
// Two-layer fix:
//   1. canvasInteractionActive: while a drag/resize gesture is active,
//      partialize returns its cached last snapshot (no strip/clone work).
//   2. debouncedJSONStorage: stringify + localStorage write are deferred to a
//      400ms trailing debounce, flushed on pagehide/visibility-hidden so a tab
//      close can't lose more than the in-flight gesture.
let canvasInteractionActive = false;
let lastPartializedSnapshot: unknown = null;
export function setCanvasInteractionActive(active: boolean) {
  canvasInteractionActive = active;
  if (!active) lastPartializedSnapshot = null; // next persist recomputes fresh
}

const PERSIST_WRITE_DELAY_MS = 400;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersist: { name: string; value: unknown; target: Storage | null } | null = null;
export function flushPendingPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!pendingPersist) return;
  const { name, value, target } = pendingPersist;
  pendingPersist = null;
  // Guard: if globalThis.localStorage was swapped after this write was queued
  // (only happens in tests that reload the store module against a fresh mock),
  // drop the stale write instead of clobbering the new environment's data.
  if (target && typeof localStorage !== 'undefined' && target !== localStorage) return;
  appStorage.setItem(name, JSON.stringify(value));
}
const debouncedJSONStorage = {
  getItem: (name: string) => {
    const raw = appStorage.getItem(name);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  setItem: (name: string, value: unknown) => {
    pendingPersist = {
      name,
      value,
      target: typeof localStorage !== 'undefined' ? localStorage : null,
    };
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPendingPersist, PERSIST_WRITE_DELAY_MS);
  },
  removeItem: (name: string) => {
    pendingPersist = null;
    appStorage.removeItem(name);
  },
};
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPendingPersist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingPersist();
  });
}

let storageQuotaWarned = false;
export const appStorage = {
  getItem: (name: string) => localStorage.getItem(storageKey(name)),
  setItem: (name: string, value: string) => {
    const key = storageKey(name);
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      try {
        localStorage.removeItem(key);
        localStorage.setItem(key, value);
        return;
      } catch {
        // Ignore and fall through to the one-time warning below.
      }
      // Quota exceeded or storage disabled — log once, don't crash the app or pollute node.error.
      const detail = err instanceof Error ? err.message : String(err);
      if (!storageQuotaWarned) {
        console.warn('[appStorage] persist skipped:', detail);
        storageQuotaWarned = true;
      }
    }
  },
  removeItem: (name: string) => {
    try { localStorage.removeItem(storageKey(name)); } catch { /* ignore */ }
  },
};

export function bindStorageToUser(userId: string) {
  if (storageUserId === userId) return;
  // Flush any debounced persist BEFORE the key switches — appStorage resolves
  // storageKey at write time, so a pending write flushed after the switch
  // would land in the NEW user's slot with the OLD user's data.
  flushPendingPersist();
  storageUserId = userId;
  useStore.persist.rehydrate();
}

function extractProxyMediaOriginalUrl(url: string): string {
  if (!url) {
    return '';
  }

  try {
    const parsed = new URL(url, 'http://localhost');
    if (parsed.pathname === '/api/app/proxy-media') {
      return parsed.searchParams.get('url') ?? '';
    }
  } catch {
    return '';
  }

  return '';
}

function resolveReferenceTransportUrl(data: Record<string, unknown>, payloadValue: string): string {
  const rawUrl = typeof data.url === 'string' ? data.url : '';
  const originalUrl = typeof data.originalUrl === 'string' ? data.originalUrl : '';
  const proxyOriginalUrl = extractProxyMediaOriginalUrl(rawUrl);
  const publicHttpUrl = [originalUrl, proxyOriginalUrl, rawUrl].find(isPublicHttpAssetUrl) ?? '';
  if (publicHttpUrl) {
    return publicHttpUrl;
  }

  // Render URLs may be proxy-media links; provider payloads must use either the
  // original public URL or a backend-readable /uploads path.
  const uploadSource = rawUrl || originalUrl || proxyOriginalUrl;
  const uploadsPath = uploadSource.match(/\/uploads\/[^\s?#]+/)?.[0] ?? '';
  return uploadsPath || payloadValue;
}

function collectUpstreamReferenceMedia(nodes: Node[], edges: Edge[], targetNodeId: string): UpstreamReferenceMedia {
  const upstreamIds = new Set(
    edges
      .filter((edge) => edge.target === targetNodeId)
      .map((edge) => edge.source),
  );

  const imageUrls: string[] = [];
  const videoUrls: string[] = [];

  for (const node of nodes) {
    if (!upstreamIds.has(node.id)) {
      continue;
    }

    const data = (node.data ?? {}) as Record<string, unknown>;

    // 导演台 / 构图预览节点没有 data.url —— 它们的"输出"是构图快照。
    // 导演台直接拉线 = 引用「退出时的镜头」(editorPreview,关闭时落盘),
    // 构图预览节点则输出各自机位的渲染图。
    if (node.type === 'directorStageNode') {
      const stage = data as {
        editorPreview?: string;
        lastCapture?: { image?: string };
        lastCaptures?: Record<string, { image?: string }>;
      };
      const snap = stage.editorPreview
        || stage.lastCapture?.image
        || (stage.lastCaptures ? Object.values(stage.lastCaptures)[0]?.image : undefined);
      if (snap) imageUrls.push(snap);
      continue;
    }
    if (node.type === 'compositionPreviewNode') {
      const img = (data as { image?: string }).image;
      if (img) imageUrls.push(img);
      continue;
    }

    const payloadValue = getReferencePayloadValue(node.id, data);
    const url = resolveReferenceTransportUrl(data, payloadValue);
    if (!url) {
      continue;
    }

    if (node.type === 'referenceImageNode' || node.type === 'imageNode') {
      imageUrls.push(url);
    } else if (node.type === 'referenceVideoNode' || node.type === 'videoNode') {
      videoUrls.push(url);
    }
  }

  return { imageUrls, videoUrls };
}

/** Flatten rich-text-editor HTML (or already-plain text) to plain text, keeping
 *  paragraph/line breaks. Used to reference an upstream 文本节点's content. */
function htmlToPlainText(html: string): string {
  if (!html) return '';
  if (typeof document !== 'undefined') {
    const el = document.createElement('div');
    el.innerHTML = html;
    el.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    el.querySelectorAll('p, div, li, h1, h2, h3').forEach((b) => b.append('\n'));
    return (el.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
  }
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-3])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Concatenated plain-text content of upstream 文本节点 wired into `targetNodeId`.
 *  Powers "connect = auto-reference": a text node connected upstream feeds its
 *  content into the downstream node's prompt without a manual @mention.
 *  Nodes already referenced via an @mention in `prompt` are SKIPPED so their
 *  text isn't emitted twice (once prepended here, once resolved from the
 *  mention). Returns '' when there are no eligible text nodes with content. */
function collectUpstreamText(nodes: Node[], edges: Edge[], targetNodeId: string, prompt = ''): string {
  const upstreamIds = new Set(
    edges.filter((edge) => edge.target === targetNodeId).map((edge) => edge.source),
  );
  // Refs already @mentioned in the prompt — those resolve on their own path.
  const mentionedRefs = new Set<string>();
  prompt.replace(/@([a-zA-Z0-9_-]{1,12})/g, (_m, ref) => { mentionedRefs.add(ref); return _m; });
  const isMentioned = (nodeId: string) => {
    for (const ref of mentionedRefs) if (nodeId.startsWith(ref)) return true;
    return false;
  };
  const parts: string[] = [];
  for (const node of nodes) {
    if (node.type !== 'textNode' || !upstreamIds.has(node.id) || isMentioned(node.id)) continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const raw = typeof data.content === 'string' ? data.content : '';
    const text = htmlToPlainText(raw);
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

function usesPublicHttpReferenceImages(provider: AppProviderConfig | null | undefined): boolean {
  if (!provider || provider.service_type !== 'image') {
    return false;
  }
  const schema = provider.parameter_schema;
  const referenceFormat = String(
    schema?.reference_request_format
      ?? schema?.referenceRequestFormat
      ?? schema?.request_format
      ?? schema?.requestFormat
      ?? '',
  ).trim().toLowerCase();
  return referenceFormat === 'chat_completions_image'
    || referenceFormat === 'chat-image'
    || referenceFormat === 'multimodal_chat_image';
}

function normalizeReferenceMediaForProvider(
  referenceMedia: UpstreamReferenceMedia,
  provider: AppProviderConfig | null | undefined,
  apiBaseUrl: string,
): UpstreamReferenceMedia {
  if (!usesPublicHttpReferenceImages(provider)) {
    return referenceMedia;
  }

  return {
    ...referenceMedia,
    imageUrls: referenceMedia.imageUrls
      .map((url) => resolveBackendAssetUrl(url, apiBaseUrl))
      .filter(isPublicHttpAssetUrl),
  };
}

function findReferenceProviderForRequest(
  providers: AppProviderConfig[],
  serviceType: string,
  model: string | undefined,
  preferredVendor: string | undefined,
  hasReferenceImages = false,
): AppProviderConfig | null {
  const matchingProviders = providers.filter((provider) =>
    provider.service_type === serviceType
    && (!model || provider.model_list.includes(model)),
  );
  const preferredProvider = matchingProviders.find((provider) => preferredVendor && provider.vendor === preferredVendor);
  if (hasReferenceImages) {
    if (usesPublicHttpReferenceImages(preferredProvider)) {
      return preferredProvider ?? null;
    }
    return matchingProviders.find(usesPublicHttpReferenceImages) ?? preferredProvider ?? matchingProviders[0] ?? null;
  }
  return preferredProvider ?? matchingProviders[0] ?? null;
}

function extensionForBlobType(type: string): string {
  return type.startsWith('image/png')
    ? 'png'
    : type.startsWith('image/webp')
      ? 'webp'
      : type.startsWith('image/jpeg')
        ? 'jpg'
        : type.startsWith('image/gif')
          ? 'gif'
          : type.startsWith('video/mp4')
            ? 'mp4'
            : type.startsWith('audio/')
              ? (type.includes('mpeg') ? 'mp3' : 'audio')
              : 'bin';
}

/**
 * Re-host a transient/expiring media URL into a stable backend-hosted URL so it
 * survives a page reload, localStorage heavy-stripping, and provider-side
 * expiry. `data:` / `blob:` / remote `http(s)` are fetched (remote via the
 * backend proxy to dodge CORS/referer) and re-uploaded via uploadFile; relative
 * `/uploads` and other same-origin URLs are already durable and pass through.
 *
 * Retries once on a transient failure. On FINAL failure it returns the original
 * URL and logs loudly (no longer a silent fallback) — the dead-media cleanup
 * (client onError → auto-delete) is the backstop for anything that still 404s.
 */
export async function rehostToStableUrl(url: string): Promise<string> {
  if (!url) return url;
  const isData = url.startsWith('data:');
  const isBlob = url.startsWith('blob:');
  const isRemoteHttp = /^https?:\/\//.test(url);
  // Already durable (relative /uploads, same-origin path): nothing to do.
  if (!isData && !isBlob && !isRemoteHttp) return url;

  const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
  const fetchURL = isRemoteHttp
    ? `${apiBase}/api/app/proxy-media?url=${encodeURIComponent(url)}`
    : url;

  const attempt = async (): Promise<string> => {
    const response = await fetch(fetchURL, { credentials: isRemoteHttp ? 'include' : 'same-origin' });
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    const blob = await response.blob();
    const uploaded = await uploadFile(blob, `asset-${Date.now()}.${extensionForBlobType(blob.type)}`);
    return uploaded.url;
  };

  try {
    return await attempt();
  } catch {
    try {
      return await attempt(); // one retry for a transient network/proxy blip
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[rehostToStableUrl] re-host failed after retry; keeping original URL (cleanup will prune if dead)', err);
      return url;
    }
  }
}

async function persistGeneratedMediaUrl(result: GenerateResult): Promise<string> {
  if (result.type !== 'url') {
    return result.content;
  }
  return rehostToStableUrl(result.content);
}

// Signature of the last successfully-saved backend canvas payload — lets the
// debounced autosave skip re-PUTting an unchanged multi-MB canvas.
let lastSavedCanvasSignature = '';

// Client ids currently being deleted server-side. hydrateAssets filters these
// out so a delete-then-reopen race can't resurrect a just-removed asset before
// the DELETE commits. Cleared once the DELETE settles (server no longer has it).
const pendingAssetDeletes = new Set<string>();
// Backfill of local-only assets to the server runs once per session.
let assetsBackfilledThisSession = false;

export const useStore = create<AppState>()(persist((set, get) => ({
  language: 'zh',
  toggleLanguage: () => set((state) => ({ language: state.language === 'en' ? 'zh' : 'en' })),

  theme: 'dark' as Theme,
  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),

  agentPanelOpen: false,
  setAgentPanelOpen: (open) => set({ agentPanelOpen: open }),
  agentNodePickActive: false,
  agentPickedNode: null,
  startAgentNodePick: () => set({ agentNodePickActive: true, agentPickedNode: null }),
  cancelAgentNodePick: () => set({ agentNodePickActive: false }),
  resolveAgentNodePick: (nodeId) => set((state) => {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return { agentNodePickActive: false };
    const d = (node.data ?? {}) as Record<string, unknown>;
    const label = String(d.customTitle || d.sourceName || node.type || node.id);
    const thumb = String(d.url || d.poster || ''); // raw URL; UI wraps for proxy
    return { agentNodePickActive: false, agentPickedNode: { id: nodeId, label, thumb } };
  }),
  clearAgentPickedNode: () => set({ agentPickedNode: null }),

  spaces: seedSpaces,
  activeSpaceId: 'space-personal',
  activeSpaceType: 'personal',
  spaceSnapshotsById: seedSpaceSnapshotsById,
  nodes: seedSpaceSnapshotsById['space-personal'].projectStateById[seedSpaceSnapshotsById['space-personal'].activeProjectId].nodes,
  edges: seedSpaceSnapshotsById['space-personal'].projectStateById[seedSpaceSnapshotsById['space-personal'].activeProjectId].edges,
  undoStack: [],
  redoStack: [],
  copiedCanvasSelection: null,

  onNodesChange: (changes: NodeChange[]) => {
    set((state) => {
      const removedIds = new Set<string>();
      for (const change of changes) {
        if (change.type === 'remove') {
          clearReferencePayloadValue(change.id);
          removedIds.add(change.id);
        }
      }
      const nodes = applyNodeChanges(changes, state.nodes);
      // Sync groups: drop removed members; delete groups that become empty.
      const groups = removedIds.size === 0
        ? state.groups
        : state.groups
            .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => !removedIds.has(id)) }))
            .filter((group) => group.nodeIds.length > 0);
      const captured = shouldCaptureNodeChangesForUndo(changes);
      const undoStack = captured ? pushUndoState(state) : state.undoStack;
      // Drag-smoothness P0: position/dimension/select-only change batches skip
      // the project/space mirror deep-clones — during a drag those cloned the
      // ENTIRE workspace (every project × every node) once per pointermove
      // frame. Structural edits still sync inline; gestures reconcile once via
      // commitCanvasMirrors() on drag/resize stop (Canvas wires it).
      if (!captured && removedIds.size === 0) {
        return { nodes, groups };
      }
      const projectStateById = syncActiveProjectState(state, { nodes, groups }).projectStateById;
      return {
        nodes,
        groups,
        undoStack,
        // A fresh edit invalidates the redo stack (standard undo/redo).
        redoStack: captured ? [] : state.redoStack,
        projectStateById,
        ...syncActiveSpaceSnapshot(state, { projectStateById }),
      };
    });
  },

  // One-shot reconciliation of the project/space mirrors with the live canvas.
  // Called at gesture end (node drag stop, group drag/resize release) to pick
  // up the position changes that onNodesChange/moveGroup skipped per-frame.
  commitCanvasMirrors: () => set((state) => {
    const projectStateById = syncActiveProjectState(state, {
      nodes: state.nodes,
      edges: state.edges,
      groups: state.groups,
    }).projectStateById;
    return {
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),

  onEdgesChange: (changes: EdgeChange[]) => {
    set((state) => {
      const edges = applyEdgeChanges(changes, state.edges);
      const captured = shouldCaptureEdgeChangesForUndo(changes);
      const undoStack = captured ? pushUndoState(state) : state.undoStack;
      const projectStateById = syncActiveProjectState(state, { edges }).projectStateById;
      return {
        edges,
        undoStack,
        redoStack: captured ? [] : state.redoStack,
        projectStateById,
        ...syncActiveSpaceSnapshot(state, { projectStateById }),
      };
    });
  },

  onConnect: (connection: Connection) => {
    set((state) => {
      const decoratedConnection = { ...connection, type: 'flow' };
      const edges = addEdge(decoratedConnection, state.edges);
      const undoStack = pushUndoState(state);
      const projectStateById = syncActiveProjectState(state, { edges }).projectStateById;
      return {
        edges,
        undoStack,
        projectStateById,
        ...syncActiveSpaceSnapshot(state, { projectStateById }),
      };
    });
  },

  addNode: (node: Node) => {
    set((state) => {
      const nodes = [...state.nodes, node];
      const undoStack = pushUndoState(state);
      const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
      return {
        nodes,
        undoStack,
        projectStateById,
        ...syncActiveSpaceSnapshot(state, { projectStateById }),
      };
    });
  },

  tasks: [],
  addTask: (task: Task) => {
    set({ tasks: [task, ...get().tasks] });
  },

  isDashboardOpen: false,
  setDashboardOpen: (open) => set({ isDashboardOpen: open }),

  isProfileOpen: false,
  setProfileOpen: (open) => set({ isProfileOpen: open }),
  isHistoryAssetsOpen: false,
  setHistoryAssetsOpen: (open) => set({ isHistoryAssetsOpen: open }),

  history: [],
  addHistory: (item) => set((state) => {
    const normalized = normalizeHistoryItem(item, state.activeSpaceId, state.activeSpaceType, state.activeProjectId);
    const history = [normalized, ...state.history].slice(0, 200);
    // Persist to the backend (best-effort) so history survives a localStorage
    // wipe and follows the user across devices. Local-first: never blocks UI.
    void saveHistoryToServer(normalized).catch(() => {});
    return {
      history,
      ...syncActiveSpaceSnapshot(state, { history }),
    };
  }),
  removeHistoryItems: (ids) => set((state) => {
    const idSet = new Set(ids);
    const history = state.history.filter((item) => !idSet.has(item.id));
    void deleteHistoryFromServer(ids).catch(() => {});
    return {
      history,
      ...syncActiveSpaceSnapshot(state, { history }),
    };
  }),
  hydrateHistory: async () => {
    const { activeSpaceId } = get();
    let remote: HistoryItem[];
    try {
      remote = await listHistoryFromServer({ spaceId: activeSpaceId });
    } catch {
      return; // best-effort; keep whatever is local
    }
    set((state) => {
      // Merge server items with any local-only items, newest-first, dedup by id.
      const byId = new Map<string, HistoryItem>();
      for (const it of remote) byId.set(it.id, it);
      for (const it of state.history) if (!byId.has(it.id)) byId.set(it.id, it);
      const history = Array.from(byId.values())
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 200);
      return {
        history,
        ...syncActiveSpaceSnapshot(state, { history }),
      };
    });
  },
  reuseHistoryItems: (ids) => set((state) => {
    const selectedById = new Set(ids);
    const appendedNodes = state.history
      .filter((item) => selectedById.has(item.id))
      .map((item, index) => createReferenceNodeFromHistoryItem(item, index))
      .filter((node): node is Node => Boolean(node));

    if (appendedNodes.length === 0) {
      return {};
    }

    const nodes = [...state.nodes, ...appendedNodes];
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;

    return {
      nodes,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),

  projects: seedSpaceSnapshotsById['space-personal'].projects,
  activeProjectId: seedSpaceSnapshotsById['space-personal'].activeProjectId,
  projectStateById: seedSpaceSnapshotsById['space-personal'].projectStateById,
  switchSpace: (id) => set((state) => {
    const targetSpace = state.spaces.find((space) => space.id === id);
    const nextSpaceType = targetSpace?.type ?? 'personal';
    const currentSpaceSnapshot = syncActiveSpaceSnapshot(state).spaceSnapshotsById;
    const nextSnapshot = currentSpaceSnapshot[id] ?? createPersonalInitialSnapshot();
    const nextProjectCanvas = nextSnapshot.projectStateById[nextSnapshot.activeProjectId] ?? createEmptyCanvasState();

    return {
      activeSpaceId: id,
      activeSpaceType: nextSpaceType,
      projects: nextSnapshot.projects,
      activeProjectId: nextSnapshot.activeProjectId,
      projectStateById: nextSnapshot.projectStateById,
      history: nextSnapshot.history,
      nodes: createCanvasSnapshot(nextProjectCanvas.nodes).nodes,
      edges: createCanvasSnapshot([], nextProjectCanvas.edges).edges,
      groups: createCanvasSnapshot([], [], nextProjectCanvas.groups).groups,
      undoStack: [],
      copiedCanvasSelection: null,
      spaceSnapshotsById: currentSpaceSnapshot,
    };
  }),
  createProject: (name) => set((state) => {
    const id = `p-${Date.now()}`;
    const now = Date.now();
    const project: Project = {
      id,
      name: name || `Project ${state.projects.length + 1}`,
      createdAt: now,
      updatedAt: now,
    };

    return {
      projects: [...state.projects, project].map((item) => (
        item.id === state.activeProjectId ? { ...item, updatedAt: now } : item
      )),
      activeProjectId: id,
      nodes: [],
      edges: [],
      groups: [],
      undoStack: [],
      copiedCanvasSelection: null,
      projectStateById: {
        ...syncActiveProjectState(state).projectStateById,
        [id]: createEmptyCanvasState(),
      },
      ...syncActiveSpaceSnapshot(state, {
        projects: [...state.projects, project].map((item) => (
          item.id === state.activeProjectId ? { ...item, updatedAt: now } : item
        )),
        activeProjectId: id,
        projectStateById: {
          ...syncActiveProjectState(state).projectStateById,
          [id]: createEmptyCanvasState(),
        },
      }),
    };
  }),
  switchProject: (id) => set((state) => {
    const nextProjectState = state.projectStateById[id] ?? createEmptyCanvasState();
    const now = Date.now();

    return {
      activeProjectId: id,
      nodes: createCanvasSnapshot(nextProjectState.nodes).nodes,
      edges: createCanvasSnapshot([], nextProjectState.edges).edges,
      groups: createCanvasSnapshot([], [], nextProjectState.groups).groups,
      undoStack: [],
      copiedCanvasSelection: null,
      projects: state.projects.map((project) => (
        project.id === id ? { ...project, updatedAt: now } : project
      )),
      projectStateById: {
        ...syncActiveProjectState(state).projectStateById,
        [id]: createCanvasSnapshot(nextProjectState.nodes, nextProjectState.edges, nextProjectState.groups),
      },
      ...syncActiveSpaceSnapshot(state, {
        activeProjectId: id,
        projectStateById: {
          ...syncActiveProjectState(state).projectStateById,
          [id]: createCanvasSnapshot(nextProjectState.nodes, nextProjectState.edges, nextProjectState.groups),
        },
      }),
    };
  }),

  // Backend-driven model list.
  backendModels: [],
  setBackendModels: (models) => set({ backendModels: models }),

  // Backend project integration.
  backendProjects: [],
  activeBackendProjectId: null,
  backendSyncing: false,
  canvasHydrated: false,

  refreshBackendProjects: async () => {
    try {
      const projects = await listProjects();
      set({ backendProjects: projects });
    } catch {
      // Best-effort — keep the current list on failure.
    }
  },

  loadBackendProjects: async () => {
    set({ backendSyncing: true });
    try {
      const projects = await listProjects();
      if (projects.length === 0) return;
      // 2026-07 修复:刷新后必须回到用户上次所在的项目,而不是无脑跳到
      // projects[0] —— 否则刚建的节点看起来"消失"了(其实好好待在原项目
      // 里,是画布自己切走了)。activeBackendProjectId 已持久化,优先用它。
      const persistedId = get().activeBackendProjectId;
      const first = (persistedId && projects.find((p) => p.id === persistedId)) || projects[0];
      // IMPORTANT: do NOT set activeBackendProjectId yet. Auto-save is gated
      // on canvasHydrated, but we still keep the project id assignment until
      // after the canvas resolves so the whole "active project" state flips
      // atomically and the heavy-stripped localStorage canvas can never be
      // saved back over the real backend snapshot mid-load.
      set({ backendProjects: projects });
      // Load canvas for the restored/first project.
      try {
        const canvas = await getCanvas(first.id);
        set((state) => {
          const rawNodes = Array.isArray(canvas.nodes) ? (canvas.nodes as Node[]) : state.nodes;
          const nodes = rawNodes.map((n) => {
            const d = n.data as Record<string, unknown> | undefined;
            if (d?.status === 'running' || d?.status === 'generating') {
              return { ...n, data: { ...d, status: 'running', queuedAfterTimeout: true, error: undefined } };
            }
            return n;
          });
          const edges = Array.isArray(canvas.edges) ? (canvas.edges as Edge[]) : state.edges;
          // Older snapshots have no groups field — keep whatever is local then.
          const groups = Array.isArray(canvas.groups) ? (canvas.groups as Group[]) : state.groups;
          const projectStateById = {
            ...state.projectStateById,
            [first.id]: createCanvasSnapshot(nodes, edges, groups),
          };
          return {
            nodes,
            edges,
            groups,
            activeProjectId: first.id,
            activeBackendProjectId: first.id,
            canvasHydrated: true, // backend canvas is now the source of truth → auto-save is safe
            projectStateById,
            undoStack: [],
            copiedCanvasSelection: null,
          };
        });
      } catch {
        // Canvas fetch failed (network / auth / 5xx). Leave activeBackendProjectId
        // unset and canvasHydrated false so auto-save stays OFF — we must not
        // overwrite the un-fetched backend snapshot with the stripped local one.
      }
    } catch {
      // Not authenticated or network error — silently continue with local state.
    } finally {
      set({ backendSyncing: false });
    }
  },

  createBackendProject: async (name) => {
    try {
      const project = await apiCreateProject(name);
      set((state) => ({
        backendProjects: [project, ...state.backendProjects],
        activeBackendProjectId: project.id,
        activeProjectId: project.id,
        canvasHydrated: true, // freshly created empty project — safe to auto-save
        nodes: [],
        edges: [],
        groups: [],
        undoStack: [],
        copiedCanvasSelection: null,
        projectStateById: {
          ...syncActiveProjectState(state).projectStateById,
          [project.id]: createEmptyCanvasState(),
        },
      }));
      return project;
    } catch {
      return null;
    }
  },

  switchBackendProject: async (id) => {
    const state = get();
    // Save current canvas first.
    if (state.activeBackendProjectId) {
      try {
        await saveCanvas(state.activeBackendProjectId, state.nodes, state.edges, state.groups);
      } catch {
        // Non-fatal — continue switching.
      }
    }
    // Switching: disable auto-save until the target canvas has loaded, so a
    // 2s auto-save can't write the outgoing/stale nodes into the new project.
    set({ activeBackendProjectId: id, canvasHydrated: false, backendSyncing: true });
    try {
      const canvas = await getCanvas(id);
      const rawNodes = Array.isArray(canvas.nodes) ? (canvas.nodes as Node[]) : [];
      const nodes = rawNodes.map((n) => {
        const d = n.data as Record<string, unknown> | undefined;
        if (d?.status === 'running' || d?.status === 'generating') {
          return { ...n, data: { ...d, status: 'running', queuedAfterTimeout: true, error: undefined } };
        }
        return n;
      });
      const edges = Array.isArray(canvas.edges) ? (canvas.edges as Edge[]) : [];
      const groups = Array.isArray(canvas.groups) ? (canvas.groups as Group[]) : [];
      set((state) => {
        const projectStateById = {
          ...state.projectStateById,
          [id]: createCanvasSnapshot(nodes, edges, groups),
        };
        return {
          nodes,
          edges,
          groups,
          undoStack: [],
          copiedCanvasSelection: null,
          activeProjectId: id,
          canvasHydrated: true,
          projectStateById,
          ...syncActiveSpaceSnapshot(state, { projectStateById }),
        };
      });
    } catch {
      // Canvas fetch failed (network / auth / 5xx) — NOT a new empty project
      // (those resolve with an empty canvas). Show an empty canvas but keep
      // auto-save OFF (canvasHydrated stays false) so we don't overwrite the
      // un-fetched backend snapshot.
      set({ nodes: [], edges: [], groups: [], activeProjectId: id, undoStack: [], copiedCanvasSelection: null });
    } finally {
      set({ backendSyncing: false });
    }
  },

  saveCanvasToBackend: async (options) => {
    const { activeBackendProjectId, canvasHydrated, nodes, edges, groups } = get();
    if (!activeBackendProjectId) return;
    // Defense-in-depth: never persist before the backend canvas has loaded,
    // so a refresh can't write the heavy-stripped localStorage canvas over
    // the full backend snapshot. (Switching projects saves the *outgoing*
    // canvas via saveCanvas() directly, which is intentionally not gated.)
    if (!canvasHydrated) return;
    const cleanNodes = nodes.map((n) => {
      const d = n.data as Record<string, unknown> | undefined;
      if (d?.status === 'running' || d?.status === 'generating') {
        return { ...n, data: { ...d, status: 'running', queuedAfterTimeout: true, error: undefined } };
      }
      return n;
    });
    // Skip identical payloads: the debounced autosave fires on many benign
    // triggers, and re-PUTting a multi-MB unchanged canvas wastes bandwidth
    // and backend writes. (The payload deliberately stays FULL fidelity —
    // the backend snapshot is the un-stripped source of truth.)
    const payloadSignature = `${activeBackendProjectId}:${JSON.stringify(cleanNodes)}:${JSON.stringify(edges)}:${JSON.stringify(groups)}`;
    if (payloadSignature === lastSavedCanvasSignature) return;
    try {
      await saveCanvas(activeBackendProjectId, cleanNodes, edges, groups, options);
      lastSavedCanvasSignature = payloadSignature;
    } catch {
      // Silent — save errors should not interrupt the user.
    }
  },

  spaceMembers: seedSpaceMembers,
  invitations: seedInvitations,

  groups: seedSpaceSnapshotsById['space-personal'].projectStateById[seedSpaceSnapshotsById['space-personal'].activeProjectId].groups,
  pushUndoSnapshot: () => set((state) => ({
    undoStack: pushUndoState(state),
    redoStack: [],
  })),
  undoCanvas: () => set((state) => {
    const previous = state.undoStack.at(-1);
    if (!previous) return {};

    const undoStack = state.undoStack.slice(0, -1);
    // Snapshot the CURRENT canvas onto the redo stack so redo can restore it.
    const redoStack = [...state.redoStack, cloneCanvasState(state)];
    const projectStateById = syncActiveProjectState(state, previous).projectStateById;
    return {
      nodes: previous.nodes,
      edges: previous.edges,
      groups: previous.groups,
      undoStack,
      redoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),

  redoCanvas: () => set((state) => {
    const next = state.redoStack.at(-1);
    if (!next) return {};

    const redoStack = state.redoStack.slice(0, -1);
    // Push the current canvas back onto the undo stack so undo still works.
    const undoStack = [...state.undoStack, cloneCanvasState(state)];
    const projectStateById = syncActiveProjectState(state, next).projectStateById;
    return {
      nodes: next.nodes,
      edges: next.edges,
      groups: next.groups,
      undoStack,
      redoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),

  deleteSelectedNodes: () => set((state) => {
    const doomed = new Set(state.nodes.filter((node) => node.selected).map((node) => node.id));
    if (doomed.size === 0) return {};

    const nodes = state.nodes.filter((node) => !doomed.has(node.id));
    const edges = state.edges.filter((edge) => !doomed.has(edge.source) && !doomed.has(edge.target));
    const groups = state.groups
      .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => !doomed.has(id)) }))
      .filter((group) => group.nodeIds.length > 0);
    const undoStack = pushUndoState(state);
    const projectStateById = syncActiveProjectState(state, { nodes, edges, groups }).projectStateById;
    return {
      nodes,
      edges,
      groups,
      undoStack,
      redoStack: [],
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  copySelectedNodes: () => set((state) => ({
    copiedCanvasSelection: buildCanvasClipboardSelection({
      nodes: state.nodes,
      edges: state.edges,
    }),
  })),
  pasteCopiedNodes: () => set((state) => {
    if (!state.copiedCanvasSelection) return {};

    const pasted = remapClipboardSelectionForPaste({
      selection: state.copiedCanvasSelection,
      offset: { x: 48, y: 48 },
    });
    const undoStack = pushUndoState(state);
    const nodes = [
      ...state.nodes.map((node) => ({ ...node, selected: false })),
      ...pasted.nodes,
    ];
    const edges = [...state.edges, ...pasted.edges];
    const projectStateById = syncActiveProjectState(state, { nodes, edges }).projectStateById;

    return {
      nodes,
      edges,
      undoStack,
      redoStack: [],
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  arrangeSelectedNodes: (mode) => set((state) => {
    const selected = state.nodes.filter((n) => n.selected);
    if (selected.length < 2) return {};

    const nodeWidth = (n: Node) => (n as any).measured?.width ?? n.width ?? 300;
    const nodeHeight = (n: Node) => (n as any).measured?.height ?? n.height ?? 200;
    const GAP = 48; // breathing room between arranged nodes — never overlap.

    // Anchor at the selection's current top-left, then re-flow from there.
    const originX = Math.min(...selected.map((n) => n.position.x));
    const originY = Math.min(...selected.map((n) => n.position.y));
    // Stable reading order: roughly top-to-bottom, then left-to-right.
    const ordered = [...selected].sort((a, b) =>
      Math.abs(a.position.y - b.position.y) > 24 ? a.position.y - b.position.y : a.position.x - b.position.x,
    );

    const nextPos = new Map<string, { x: number; y: number }>();
    if (mode === 'horizontal') {
      let x = originX;
      for (const n of ordered) { nextPos.set(n.id, { x, y: originY }); x += nodeWidth(n) + GAP; }
    } else if (mode === 'vertical') {
      let y = originY;
      for (const n of ordered) { nextPos.set(n.id, { x: originX, y }); y += nodeHeight(n) + GAP; }
    } else {
      // Grid: uniform cells sized to the largest node so nothing overlaps.
      const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
      const cellW = Math.max(...ordered.map(nodeWidth)) + GAP;
      const cellH = Math.max(...ordered.map(nodeHeight)) + GAP;
      ordered.forEach((n, i) => {
        nextPos.set(n.id, {
          x: originX + (i % cols) * cellW,
          y: originY + Math.floor(i / cols) * cellH,
        });
      });
    }

    const undoStack = pushUndoState(state);
    const nodes = state.nodes.map((n) => (nextPos.has(n.id) ? { ...n, position: nextPos.get(n.id)! } : n));
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return {
      nodes,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),

  alignSelectedNodes: (mode) => set((state) => {
    const selected = state.nodes.filter((n) => n.selected);
    if (selected.length < 2) return {};

    // Use measured size when available (post-mount) so we align actual edges,
    // not just origins. Fall back to 300×200 for nodes that haven't measured.
    const nodeWidth = (n: Node) => (n as any).measured?.width ?? n.width ?? 300;
    const nodeHeight = (n: Node) => (n as any).measured?.height ?? n.height ?? 200;

    const lefts = selected.map((n) => n.position.x);
    const rights = selected.map((n) => n.position.x + nodeWidth(n));
    const tops = selected.map((n) => n.position.y);
    const bottoms = selected.map((n) => n.position.y + nodeHeight(n));
    const minLeft = Math.min(...lefts);
    const maxRight = Math.max(...rights);
    const minTop = Math.min(...tops);
    const maxBottom = Math.max(...bottoms);
    const centerH = (minLeft + maxRight) / 2;
    const centerV = (minTop + maxBottom) / 2;

    const targetIds = new Set(selected.map((n) => n.id));
    const undoStack = pushUndoState(state);
    const nodes = state.nodes.map((n) => {
      if (!targetIds.has(n.id)) return n;
      const w = nodeWidth(n);
      const h = nodeHeight(n);
      const next = { ...n.position };
      switch (mode) {
        case 'left':     next.x = minLeft; break;
        case 'right':    next.x = maxRight - w; break;
        case 'center-h': next.x = centerH - w / 2; break;
        case 'top':      next.y = minTop; break;
        case 'bottom':   next.y = maxBottom - h; break;
        case 'center-v': next.y = centerV - h / 2; break;
      }
      return { ...n, position: next };
    });
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return {
      nodes,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),

  distributeSelectedNodes: (axis) => set((state) => {
    const selected = state.nodes.filter((n) => n.selected);
    if (selected.length < 3) return {};
    const nodeWidth = (n: Node) => (n as any).measured?.width ?? n.width ?? 300;
    const nodeHeight = (n: Node) => (n as any).measured?.height ?? n.height ?? 200;

    // Sort by the relevant axis, then keep first + last anchored and spread
    // the rest evenly so the GAPS between adjacent nodes are equal.
    const sorted = [...selected].sort((a, b) =>
      axis === 'horizontal' ? a.position.x - b.position.x : a.position.y - b.position.y
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    let totalSize = 0;
    for (const n of sorted) totalSize += axis === 'horizontal' ? nodeWidth(n) : nodeHeight(n);
    const span = axis === 'horizontal'
      ? (last.position.x + nodeWidth(last)) - first.position.x
      : (last.position.y + nodeHeight(last)) - first.position.y;
    const gap = (span - totalSize) / (sorted.length - 1);

    let cursor = axis === 'horizontal' ? first.position.x : first.position.y;
    const idToNewPos = new Map<string, number>();
    for (const n of sorted) {
      idToNewPos.set(n.id, cursor);
      cursor += (axis === 'horizontal' ? nodeWidth(n) : nodeHeight(n)) + gap;
    }

    const undoStack = pushUndoState(state);
    const nodes = state.nodes.map((n) => {
      const newCoord = idToNewPos.get(n.id);
      if (newCoord == null) return n;
      return {
        ...n,
        position: axis === 'horizontal'
          ? { ...n.position, x: newCoord }
          : { ...n.position, y: newCoord },
      };
    });
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return {
      nodes,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),

  toggleNodeLock: (nodeIds) => set((state) => {
    const targetIds = nodeIds && nodeIds.length > 0
      ? new Set(nodeIds)
      : new Set(state.nodes.filter((n) => n.selected).map((n) => n.id));
    if (targetIds.size === 0) return {};

    // Determine the next state: if ALL targets are currently locked, unlock
    // them all; otherwise lock them all. (Mixed selections converge to
    // "locked" so a stray drag doesn't ever happen.)
    const allLocked = state.nodes
      .filter((n) => targetIds.has(n.id))
      .every((n) => (n as any).data?.locked === true);
    const nextLocked = !allLocked;

    const undoStack = pushUndoState(state);
    const nodes = state.nodes.map((n) => {
      if (!targetIds.has(n.id)) return n;
      return {
        ...n,
        draggable: !nextLocked,
        // selectable + connectable stay enabled so the user can still see
        // the lock visually and click it to unlock from the header.
        data: { ...(n.data ?? {}), locked: nextLocked },
      };
    });
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return {
      nodes,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),

  bringNodeForward: (nodeId) => set((state) => {
    const idx = state.nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0 || idx === state.nodes.length - 1) return {};
    const nodes = state.nodes.slice();
    [nodes[idx], nodes[idx + 1]] = [nodes[idx + 1], nodes[idx]];
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return { nodes, projectStateById, ...syncActiveSpaceSnapshot(state, { projectStateById }) };
  }),
  sendNodeBackward: (nodeId) => set((state) => {
    const idx = state.nodes.findIndex((n) => n.id === nodeId);
    if (idx <= 0) return {};
    const nodes = state.nodes.slice();
    [nodes[idx], nodes[idx - 1]] = [nodes[idx - 1], nodes[idx]];
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return { nodes, projectStateById, ...syncActiveSpaceSnapshot(state, { projectStateById }) };
  }),
  bringNodeToFront: (nodeId) => set((state) => {
    const idx = state.nodes.findIndex((n) => n.id === nodeId);
    if (idx < 0 || idx === state.nodes.length - 1) return {};
    const node = state.nodes[idx];
    const nodes = [...state.nodes.slice(0, idx), ...state.nodes.slice(idx + 1), node];
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return { nodes, projectStateById, ...syncActiveSpaceSnapshot(state, { projectStateById }) };
  }),
  sendNodeToBack: (nodeId) => set((state) => {
    const idx = state.nodes.findIndex((n) => n.id === nodeId);
    if (idx <= 0) return {};
    const node = state.nodes[idx];
    const nodes = [node, ...state.nodes.slice(0, idx), ...state.nodes.slice(idx + 1)];
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return { nodes, projectStateById, ...syncActiveSpaceSnapshot(state, { projectStateById }) };
  }),

  createGroup: (nodeIds) => set((state) => {
    // Merge semantics: if any selected node already belongs to a group, absorb that
    // group's full membership into the new group (and drop the old group) instead of nesting.
    const selectionSet = new Set(nodeIds);
    const absorbedGroupIds = new Set<string>();
    state.groups.forEach((group) => {
      if (group.nodeIds.some((id) => selectionSet.has(id))) {
        absorbedGroupIds.add(group.id);
        group.nodeIds.forEach((id) => selectionSet.add(id));
      }
    });
    const mergedNodeIds = Array.from(selectionSet);
    const memberNodes = state.nodes.filter((node) => selectionSet.has(node.id));
    const bounds = computeGroupBounds(memberNodes);
    const undoStack = pushUndoState(state);
    const remainingGroups = state.groups.filter((group) => !absorbedGroupIds.has(group.id));
    const groups = [...remainingGroups, {
      id: `g-${Date.now()}`,
      nodeIds: mergedNodeIds,
      name: `分组 ${remainingGroups.length + 1}`,
      position: { x: bounds.x, y: bounds.y },
      width: bounds.width,
      height: bounds.height,
    }];
    const projectStateById = syncActiveProjectState(state, { groups }).projectStateById;
    return {
      groups,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  removeGroup: (groupId) => set((state) => {
    const undoStack = pushUndoState(state);
    const target = state.groups.find((group) => group.id === groupId);
    const groups = state.groups.filter((group) => group.id !== groupId);
    // Also delete the member nodes and any edges connected to them.
    const memberIds = new Set(target?.nodeIds ?? []);
    const nodes = state.nodes.filter((node) => !memberIds.has(node.id));
    const edges = state.edges.filter((edge) => !memberIds.has(edge.source) && !memberIds.has(edge.target));
    const projectStateById = syncActiveProjectState(state, { nodes, edges, groups }).projectStateById;
    return {
      nodes,
      edges,
      groups,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  ungroupNodes: (groupId) => set((state) => {
    const undoStack = pushUndoState(state);
    const groups = state.groups.filter((group) => group.id !== groupId);
    const projectStateById = syncActiveProjectState(state, { groups }).projectStateById;
    return {
      groups,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  savedAssets: [],
  saveAsset: (asset) => {
    const created: SavedAsset = {
      id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      ...asset,
    };
    // Prepend to the LIVE list without heavy-stripping siblings — stripping is a
    // persist-only concern (partialize). Blanking a sibling's in-memory data:/blob:
    // url here would make its tile render empty and trip the auto-clean cascade.
    set((state) => ({ savedAssets: [created, ...state.savedAssets] }));
    // Persist to the backend (best-effort) so the library survives a localStorage
    // wipe and follows the user across devices. Local-first: never blocks UI.
    void saveAssetToServer(created).catch(() => {});
    return created;
  },
  removeAsset: (id) => {
    pendingAssetDeletes.add(id);
    void deleteAssetsFromServer([id]).catch(() => {}).finally(() => pendingAssetDeletes.delete(id));
    // Only filter out the target — never heavy-strip surviving rows (see saveAsset).
    set((state) => ({ savedAssets: state.savedAssets.filter((asset) => asset.id !== id) }));
  },
  hydrateAssets: async () => {
    let remote: SavedAsset[];
    try {
      remote = await listAssetsFromServer();
    } catch {
      return; // best-effort; keep whatever is local
    }
    set((state) => {
      // Merge server assets with any local-only ones, newest-first, dedup by id.
      // Skip ids with an in-flight DELETE so a racing hydrate can't resurrect a
      // just-removed asset.
      const byId = new Map<string, SavedAsset>();
      for (const it of remote) if (!pendingAssetDeletes.has(it.id)) byId.set(it.id, it);
      for (const it of state.savedAssets) if (!byId.has(it.id)) byId.set(it.id, it);
      const savedAssets = Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
      // One-time (per session) backfill: push local-only assets with DURABLE media
      // up to the server so pre-existing local libraries land in the DB. Skip
      // empty / blob: (dead) and data: (heavy inline — would bloat the TEXT column;
      // it was never re-hosted) urls. Idempotent via the (user_id, client_id) upsert.
      if (!assetsBackfilledThisSession) {
        assetsBackfilledThisSession = true;
        const serverIds = new Set(remote.map((it) => it.id));
        for (const it of savedAssets) {
          if (serverIds.has(it.id)) continue;
          const media = it.url || it.thumbnail || '';
          if (!media || media.startsWith('blob:') || media.startsWith('data:')) continue;
          void saveAssetToServer(it).catch(() => {});
        }
      }
      return { savedAssets };
    });
  },
  saveAssetDialogNodeId: null,
  openSaveAssetDialog: (nodeId) => set({ saveAssetDialogNodeId: nodeId }),
  closeSaveAssetDialog: () => set({ saveAssetDialogNodeId: null }),
  directorStageNodeId: null,
  openDirectorStage: (nodeId) => set({ directorStageNodeId: nodeId }),
  closeDirectorStage: () => set({ directorStageNodeId: null }),
  isAssetLibraryOpen: false,
  setAssetLibraryOpen: (open) => set({ isAssetLibraryOpen: open }),
  setGroupMembers: (groupId, nodeIds) => set((state) => {
    const undoStack = pushUndoState(state);
    const groups = state.groups
      .map((group) => (group.id === groupId ? { ...group, nodeIds } : group))
      .filter((group) => group.nodeIds.length > 0);
    const projectStateById = syncActiveProjectState(state, { groups }).projectStateById;
    return {
      groups,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  renameGroup: (groupId, name) => set((state) => {
    const groups = state.groups.map((group) => (group.id === groupId ? { ...group, name } : group));
    const projectStateById = syncActiveProjectState(state, { groups }).projectStateById;
    return {
      groups,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  moveGroup: (groupId, delta, options) => set((state) => {
    if (!delta.x && !delta.y) {
      return {};
    }

    const target = state.groups.find((group) => group.id === groupId);
    if (!target) {
      return {};
    }

    const memberIds = new Set(target.nodeIds);
    const nodes = state.nodes.map((node) => (
      memberIds.has(node.id)
        ? {
            ...node,
            position: {
              x: node.position.x + delta.x,
              y: node.position.y + delta.y,
            },
          }
        : node
    ));
    const groups = state.groups.map((group) => (
      group.id !== groupId
        ? group
        : {
            ...group,
            position: {
              x: (group.position?.x ?? 0) + delta.x,
              y: (group.position?.y ?? 0) + delta.y,
            },
          }
    ));
    const undoStack = options?.captureUndo ? pushUndoState(state) : state.undoStack;

    // Per-frame gesture: skip the project/space mirror deep-clones (see
    // onNodesChange). commitCanvasMirrors() reconciles on pointer-up.
    return {
      nodes,
      groups,
      undoStack,
    };
  }),
  resizeGroup: (groupId, size, options) => set((state) => {
    const target = state.groups.find((group) => group.id === groupId);
    if (!target) return {};
    const width = Math.max(160, Math.round(size.width));
    const height = Math.max(120, Math.round(size.height));
    if (target.width === width && target.height === height) return {};
    const groups = state.groups.map((group) => (
      group.id === groupId ? { ...group, width, height } : group
    ));
    // Same undo convention as moveGroup: one snapshot per drag (captured on the
    // first move), not one per pointermove frame. Mirror sync deferred to
    // commitCanvasMirrors() on pointer-up (per-frame gesture).
    const undoStack = options?.captureUndo ? pushUndoState(state) : state.undoStack;
    return {
      groups,
      undoStack,
    };
  }),
  setGroupColor: (groupId, color) => set((state) => {
    const target = state.groups.find((group) => group.id === groupId);
    if (!target || target.color === color) return {};
    const groups = state.groups.map((group) => (
      group.id === groupId ? { ...group, color } : group
    ));
    const undoStack = pushUndoState(state);
    const projectStateById = syncActiveProjectState(state, { groups }).projectStateById;
    return {
      groups,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  // 整理布局: re-flow a group's MEMBER nodes inside the group frame (same
  // layout math as arrangeSelectedNodes), then grow/shrink the frame to fit
  // the arranged content. One undo step.
  arrangeGroupNodes: (groupId, mode) => set((state) => {
    const group = state.groups.find((g) => g.id === groupId);
    if (!group || group.nodeIds.length === 0) return {};
    const memberIds = new Set(group.nodeIds);
    const members = state.nodes.filter((n) => memberIds.has(n.id));
    if (members.length === 0) return {};

    const nodeWidth = (n: Node) => (n as any).measured?.width ?? n.width ?? 300;
    const nodeHeight = (n: Node) => (n as any).measured?.height ?? n.height ?? 200;
    const GAP = 48;
    const PAD = 32; // interior padding between the frame edge and the content

    const originX = (group.position?.x ?? Math.min(...members.map((n) => n.position.x))) + PAD;
    const originY = (group.position?.y ?? Math.min(...members.map((n) => n.position.y))) + PAD;
    const ordered = [...members].sort((a, b) =>
      Math.abs(a.position.y - b.position.y) > 24 ? a.position.y - b.position.y : a.position.x - b.position.x,
    );

    const nextPos = new Map<string, { x: number; y: number }>();
    if (mode === 'horizontal') {
      let x = originX;
      for (const n of ordered) { nextPos.set(n.id, { x, y: originY }); x += nodeWidth(n) + GAP; }
    } else if (mode === 'vertical') {
      let y = originY;
      for (const n of ordered) { nextPos.set(n.id, { x: originX, y }); y += nodeHeight(n) + GAP; }
    } else {
      const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
      const cellW = Math.max(...ordered.map(nodeWidth)) + GAP;
      const cellH = Math.max(...ordered.map(nodeHeight)) + GAP;
      ordered.forEach((n, i) => {
        nextPos.set(n.id, {
          x: originX + (i % cols) * cellW,
          y: originY + Math.floor(i / cols) * cellH,
        });
      });
    }

    // Fit the frame around the arranged content.
    let maxRight = originX;
    let maxBottom = originY;
    for (const n of ordered) {
      const p = nextPos.get(n.id)!;
      maxRight = Math.max(maxRight, p.x + nodeWidth(n));
      maxBottom = Math.max(maxBottom, p.y + nodeHeight(n));
    }
    const gx = group.position?.x ?? (originX - PAD);
    const gy = group.position?.y ?? (originY - PAD);

    const undoStack = pushUndoState(state);
    const nodes = state.nodes.map((n) => (nextPos.has(n.id) ? { ...n, position: nextPos.get(n.id)! } : n));
    const groups = state.groups.map((g) => (
      g.id === groupId
        ? { ...g, position: { x: gx, y: gy }, width: Math.max(160, maxRight - gx + PAD), height: Math.max(120, maxBottom - gy + PAD) }
        : g
    ));
    const projectStateById = syncActiveProjectState(state, { nodes, groups }).projectStateById;
    return {
      nodes,
      groups,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  tidyCanvas: () => set((state) => {
    if (state.nodes.length === 0) return {};
    const undoStack = pushUndoState(state);

    const COL_GAP = 130;   // horizontal gap between layers
    const ROW_GAP = 64;    // vertical gap between nodes within a column
    const NODE_W = 300;    // BaseNode fixed content width
    const colStep = NODE_W + COL_GAP;

    const nodeById = new Map(state.nodes.map((n) => [n.id, n]));
    const heightOf = (id: string): number => {
      const n = nodeById.get(id) as (Node & { measured?: { height?: number } }) | undefined;
      return n?.measured?.height ?? n?.height ?? 220;
    };

    // Build incoming adjacency from edges (only between existing nodes).
    const incoming = new Map<string, string[]>();
    state.nodes.forEach((n) => incoming.set(n.id, []));
    state.edges.forEach((e) => {
      if (nodeById.has(e.source) && nodeById.has(e.target)) {
        incoming.get(e.target)!.push(e.source);
      }
    });

    // Longest-path layering: a node's column = max(column of predecessors)+1.
    // Cycle-guarded so a stray loop can't recurse forever.
    const layer = new Map<string, number>();
    const visiting = new Set<string>();
    const computeLayer = (id: string): number => {
      const cached = layer.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      let l = 0;
      for (const pred of incoming.get(id) ?? []) {
        l = Math.max(l, computeLayer(pred) + 1);
      }
      visiting.delete(id);
      layer.set(id, l);
      return l;
    };
    state.nodes.forEach((n) => computeLayer(n.id));

    // Group node ids by their column.
    const byLayer = new Map<number, string[]>();
    state.nodes.forEach((n) => {
      const l = layer.get(n.id) ?? 0;
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(n.id);
    });
    const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);

    // Total stacked height per column, to vertically center each one.
    const layerHeight = new Map<number, number>();
    layerKeys.forEach((l) => {
      const ids = byLayer.get(l)!;
      const h = ids.reduce((sum, id) => sum + heightOf(id) + ROW_GAP, -ROW_GAP);
      layerHeight.set(l, h);
    });
    const maxColHeight = Math.max(0, ...layerHeight.values());

    // Assign new positions. Keep each column's existing vertical order so
    // the layout doesn't scramble what the user already arranged.
    const newPos = new Map<string, { x: number; y: number }>();
    layerKeys.forEach((l) => {
      const ids = byLayer.get(l)!;
      ids.sort((a, b) => (nodeById.get(a)!.position.y) - (nodeById.get(b)!.position.y));
      const x = l * colStep;
      let y = (maxColHeight - layerHeight.get(l)!) / 2;
      ids.forEach((id) => {
        newPos.set(id, { x, y });
        y += heightOf(id) + ROW_GAP;
      });
    });

    const nodes = state.nodes.map((n) => ({ ...n, position: newPos.get(n.id) ?? n.position }));

    // Recompute each group rectangle to wrap its (newly laid out) members.
    const nodesAfter = new Map(nodes.map((n) => [n.id, n]));
    const groups = state.groups.map((group) => {
      const members = group.nodeIds.map((id) => nodesAfter.get(id)).filter(Boolean) as Node[];
      if (members.length === 0) return group;
      const bounds = computeGroupBounds(members);
      return { ...group, position: { x: bounds.x, y: bounds.y }, width: bounds.width, height: bounds.height };
    });

    const projectStateById = syncActiveProjectState(state, { nodes, groups }).projectStateById;
    return {
      nodes,
      groups,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  setActiveVersion: (nodeId, versionId) => set((state) => {
    const undoStack = pushUndoState(state);
    const nodes = state.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const data = (node.data ?? {}) as Record<string, unknown>;
      const versions = Array.isArray(data.versions) ? (data.versions as NodeVersion[]) : [];
      const target = versions.find((v) => v.id === versionId);
      if (!target) return node;
      // 当前 url 退到 versions 顶,target 提为当前.
      const currentUrl = typeof data.url === 'string' ? data.url : '';
      const currentSnapshot: NodeVersion | null = currentUrl ? {
        id: typeof data.activeVersionId === 'string' ? data.activeVersionId : `v-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        url: currentUrl,
        prompt: typeof data.prompt === 'string' ? data.prompt : undefined,
        model: typeof data.model === 'string' ? data.model : undefined,
        timestamp: typeof data.activeVersionTimestamp === 'number' ? data.activeVersionTimestamp : Date.now(),
      } : null;
      const restVersions = versions.filter((v) => v.id !== versionId);
      const nextVersions = currentSnapshot ? [currentSnapshot, ...restVersions] : restVersions;
      return {
        ...node,
        data: {
          ...data,
          url: target.url,
          output: target.url,
          prompt: target.prompt ?? data.prompt,
          model: target.model ?? data.model,
          activeVersionId: target.id,
          activeVersionTimestamp: target.timestamp,
          versions: nextVersions,
        },
      };
    });
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return { nodes, undoStack, projectStateById };
  }),
  updateNodeData: (nodeId, patch) => set((state) => {
    const undoStack = pushUndoState(state);
    const nodes = state.nodes.map((node) => (
      node.id !== nodeId
        ? node
        : {
            ...node,
            data: {
              ...(node.data ?? {}),
              ...patch,
            },
          }
    ));
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return {
      nodes,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  updateNodeGenerationParams: (nodeId, patch) => set((state) => {
    const undoStack = pushUndoState(state);
    const nodes = state.nodes.map((node) => (
      node.id !== nodeId
        ? node
        : {
            ...node,
            data: {
              ...(node.data ?? {}),
              generationParams: {
                ...((node.data as Record<string, unknown> | undefined)?.generationParams as NodeGenerationParams | undefined),
                ...patch,
              },
            },
          }
    ));
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return {
      nodes,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),

  activeRun: null,
  runNode: async (nodeId, payload) => {
    // 使用偏好「生成前确认」:先挂起请求弹确认窗,确认按钮带 skipConfirm
    // 重入。放在最前面 —— 确认之前不 abort 旧请求、不产生任何生成状态。
    if (get().confirmBeforeGenerate && !payload?.skipConfirm) {
      set((state) => ({
        pendingRunConfirm: [
          ...state.pendingRunConfirm.filter((p) => p.nodeId !== nodeId),
          { nodeId, payload: { prompt: payload.prompt, model: payload.model } },
        ],
      }));
      // 撤掉调用方的乐观 running 态 —— 提交按钮会先把节点置成 running 再
      // 调 runNode,这里不清掉的话确认之前节点就空转生成动画(没有真任务,
      // 轮询也永远不会来收尾)。
      const optimistic = get().nodes.find((n) => n.id === nodeId);
      if (optimistic && (optimistic.data as Record<string, unknown>)?.status === 'running') {
        get().updateNodeData(nodeId, { status: undefined, error: undefined, queuedAfterTimeout: false });
      }
      return;
    }
    // 新提交优先：如果同一个节点已有请求在跑，先中止旧请求并让新请求接管。
    // 不能直接 return，否则用户会看到按钮只闪一下但没有任何生成状态。
    if (runAborters[nodeId]) {
      runAborters[nodeId]?.abort();
      delete runAborters[nodeId];
    }
    const runToken = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    runTokens[nodeId] = runToken;
    const isCurrentRun = () => runTokens[nodeId] === runToken;
    const state = get();
    // Determine service type from the node type.
    const currentNode = state.nodes.find((n) => n.id === nodeId);
    const nodeType = currentNode?.type ?? '';
    const serviceTypeMap: Record<string, string> = {
      textNode: 'text',
      imageNode: 'image',
      panoramaNode: 'image',
      videoNode: 'video',
      audioNode: 'audio',
    };
    const serviceType = serviceTypeMap[nodeType] ?? 'text';

    const genParams = (currentNode?.data as Record<string, unknown> | undefined)?.generationParams as NodeGenerationParams | undefined;
    const rawReferenceMedia = genParams?.referenceImages?.length || genParams?.referenceVideo || genParams?.referenceVideos?.length
      ? {
          imageUrls: genParams.referenceImages ?? [],
          videoUrls: [
            ...(genParams.referenceVideo ? [genParams.referenceVideo] : []),
            ...(genParams.referenceVideos ?? []),
          ],
        }
      : collectUpstreamReferenceMedia(state.nodes, state.edges, nodeId);
    const referenceProvider = findReferenceProviderForRequest(
      state.backendModels,
      serviceType,
      payload.model,
      genParams?.vendor,
      rawReferenceMedia.imageUrls.length > 0,
    );
    const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
    const referenceMedia = normalizeReferenceMediaForProvider(rawReferenceMedia, referenceProvider, apiBaseUrl);
    if (
      serviceType === 'image'
      && usesPublicHttpReferenceImages(referenceProvider)
      && rawReferenceMedia.imageUrls.length > 0
      && referenceMedia.imageUrls.length !== rawReferenceMedia.imageUrls.length
    ) {
      const language = get().language;
      const error = language === 'zh'
        ? '当前模型需要公网可访问的参考图。请重新上传图片到 COS，或移除本地/旧上传引用后再生成。'
        : 'This model needs public reference image URLs. Re-upload the image to COS, or remove local/stale references before generating.';
      set((snapshot) => {
      const nodes = snapshot.nodes.map((node) => node.id === nodeId
          ? { ...node, data: { ...node.data, status: 'error', error } }
          : node);
      const projectStateById = syncActiveProjectState(snapshot, { nodes }).projectStateById;
      return {
        activeRun: null,
        nodes,
        projectStateById,
        ...syncActiveSpaceSnapshot(snapshot, { projectStateById }),
      };
    });
      return;
    }
    // "Connect = auto-reference": prepend the plain-text content of any upstream
    // 文本节点 wired into this node, so a connected text node feeds the prompt
    // without a manual @mention. Skipped when the text is already present in the
    // prompt (e.g. the user inlined it) to avoid duplication. The user's own
    // typed prompt is stored/displayed unchanged — only the RESOLVED prompt sent
    // to the backend carries the reference.
    const upstreamText = collectUpstreamText(state.nodes, state.edges, nodeId, payload.prompt);
    const effectivePrompt = upstreamText && !payload.prompt.includes(upstreamText)
      ? (payload.prompt.trim() ? `${upstreamText}\n\n${payload.prompt}` : upstreamText)
      : payload.prompt;
    const shouldStripMentions = serviceType === 'video'
      || serviceType === 'audio'
      || (serviceType === 'image' && referenceMedia.imageUrls.length > 0);
    // For media-generation routes that send structured references, strip @mentions
    // from the prompt instead of inlining raw upload paths.
    const strippedForMedia = shouldStripMentions
      ? effectivePrompt.replace(/@([a-zA-Z0-9_-]{1,12})/g, '').trim()
      : null;
    // When the prompt only contained @mentions, keep a sane natural-language fallback
    // so backend validation and third-party relays receive a usable prompt.
    // If the prompt only contained @mentions and is now empty, fall back to a sane default
    // so the backend `minLength:1` validator doesn't reject the call.
    const resolvedPrompt = strippedForMedia !== null
      ? (
        strippedForMedia
        || (serviceType === 'video'
          ? 'Generate a video from the provided reference media.'
          : serviceType === 'image'
            ? 'Generate an image using the provided reference media.'
            : 'Generate audio.')
      )
      : effectivePrompt.replace(/@([a-zA-Z0-9_-]{1,12})/g, (_match, ref) => {
          const upstreamNode = state.nodes.find((node) => node.id.startsWith(ref));
          if (!upstreamNode) return `@${ref}`;
          const data = (upstreamNode.data ?? {}) as Record<string, string>;
          return data.output ?? data.url ?? data.content ?? `@${ref}`;
        });

    // Get aspectRatio (used as size ratio) and resolution from generation params.
    // aspectRatio → ratio for size param (e.g. "16:9"), resolution → "1k"/"2k"/"4k"
    const aspectRatio = genParams?.aspectRatio ?? 'auto';
    // Resolution field might be "自适应·1K" or "1k" — normalize.
    // Preserve the ORIGINAL case of the 'p' / 'P' suffix: some providers
    // (DashScope / 阿里云 HappyHorse) reject lowercase `720p` with
    // "Input should be '1080P' or '720P'". The model templates declare the
    // capitalisation they want (e.g. HappyHorse declares "720P/1080P"),
    // so we just preserve whatever case was set; only fall back to
    // lowercase when there was no suffix at all.
    const rawRes = genParams?.resolution ?? '720p';
    const resolution = (() => {
      const text = rawRes.trim();
      const imageMatch = text.match(/([124])\s*k/i);
      if (serviceType === 'image' && imageMatch) return `${imageMatch[1]}K`;
      const videoMatch = text.match(/(\d{3,4})\s*([Pp])/) ?? text.match(/(\d{3,4})/);
      if (serviceType === 'video' && videoMatch) {
        const suffix = videoMatch[2] ?? 'p';
        return `${videoMatch[1]}${suffix}`;
      }
      return serviceType === 'image' ? '1K' : '720p';
    })();
    const quality = (genParams?.quality ?? 'auto').trim().toLowerCase() || 'auto';

    // ── Reference-mode resolution (video only) ──────────────────────────
    // Resolve the active reference mode from the capability registry, then
    // preflight-validate the upstream inputs BEFORE spending a request.
    // The backend reference_mode is derived from the chosen mode, not from
    // ad-hoc input counting. See reference-modes.ts.
    //
    // Models with NO declared referenceModes (e.g. HappyHorse t2v —
    // pure text-to-video) skip this block entirely. Calling modesForModel
    // on an empty / undefined input would fall back to ["multi-image"]
    // which then errors with "needs 1+ image" — wrong for text-only.
    let resolvedReferenceMode: string | undefined;
    if (serviceType === 'video') {
      const template = getModelTemplate(payload.model ?? '');
      const declared = template?.referenceModes;
      if (declared && declared.length > 0) {
        const counts = {
          images: referenceMedia.imageUrls.length,
          videos: referenceMedia.videoUrls.length,
        };
        const supported = modesForModel(declared);
        const persisted = genParams?.referenceVariant as ReferenceModeKey | undefined;
        // Pick the mode the same way the UI does: persisted choice when still
        // valid, else first satisfiable supported mode.
        const chosen: ReferenceModeKey | undefined =
          persisted && supported.includes(persisted) && isModeSatisfied(persisted, counts)
            ? persisted
            : (supported.find((k) => isModeSatisfied(k, counts)) ?? supported[0]);

        if (chosen) {
          const spec = REFERENCE_MODE_SPECS[chosen];
          // Preflight: if the chosen mode's input requirements aren't met,
          // surface the reason on the node and abort without a network call.
          if (!isModeSatisfied(chosen, counts)) {
            const lang = get().language;
            const hint = lang === 'zh' ? spec.disabledHint.zh : spec.disabledHint.en;
            set((snapshot) => {
          const nodes = snapshot.nodes.map((node) => node.id === nodeId
              ? { ...node, data: { ...node.data, status: 'error', error: hint } }
              : node);
          const projectStateById = syncActiveProjectState(snapshot, { nodes }).projectStateById;
          return {
            nodes,
            projectStateById,
            ...syncActiveSpaceSnapshot(snapshot, { projectStateById }),
          };
        });
            return;
          }
          resolvedReferenceMode = spec.backendMode;
        }
      }
    }

    // Set status to running — clear error but keep old url/content until new result arrives.
    // runningStartedAt is persisted on the node so NodeLoadingTimer can
    // resume from the original start time after a page refresh (instead of
    // counting from 0 each mount).
    const startedAt = Date.now();
    set((snapshot) => {
      const nodes = snapshot.nodes.map((node) => node.id === nodeId
        ? { ...node, data: { ...node.data, status: 'running', error: undefined, taskId: undefined, queuedAfterTimeout: false, output: undefined, content: undefined, prompt: payload.prompt, resolvedPrompt, model: payload.model, runningStartedAt: startedAt } }
        : node);
      const projectStateById = syncActiveProjectState(snapshot, { nodes }).projectStateById;
      return {
        activeRun: { nodeId, startedAt },
        nodes,
        projectStateById,
        ...syncActiveSpaceSnapshot(snapshot, { projectStateById }),
      };
    });

    // Video-specific: duration from genParams.
    const durationSeconds = genParams?.durationSeconds ?? undefined;

    const aborter = new AbortController();
    runAborters[nodeId] = aborter;
    const timeout = setTimeout(() => aborter.abort(), generationTimeoutMs);

    // Stable idempotency key for this submit (F6). Survives the whole
    // runNode call; if apiClient retries the POST under the hood, the same
    // request_id reaches the backend and dedupes to one task / one bill.
    const requestId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Active model's template — used to gate capability-scoped params (seed,
    // audio_setting) so a value that persisted from a previous model doesn't
    // ride along to a sibling that doesn't support it.
    const activeTemplate = getModelTemplate(payload.model ?? '');

    // Make sure the recovery poller is running. Idempotent — first call
    // wires up the interval, subsequent calls are no-ops.
    ensureTaskPollerStarted(get, set as never);
    trackedTaskNodes.add(nodeId);

    try {
      const result = await apiGenerate({
        node_id: nodeId,
        request_id: requestId,
        provider_config_id: referenceProvider?.id,
        service_type: serviceType,
        model: payload.model ?? '',
        prompt: resolvedPrompt,
        size: aspectRatio,
        resolution: serviceType === 'image' || serviceType === 'video' ? resolution : undefined,
        quality: serviceType === 'image' ? quality : undefined,
        edit_operation: genParams?.editOperation,
        mask_image: genParams?.maskImage,
        output_count: genParams?.outputCount,
        expand_direction: genParams?.expandDirection,
        derive_from_node_id: genParams?.deriveFromNodeId,
        trim_range: genParams?.trimRange,
        crop_rect: genParams?.cropRect,
        target_tracks: genParams?.targetTracks,
        output_format: genParams?.outputFormat,
        parameters: genParams?.outputFormat ? { output_format: genParams.outputFormat } : undefined,
        duration: durationSeconds,
        aspect_ratio: serviceType === 'video' ? aspectRatio : undefined,
        reference_images: referenceMedia.imageUrls.length > 0 ? referenceMedia.imageUrls : undefined,
        // For video, the mode comes from the capability registry (resolved
        // above). For image, keep the legacy auto/image_reference heuristic.
        reference_mode: serviceType === 'video'
          ? resolvedReferenceMode
          : (referenceMedia.imageUrls.length > 0
            ? (referenceMedia.videoUrls.length > 0 ? 'image_reference' : 'auto')
            : undefined),
        reference_video: referenceMedia.videoUrls.length === 1 ? referenceMedia.videoUrls[0] : undefined,
        reference_videos: referenceMedia.videoUrls.length > 1 ? referenceMedia.videoUrls : undefined,
        // Gate on the ACTIVE model's declared capability so a stale value set
        // on a previous model (genParams persists across model switches) never
        // rides along to a sibling that doesn't support it. audio_setting only
        // for templates that expose it (video-edit); seed only for supportsSeed.
        // 兜底到首个选项:UI 把 options[0] 显示为默认激活态(如可灵默认
        // 生成音效),不兜底的话用户没点过开关时请求里就没有这个字段,
        // 后端默认可能和 UI 显示相反。
        audio_setting: serviceType === 'video' && activeTemplate?.audioSettingOptions?.length
          ? (genParams?.audioSetting ?? activeTemplate.audioSettingOptions[0])
          : undefined,
        seed: (serviceType === 'video' || serviceType === 'image') && activeTemplate?.supportsSeed && typeof genParams?.seed === 'number' ? genParams.seed : undefined,
        // wan2.7 组图 (grid) mode → the backend sets enable_sequential so one
        // request yields up to 12 images. Gated to the image 组图 tab.
        enable_sequential: serviceType === 'image' && genParams?.referenceVariant === 'wan-group' ? true : undefined,
      }, aborter.signal);

      if (!isCurrentRun()) return;

      if (result.type === 'queued') {
        set((snapshot) => {
          const nodes = snapshot.nodes.map((node) => node.id === nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  status: 'running',
                  taskId: result.task_id,
                  queuedAfterTimeout: true,
                  taskPhase: 'queued',
                  error: undefined,
                },
              }
            : node);
          const projectStateById = syncActiveProjectState(snapshot, { nodes }).projectStateById;
          return {
            activeRun: { nodeId, startedAt, timedOut: true },
            nodes,
            projectStateById,
            ...syncActiveSpaceSnapshot(snapshot, { projectStateById }),
          };
        });
        if (result.task_id) {
          void getTask(result.task_id)
            .then((task) => applyTaskResultToNode(task, get, set as never))
            .catch((err) => {
              // eslint-disable-next-line no-console
              console.warn('[runNode] initial queued task lookup failed', { taskId: result.task_id, error: err });
            });
        }
        return;
      }

      const persistedContent = await persistGeneratedMediaUrl(result);
      if (!isCurrentRun()) return;

      // Hard guard: don't pretend success when the backend returned an
      // empty payload — that produces a `<img src="">` and looks like
      // "click, blue flash, nothing" to the user. Log the actual response
      // shape so we can tell why it came back empty.
      if (!result.content || !persistedContent) {
        // eslint-disable-next-line no-console
        console.error('[runNode] empty result from backend', {
          nodeId,
          resultType: result.type,
          resultContentLength: result.content?.length ?? 0,
          persistedLength: persistedContent?.length ?? 0,
          task_id: result.task_id,
        });
        const message = get().language === 'zh'
          ? '生成请求返回了空结果（type=' + result.type + '）。请检查模型配置或在管理端日志查看任务详情。'
          : 'Backend returned an empty result (type=' + result.type + '). Check the model config or admin task logs.';
        set((snapshot) => {
          const nodes = snapshot.nodes.map((node) => node.id === nodeId
            ? { ...node, data: { ...node.data, status: 'error', error: message, taskId: result.task_id } }
            : node);
          const projectStateById = syncActiveProjectState(snapshot, { nodes }).projectStateById;
          return {
            activeRun: null,
            nodes,
            projectStateById,
            ...syncActiveSpaceSnapshot(snapshot, { projectStateById }),
          };
        });
        trackedTaskNodes.delete(nodeId);
        return;
      }

      set((snapshot) => {
        const nodes = snapshot.nodes.map((node) => {
          if (node.id !== nodeId) return node;
          // 把旧 url 压进 versions[]、新 url 提升为当前. 跟
          // applyTaskResultToNode 同样的语义,保证两条成功路径
          // (同步路径 + SSE / 轮询恢复路径) 都维护历史.
          const prevData = (node.data ?? {}) as Record<string, unknown>;
          const isUrlResult = result.type === 'url';
          let nextVersions: NodeVersion[] | undefined;
          let nextActiveVersionId: string | undefined;
          const nextTs = Date.now();
          if (isUrlResult) {
            const prevUrl = typeof prevData.url === 'string' ? prevData.url : '';
            const existing = Array.isArray(prevData.versions) ? (prevData.versions as NodeVersion[]) : [];
            if (prevUrl && prevUrl !== persistedContent) {
              const snap: NodeVersion = {
                id: typeof prevData.activeVersionId === 'string' ? prevData.activeVersionId as string : `v-${nextTs - 1}-${Math.random().toString(36).slice(2, 6)}`,
                url: prevUrl,
                prompt: typeof prevData.prompt === 'string' ? prevData.prompt as string : payload.prompt,
                model: typeof prevData.model === 'string' ? prevData.model as string : payload.model,
                timestamp: typeof prevData.activeVersionTimestamp === 'number' ? prevData.activeVersionTimestamp as number : nextTs - 1,
              };
              nextVersions = [snap, ...existing];
            } else {
              nextVersions = existing;
            }
            nextActiveVersionId = `v-${nextTs}-${Math.random().toString(36).slice(2, 6)}`;
          }
          return {
            ...node,
            data: {
              ...node.data,
              status: 'done',
              sourceKind: (currentNode?.data as Record<string, unknown> | undefined)?.derivedFromNodeId
                ? ((currentNode?.data as Record<string, unknown> | undefined)?.sourceKind ?? 'derived')
                : (serviceType === 'image' || serviceType === 'video' ? 'generated' : (node.data as Record<string, unknown> | undefined)?.sourceKind),
              taskId: result.task_id,
              queuedAfterTimeout: false,
              error: undefined,
              ...(isUrlResult
                ? {
                    url: persistedContent,
                    output: persistedContent,
                    originalUrl: result.content,
                    versions: nextVersions,
                    activeVersionId: nextActiveVersionId,
                    activeVersionTimestamp: nextTs,
                    prompt: payload.prompt,
                    model: payload.model,
                  }
                : { content: result.content, output: result.content }),
            },
          };
        });
        // Multi-image sync result (wan2.7 组图 / n>1): fan the extra assets out
        // as sibling image nodes (same behavior as the SSE/poller path).
        const withExtras = serviceType === 'image' && (result.content_list?.length ?? 0) > 1
          ? [...nodes, ...buildExtraImageNodes(nodes.find((n) => n.id === nodeId), nodes, result.content_list as string[], result.task_id ?? nodeId)]
          : nodes;
        const projectStateById = syncActiveProjectState(snapshot, { nodes: withExtras }).projectStateById;
        return {
          activeRun: null,
          nodes: withExtras,
          projectStateById,
          ...syncActiveSpaceSnapshot(snapshot, { projectStateById }),
        };
      });
      trackedTaskNodes.delete(nodeId);

      // Add to history for the file manager panel.
      get().addHistory({
        id: `gen-${Date.now()}`,
        title: payload.prompt.slice(0, 60),
        type: serviceType,
        mediaType: serviceType as 'text' | 'image' | 'video' | 'audio',
        timestamp: Date.now(),
        thumbnail: result.type === 'url' ? persistedContent : undefined,
        content: result.type === 'text' ? result.content : undefined,
        promptExcerpt: payload.prompt.slice(0, 120),
        sourceNodeId: (currentNode?.data as Record<string, unknown> | undefined)?.derivedFromNodeId as string | undefined,
        derivationAction: (currentNode?.data as Record<string, unknown> | undefined)?.derivationAction as string | undefined,
      });
    } catch (err: unknown) {
      if (!isCurrentRun()) return;
      // eslint-disable-next-line no-console
      console.error('[runNode] generation request failed', { nodeId, error: err });
      const message = getGenerationErrorMessage(err, get().language);
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      const isTimeoutLike = isAbort || /timeout|timed out|aborted|deadline/i.test(message);

      if (isTimeoutLike) {
        // Client gave up but backend Stage-1 task may still finish.
        // Leave status='running' and flag queuedAfterTimeout so the
        // loading overlay can swap to "已加入队列" copy. Cleared when
        // the recovery poller / SSE event flips the node to done/error.
        set((snapshot) => {
          const nodes = snapshot.nodes.map((node) => node.id === nodeId
            ? { ...node, data: { ...node.data, status: 'running', queuedAfterTimeout: true, error: undefined } }
            : node);
          const projectStateById = syncActiveProjectState(snapshot, { nodes }).projectStateById;
          return {
            activeRun: null,
            nodes,
            projectStateById,
            ...syncActiveSpaceSnapshot(snapshot, { projectStateById }),
          };
        });
      } else {
        // Real, non-timeout failure (4xx, network down, etc.). Surface
        // the error directly and stop tracking.
        if (isInsufficientCreditsError(err)) {
          toast.warning(message, { id: 'insufficient-credits', duration: 3200 });
        }
        set((snapshot) => {
          const nodes = snapshot.nodes.map((node) => node.id === nodeId
            ? { ...node, data: { ...node.data, status: 'error', error: message } }
            : node);
          const projectStateById = syncActiveProjectState(snapshot, { nodes }).projectStateById;
          return {
            activeRun: null,
            nodes,
            projectStateById,
            ...syncActiveSpaceSnapshot(snapshot, { projectStateById }),
          };
        });
        trackedTaskNodes.delete(nodeId);
      }
    } finally {
      clearTimeout(timeout);
      if (isCurrentRun()) {
        delete runAborters[nodeId];
        delete runTokens[nodeId];
      }
    }
  },
  cancelNode: (nodeId) => {
    runAborters[nodeId]?.abort();
    delete runAborters[nodeId];
    set((state) => {
      // 一并清掉任务引用：留着 taskId 的话轮询协调器会把节点重新挂回任务、
      // 孤儿恢复还会在完成时把结果塞回来 — 取消就白点了。
      const nodes = state.nodes.map((node) => node.id === nodeId
        ? { ...node, data: { ...node.data, status: 'idle', taskId: undefined, queuedAfterTimeout: false, taskPhase: undefined } }
        : node);
      const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
      return {
        activeRun: state.activeRun?.nodeId === nodeId ? null : state.activeRun,
        nodes,
        projectStateById,
        ...syncActiveSpaceSnapshot(state, { projectStateById }),
      };
    });
  },

  shortcuts: { ...DEFAULT_SHORTCUTS },
  setShortcut: (action, combo) => set((state) => ({ shortcuts: { ...state.shortcuts, [action]: combo } })),
  resetShortcuts: () => set({ shortcuts: { ...DEFAULT_SHORTCUTS } }),

  isSettingsOpen: false,
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),

  confirmBeforeGenerate: false,
  setConfirmBeforeGenerate: (v) => set({ confirmBeforeGenerate: v }),
  pendingRunConfirm: [],
  setPendingRunConfirm: (v) => set({ pendingRunConfirm: v }),

  isTaskQueueCollapsed: false,
  setTaskQueueCollapsed: (value) => set({ isTaskQueueCollapsed: value }),
  showMiniMap: false,
  setShowMiniMap: (value) => set({ showMiniMap: value }),
  snapToGrid: false,
  setSnapToGrid: (value) => set({ snapToGrid: value }),
  isConnectionDragging: false,
  setConnectionDragging: (value) => set({ isConnectionDragging: value }),
}), {
  name: 'cineflow-store',
  // Object-level storage with a trailing debounce: stringify + localStorage
  // write happen at most once per 400ms (and on pagehide), not once per set().
  storage: debouncedJSONStorage as never,
  version: 5,
  migrate: (persistedState: any, version) => {
    if (!persistedState) {
      return persistedState;
    }

    if (version < 4) {
      const fallbackNodes = Array.isArray(persistedState.nodes) ? persistedState.nodes : initialNodes;
      const fallbackEdges = Array.isArray(persistedState.edges) ? persistedState.edges : initialEdges;
      const fallbackGroups = Array.isArray(persistedState.groups) ? persistedState.groups : [];
      const fallbackProjects = Array.isArray(persistedState.projects) && persistedState.projects.length > 0
        ? persistedState.projects.map((project: Project) => ({
          ...project,
          updatedAt: project.updatedAt ?? project.createdAt ?? Date.now(),
        }))
        : [{ id: 'p-default', name: 'Untitled', createdAt: Date.now(), updatedAt: Date.now() }];
      const activeProjectId = persistedState.activeProjectId ?? fallbackProjects[0].id;

      return sanitizePersistedAppState({
        ...persistedState,
        spaces: persistedState.spaces ?? seedSpaces,
        activeSpaceId: persistedState.activeSpaceId ?? 'space-personal',
        activeSpaceType: persistedState.activeSpaceType ?? 'personal',
        projects: fallbackProjects,
        activeProjectId,
        projectStateById: {
          [activeProjectId]: createCanvasSnapshot(fallbackNodes, fallbackEdges, fallbackGroups),
        },
        spaceSnapshotsById: {
          'space-personal': createSpaceSnapshot(
            fallbackProjects,
            activeProjectId,
            { [activeProjectId]: createCanvasSnapshot(fallbackNodes, fallbackEdges, fallbackGroups) },
            Array.isArray(persistedState.history) ? persistedState.history : [],
          ),
          'space-team-alpha': seedSpaceSnapshotsById['space-team-alpha'],
          'space-team-studio': seedSpaceSnapshotsById['space-team-studio'],
        },
        history: Array.isArray(persistedState.history) ? persistedState.history : [],
        spaceMembers: persistedState.spaceMembers ?? seedSpaceMembers,
        invitations: persistedState.invitations ?? seedInvitations,
      });
    }

    if (version < 5) {
      return sanitizePersistedAppState(persistedState);
    }

    return sanitizePersistedAppState(persistedState);
  },
  merge: (persistedState, currentState) => ({
    ...currentState,
    ...(persistedState && typeof persistedState === 'object'
      ? sanitizePersistedAppState(persistedState as Partial<AppState>)
      : {}),
  }),
  partialize: (state) => {
    // During a drag/resize gesture, skip the expensive strip/clone pass and
    // reuse the last snapshot — the debounced storage discards intermediate
    // writes anyway, and the gesture's final set() recomputes fresh.
    if (canvasInteractionActive && lastPartializedSnapshot) {
      return lastPartializedSnapshot as never;
    }
    const snapshot = {
      language: state.language,
      theme: state.theme,
      spaces: state.spaces,
      activeSpaceId: state.activeSpaceId,
      activeSpaceType: state.activeSpaceType,
      spaceSnapshotsById: stripHeavyFromSpaceSnapshots(state.spaceSnapshotsById),
      nodes: stripHeavyFromNodes(state.nodes),
      edges: state.edges,
      history: stripHeavyFromHistory(state.history),
      projects: state.projects,
      activeProjectId: state.activeProjectId,
      // 刷新后 loadBackendProjects 用它恢复"上次所在项目"(不再跳回第一个)。
      activeBackendProjectId: state.activeBackendProjectId,
      projectStateById: stripHeavyFromProjectStateById(state.projectStateById),
      spaceMembers: state.spaceMembers,
      invitations: state.invitations,
      groups: state.groups,
      savedAssets: stripHeavyFromSavedAssets(state.savedAssets),
      shortcuts: state.shortcuts,
      isTaskQueueCollapsed: state.isTaskQueueCollapsed,
      showMiniMap: state.showMiniMap,
      snapToGrid: state.snapToGrid,
      // 使用偏好(storage key 按用户隔离,天然每用户独立)。
      confirmBeforeGenerate: state.confirmBeforeGenerate,
    };
    lastPartializedSnapshot = snapshot;
    return snapshot;
  },
}));

// Boot the recovery poller once the store exists. Safe to call before any
// runNode: it just ticks every 8s and finds nothing to do until a node
// hits 'running' state. After a page reload, any node that was running
// at refresh time gets picked up automatically on the first tick.
ensureTaskPollerStarted(useStore.getState, useStore.setState as never);
// Open the SSE stream so completion events arrive in real time. The
// poller still runs as a low-frequency reconciliation safety net.
ensureTaskStreamStarted(useStore.getState, useStore.setState as never);
// Re-bind any server-side in-flight tasks to their nodes (F10), covering
// localStorage wipes / a different browser where the persisted node
// snapshot no longer reflects what's actually running.
void hydrateActiveTasks(useStore.getState, useStore.setState as never);
