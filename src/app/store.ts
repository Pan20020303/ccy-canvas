import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
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
import { batchTasksByNodeIds, getTask, type TaskItem } from './api/tasks';
import type { BackendProject } from './api/projects';
import { createProject as apiCreateProject, getCanvas, listProjects, saveCanvas, uploadFile } from './api/projects';
import {
  buildCanvasClipboardSelection,
  remapClipboardSelectionForPaste,
  type CanvasClipboardSelection,
} from './canvas-clipboard';
import { computeGroupBounds } from './group-routing';
import { clearReferencePayloadValue, getReferencePayloadValue, isTransientBrowserMediaUrl, resolveBackendAssetUrl } from './reference-media';
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
};
type ProjectCanvasState = { nodes: Node[]; edges: Edge[]; groups: Group[] };

export type SavedAssetCategory = 'character' | 'scene' | 'object' | 'style' | 'sound' | 'project' | 'other';

export type SavedAsset = {
  id: string;
  name: string;
  category: SavedAssetCategory;
  thumbnail: string;
  url: string;
  kind: 'image' | 'video' | 'text';
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
  loadBackendProjects: () => Promise<void>;
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
  // Multi-node layout actions (operate on currently `selected: true` nodes).
  // No-op when fewer than 2 nodes are selected. Alignment snaps every
  // selected node to a shared edge; distribute spreads them evenly.
  alignSelectedNodes: (mode: 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom') => void;
  distributeSelectedNodes: (axis: 'horizontal' | 'vertical') => void;
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
  pushUndoSnapshot: () => void;
  undoCanvas: () => void;
  copiedCanvasSelection: CanvasClipboardSelection | null;
  copySelectedNodes: () => void;
  pasteCopiedNodes: () => void;
  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  updateNodeGenerationParams: (nodeId: string, patch: Partial<NodeGenerationParams>) => void;
  runNode: (nodeId: string, payload: { prompt: string; model?: string }) => void;
  cancelNode: (nodeId: string) => void;
  activeRun: { nodeId: string; startedAt: number; timedOut?: boolean } | null;
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
  redo: 'Shift+Ctrl+Z',
  delete_node: 'D',
  select_all: 'Ctrl+A',
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

const pushUndoState = (state: AppState) => [...state.undoStack, cloneCanvasState(state)];

const shouldCaptureNodeChangesForUndo = (changes: NodeChange[]) =>
  changes.some((change) => change.type !== 'select');

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

const createReferenceNodeFromHistoryItem = (
  item: HistoryItem,
  index: number,
): Node | null => {
  const type = item.mediaType === 'image'
    ? 'referenceImageNode'
    : item.mediaType === 'video'
      ? 'referenceVideoNode'
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
const generationTimeoutMs = 900 * 1000;

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

/** Apply a task lookup result back onto its node. Called from the poller
 *  for each non-pending row the backend returns. */
function applyTaskResultToNode(task: TaskItem, getStore: () => AppState, setStore: (updater: (state: AppState) => Partial<AppState>) => void) {
  if (task.status !== 'success' && task.status !== 'error') {
    return; // still pending — leave node alone
  }
  const targetNode = getStore().nodes.find((n) => n.id === task.node_id);
  if (!targetNode) {
    trackedTaskNodes.delete(task.node_id);
    return;
  }
  const targetData = targetNode.data as Record<string, unknown>;
  const currentStatus = targetData?.status;
  const queuedAfterTimeout = targetData?.queuedAfterTimeout === true;
  const isSameQueuedTask = queuedAfterTimeout && (!targetData?.taskId || targetData.taskId === task.id);
  if (currentStatus !== 'running' && currentStatus !== 'generating' && !isSameQueuedTask) {
    // The node has already moved on (user ran a new generation, or the
    // success path already handled it). Drop tracking and skip.
    trackedTaskNodes.delete(task.node_id);
    return;
  }

  setStore((state) => ({
    nodes: state.nodes.map((node) => {
      if (node.id !== task.node_id) return node;
      const isUrl = task.service_type === 'image' || task.service_type === 'video' || task.service_type === 'audio';
      if (task.status === 'success') {
        return {
          ...node,
          data: {
            ...node.data,
            status: 'done',
            taskId: task.id,
            queuedAfterTimeout: false,
            ...(isUrl
              ? { url: task.result_url, output: task.result_url }
              : { content: task.result_url, output: task.result_url }),
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
          error: task.error_msg || 'Generation failed',
        },
      };
    }),
  }));
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
  const runningNodeIds = getStore().nodes
    .filter((n) => {
      const data = n.data as Record<string, unknown>;
      const status = data?.status;
      return status === 'running' || status === 'generating' || data?.queuedAfterTimeout === true;
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
    requests.push(batchTasksByNodeIds(withoutTaskId).catch(() => []));
  }
  for (const taskId of withTaskId) {
    requests.push(getTask(taskId).then((t) => [t]).catch(() => []));
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

let storageUserId = '';

function storageKey(name: string): string {
  return storageUserId ? `${name}-${storageUserId}` : name;
}

/** Strip large inline payloads from a single node's data before persisting.
 *  Keeps the canvas snapshot small enough to fit in localStorage (5MB).
 *  Network-hosted URLs are kept; data URLs / base64 are dropped. */
function stripHeavyFromNodeData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const key of ['url', 'thumbnail', 'poster'] as const) {
    const value = out[key];
    if (typeof value === 'string' && isTransientBrowserMediaUrl(value)) {
      out[key] = '';
    }
  }
  return out;
}

function stripHeavyFromNodes(nodes: Node[]): Node[] {
  return nodes.map((node) => ({ ...node, data: stripHeavyFromNodeData(node.data) as never }));
}

function stripHeavyFromHistory(history: HistoryItem[]): HistoryItem[] {
  return history.map((item) => ({
    ...item,
    thumbnail: isTransientBrowserMediaUrl(item.thumbnail) ? '' : item.thumbnail,
    content: item.mediaType === 'text'
      ? item.content
      : isTransientBrowserMediaUrl(item.content)
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
    savedAssets: Array.isArray(persistedState.savedAssets)
      ? persistedState.savedAssets.map((asset) => ({
          ...asset,
          thumbnail: isTransientBrowserMediaUrl(asset.thumbnail) ? '' : asset.thumbnail,
          url: isTransientBrowserMediaUrl(asset.url) ? '' : asset.url,
        }))
      : persistedState.savedAssets,
  };
}

let storageQuotaWarned = false;
export const appStorage = {
  getItem: (name: string) => localStorage.getItem(storageKey(name)),
  setItem: (name: string, value: string) => {
    try {
      localStorage.setItem(storageKey(name), value);
    } catch (err) {
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
  storageUserId = userId;
  useStore.persist.rehydrate();
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
    // Prefer the backend-relative path (/uploads/...) so the backend can read
    // the file from disk and convert it for external providers like Sora.
    const rawUrl = typeof data.url === 'string' ? data.url : '';
    const uploadsPath = rawUrl.match(/\/uploads\/[^\s?#]+/)?.[0] ?? '';
    const url = uploadsPath || getReferencePayloadValue(node.id, data);
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
    imageUrls: referenceMedia.imageUrls.map((url) => resolveBackendAssetUrl(url, apiBaseUrl)),
  };
}

function findReferenceProviderForRequest(
  providers: AppProviderConfig[],
  serviceType: string,
  model: string | undefined,
  preferredVendor: string | undefined,
): AppProviderConfig | null {
  const matchingProviders = providers.filter((provider) =>
    provider.service_type === serviceType
    && (!model || provider.model_list.includes(model)),
  );
  const preferredProvider = matchingProviders.find((provider) => preferredVendor && provider.vendor === preferredVendor);
  if (usesPublicHttpReferenceImages(preferredProvider)) {
    return preferredProvider ?? null;
  }
  return matchingProviders.find(usesPublicHttpReferenceImages) ?? preferredProvider ?? matchingProviders[0] ?? null;
}

async function persistGeneratedMediaUrl(result: GenerateResult): Promise<string> {
  if (result.type !== 'url') {
    return result.content;
  }

  const isPersistableRemoteAsset = result.content.startsWith('data:') || /^https?:\/\//.test(result.content);
  if (!isPersistableRemoteAsset) {
    return result.content;
  }

  // For remote http(s) URLs, route through the backend proxy. A direct
  // browser fetch often fails on third-party provider hosts due to CORS /
  // referer / mixed-content rules, which would leave the node with an
  // unrenderable remote URL. The proxy strips those constraints and gives
  // us a same-origin blob we can re-upload as a stable /uploads/ asset.
  const isRemoteHttp = /^https?:\/\//.test(result.content);
  const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
  const fetchURL = isRemoteHttp
    ? `${apiBase}/api/app/proxy-media?url=${encodeURIComponent(result.content)}`
    : result.content;

  try {
    const response = await fetch(fetchURL, { credentials: isRemoteHttp ? 'include' : 'same-origin' });
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    const blob = await response.blob();
    const extension = blob.type.startsWith('image/png')
      ? 'png'
      : blob.type.startsWith('image/webp')
        ? 'webp'
        : blob.type.startsWith('image/jpeg')
          ? 'jpg'
          : blob.type.startsWith('video/mp4')
            ? 'mp4'
            : 'bin';
    const uploaded = await uploadFile(blob, `generated-${Date.now()}.${extension}`);
    return uploaded.url;
  } catch {
    return result.content;
  }
}

export const useStore = create<AppState>()(persist((set, get) => ({
  language: 'zh',
  toggleLanguage: () => set((state) => ({ language: state.language === 'en' ? 'zh' : 'en' })),

  theme: 'dark' as Theme,
  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),

  spaces: seedSpaces,
  activeSpaceId: 'space-personal',
  activeSpaceType: 'personal',
  spaceSnapshotsById: seedSpaceSnapshotsById,
  nodes: seedSpaceSnapshotsById['space-personal'].projectStateById[seedSpaceSnapshotsById['space-personal'].activeProjectId].nodes,
  edges: seedSpaceSnapshotsById['space-personal'].projectStateById[seedSpaceSnapshotsById['space-personal'].activeProjectId].edges,
  undoStack: [],
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
      const undoStack = shouldCaptureNodeChangesForUndo(changes) ? pushUndoState(state) : state.undoStack;
      const projectStateById = syncActiveProjectState(state, { nodes, groups }).projectStateById;
      return {
        nodes,
        groups,
        undoStack,
        projectStateById,
        ...syncActiveSpaceSnapshot(state, { projectStateById }),
      };
    });
  },

  onEdgesChange: (changes: EdgeChange[]) => {
    set((state) => {
      const edges = applyEdgeChanges(changes, state.edges);
      const undoStack = shouldCaptureEdgeChangesForUndo(changes) ? pushUndoState(state) : state.undoStack;
      const projectStateById = syncActiveProjectState(state, { edges }).projectStateById;
      return {
        edges,
        undoStack,
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
  addHistory: (item) => set((state) => ({
    history: [normalizeHistoryItem(item, state.activeSpaceId, state.activeSpaceType, state.activeProjectId), ...state.history].slice(0, 200),
    ...syncActiveSpaceSnapshot(state, {
      history: [normalizeHistoryItem(item, state.activeSpaceId, state.activeSpaceType, state.activeProjectId), ...state.history].slice(0, 200),
    }),
  })),
  removeHistoryItems: (ids) => set((state) => {
    const idSet = new Set(ids);
    const history = state.history.filter((item) => !idSet.has(item.id));
    return {
      history,
      ...syncActiveSpaceSnapshot(state, { history }),
    };
  }),
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

  loadBackendProjects: async () => {
    set({ backendSyncing: true });
    try {
      const projects = await listProjects();
      if (projects.length === 0) return;
      const first = projects[0];
      set({ backendProjects: projects, activeBackendProjectId: first.id });
      // Load canvas for the first/active project.
      try {
        const canvas = await getCanvas(first.id);
        set((state) => {
          const rawNodes = Array.isArray(canvas.nodes) ? (canvas.nodes as Node[]) : state.nodes;
          // Clear stale running/error status from persisted nodes.
          const nodes = rawNodes.map((n) => {
            const d = n.data as Record<string, unknown> | undefined;
            if (d?.status === 'running' || d?.status === 'generating') {
              return { ...n, data: { ...d, status: 'idle', error: undefined } };
            }
            return n;
          });
          const edges = Array.isArray(canvas.edges) ? (canvas.edges as Edge[]) : state.edges;
          const projectStateById = {
            ...state.projectStateById,
            [first.id]: createCanvasSnapshot(nodes, edges, state.groups),
          };
          return {
            nodes,
            edges,
            activeProjectId: first.id,
            projectStateById,
            undoStack: [],
            copiedCanvasSelection: null,
          };
        });
      } catch {
        // Canvas not yet saved — keep local state.
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
        await saveCanvas(state.activeBackendProjectId, state.nodes, state.edges);
      } catch {
        // Non-fatal — continue switching.
      }
    }
    set({ activeBackendProjectId: id, backendSyncing: true });
    try {
      const canvas = await getCanvas(id);
      const rawNodes = Array.isArray(canvas.nodes) ? (canvas.nodes as Node[]) : [];
      const nodes = rawNodes.map((n) => {
        const d = n.data as Record<string, unknown> | undefined;
        if (d?.status === 'running' || d?.status === 'generating') {
          return { ...n, data: { ...d, status: 'idle', error: undefined } };
        }
        return n;
      });
      const edges = Array.isArray(canvas.edges) ? (canvas.edges as Edge[]) : [];
      set((state) => ({
        nodes,
        edges,
        groups: [],
        undoStack: [],
        copiedCanvasSelection: null,
        activeProjectId: id,
        projectStateById: {
          ...state.projectStateById,
          [id]: createCanvasSnapshot(nodes, edges, []),
        },
      }));
    } catch {
      // Canvas not yet saved — load empty canvas.
      set({ nodes: [], edges: [], groups: [], activeProjectId: id, undoStack: [], copiedCanvasSelection: null });
    } finally {
      set({ backendSyncing: false });
    }
  },

  saveCanvasToBackend: async (options) => {
    const { activeBackendProjectId, nodes, edges } = get();
    if (!activeBackendProjectId) return;
    // Strip transient runtime status before persisting so reloads don't show stale running state.
    const cleanNodes = nodes.map((n) => {
      const d = n.data as Record<string, unknown> | undefined;
      if (d?.status === 'running' || d?.status === 'generating') {
        return { ...n, data: { ...d, status: 'idle', error: undefined } };
      }
      return n;
    });
    try {
      await saveCanvas(activeBackendProjectId, cleanNodes, edges, options);
    } catch {
      // Silent — save errors should not interrupt the user.
    }
  },

  spaceMembers: seedSpaceMembers,
  invitations: seedInvitations,

  groups: seedSpaceSnapshotsById['space-personal'].projectStateById[seedSpaceSnapshotsById['space-personal'].activeProjectId].groups,
  pushUndoSnapshot: () => set((state) => ({
    undoStack: pushUndoState(state),
  })),
  undoCanvas: () => set((state) => {
    const previous = state.undoStack.at(-1);
    if (!previous) return {};

    const undoStack = state.undoStack.slice(0, -1);
    const projectStateById = syncActiveProjectState(state, previous).projectStateById;
    return {
      nodes: previous.nodes,
      edges: previous.edges,
      groups: previous.groups,
      undoStack,
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
    set((state) => ({ savedAssets: [created, ...state.savedAssets] }));
    return created;
  },
  removeAsset: (id) => set((state) => ({ savedAssets: state.savedAssets.filter((asset) => asset.id !== id) })),
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
    const projectStateById = syncActiveProjectState(state, { nodes, groups }).projectStateById;

    return {
      nodes,
      groups,
      undoStack,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
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
    const state = get();
    // Determine service type from the node type.
    const currentNode = state.nodes.find((n) => n.id === nodeId);
    const nodeType = currentNode?.type ?? '';
    const serviceTypeMap: Record<string, string> = {
      textNode: 'text',
      imageNode: 'image',
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
    );
    const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
    const referenceMedia = normalizeReferenceMediaForProvider(rawReferenceMedia, referenceProvider, apiBaseUrl);
    const shouldStripMentions = serviceType === 'video'
      || serviceType === 'audio'
      || (serviceType === 'image' && referenceMedia.imageUrls.length > 0);
    // For media-generation routes that send structured references, strip @mentions
    // from the prompt instead of inlining raw upload paths.
    const strippedForMedia = shouldStripMentions
      ? payload.prompt.replace(/@([a-zA-Z0-9_-]{1,12})/g, '').trim()
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
      : payload.prompt.replace(/@([a-zA-Z0-9_-]{1,12})/g, (_match, ref) => {
          const upstreamNode = state.nodes.find((node) => node.id.startsWith(ref));
          if (!upstreamNode) return `@${ref}`;
          const data = (upstreamNode.data ?? {}) as Record<string, string>;
          return data.output ?? data.url ?? data.content ?? `@${ref}`;
        });

    // Get aspectRatio (used as size ratio) and resolution from generation params.
    // aspectRatio → ratio for size param (e.g. "16:9"), resolution → "1k"/"2k"/"4k"
    const aspectRatio = genParams?.aspectRatio ?? 'auto';
    // Resolution field might be "自适应·1K" or "1k" — normalize.
    const rawRes = genParams?.resolution ?? '720p';
    const resolution = (() => {
      const text = rawRes.trim();
      const imageMatch = text.match(/([124])\s*k/i);
      if (serviceType === 'image' && imageMatch) return `${imageMatch[1]}K`;
      const videoMatch = text.match(/(\d{3,4})\s*p/i) ?? text.match(/(\d{3,4})/);
      if (serviceType === 'video' && videoMatch) return `${videoMatch[1]}p`;
      return serviceType === 'image' ? '1K' : '720p';
    })();
    const quality = (genParams?.quality ?? 'auto').trim().toLowerCase() || 'auto';

    // ── Reference-mode resolution (video only) ──────────────────────────
    // Resolve the active reference mode from the capability registry, then
    // preflight-validate the upstream inputs BEFORE spending a request.
    // The backend reference_mode is derived from the chosen mode, not from
    // ad-hoc input counting. See reference-modes.ts.
    let resolvedReferenceMode: string | undefined;
    if (serviceType === 'video') {
      const counts = {
        images: referenceMedia.imageUrls.length,
        videos: referenceMedia.videoUrls.length,
      };
      const template = getModelTemplate(payload.model ?? '');
      const supported = modesForModel(template?.referenceModes);
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
          set((snapshot) => ({
            nodes: snapshot.nodes.map((node) => node.id === nodeId
              ? { ...node, data: { ...node.data, status: 'error', error: hint } }
              : node),
          }));
          return;
        }
        resolvedReferenceMode = spec.backendMode;
      }
    }

    // Set status to running — clear error but keep old url/content until new result arrives.
    set((snapshot) => ({
      activeRun: { nodeId, startedAt: Date.now() },
      nodes: snapshot.nodes.map((node) => node.id === nodeId
        ? { ...node, data: { ...node.data, status: 'running', error: undefined, queuedAfterTimeout: false, prompt: payload.prompt, resolvedPrompt, model: payload.model } }
        : node),
    }));

    // Video-specific: duration from genParams.
    const durationSeconds = genParams?.durationSeconds ?? undefined;

    const aborter = new AbortController();
    runAborters[nodeId] = aborter;
    const timeout = setTimeout(() => aborter.abort(), generationTimeoutMs);

    // Make sure the recovery poller is running. Idempotent — first call
    // wires up the interval, subsequent calls are no-ops.
    ensureTaskPollerStarted(get, set as never);
    trackedTaskNodes.add(nodeId);

    try {
      const result = await apiGenerate({
        node_id: nodeId,
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
      }, aborter.signal);

      if (result.type === 'queued') {
        set((snapshot) => ({
          activeRun: null,
          nodes: snapshot.nodes.map((node) => node.id === nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  status: 'running',
                  taskId: result.task_id,
                  queuedAfterTimeout: true,
                  error: undefined,
                },
              }
            : node),
        }));
        return;
      }

      const persistedContent = await persistGeneratedMediaUrl(result);

      set((snapshot) => ({
        activeRun: null,
        nodes: snapshot.nodes.map((node) => node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                status: 'done',
                sourceKind: (currentNode?.data as Record<string, unknown> | undefined)?.derivedFromNodeId
                  ? ((currentNode?.data as Record<string, unknown> | undefined)?.sourceKind ?? 'derived')
                  : (serviceType === 'image' || serviceType === 'video' ? 'generated' : (node.data as Record<string, unknown> | undefined)?.sourceKind),
                taskId: result.task_id,
                queuedAfterTimeout: false,
                ...(result.type === 'url'
                  ? { url: persistedContent, output: persistedContent }
                  : { content: result.content, output: result.content }),
              },
            }
          : node),
      }));
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
      const message = err instanceof Error ? err.message : 'Generation failed';
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      const isTimeoutLike = isAbort || /timeout|timed out|aborted|deadline/i.test(message);

      if (isTimeoutLike) {
        // Client gave up but backend Stage-1 task may still finish.
        // Leave status='running' and flag queuedAfterTimeout so the
        // loading overlay can swap to "已加入队列" copy. Cleared when
        // the recovery poller / SSE event flips the node to done/error.
        set((snapshot) => ({
          activeRun: null,
          nodes: snapshot.nodes.map((node) => node.id === nodeId
            ? { ...node, data: { ...node.data, status: 'running', queuedAfterTimeout: true, error: undefined } }
            : node),
        }));
      } else {
        // Real, non-timeout failure (4xx, network down, etc.). Surface
        // the error directly and stop tracking.
        set((snapshot) => ({
          activeRun: null,
          nodes: snapshot.nodes.map((node) => node.id === nodeId
            ? { ...node, data: { ...node.data, status: 'error', error: message } }
            : node),
        }));
        trackedTaskNodes.delete(nodeId);
      }
    } finally {
      clearTimeout(timeout);
      delete runAborters[nodeId];
    }
  },
  cancelNode: (nodeId) => {
    runAborters[nodeId]?.abort();
    delete runAborters[nodeId];
    set((state) => {
      const nodes = state.nodes.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, status: 'idle' } } : node);
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
  storage: createJSONStorage(() => appStorage),
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
  partialize: (state) => ({
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
    projectStateById: stripHeavyFromProjectStateById(state.projectStateById),
    spaceMembers: state.spaceMembers,
    invitations: state.invitations,
    groups: state.groups,
    savedAssets: state.savedAssets.map((asset) => ({
      ...asset,
      // Drop heavy inline thumbnails/urls; keep only network-hosted ones.
      thumbnail: isTransientBrowserMediaUrl(asset.thumbnail) ? '' : asset.thumbnail,
      url: isTransientBrowserMediaUrl(asset.url) ? '' : asset.url,
    })),
    shortcuts: state.shortcuts,
    isTaskQueueCollapsed: state.isTaskQueueCollapsed,
    showMiniMap: state.showMiniMap,
    snapToGrid: state.snapToGrid,
  }),
}));

// Boot the recovery poller once the store exists. Safe to call before any
// runNode: it just ticks every 8s and finds nothing to do until a node
// hits 'running' state. After a page reload, any node that was running
// at refresh time gets picked up automatically on the first tick.
ensureTaskPollerStarted(useStore.getState, useStore.setState as never);
// Open the SSE stream so completion events arrive in real time. The
// poller still runs as a low-frequency reconciliation safety net.
ensureTaskStreamStarted(useStore.getState, useStore.setState as never);
