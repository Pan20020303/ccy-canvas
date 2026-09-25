import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { toast } from 'sonner';
import { bindCanvasPreferences, useCanvasPreferences } from './canvas-preferences';
import { cancelCanvasSubmissions, waitForCanvasSubmit } from './canvas-submit-delay';
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
import type { ServiceType } from './model-config';
import { generate as apiGenerate, generateStream, providerServesType } from './api/providerConfigs';
import { ApiClientError } from './api/client';
import { taskMediaPatch } from './media-result-state';
import { buildImageResultNodes, imageGalleryEntries, imageGallerySelectionPatch, imageResultGroupPatch, imageResultUrls, imageResultUrlUpgrade } from './image-result-group';
import { batchTasksByNodeIds, getTask, listActiveTasks, cancelTask, type TaskItem } from './api/tasks';
import { publishTaskUpdate, subscribeTaskUpdates, taskAccountSession, invalidateTaskAccountSession } from './task-events';
import { saveHistoryToServer, deleteHistoryFromServer, listHistoryFromServer } from './api/history';
import {
  saveAssetToServer, deleteAssetsFromServer, listAssetsFromServer,
  listAssetFoldersFromServer, saveAssetFolderToServer, deleteAssetFolderFromServer,
} from './api/assets';
import type { BackendProject } from './api/projects';
import { createProject as apiCreateProject, getCanvas, listProjects, saveCanvas, uploadFile } from './api/projects';
import { downloadRecoverySnapshot, readCanvasRecovery, removeCanvasRecovery, writeCanvasRecovery, type CanvasRecoverySnapshot } from './canvas-recovery';
import { setChunkReloadSafety } from './chunk-recovery';
import {
  buildCanvasClipboardSelection,
  remapClipboardSelectionForPaste,
  type CanvasClipboardSelection,
} from './canvas-clipboard';
import { computeGroupBounds } from './group-routing';
import { canvasDocumentToken, retainCanvasArrayToken } from './canvas-document-token';
import { createAssetSyncJournal, type AssetMutation, type AssetSyncState } from './asset-sync';
import { clearReferencePayloadValue, getReferencePayloadValue, isPublicHttpAssetUrl, isTransientBrowserMediaUrl, resolveBackendAssetUrl } from './reference-media';
import { getModelTemplate } from './model-templates';
import { isSeedance25Model, orderedReferenceConnections, reconcileReferenceConnectionEdits, seedanceReferenceIndexIssues, usesConnectedReferenceInputs } from './reference-connections';
import { buildZImageParams, type ZImageParams } from './zimage-params';
import { buildLocalImageParams, type LocalImageSettings } from './local-image-params';
import {
  REFERENCE_MODE_SPECS,
  modesForModel,
  isModeSatisfied,
  formatReferenceRequirement,
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
  imageResults?: string[];
  imageResultTaskId?: string;
  mediaTaskId?: string;
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
  /** 所属素材库文件夹 id;'' 或 undefined = 根目录。 */
  folderId?: string;
  createdAt: number;
};

/** 素材库用户自建文件夹(后端持久化,migration 026)。 */
export type AssetFolder = {
  id: string;
  name: string;
  createdAt: number;
};

// ─── 协作(UI 外壳,后端逻辑后续接入)────────────────────────────────────────
// 画布可从私有转为协作,创建者可邀请成员共创。三种身份:访问者/协作者/管理者
// (创建者是特殊的管理者)。目前仅前端会话态,后端持久化与真实权限稍后接入。
export type CollabRole = 'creator' | 'admin' | 'collaborator' | 'visitor';
export type CollabMember = {
  uid: string;
  name: string;
  avatar?: string;
  role: CollabRole;
};
export const COLLAB_ROLE_OPTIONS: { key: Exclude<CollabRole, 'creator'>; zh: string; en: string }[] = [
  { key: 'visitor', zh: '访问者', en: 'Visitor' },
  { key: 'collaborator', zh: '协作者', en: 'Collaborator' },
  { key: 'admin', zh: '管理者', en: 'Manager' },
];
export const collabRoleLabel = (role: CollabRole, zh: boolean): string => {
  if (role === 'creator') return zh ? '创建者' : 'Creator';
  const opt = COLLAB_ROLE_OPTIONS.find((o) => o.key === role);
  return opt ? (zh ? opt.zh : opt.en) : role;
};

/** 协作操作日志条目(会话态;真正的多人日志需后端记录)。 */
export type CollabActivity = { id: string; action: string; ts: number; uid: string; name: string; avatar?: string };

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
  /** Voice-cloning speed multiplier; only sent by models that expose it. */
  audioSpeed?: number;
  /** VoiceDesign instruction, e.g. "young warm female voice, natural Mandarin". */
  voiceDescription?: string;
  /** Spoken language passed to local VoiceDesign TTS. */
  audioLanguage?: string;
  /** HappyHorse video-edit audio: "auto" (default) / "origin" (keep source audio). */
  audioSetting?: string;
  /** Random seed [0, 2147483647]; unset → provider picks a random seed. */
  seed?: number;
  zImage?: ZImageParams;
  localImage?: LocalImageSettings;
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
  referenceAudio?: string;
  referenceAudios?: string[];
  /** Connected media remains authoritative after the last wire is removed. */
  referenceInputSource?: 'connections';
  // Video reference variant (Seedance 2.0 tabs). Drives the prompt panel's
  // reference-slot layout; passed through to the backend as a hint about
  // how upstream media should be interpreted.
  referenceVariant?: string;
};

type UpstreamReferenceMedia = {
  imageUrls: string[];
  videoUrls: string[];
  audioUrls: string[];
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
  /** 智能体面板宽度(px,可拖拽调节,localStorage 持久)。routes 用它给主区让位。 */
  agentPanelWidth: number;
  setAgentPanelWidth: (width: number) => void;
  /** 拖拽调宽进行中:主区/导航栏禁用让位过渡,画布实时跟手不滞后。 */
  agentPanelResizing: boolean;
  setAgentPanelResizing: (resizing: boolean) => void;
  agentNodePickActive: boolean;
  agentPickedNode: { id: string; label: string; thumb: string } | null;
  canvasReferencePickTargetId: string | null;
  startAgentNodePick: () => void;
  cancelAgentNodePick: () => void;
  resolveAgentNodePick: (nodeId: string) => void;
  clearAgentPickedNode: () => void;
  startCanvasReferencePick: (targetId: string) => void;
  cancelCanvasReferencePick: () => void;
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
  /** Persisted backend canvas revision used as the base for agent-run deltas. */
  canvasRevision: number;
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
  switchBackendProject: (id: string) => Promise<boolean>;
  /** Re-fetch the active project's canvas from the backend WITHOUT saving the
   *  current (stale) state first — used after a version restore so the restored
   *  snapshot isn't clobbered by the outgoing nodes. */
  reloadActiveCanvas: () => Promise<void>;
  saveCanvasToBackend: (options?: { keepalive?: boolean; force?: boolean }) => Promise<boolean>;
  canvasSaveStatus: 'idle' | 'saving' | 'saved' | 'error';
  canvasSaveError: string | null;
  canvasSaveConflict: boolean;
  canvasRecovery: CanvasRecoverySnapshot | null;
  canvasRecoveryError: string | null;
  hasUnsavedCanvasChanges: () => boolean;
  saveCanvasRecovery: () => Promise<boolean>;
  prepareCanvasPageReload: () => Promise<boolean>;
  downloadCanvasRecovery: () => boolean;
  restoreCanvasRecoveryCopy: () => Promise<boolean>;
  retryCanvasSave: () => void;
  spaceMembers: SpaceMember[];
  invitations: AdminInvitation[];
  groups: Group[];
  createGroup: (nodeIds: string[], name?: string) => void;
  removeGroup: (groupId: string) => void;
  ungroupNodes: (groupId: string) => void;
  setGroupMembers: (groupId: string, nodeIds: string[]) => void;
  translateGroupBoxes: (groupIds: string[], delta: { x: number; y: number }) => void;
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
  assetSync: AssetSyncState;
  retryAssetSync: () => Promise<boolean>;
  saveAsset: (asset: Omit<SavedAsset, 'id' | 'createdAt'>) => SavedAsset;
  removeAsset: (id: string) => void;
  hydrateAssets: () => void;
  // 素材库文件夹(后端持久化)。
  assetFolders: AssetFolder[];
  hydrateAssetFolders: () => void;
  createAssetFolder: (name: string) => AssetFolder | null;
  renameAssetFolder: (id: string, name: string) => void;
  deleteAssetFolder: (id: string) => void;
  /** 把素材移动到某文件夹('' = 移回根)。就地改 folderId 并回写后端。 */
  moveAssetToFolder: (assetId: string, folderId: string) => void;
  // 协作:是否协作中 / 成员 / 权限均由后端持久化(见 api/projects.ts 的
  // is_collaborative + project_members)。此处仅保留会话态的操作日志。
  collabActivityByProject: Record<string, CollabActivity[]>;
  logCollabActivity: (projectId: string, entry: Omit<CollabActivity, 'id' | 'ts'>) => void;
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
  // 资产库「定位」:请求把画布平移/缩放到某个节点。Canvas 订阅 nonce 变化后
  // 调 setCenter(useReactFlow 只在 Canvas 内可用,故用 store 中转)。
  canvasFocusRequest: { nodeId: string; nonce: number } | null;
  requestCanvasFocus: (nodeId: string) => void;
  undoStack: ProjectCanvasState[];
  redoStack: ProjectCanvasState[];
  pushUndoSnapshot: () => void;
  undoCanvas: () => void;
  redoCanvas: () => void;
  /** Atomically move one node and persist the project/space mirrors. */
  moveNodeTo: (nodeId: string, position: { x: number; y: number }) => void;
  /** Atomically delete explicit nodes together with connected edges/groups. */
  deleteNodes: (nodeIds: string[]) => void;
  /** Delete the currently-selected node(s) + their edges (Del / Backspace). */
  deleteSelectedNodes: () => void;
  copiedCanvasSelection: CanvasClipboardSelection | null;
  copySelectedNodes: () => void;
  pasteCopiedNodes: () => void;
  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  setNodePrimaryImage: (nodeId: string, url: string) => void;
  addNodeImagesToCanvas: (nodeId: string) => void;
  /** 应用协作者广播过来的画布增量(实时同步)。合并式 upsert/remove，不压撤销、
   *  保留本地选中/拖拽/尺寸等交互态。结构化入参以避免与 collab/canvas-sync 循环依赖。 */
  applyRemoteCanvasDelta: (delta: {
    nodesUpsert?: Node[];
    nodesRemove?: string[];
    edgesUpsert?: Edge[];
    edgesRemove?: string[];
    groupsUpsert?: Group[];
    groupsRemove?: string[];
  }) => void;
  /** 把指定版本调回成当前主图 —— 现在的 url 反过来进 versions[] 顶端,
   *  选中的 version.url 提升为当前 url. 节点其他 metadata (prompt 等)
   *  也一起切换,让面板里看到的提示词跟图对上. */
  setActiveVersion: (nodeId: string, versionId: string) => void;
  updateNodeGenerationParams: (nodeId: string, patch: Partial<NodeGenerationParams>) => void;
  runNode: (nodeId: string, payload: { prompt: string; model?: string; skipConfirm?: boolean; checkOnly?: boolean; expectedInputs?: string }) => Promise<void>;
  cancelNode: (nodeId: string) => Promise<void>;
  activeRun: { nodeId: string; startedAt: number; timedOut?: boolean } | null;
  /** 图层编辑器:当前打开的 layerEditorNode id(null = 关闭)。 */
  layerEditorNodeId: string | null;
  videoEditorNodeId: string | null;
  openVideoEditor: (nodeId: string) => void;
  closeVideoEditor: () => void;
  openLayerEditor: (nodeId: string) => void;
  closeLayerEditor: () => void;
  /** 使用偏好:生成前确认(设置 → 使用偏好)。开启后每次调用模型先弹窗确认。
   *  新用户默认开启;显式关过的用户保持关闭(独立小键权威,见 applyLightPrefsOverride)。 */
  confirmBeforeGenerate: boolean;
  setConfirmBeforeGenerate: (v: boolean) => void;
  /** 上次视频生成用的时长/分辨率/宽高比。新建视频节点时预填,免去每次重选。
   *  与 confirmBeforeGenerate 同存独立小键(cineflow-prefs),不随大画布 blob 丢失。 */
  lastVideoParams: LastVideoParams | null;
  setLastVideoParams: (params: LastVideoParams) => void;
  /** 待确认的生成请求队列 —— 弹窗一次确认一个;做成队列是因为批量流程
   *  (如分镜派生)会连续调用 runNode,单槽会互相覆盖丢单。 */
  pendingRunConfirm: Array<{ nodeId: string; payload: { prompt: string; model?: string }; checkOnly?: boolean; expectedInputs?: string;
    preview?: { prompt: string; projectId: string | null; provider: string; images: string[]; videos: string[]; audios: string[]; parameters: Record<string, unknown> } }>;
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
  setConnectionDragging: (value: boolean, handleType?: 'source' | 'target' | null) => void;
  /** 当前拖线的起点类型:source=从右+拉出(正向),target=从左+拉出(反向)。
   *  反向拖线时节点激活"全卡 source 命中区",线才能落到卡片任意位置。 */
  connectionDragType: 'source' | 'target' | null;
  // 人物站位/涂画 放大编辑器:全局单例，脱离节点选中/工具条生命周期(否则按 Shift
  // 进入多选、节点工具条卸载就会把编辑器一起关掉)。
  positionStudio: { nodeId: string; imageUrl: string } | null;
  openPositionStudio: (payload: { nodeId: string; imageUrl: string }) => void;
  closePositionStudio: () => void;
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

type CanvasConnectionLike = {
  source?: string | null;
  target?: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export type CanvasConnectionIssue = 'invalid' | 'self' | 'duplicate' | 'cycle' | null;

const edgeConnectionKey = (edge: CanvasConnectionLike): string => [
  edge.source ?? '',
  edge.sourceHandle ?? '',
  edge.target ?? '',
  edge.targetHandle ?? '',
].join('\u0000');

const hasDirectedPathInAdjacency = (
  outgoing: ReadonlyMap<string, readonly string[]>,
  start: string,
  destination: string,
): boolean => {
  if (start === destination) return true;
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (nodeId === destination) return true;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    for (const targetId of outgoing.get(nodeId) ?? []) {
      if (!visited.has(targetId)) pending.push(targetId);
    }
  }
  return false;
};

const buildDirectedAdjacency = (
  edges: readonly Pick<Edge, 'source' | 'target'>[],
): Map<string, string[]> => {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge.source || !edge.target || edge.source === edge.target) continue;
    const targets = outgoing.get(edge.source);
    if (targets) targets.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
  }
  return outgoing;
};

/** Validate a proposed dependency edge. Adding source -> target closes a loop
 * exactly when target can already reach source in the existing graph. */
export function getCanvasConnectionIssue(
  edges: readonly Edge[] = [],
  connection: CanvasConnectionLike,
): CanvasConnectionIssue {
  const source = connection.source;
  const target = connection.target;
  if (!source || !target) return 'invalid';
  if (source === target) return 'self';
  const connectionKey = edgeConnectionKey(connection);
  if (edges.some((edge) => edgeConnectionKey(edge) === connectionKey)) return 'duplicate';
  return hasDirectedPathInAdjacency(buildDirectedAdjacency(edges), target, source) ? 'cycle' : null;
}

/** Remove graph connections that cannot represent a valid dependency.
 * Besides malformed/self/duplicate edges, this repairs legacy or concurrently
 * edited canvases into a DAG. Candidates are evaluated in a canonical order so
 * collaborators converge on the same surviving edges even if merge order differs. */
export function sanitizeCanvasEdges(edges: Edge[] = []): Edge[] {
  const candidates = edges
    .filter((edge) => Boolean(edge.source) && Boolean(edge.target) && edge.source !== edge.target)
    .slice()
    .sort((a, b) => {
      const aKey = `${edgeConnectionKey(a)}\u0000${a.id ?? ''}`;
      const bKey = `${edgeConnectionKey(b)}\u0000${b.id ?? ''}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
  const accepted: Edge[] = [];
  const acceptedRefs = new Set<Edge>();
  const seenConnections = new Set<string>();
  const outgoing = new Map<string, string[]>();

  for (const edge of candidates) {
    const connectionKey = edgeConnectionKey(edge);
    if (seenConnections.has(connectionKey)) continue;
    if (hasDirectedPathInAdjacency(outgoing, edge.target, edge.source)) continue;
    seenConnections.add(connectionKey);
    accepted.push(edge);
    acceptedRefs.add(edge);
    const targets = outgoing.get(edge.source);
    if (targets) targets.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
  }

  return edges.filter((edge) => acceptedRefs.has(edge));
}

const createCanvasSnapshot = (
  nodes: Node[] = [],
  edges: Edge[] = [],
  groups: Group[] = [],
): ProjectCanvasState => ({
  nodes: nodes.map((node) => ({ ...node, position: { ...node.position }, data: { ...(node.data ?? {}) } })),
  edges: sanitizeCanvasEdges(edges).map((edge) => ({ ...edge, style: edge.style ? { ...edge.style } : edge.style })),
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

// Shallow structural equality between an existing snapshot and the live canvas.
// cloneCanvasState() spreads data one level deep, so when NOTHING changed the
// live node's data keeps the same nested references as the stored clone — a
// key-by-key Object.is check is O(nodes) and never touches large data: URLs.
// Zero false-positive risk: it only reports "equal" when the two are actually
// identical, so we never drop a real undo step (a genuine edit changes an id,
// position, or an immutably-replaced value → not equal → still pushed).
const shallowDataEqual = (
  a?: Record<string, unknown>,
  b?: Record<string, unknown>,
): boolean => {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
};

const canvasStatesEqual = (
  a: ProjectCanvasState,
  b: Pick<AppState, 'nodes' | 'edges' | 'groups'>,
): boolean => {
  if (a.nodes.length !== b.nodes.length) return false;
  if (a.edges.length !== b.edges.length) return false;
  if (a.groups.length !== b.groups.length) return false;
  for (let i = 0; i < a.nodes.length; i += 1) {
    const na = a.nodes[i];
    const nb = b.nodes[i];
    if (na.id !== nb.id || na.type !== nb.type) return false;
    if (na.position.x !== nb.position.x || na.position.y !== nb.position.y) return false;
    if (!shallowDataEqual(na.data as Record<string, unknown>, nb.data as Record<string, unknown>)) return false;
  }
  for (let i = 0; i < a.edges.length; i += 1) {
    const ea = a.edges[i];
    const eb = b.edges[i];
    if (ea.id !== eb.id || ea.source !== eb.source || ea.target !== eb.target) return false;
  }
  for (let i = 0; i < a.groups.length; i += 1) {
    const ga = a.groups[i];
    const gb = b.groups[i];
    if (ga.id !== gb.id || ga.nodeIds.length !== gb.nodeIds.length) return false;
    for (let j = 0; j < ga.nodeIds.length; j += 1) {
      if (ga.nodeIds[j] !== gb.nodeIds[j]) return false;
    }
  }
  return true;
};

const pushUndoState = (state: AppState) => {
  // Skip a snapshot identical to the top of the stack: nothing changed between
  // the two captures, so it would only add a phantom no-op undo step — the
  // "Ctrl+Z that appears to do nothing" the user hit (e.g. a click that fired a
  // pre-edit snapshot but no actual edit followed).
  const top = state.undoStack.at(-1);
  if (top && canvasStatesEqual(top, state)) return state.undoStack;
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

// Node IDs can be retained when a canvas is copied. Async generation work
// belongs to the initiating account/space/project, not whichever canvas is open.
function captureTaskContext(getStore: () => AppState) {
  const initial = getStore();
  const owner = storageUserId;
  const epoch = taskAccountSession();
  return () => {
    const current = getStore();
    return owner === storageUserId && epoch === taskAccountSession()
      && initial.activeBackendProjectId === current.activeBackendProjectId
      && initial.activeProjectId === current.activeProjectId
      && initial.activeSpaceId === current.activeSpaceId
      && initial.activeSpaceType === current.activeSpaceType;
  };
}
// 智能体面板宽度边界:最窄保证 composer 控件不换行,最宽给大屏留出画布空间。
const AGENT_PANEL_MIN_WIDTH = 380;
const AGENT_PANEL_MAX_WIDTH = 860;
function clampAgentPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return 480;
  return Math.min(AGENT_PANEL_MAX_WIDTH, Math.max(AGENT_PANEL_MIN_WIDTH, Math.round(width)));
}
function readAgentPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem('agentPanelWidth'));
    if (stored > 0) return clampAgentPanelWidth(stored);
  } catch { /* SSR / privacy mode */ }
  return 480;
}

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
 *  node's url in place — guarded so a stale swap can't clobber a newer run.
 *  `force`（事件带 asset_temporary=true）时跳过 URL 启发式：无签名参数/需鉴权
 *  的上游临时 URL 启发式认不出来，正是「生成成功但没有返图」的来源。 */
function upgradeExpiringNodeMedia(nodeId: string, appliedUrl: string, setStore: (updater: (state: AppState) => Partial<AppState>) => void, force = false, canApply = () => true) {
  if (!/^https?:\/\//i.test(appliedUrl)) return; // 相对 /uploads 等本地 URL 已经持久
  if (!force && !isLikelyExpiringMediaUrl(appliedUrl)) return;
  void rehostToStableUrl(appliedUrl).then((stable) => {
    if (!canApply() || !stable || stable === appliedUrl) return;
    setStore((state) => {
      const nodes = state.nodes.map((node) => {
        const data = (node.data ?? {}) as Record<string, unknown>;
        const belongsToGroup = data.imageResultSourceNodeId === nodeId;
        if (node.id !== nodeId && !belongsToGroup) return node;
        const patch = imageResultUrlUpgrade(data, appliedUrl, stable);
        if (Object.keys(patch).length === 0) return node;
        if (data.url === appliedUrl) clearReferencePayloadValue(node.id);
        return { ...node, data: { ...data, ...patch } };
      });
      const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
      return { nodes, projectStateById, ...syncActiveSpaceSnapshot(state, { projectStateById }) };
    });
  }).catch(() => {});
}

/**
 * Keep the last usable media visible when a re-generation fails.
 *
 * A generated media node is both the editor and the result viewer. Marking the
 * whole node as `error` while it still owns a valid URL makes the full-card
 * error overlay hide that result (and its version switcher). Recoverable
 * failures therefore return the node to `done` and store the new failure as a
 * non-blocking notice. Nodes without a previous result still use the normal
 * blocking error state.
 */
function generationFailureData(
  data: Record<string, unknown>,
  message: string,
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  const hasPreviousMedia = typeof data.url === 'string' && data.url.trim().length > 0;
  const common = {
    ...data,
    ...patch,
    queuedAfterTimeout: false,
    taskPhase: undefined,
    assetSyncing: false,
  };
  if (hasPreviousMedia) {
    return {
      ...common,
      status: 'done',
      error: undefined,
      lastGenerationError: message,
      lastGenerationFailedAt: Date.now(),
    };
  }
  return {
    ...common,
    status: 'error',
    error: message,
    lastGenerationError: undefined,
    lastGenerationFailedAt: undefined,
  };
}

/** Apply a task lookup result back onto its node. Called from the poller
 *  for each non-pending row the backend returns. */
function applyTaskResultToNode(task: TaskItem, getStore: () => AppState, setStore: (updater: (state: AppState) => Partial<AppState>) => void) {
  if (!task.id || !task.node_id) return;
  if (task.project_id && task.project_id !== getStore().activeBackendProjectId) return;
  const boundNode = getStore().nodes.find(node => node.id === task.node_id);
  // Legacy unscoped events may update an exact task binding, never claim a
  // same-ID node in another project. Scoped lookup/polling recovers missed events.
  if (!task.project_id && boundNode?.data.taskId !== task.id) {
    const data = boundNode?.data as Record<string, unknown> | undefined;
    // Local depth jobs used to outlive the browser request without persisting
    // their project id or returning a task id first. Recover only the exact
    // purpose-built depth node while it is explicitly waiting; the timestamp
    // window below still rejects stale rows. This keeps old in-flight jobs
    // recoverable while newer backends persist project_id normally.
    const recoverableLegacyDepth = task.model === 'video-depth-anything-small'
      && task.service_type === 'video'
      && data?.depthVideo === true
      && data?.queuedAfterTimeout === true
      && (data?.status === 'running' || data?.status === 'generating');
    if (!recoverableLegacyDepth) return;
  }
  if (boundNode?.data.taskId === task.id && boundNode.data.status === 'cancelled') return;
  if (task.status === 'cancelled' || task.status === 'canceled') {
    // Cancellation is terminal only after server confirmation. Keep its task
    // identity so delayed queued events cannot reattach or restart tracking.
    if (!boundNode || boundNode.data.taskId !== task.id) return;
    trackedTaskNodes.delete(task.node_id);
    setStore(state => {
      const nodes = state.nodes.map(node => node.id === task.node_id
        ? { ...node, data: { ...node.data, status: 'cancelled', taskId: task.id, taskPhase: 'cancelled', queuedAfterTimeout: false, error: undefined } }
        : node);
      const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
      return { nodes, projectStateById, activeRun: state.activeRun?.nodeId === task.node_id ? null : state.activeRun,
        ...syncActiveSpaceSnapshot(state, { projectStateById }) };
    });
    return;
  }
  const normalizedStatus = normalizeTaskStatus(task.status);
  if (normalizedStatus !== 'success' && normalizedStatus !== 'error') {
    if (normalizedStatus === 'active') {
      const targetNode = getStore().nodes.find((n) => n.id === task.node_id);
      const targetData = targetNode?.data as Record<string, unknown> | undefined;
      const nodeTaskId = typeof targetData?.taskId === 'string' ? targetData.taskId : undefined;
      // A poll that started before completion can arrive after the success SSE.
      // Never roll a completed task back to its staging URL or running state.
      if (nodeTaskId === task.id && targetData?.status === 'done' && targetData?.queuedAfterTimeout !== true) return;
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
                        ...(task.service_type === 'image'
                          ? imageResultGroupPatch((node.data ?? {}) as Record<string, unknown>, task.result_url, task.result_urls, task.id)
                          : taskMediaPatch((node.data ?? {}) as Record<string, unknown>, task.result_url, task.id)),
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
  const isCompletedImageRefresh = normalizedStatus === 'success' && task.service_type === 'image'
    && currentStatus === 'done' && nodeTaskId === task.id;
  if (currentStatus !== 'running' && currentStatus !== 'generating' && !isSameQueuedTask && !isOrphanedRecovery && !isCompletedImageRefresh) {
    // The node has already moved on (user ran a new generation, or the
    // success path already handled it). Drop tracking and skip.
    trackedTaskNodes.delete(task.node_id);
    return;
  }

  if (normalizedStatus === 'success' && task.service_type === 'image') clearReferencePayloadValue(task.node_id);
  setStore((state) => {
    const nodes = state.nodes.map((node) => {
      if (node.id !== task.node_id) return node;
      const isUrl = task.service_type === 'image' || task.service_type === 'video' || task.service_type === 'audio';
      if (normalizedStatus === 'success') {
        if (!task.result_url) {
          const message = '生成任务已完成，但后端没有返回媒体地址。';
          return {
            ...node,
            data: generationFailureData((node.data ?? {}) as Record<string, unknown>, message, { taskId: task.id }),
          };
        }
        // 把当前 url (如果有) 压进 versions 顶端, 把新 url 提为当前.
        // 只对 image / video / audio 这种 url 型节点维护历史.
        // Persist the raw upstream URL; proxy wrapping is applied at render time.
        const resultUrl = task.result_url;
        const prevData = (node.data ?? {}) as Record<string, unknown>;
        const nextTs = Date.now();
        return {
          ...node,
          data: {
            ...node.data,
            status: 'done',
            taskId: task.id,
            queuedAfterTimeout: false,
            taskPhase: undefined,
            error: undefined,
            lastGenerationError: undefined,
            lastGenerationFailedAt: undefined,
            assetStatus: 'ready',
            assetSyncing: false,
            ...(isUrl
              ? {
                  ...(task.service_type === 'image'
                    ? imageResultGroupPatch(prevData, resultUrl, task.result_urls, task.id, nextTs)
                    : { ...taskMediaPatch(prevData, resultUrl, task.id, nextTs), originalUrl: task.result_url }),
                }
              : { content: resultUrl, output: resultUrl }),
          },
        };
      }
      return {
        ...node,
        data: generationFailureData(
          (node.data ?? {}) as Record<string, unknown>,
          `Queued task failed: ${task.error_msg || 'Generation failed'}`,
          { taskId: task.id },
        ),
      };
    });
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return {
      activeRun: state.activeRun?.nodeId === task.node_id ? null : state.activeRun,
      nodes,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  });
  // P0-8 second chance: if the delivered URL looks signed/expiring (backend
  // re-host failed and published the provider URL), re-host client-side.
  // asset_temporary（后端明示转存失败）时无条件转存 —— 无签名参数/需鉴权的
  // 临时 URL 启发式认不出，会以「生成成功但没有返图」的裂图收场。
  if (normalizedStatus === 'success' && task.result_url
    && (task.service_type === 'image' || task.service_type === 'video' || task.service_type === 'audio')) {
    const isCurrentContext = captureTaskContext(getStore);
    const resultUrls = task.service_type === 'image' ? imageResultUrls(task.result_urls, task.result_url) : [task.result_url];
    const currentData = getStore().nodes.find(node => node.id === task.node_id)?.data;
    for (const url of resultUrls) {
      if (currentData?.url !== url && !imageGalleryEntries(currentData ?? {}).some(entry => entry.url === url)) continue;
      upgradeExpiringNodeMedia(task.node_id, url, setStore, task.asset_temporary === true,
        () => isCurrentContext() && getStore().nodes.find(node => node.id === task.node_id)?.data.taskId === task.id);
    }
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
  const isCurrentContext = captureTaskContext(getStore);
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
      if (status === 'cancelled') return false;
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
  if (!isCurrentContext()) return;
  for (const tasks of results) {
    for (const task of tasks) {
      // Older batch projections omit project_id. Resolve the precise task
      // before binding an unscoped row to a copied canvas node.
      const resolved = !task.project_id && nodes.find(node => node.id === task.node_id)?.data.taskId !== task.id
        ? await getTask(task.id).catch(() => null) : task;
      if (!isCurrentContext()) return;
      if (resolved) publishTaskUpdate(resolved);
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
  project_id?: string;
  service_type: string;
  status: string;
  result_url: string;
  result_urls?: string[];
  error_msg: string;
  duration_ms: number;
  // 后端转存失败，result_url 仍是会过期/需鉴权的上游临时 URL → 前端必须二次转存。
  asset_temporary?: boolean;
};

let taskEventSource: EventSource | null = null;
let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function applyTaskEventToNode(event: TaskEventPayload, getStore: () => AppState, setStore: (updater: (state: AppState) => Partial<AppState>) => void) {
  // Reuse the poller's per-task application — they share semantics.
  publishTaskUpdate(
    {
      id: event.task_id,
      node_id: event.node_id,
      project_id: event.project_id,
      service_type: event.service_type,
      model: '',
      status: event.status,
      result_url: event.result_url,
      result_urls: event.result_urls,
      error_msg: event.error_msg,
      duration_ms: event.duration_ms,
      created_at: '',
      asset_temporary: event.asset_temporary,
    },
  );
}

function ensureTaskStreamStarted(getStore: () => AppState, setStore: (updater: (state: AppState) => Partial<AppState>) => void) {
  if (taskEventSource) return;
  const accountEpoch = taskAccountSession();

  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
  const url = `${apiBaseUrl}/api/app/tasks/stream`;
  try {
    taskEventSource = new EventSource(url, { withCredentials: true });
  } catch {
    return; // EventSource not supported (e.g. SSR) — poller remains the safety net
  }

  taskEventSource.onopen = () => {
    if (accountEpoch !== taskAccountSession()) return;
    if (sseReconnectTimer) {
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
    }
  };

  taskEventSource.onmessage = (msg) => {
    if (accountEpoch !== taskAccountSession()) return;
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
    if (accountEpoch !== taskAccountSession()) return;
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
    const scopedTasks = tasks.filter(task => task.project_id
      ? task.project_id === getStore().activeBackendProjectId
      : nodes.some(node => node.id === task.node_id && node.data.taskId === task.id));
    for (const task of scopedTasks) {
      const node = nodes.find((n) => n.id === task.node_id);
      if (!node) continue; // node not loaded yet — caller retries on change
      appliedNodeIds.add(task.node_id);
      trackedTaskNodes.add(task.node_id);
    }
    if (appliedNodeIds.size === 0) return appliedNodeIds;
    const taskByNode = new Map(scopedTasks.map((t) => [t.node_id, t]));
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
          data: { ...node.data, status: 'running', generationOwnerId: storageUserId, taskId: task.id, queuedAfterTimeout: true, taskPhase, error: undefined, runningStartedAt },
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
  const accountEpoch = taskAccountSession();
  let tasks: TaskItem[];
  try {
    tasks = await listActiveTasks();
  } catch {
    return; // best-effort; the poller still covers locally-running nodes
  }
  if (accountEpoch !== taskAccountSession() || !tasks || tasks.length === 0) return;

  const pending = new Map(tasks.map((t) => [t.node_id, t]));
  const applied = applyActiveTasksToNodes([...pending.values()], getStore, setStore);
  for (const id of applied) pending.delete(id);
  if (pending.size === 0) return;

  // Some target nodes haven't loaded yet (canvas snapshot is async). Re-apply
  // as the store changes, then give up after a bounded window.
  const unsubscribe = useStore.subscribe(() => {
    if (accountEpoch !== taskAccountSession()) { unsubscribe(); return; }
    if (pending.size === 0) { unsubscribe(); return; }
    const applied = applyActiveTasksToNodes([...pending.values()], getStore, setStore);
    for (const id of applied) pending.delete(id);
    if (pending.size === 0) unsubscribe();
  });
  setTimeout(() => unsubscribe(), 30000);
}

let storageUserId = '';
let assetLibraryOwner = '';

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
    ...(version.imageResults ? { imageResults: imageResultUrls(version.imageResults).filter(url => !isHeavyMediaString(url)) } : {}),
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
  if (Array.isArray(out.referenceAudios)) {
    out.referenceAudios = out.referenceAudios.map((url) => stripHeavyMediaString(url)).filter(Boolean);
  }
  out.referenceVideo = stripHeavyMediaString(out.referenceVideo);
  out.referenceAudio = stripHeavyMediaString(out.referenceAudio);
  out.maskImage = stripHeavyMediaString(out.maskImage);
  return out;
}

export function stripHeavyFromNodeData(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const key of ['url', 'output', 'thumbnail', 'poster', 'referenceValue', 'maskImage'] as const) {
    out[key] = stripHeavyMediaString(out[key]);
  }
  // 导演台 / 构图预览的快照字段:base64 PNG 动辄数 MB,一次「确认构图」
  // 就能把整个 localStorage 持久化写挂(配额超限 → 整体写入失败,连
  // activeBackendProjectId 都存不下来 → 刷新后跳项目)。正常情况下这些
  // 字段在落盘前已被替换成 /uploads URL(上传失败才会残留 base64)。
  for (const key of ['editorPreview', 'image'] as const) {
    out[key] = stripHeavyMediaString(out[key]);
  }
  if (out.lastCapture && typeof out.lastCapture === 'object') {
    const lc = out.lastCapture as Record<string, unknown>;
    out.lastCapture = { ...lc, image: stripHeavyMediaString(lc.image) };
  }
  if (out.lastCaptures && typeof out.lastCaptures === 'object') {
    out.lastCaptures = Object.fromEntries(
      Object.entries(out.lastCaptures as Record<string, Record<string, unknown>>).map(([k, v]) => [
        k,
        v && typeof v === 'object' ? { ...v, image: stripHeavyMediaString(v.image) } : v,
      ]),
    );
  }
  if (out.referenceLayer && typeof out.referenceLayer === 'object'
    && isHeavyMediaString((out.referenceLayer as Record<string, unknown>).image)) {
    out.referenceLayer = null;
  }
  if (Array.isArray(out.versions)) {
    out.versions = (out.versions as NodeVersion[])
      .map(stripHeavyFromVersion)
      .filter((version) => version.url)
      .slice(0, MAX_PERSISTED_NODE_VERSIONS);
  }
  if (Array.isArray(out.imageResults)) {
    out.imageResults = imageResultUrls(out.imageResults).filter(url => !isHeavyMediaString(url));
  }
  if (out.generationParams) {
    out.generationParams = stripHeavyFromGenerationParams(out.generationParams);
  }
  return out;
}

function stripHeavyFromNodes(nodes: Node[]): Node[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((node) => ({ ...node, data: stripHeavyFromNodeData(node.data) as never }));
}

function stripHeavyFromHistory(history: HistoryItem[]): HistoryItem[] {
  if (!Array.isArray(history)) return [];
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
  if (!projectStateById || typeof projectStateById !== 'object') return {};
  const out: Record<string, ProjectCanvasState> = {};
  for (const [key, snapshot] of Object.entries(projectStateById)) {
    out[key] = {
      ...snapshot,
      nodes: stripHeavyFromNodes(snapshot.nodes),
      edges: sanitizeCanvasEdges(snapshot.edges),
    };
  }
  return out;
}

function stripHeavyFromSpaceSnapshots<T extends { projectStateById?: Record<string, ProjectCanvasState>; history?: HistoryItem[] }>(
  snapshots: Record<string, T>,
): Record<string, T> {
  if (!snapshots || typeof snapshots !== 'object') return {} as Record<string, T>;
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
  edges?: Edge[];
  history?: HistoryItem[];
  projectStateById?: Record<string, ProjectCanvasState>;
  spaceSnapshotsById?: Record<string, SpaceSnapshot>;
  savedAssets?: SavedAsset[];
}>(persistedState: T): T {
  return {
    ...persistedState,
    nodes: Array.isArray(persistedState.nodes) ? stripHeavyFromNodes(persistedState.nodes) : persistedState.nodes,
    edges: Array.isArray(persistedState.edges) ? sanitizeCanvasEdges(persistedState.edges) : persistedState.edges,
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

/** 使用偏好的独立小键(几十字节)。主持久化是整仓 JSON,画布重的账号一次
 *  QuotaExceeded 就整体写入失败(appStorage 静默吞掉),偏好开关会跟着丢 ——
 *  关键小设置单独落盘,不与大画布共命运。 */
const LIGHT_PREFS_KEY = 'cineflow-prefs';

/** 上次视频生成参数(会预填新视频节点)。 */
export type LastVideoParams = { resolution?: string; aspectRatio?: string; durationSeconds?: number };

type LightPrefs = { confirmBeforeGenerate?: boolean; lastVideoParams?: LastVideoParams | null };

function readLightPrefs(): LightPrefs {
  try {
    const raw = localStorage.getItem(storageKey(LIGHT_PREFS_KEY));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as LightPrefs) : {};
  } catch { return {}; }
}

/** 合并写入独立小键(各字段互不覆盖)。confirmBeforeGenerate 的“是否写过”本身
 *  就是新旧用户的分水岭 —— 写过 = 用户显式选择,没写过 = 用默认。 */
export function persistLightPrefs(patch: LightPrefs) {
  try {
    const merged = { ...readLightPrefs(), ...patch };
    localStorage.setItem(storageKey(LIGHT_PREFS_KEY), JSON.stringify(merged));
  } catch { /* storage 不可用就算了,主持久化还有机会兜住 */ }
}

function applyLightPrefsOverride() {
  const prefs = readLightPrefs();
  const patch: { confirmBeforeGenerate: boolean; lastVideoParams?: LastVideoParams } = {
    // 独立小键是生成前确认的唯一权威:用户显式存过(键里有该布尔)就用其值,
    // 保住关掉的选择;从未设置过的(新用户,或老用户没碰过开关)一律用新默认
    // = 开启。这样即便大 blob 里残留旧的 false 也压不过它。
    confirmBeforeGenerate: typeof prefs.confirmBeforeGenerate === 'boolean' ? prefs.confirmBeforeGenerate : true,
  };
  if (prefs.lastVideoParams && typeof prefs.lastVideoParams === 'object') {
    patch.lastVideoParams = prefs.lastVideoParams;
  }
  useStore.setState(patch);
  // Only migrate preferences from this account's persisted snapshot, never the
  // previous account's still-mounted in-memory canvas.
  let legacy = {};
  try { legacy = JSON.parse(localStorage.getItem(storageKey('cineflow-store')) || '{}')?.state || {}; } catch { /* defaults */ }
  bindCanvasPreferences(storageUserId, legacy);
}

export async function bindStorageToUser(userId: string): Promise<void> {
  if (storageUserId === userId) return;
  cancelCanvasSubmissions();
  // Flush any debounced persist BEFORE the key switches — appStorage resolves
  // storageKey at write time, so a pending write flushed after the switch
  // would land in the NEW user's slot with the OLD user's data.
  flushPendingPersist();
  storageUserId = userId;
  invalidateTaskAccountSession();
  // Close the previous account's stream; an already queued browser callback
  // still carries its old epoch and is ignored.
  taskEventSource?.close();
  taskEventSource = null;
  if (sseReconnectTimer) clearTimeout(sseReconnectTimer);
  sseReconnectTimer = null;
  activeTasksHydrated = false;
  trackedTaskNodes.clear();
  ensureTaskStreamStarted(useStore.getState, useStore.setState as never);
  void hydrateActiveTasks(useStore.getState, useStore.setState as never);
  const rehydrated = useStore.persist.rehydrate();
  // 项目列表/画布加载必须等账号自己的持久化状态恢复完成。之前这里 fire-and-forget，
  // AuthProvider 紧接着 loadBackendProjects() 时经常读到 null，于是每次刷新都打开
  // projects[0]（用户看到的就是固定跳回「古偶甜宠」）。
  try {
    if (rehydrated && typeof (rehydrated as Promise<void>).then === 'function') {
      await rehydrated;
    }
  } catch {
    // 损坏/不可用的本地存储不应阻断登录；项目加载会安全退回服务端第一项。
  }
  // 独立小键在整仓 rehydrate 之后覆盖,保证大 blob 里的旧值压不过它。
  applyLightPrefsOverride();
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
  const imageUrls: string[] = [];
  const videoUrls: string[] = [];
  const audioUrls: string[] = [];

  for (const { node } of orderedReferenceConnections(nodes, edges, targetNodeId)) {
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

    // 图层编辑节点保存后把合成图写在 data.url —— 作为图片参考输出。
    if (node.type === 'referenceImageNode' || node.type === 'imageNode' || node.type === 'layerEditorNode') {
      imageUrls.push(url);
    } else if (node.type === 'referenceVideoNode' || node.type === 'videoNode' || node.type === 'videoEditorNode') {
      videoUrls.push(url);
    } else if (node.type === 'referenceAudioNode' || node.type === 'audioNode') {
      audioUrls.push(url);
    }
  }

  return { imageUrls, videoUrls, audioUrls };
}

// 文本节点的内容基准格式现在是 Markdown（LLM 产出就是 Markdown）。只有旧节点
// 里残留的是 execCommand 富文本 HTML（成块的 <div>/<p>/<br>/<ul>/<hr>/<font> 等）。
// 用「是否出现块级 HTML 标签」区分：命中→按 HTML 展平；否则原样当 Markdown 文本。
// 关键：不能对 Markdown 走 htmlToPlainText —— 那会把 List<String>、<threshold>
// 之类的尖括号片段当成 HTML 标签静默吞掉，破坏下游提示词。
const LEGACY_HTML_RE = /<(div|p|br|hr|ul|ol|li|h[1-6]|blockquote|pre|table|font)[\s>/]/i;

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
    // Markdown 节点用原文（保留 <String>/# / | 等）；遗留 HTML 节点才展平。
    const text = LEGACY_HTML_RE.test(raw) ? htmlToPlainText(raw) : raw.trim();
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
    providerServesType(provider, serviceType as ServiceType)
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
 * URL and logs the failure. Preview errors retain the original asset and offer
 * retry; they must never delete an asset-library or history record.
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
      console.warn('[rehostToStableUrl] re-host failed after retry; keeping original URL for retry', err);
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

// Identity of the last saved immutable document. Never stringify the graph
// merely to ask whether it is dirty (this runs on every drag frame).
let lastSavedCanvasSignature = '';
let canvasSaveInFlight: Promise<boolean> | null = null;
type CanvasDraft = { snapshot: CanvasRecoverySnapshot; signature: string; owner: string; persisted: Promise<boolean>; durable: boolean | null };
const canvasDrafts = new Map<string, CanvasDraft>();
const protectedRecoveryIds = new Set<string>();
let recoveryClock = 0;

function canvasNodesForSave(nodes: Node[]): Node[] {
  return nodes.map(n => {
    const { selected: _selected, dragging: _dragging, measured: _measured, resizing: _resizing, ...persistent } = n;
    const data = n.data as Record<string, unknown> | undefined;
    return data?.status === 'running' || data?.status === 'generating'
      ? { ...persistent, data: { ...data, status: 'running', queuedAfterTimeout: true, error: undefined } }
      : persistent;
  });
}

function canvasSignature(projectId: string, nodes: Node[], edges: Edge[], groups: Group[]): string {
  return canvasDocumentToken(projectId, nodes, edges, groups);
}

function draftKey(projectId: string, owner = storageUserId): string { return `${owner}:${projectId}`; }

function recoverySnapshot(state: AppState): CanvasRecoverySnapshot {
  recoveryClock = Math.max(Date.now(), recoveryClock + 1);
  return JSON.parse(JSON.stringify({
    format: 'ccy-canvas-recovery-v1',
    id: `${recoveryClock}-${Math.random().toString(36).slice(2)}`,
    projectId: state.activeBackendProjectId!,
    projectName: state.backendProjects.find(project => project.id === state.activeBackendProjectId)?.name || '画布',
    baseVersion: state.canvasRevision,
    savedAt: recoveryClock,
    nodes: state.nodes, edges: state.edges, groups: state.groups,
  })) as CanvasRecoverySnapshot;
}

/** Called before awaiting an in-flight save: the latest draft gets a
 * synchronous recovery attempt even when pagehide cannot start another PUT. */
function stageCanvasRecovery(state: AppState): CanvasDraft {
  const owner = storageUserId;
  const key = draftKey(state.activeBackendProjectId!, owner);
  const signature = canvasSignature(state.activeBackendProjectId!, state.nodes, state.edges, state.groups);
  const previous = canvasDrafts.get(key);
  if (previous?.signature === signature && previous.durable !== false) return previous;
  const snapshot = recoverySnapshot(state);
  const record: CanvasDraft = { snapshot, signature, owner, durable: null, persisted: Promise.resolve(false) };
  record.persisted = writeCanvasRecovery(owner, snapshot).then(async () => {
    record.durable = true;
    if (previous && !protectedRecoveryIds.has(previous.snapshot.id)) {
      await previous.persisted;
      await removeCanvasRecovery(owner, previous.snapshot.id);
    }
    return true;
  }, () => { record.durable = false; return false; });
  canvasDrafts.set(key, record);
  return record;
}

const recoveryFailureMessage = '本地恢复副本未能写入（存储空间不足或浏览器禁用存储）。请下载本地快照后再离开；当前编辑仍保留。';

const assetJournals = new Map<string, ReturnType<typeof createAssetSyncJournal>>();
const localOnlyAssets = new Map<string, { assets: Set<string>; folders: Set<string>; readErrors: { assets?: string; folders?: string } }>();
function assetLocalOnly(owner: string) {
  let missing = localOnlyAssets.get(owner);
  if (!missing) { missing = { assets: new Set(), folders: new Set(), readErrors: {} }; localOnlyAssets.set(owner, missing); }
  return missing;
}
function publishAssetSync(owner: string, status: AssetSyncState) {
  if (owner !== storageUserId) return;
  const missing = assetLocalOnly(owner);
  useStore.setState({ assetSync: { ...status, pending: status.pending + missing.assets.size + missing.folders.size,
    error: status.error || missing.readErrors.assets || missing.readErrors.folders || null } });
}
function assetSyncFailure(error: unknown) {
  const message = error instanceof Error ? error.message : '素材同步失败，请重试。';
  useStore.setState(state => ({ assetSync: { ...state.assetSync, error: message } }));
  toast.error(message);
}
function assetJournal(owner = storageUserId) {
  if (!owner) throw new Error('请登录当前账号后再保存素材。');
  let journal = assetJournals.get(owner);
  if (!journal) {
    journal = createAssetSyncJournal({ owner, currentOwner: () => storageUserId, storage: localStorage,
      send: async operation => {
        if (operation.entity === 'asset') {
          if (operation.action === 'save') await saveAssetToServer(operation.value);
          else await deleteAssetsFromServer([operation.id]);
        } else if (operation.action === 'save') await saveAssetFolderToServer(operation.value);
        else await deleteAssetFolderFromServer(operation.id);
      }, onChange: status => publishAssetSync(owner, status) });
    assetJournals.set(owner, journal);
  }
  return journal;
}
function applyAssetMutation(mutation: AssetMutation) {
  const owner = storageUserId;
  const journal = assetJournal(owner);
  journal.enqueue(mutation);
  const missing = assetLocalOnly(owner);
  (mutation.entity === 'asset' ? missing.assets : missing.folders).delete(mutation.action === 'save' ? mutation.value.id : mutation.id);
  useStore.setState(state => journal.overlay(state.savedAssets, state.assetFolders));
  void journal.flush().then(ok => {
    if (!ok && owner === storageUserId && journal.status().error) toast.error('素材尚未同步，操作已保留，请在素材库重试。');
  });
}

/** 当前打开的后端项目里「我」是否只读(访问者)。协作画布:访问者只读,不能写。 */
function computeActiveProjectReadOnly(state: AppState): boolean {
  const id = state.activeBackendProjectId;
  if (!id) return false;
  return state.backendProjects.find((p) => p.id === id)?.my_role === 'visitor';
}

export const useStore = create<AppState>()(persist((set, get) => ({
  language: 'zh',
  toggleLanguage: () => set((state) => ({ language: state.language === 'en' ? 'zh' : 'en' })),

  theme: 'dark' as Theme,
  setTheme: (theme) => set({ theme }),
  toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),

  agentPanelOpen: false,
  setAgentPanelOpen: (open) => set({ agentPanelOpen: open }),
  agentPanelWidth: readAgentPanelWidth(),
  setAgentPanelWidth: (width) => {
    const clamped = clampAgentPanelWidth(width);
    try { localStorage.setItem('agentPanelWidth', String(clamped)); } catch { /* ignore */ }
    set({ agentPanelWidth: clamped });
  },
  agentPanelResizing: false,
  setAgentPanelResizing: (resizing) => set({ agentPanelResizing: resizing }),
  agentNodePickActive: false,
  agentPickedNode: null,
  canvasReferencePickTargetId: null,
  startAgentNodePick: () => set({ agentNodePickActive: true, agentPickedNode: null, canvasReferencePickTargetId: null }),
  cancelAgentNodePick: () => set({ agentNodePickActive: false }),
  resolveAgentNodePick: (nodeId) => set((state) => {
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node || !state.agentNodePickActive) return {};
    const d = (node.data ?? {}) as Record<string, unknown>;
    const label = useCanvasPreferences.getState().values.mentionNaming === 'number'
      ? `节点${state.nodes.findIndex(n => n.id === nodeId) + 1}`
      : String(d.customTitle || d.sourceName || node.type || node.id);
    const thumb = String(d.output || d.url || d.imageUrl || d.image || d.poster || ''); // raw URL; UI wraps for proxy
    return { agentPickedNode: { id: nodeId, label, thumb } };
  }),
  clearAgentPickedNode: () => set({ agentPickedNode: null }),
  startCanvasReferencePick: (targetId) => set({ canvasReferencePickTargetId: targetId, agentNodePickActive: false }),
  cancelCanvasReferencePick: () => set({ canvasReferencePickTargetId: null }),

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
      const changedNodes = applyNodeChanges(changes, state.nodes);
      const edges = removedIds.size === 0 ? state.edges
        : state.edges.filter(edge => !removedIds.has(edge.source) && !removedIds.has(edge.target));
      const nodes = removedIds.size === 0 ? changedNodes
        : reconcileReferenceConnectionEdits(changedNodes, state.edges, edges, state.nodes);
      if (changes.every(change => change.type === 'select'
        || (change.type === 'dimensions' && !change.setAttributes)
        || (change.type === 'position' && !change.position))) {
        retainCanvasArrayToken(state.nodes, nodes);
      }
      // Sync group membership without deleting the spatial container when its
      // final member leaves. An empty group remains a reusable canvas area.
      const groups = removedIds.size === 0
        ? state.groups
        : state.groups
            .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => !removedIds.has(id)) }));
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
      const projectStateById = syncActiveProjectState(state, { nodes, edges, groups }).projectStateById;
      return {
        nodes,
        edges,
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
      if (changes.every(change => change.type === 'select')) {
        const edges = applyEdgeChanges(changes, state.edges);
        retainCanvasArrayToken(state.edges, edges);
        return { edges };
      }
      const edges = sanitizeCanvasEdges(applyEdgeChanges(changes, state.edges));
      const nodes = reconcileReferenceConnectionEdits(state.nodes, state.edges, edges);
      const captured = shouldCaptureEdgeChangesForUndo(changes);
      const undoStack = captured ? pushUndoState(state) : state.undoStack;
      const projectStateById = syncActiveProjectState(state, { nodes, edges }).projectStateById;
      return {
        nodes,
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
      if (computeActiveProjectReadOnly(state)) return {};
      if (getCanvasConnectionIssue(state.edges, connection)) return {};
      const decoratedConnection = { ...connection, type: 'flow' };
      const edges = addEdge(decoratedConnection, state.edges);
      const nodes = reconcileReferenceConnectionEdits(state.nodes, state.edges, edges);
      const undoStack = pushUndoState(state);
      const projectStateById = syncActiveProjectState(state, { nodes, edges }).projectStateById;
      return {
        nodes,
        edges,
        undoStack,
        projectStateById,
        ...syncActiveSpaceSnapshot(state, { projectStateById }),
      };
    });
  },

  addNode: (node: Node) => {
    set((state) => {
      if (computeActiveProjectReadOnly(state)) return {};
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
  canvasRevision: 0,
  backendSyncing: false,
  canvasHydrated: false,
  canvasSaveStatus: 'idle',
  canvasSaveError: null,
  canvasSaveConflict: false,
  canvasRecovery: null,
  canvasRecoveryError: null,

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
        const recovery = await readCanvasRecovery(storageUserId, first.id);
        if (recovery) protectedRecoveryIds.add(recovery.id);
        set((state) => {
          const rawNodes = Array.isArray(canvas.nodes) ? (canvas.nodes as Node[]) : state.nodes;
          const nodes = rawNodes.map((n) => {
            const d = n.data as Record<string, unknown> | undefined;
            if (d?.status === 'running' || d?.status === 'generating') {
              return { ...n, data: { ...d, status: 'running', queuedAfterTimeout: true, error: undefined } };
            }
            return n;
          });
          const edges = sanitizeCanvasEdges(Array.isArray(canvas.edges) ? (canvas.edges as Edge[]) : state.edges);
          // Older snapshots have no groups field — keep whatever is local then.
          const groups = Array.isArray(canvas.groups) ? (canvas.groups as Group[]) : state.groups;
          lastSavedCanvasSignature = canvasSignature(first.id, nodes, edges, groups);
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
            canvasRevision: Number.isSafeInteger(canvas.version) ? canvas.version : 0,
            canvasHydrated: true, // backend canvas is now the source of truth → auto-save is safe
            canvasSaveStatus: 'saved', canvasSaveError: null, canvasSaveConflict: false,
            canvasRecovery: recovery, canvasRecoveryError: null,
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
    if (get().backendSyncing) return null;
    if (!await get().saveCanvasToBackend()) return null;
    if (get().hasUnsavedCanvasChanges()) return null;
    try {
      const project = await apiCreateProject(name);
      const nodes: Node[] = [], edges: Edge[] = [], groups: Group[] = [];
      lastSavedCanvasSignature = canvasSignature(project.id, nodes, edges, groups);
      set((state) => ({
        backendProjects: [project, ...state.backendProjects],
        activeBackendProjectId: project.id,
        canvasRevision: 0,
        activeProjectId: project.id,
        canvasHydrated: true, // freshly created empty project — safe to auto-save
        canvasSaveStatus: 'saved', canvasSaveError: null, canvasSaveConflict: false,
        canvasRecovery: null, canvasRecoveryError: null,
        nodes,
        edges,
        groups,
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
    const outgoing = get();
    if (id === outgoing.activeBackendProjectId && outgoing.canvasHydrated) return true;
    if (outgoing.backendSyncing) return false;
    set({ backendSyncing: true });
    try {
      // Edits made while the first request was in flight also have to be saved.
      do {
        if (!await get().saveCanvasToBackend()) return false;
      } while (get().hasUnsavedCanvasChanges());
      set({ canvasHydrated: false });
      const canvas = await getCanvas(id);
      const recovery = await readCanvasRecovery(storageUserId, id);
      if (recovery) protectedRecoveryIds.add(recovery.id);
      const rawNodes = Array.isArray(canvas.nodes) ? (canvas.nodes as Node[]) : [];
      const nodes = rawNodes.map((n) => {
        const d = n.data as Record<string, unknown> | undefined;
        if (d?.status === 'running' || d?.status === 'generating') {
          return { ...n, data: { ...d, status: 'running', queuedAfterTimeout: true, error: undefined } };
        }
        return n;
      });
      const edges = sanitizeCanvasEdges(Array.isArray(canvas.edges) ? (canvas.edges as Edge[]) : []);
      const groups = Array.isArray(canvas.groups) ? (canvas.groups as Group[]) : [];
      lastSavedCanvasSignature = canvasSignature(id, nodes, edges, groups);
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
          activeBackendProjectId: id,
          canvasRevision: Number.isSafeInteger(canvas.version) ? canvas.version : 0,
          canvasHydrated: true,
          canvasSaveStatus: 'saved', canvasSaveError: null, canvasSaveConflict: false,
          canvasRecovery: recovery, canvasRecoveryError: null,
          projectStateById,
          ...syncActiveSpaceSnapshot(state, { projectStateById }),
        };
      });
      return true;
    } catch (error) {
      // A failed target load must not discard or relabel the outgoing editor.
      set({ canvasHydrated: outgoing.canvasHydrated, canvasSaveError: `项目未切换：${error instanceof Error ? error.message : String(error)}` });
      return false;
    } finally {
      set({ backendSyncing: false });
    }
  },

  reloadActiveCanvas: async () => {
    const id = get().activeBackendProjectId;
    if (!id || get().backendSyncing) return;
    const wasHydrated = get().canvasHydrated;
    set({ backendSyncing: true });
    try {
      if (canvasSaveInFlight) await canvasSaveInFlight;
      if (get().hasUnsavedCanvasChanges()) {
        if (!await get().saveCanvasRecovery()) return;
        const draft = canvasDrafts.get(draftKey(id));
        if (draft) {
          protectedRecoveryIds.add(draft.snapshot.id);
          set({ canvasRecovery: draft.snapshot });
        }
      }
      // No stale autosave may race the explicit server reload.
      set({ canvasHydrated: false });
      const canvas = await getCanvas(id);
      if (get().activeBackendProjectId !== id) return;
      // Capture edits made during the fetch as well. saveCanvasRecovery does
      // not require hydration: it is a local backup, never a server write.
      while (canvasSignature(id, get().nodes, get().edges, get().groups) !== lastSavedCanvasSignature && !computeActiveProjectReadOnly(get())) {
        const before = get();
        if (!await get().saveCanvasRecovery()) return;
        const draft = canvasDrafts.get(draftKey(id));
        if (draft) { protectedRecoveryIds.add(draft.snapshot.id); set({ canvasRecovery: draft.snapshot }); }
        if (get().nodes === before.nodes && get().edges === before.edges && get().groups === before.groups) break;
      }
      const nodes = canvasNodesForSave(Array.isArray(canvas.nodes) ? canvas.nodes as Node[] : []);
      const edges = sanitizeCanvasEdges(Array.isArray(canvas.edges) ? (canvas.edges as Edge[]) : []);
      const groups = Array.isArray(canvas.groups) ? (canvas.groups as Group[]) : [];
      lastSavedCanvasSignature = canvasSignature(id, nodes, edges, groups);
      canvasDrafts.delete(draftKey(id)); // the protected recovery now stands on its own
      set((state) => {
        const projectStateById = { ...state.projectStateById, [id]: createCanvasSnapshot(nodes, edges, groups) };
        return {
          nodes, edges, groups, undoStack: [], copiedCanvasSelection: null,
          canvasRevision: Number.isSafeInteger(canvas.version) ? canvas.version : 0,
          canvasHydrated: true, projectStateById,
          canvasSaveStatus: 'saved', canvasSaveError: null, canvasSaveConflict: false,
          ...syncActiveSpaceSnapshot(state, { projectStateById }),
        };
      });
    } catch (error) {
      set({ canvasSaveStatus: 'error', canvasSaveError: `重新加载失败，当前编辑仍保留：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      set({ backendSyncing: false, canvasHydrated: get().canvasHydrated || wasHydrated });
    }
  },

  hasUnsavedCanvasChanges: () => {
    const state = get();
    return Boolean(state.activeBackendProjectId && state.canvasHydrated && !computeActiveProjectReadOnly(state)
      && canvasSignature(state.activeBackendProjectId, state.nodes, state.edges, state.groups) !== lastSavedCanvasSignature);
  },

  saveCanvasRecovery: async () => {
    const state = get();
    if (!state.activeBackendProjectId || computeActiveProjectReadOnly(state)) return true;
    try {
      const draft = stageCanvasRecovery(state);
      const durable = await draft.persisted;
      if (get().activeBackendProjectId === state.activeBackendProjectId) {
        set({ canvasRecoveryError: durable ? null : recoveryFailureMessage,
          ...(get().canvasSaveConflict || get().canvasSaveStatus === 'error' ? { canvasRecovery: draft.snapshot } : {}) });
      }
      return durable;
    } catch {
      set({ canvasRecoveryError: recoveryFailureMessage });
      return false;
    }
  },

  prepareCanvasPageReload: async () => {
    // A frontend update must preserve work even if an ordinary PUT is still
    // in flight. Do not wait for that request or assume it will survive unload.
    while (get().hasUnsavedCanvasChanges()) {
      const before = get();
      let draft: CanvasDraft;
      try { draft = stageCanvasRecovery(before); }
      catch { set({ canvasRecoveryError: recoveryFailureMessage }); return false; }
      protectedRecoveryIds.add(draft.snapshot.id);
      const durable = await draft.persisted;
      set({ canvasRecovery: draft.snapshot, canvasRecoveryError: durable ? null : recoveryFailureMessage });
      if (!durable) return false;
      if (get().nodes === before.nodes && get().edges === before.edges && get().groups === before.groups) break;
    }
    return true;
  },

  downloadCanvasRecovery: () => {
    const state = get();
    const snapshot = state.hasUnsavedCanvasChanges() ? recoverySnapshot(state) : state.canvasRecovery;
    if (!snapshot) return false;
    const downloaded = downloadRecoverySnapshot(snapshot);
    if (!downloaded) set({ canvasRecoveryError: '下载未能启动，请保留此页面后重试。' });
    return downloaded;
  },

  restoreCanvasRecoveryCopy: async () => {
    const current = get();
    if (current.backendSyncing) return false;
    const snapshot = current.canvasSaveConflict && current.hasUnsavedCanvasChanges()
      ? recoverySnapshot(current) : current.canvasRecovery;
    if (!snapshot) return false;
    // A retained older draft must never displace newer edits without a backup.
    if (current.hasUnsavedCanvasChanges() && !await current.saveCanvasRecovery()) return false;
    set({ backendSyncing: true });
    try {
      if (canvasSaveInFlight) await canvasSaveInFlight;
      const project = await apiCreateProject(`${snapshot.projectName.slice(0, 70)}（恢复副本）`);
      // Recovery is an editing operation. It must not restart copied jobs.
      const nodes = snapshot.nodes.map(node => {
        const data = node.data as Record<string, unknown>;
        return data?.status === 'running' || data?.status === 'generating'
          ? { ...node, data: { ...data, status: 'idle', queuedAfterTimeout: false, taskId: undefined, error: undefined } }
          : node;
      });
      const saved = await saveCanvas(project.id, nodes, snapshot.edges, snapshot.groups, { expectedVersion: 0 });
      // Preserve edits made while the recovery copy was being uploaded, too.
      if (!await get().prepareCanvasPageReload()) return false;
      protectedRecoveryIds.add(snapshot.id);
      lastSavedCanvasSignature = canvasSignature(project.id, nodes, snapshot.edges, snapshot.groups);
      set(state => {
        const projectStateById = { ...syncActiveProjectState(state).projectStateById,
          [project.id]: createCanvasSnapshot(nodes, snapshot.edges, snapshot.groups) };
        return { backendProjects: [project, ...state.backendProjects], activeProjectId: project.id,
          activeBackendProjectId: project.id, canvasRevision: saved.version, canvasHydrated: true,
          nodes, edges: snapshot.edges, groups: snapshot.groups, projectStateById,
          undoStack: [], redoStack: [], copiedCanvasSelection: null,
          canvasSaveStatus: 'saved', canvasSaveError: null, canvasSaveConflict: false,
          canvasRecovery: null, canvasRecoveryError: null,
          ...syncActiveSpaceSnapshot(state, { projectStateById }) };
      });
      return true;
    } catch (error) {
      set({ canvasSaveError: `恢复副本失败，原画布与本地快照仍保留：${error instanceof Error ? error.message : String(error)}` });
      return false;
    } finally { set({ backendSyncing: false }); }
  },

  saveCanvasToBackend: async (options) => {
    const initial = get();
    const projectId = initial.activeBackendProjectId;
    if (!projectId || !initial.canvasHydrated) return true;
    if (computeActiveProjectReadOnly(initial)) return true;
    const signature = canvasSignature(projectId, initial.nodes, initial.edges, initial.groups);
    if (!options?.force && signature === lastSavedCanvasSignature) return true;
    let draft: CanvasDraft;
    try { draft = stageCanvasRecovery(initial); }
    catch { set({ canvasRecoveryError: recoveryFailureMessage }); return false; }
    void draft.persisted.then(durable => {
      if (get().activeBackendProjectId === projectId && !durable) set({ canvasRecoveryError: recoveryFailureMessage });
    });
    // A conflict cannot be fixed by retrying the old base version. Keep the
    // latest local draft until the user downloads, reloads, or makes a copy.
    if (initial.canvasSaveConflict) {
      set({ canvasRecovery: draft.snapshot });
      return false;
    }
    if (canvasSaveInFlight) {
      await canvasSaveInFlight;
      if (get().activeBackendProjectId !== projectId) return false;
      return get().saveCanvasToBackend(options);
    }
    const { nodes, edges, groups, canvasRevision: expectedVersion } = initial;
    set({ canvasSaveStatus: 'saving', canvasSaveError: null });
    const operation = (async () => {
      try {
        const savedEdges = edges.map(({ selected: _selected, ...edge }) => edge);
        const savedCanvas = await saveCanvas(projectId, canvasNodesForSave(nodes), savedEdges, groups, { ...options, expectedVersion });
        lastSavedCanvasSignature = signature;
        if (get().activeBackendProjectId === projectId) {
          const clean = canvasSignature(projectId, get().nodes, get().edges, get().groups) === signature;
          set({ canvasRevision: Number.isSafeInteger(savedCanvas.version) ? savedCanvas.version : get().canvasRevision,
            canvasSaveStatus: clean ? 'saved' : 'idle', canvasSaveError: null, canvasSaveConflict: false,
            ...(clean ? { canvasRecoveryError: null } : {}),
            ...(get().canvasRecovery?.id === draft.snapshot.id && !protectedRecoveryIds.has(draft.snapshot.id) ? { canvasRecovery: null } : {}) });
        }
        await draft.persisted;
        if (!protectedRecoveryIds.has(draft.snapshot.id)) await removeCanvasRecovery(draft.owner, draft.snapshot.id);
        if (canvasDrafts.get(draftKey(projectId, draft.owner)) === draft) canvasDrafts.delete(draftKey(projectId, draft.owner));
        return true;
      } catch (err) {
        if (get().activeBackendProjectId === projectId) {
          const latest = stageCanvasRecovery(get());
          const durable = await latest.persisted;
          set({ canvasSaveStatus: 'error', canvasSaveError: err instanceof Error ? err.message : String(err),
            canvasSaveConflict: err instanceof ApiClientError && err.status === 409,
            canvasRecovery: latest.snapshot, canvasRecoveryError: durable ? null : recoveryFailureMessage });
        }
        return false;
      }
    })();
    canvasSaveInFlight = operation;
    try { return await operation; } finally { if (canvasSaveInFlight === operation) canvasSaveInFlight = null; }
  },

  retryCanvasSave: () => {
    void get().saveCanvasToBackend({ force: true });
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

  moveNodeTo: (nodeId, position) => set((state) => {
    if (computeActiveProjectReadOnly(state)) return {};
    const index = state.nodes.findIndex((node) => node.id === nodeId);
    if (index < 0) return {};
    const nodes = state.nodes.slice();
    nodes[index] = { ...nodes[index], position: { ...position } };
    const undoStack = pushUndoState(state);
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return {
      nodes,
      undoStack,
      redoStack: [],
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),

  deleteNodes: (nodeIds) => {
    if (computeActiveProjectReadOnly(get())) return;
    nodeIds.forEach(clearReferencePayloadValue);
    set((state) => {
      const doomed = new Set(nodeIds);
      if (doomed.size === 0) return {};

      const remainingNodes = state.nodes.filter((node) => !doomed.has(node.id));
      if (remainingNodes.length === state.nodes.length) return {};
      const edges = state.edges.filter((edge) => !doomed.has(edge.source) && !doomed.has(edge.target));
      const nodes = reconcileReferenceConnectionEdits(remainingNodes, state.edges, edges, state.nodes);
      const groups = state.groups
        .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => !doomed.has(id)) }));
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
    });
  },
  deleteSelectedNodes: () => {
    const state = get();
    state.deleteNodes(state.nodes.filter((node) => node.selected).map((node) => node.id));
  },
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
    const { horizontalGap: H_GAP, verticalGap: V_GAP } = useCanvasPreferences.getState().values;

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
      for (const n of ordered) { nextPos.set(n.id, { x, y: originY }); x += nodeWidth(n) + H_GAP; }
    } else if (mode === 'vertical') {
      let y = originY;
      for (const n of ordered) { nextPos.set(n.id, { x: originX, y }); y += nodeHeight(n) + V_GAP; }
    } else {
      // Grid: uniform cells sized to the largest node so nothing overlaps.
      const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
      const cellW = Math.max(...ordered.map(nodeWidth)) + H_GAP;
      const cellH = Math.max(...ordered.map(nodeHeight)) + V_GAP;
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

  createGroup: (nodeIds, name) => set((state) => {
    if (computeActiveProjectReadOnly(state)) return {};
    // Merge semantics: if any selected node already belongs to a group, absorb that
    // group's full membership into the new group (and drop the old group) instead of nesting.
    const existingNodeIds = new Set(state.nodes.map((node) => node.id));
    const selectionSet = new Set(nodeIds.filter((id) => existingNodeIds.has(id)));
    if (selectionSet.size < 2) return {};
    const absorbedGroupIds = new Set<string>();
    state.groups.forEach((group) => {
      if (group.nodeIds.some((id) => selectionSet.has(id))) {
        absorbedGroupIds.add(group.id);
        group.nodeIds.forEach((id) => selectionSet.add(id));
      }
    });
    const mergedNodeIds = Array.from(selectionSet);
    const memberNodes = state.nodes.filter((node) => selectionSet.has(node.id));
    const bounds = computeGroupBounds(memberNodes, useCanvasPreferences.getState().values.groupPadding);
    const undoStack = pushUndoState(state);
    const remainingGroups = state.groups.filter((group) => !absorbedGroupIds.has(group.id));
    const groups = [...remainingGroups, {
      id: `g-${Date.now()}`,
      nodeIds: mergedNodeIds,
      name: name?.trim() || `分组 ${remainingGroups.length + 1}`,
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
  assetSync: { pending: 0, syncing: false, error: null },
  saveAsset: (asset) => {
    const created: SavedAsset = {
      ...asset,
      id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
    };
    // Durable journal write precedes the optimistic library update. Keep the
    // synchronous return contract; dialogs can catch a storage/media error.
    applyAssetMutation({ entity: 'asset', action: 'save', value: created });
    return created;
  },
  removeAsset: (id) => {
    try { applyAssetMutation({ entity: 'asset', action: 'delete', id, name: get().savedAssets.find(a => a.id === id)?.name }); }
    catch (error) { assetSyncFailure(error); }
  },
  hydrateAssets: async () => {
    const owner = storageUserId;
    try {
      const journal = assetJournal(owner);
      set(state => journal.overlay(state.savedAssets, state.assetFolders));
      publishAssetSync(owner, journal.status());
      const revision = journal.revision();
      const remote = await listAssetsFromServer();
      // A save/delete acknowledged during this GET makes its response stale.
      if (owner !== storageUserId || revision !== journal.revision()) return;
      const byId = new Map(remote.map(asset => [asset.id, asset]));
      const missing = assetLocalOnly(owner);
      delete missing.readErrors.assets;
      missing.assets.clear();
      for (const asset of get().savedAssets) if (!byId.has(asset.id)) {
        byId.set(asset.id, asset);
        if (!journal.hasPending('asset', asset.id)) missing.assets.add(asset.id);
      }
      set(state => journal.overlay([...byId.values()], state.assetFolders));
      publishAssetSync(owner, journal.status());
    } catch (error) { if (owner === storageUserId) {
      assetLocalOnly(owner).readErrors.assets = error instanceof Error ? error.message : '素材读取失败，请重试。';
      assetSyncFailure(error);
    } }
  },
  assetFolders: [],
  hydrateAssetFolders: async () => {
    const owner = storageUserId;
    try {
      const journal = assetJournal(owner);
      set(state => journal.overlay(state.savedAssets, state.assetFolders));
      publishAssetSync(owner, journal.status());
      const revision = journal.revision();
      const remote = await listAssetFoldersFromServer();
      if (owner !== storageUserId || revision !== journal.revision()) return;
      const byId = new Map(remote.map(folder => [folder.id, folder]));
      const missing = assetLocalOnly(owner);
      delete missing.readErrors.folders;
      missing.folders.clear();
      for (const folder of get().assetFolders) if (!byId.has(folder.id)) {
        byId.set(folder.id, folder);
        if (!journal.hasPending('folder', folder.id)) missing.folders.add(folder.id);
      }
      set(state => journal.overlay(state.savedAssets, [...byId.values()]));
      publishAssetSync(owner, journal.status());
    } catch (error) { if (owner === storageUserId) {
      assetLocalOnly(owner).readErrors.folders = error instanceof Error ? error.message : '文件夹读取失败，请重试。';
      assetSyncFailure(error);
    } }
  },
  retryAssetSync: async () => {
    const owner = storageUserId;
    try {
      const journal = assetJournal(owner);
      const missing = assetLocalOnly(owner);
      let localError: unknown;
      // Legacy local-only libraries are preserved and sent only after this
      // explicit retry. Folders precede their members; never auto-backfill.
      for (const folder of get().assetFolders) if (missing.folders.has(folder.id) && !journal.hasPending('folder', folder.id)) {
        journal.enqueue({ entity: 'folder', action: 'save', value: folder });
        missing.folders.delete(folder.id);
      }
      for (const asset of get().savedAssets) if (missing.assets.has(asset.id) && !journal.hasPending('asset', asset.id)) {
        try {
          journal.enqueue({ entity: 'asset', action: 'save', value: asset });
          missing.assets.delete(asset.id);
        } catch (error) { localError = error; }
      }
      const ok = await journal.flush();
      if (owner !== storageUserId) return false;
      if (ok) {
        await Promise.all([get().hydrateAssets(), get().hydrateAssetFolders()]);
        if (owner !== storageUserId) return false;
        if (localError) { assetSyncFailure(localError); return false; }
        return !get().assetSync.error && get().assetSync.pending === 0;
      }
      return false;
    } catch (error) { if (owner === storageUserId) assetSyncFailure(error); return false; }
  },
  createAssetFolder: (name) => {
    const created: AssetFolder = { id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name.trim() || '新建文件夹', createdAt: Date.now() };
    try { applyAssetMutation({ entity: 'folder', action: 'save', value: created }); return created; }
    catch (error) { assetSyncFailure(error); return null; }
  },
  renameAssetFolder: (id, name) => {
    const folder = get().assetFolders.find(f => f.id === id);
    if (!folder || !name.trim()) return;
    try { applyAssetMutation({ entity: 'folder', action: 'save', value: { ...folder, name: name.trim() } }); }
    catch (error) { assetSyncFailure(error); }
  },
  deleteAssetFolder: (id) => {
    try { applyAssetMutation({ entity: 'folder', action: 'delete', id, name: get().assetFolders.find(f => f.id === id)?.name }); }
    catch (error) { assetSyncFailure(error); }
  },
  moveAssetToFolder: (assetId, folderId) => {
    const asset = get().savedAssets.find(a => a.id === assetId);
    if (!asset) return;
    if (folderId && !get().assetFolders.some(f => f.id === folderId)) {
      assetSyncFailure(new Error('目标文件夹已不存在，请重新选择。')); return;
    }
    try { applyAssetMutation({ entity: 'asset', action: 'save', value: { ...asset, folderId } }); }
    catch (error) { assetSyncFailure(error); }
  },
  // ─── 协作:操作日志(会话态;协作标记/成员/权限由后端持久化)───────────────
  collabActivityByProject: {},
  logCollabActivity: (projectId, entry) => set((state) => {
    const list = state.collabActivityByProject[projectId] ?? [];
    const next = [{ ...entry, id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ts: Date.now() }, ...list].slice(0, 300);
    return { collabActivityByProject: { ...state.collabActivityByProject, [projectId]: next } };
  }),
  saveAssetDialogNodeId: null,
  openSaveAssetDialog: (nodeId) => set({ saveAssetDialogNodeId: nodeId }),
  closeSaveAssetDialog: () => set({ saveAssetDialogNodeId: null }),
  directorStageNodeId: null,
  openDirectorStage: (nodeId) => set({ directorStageNodeId: nodeId }),
  closeDirectorStage: () => set({ directorStageNodeId: null }),
  isAssetLibraryOpen: false,
  setAssetLibraryOpen: (open) => set({ isAssetLibraryOpen: open }),
  canvasFocusRequest: null,
  requestCanvasFocus: (nodeId) => set((state) => ({
    canvasFocusRequest: { nodeId, nonce: (state.canvasFocusRequest?.nonce ?? 0) + 1 },
  })),
  setGroupMembers: (groupId, nodeIds) => set((state) => {
    const undoStack = pushUndoState(state);
    const groups = state.groups
      .map((group) => (group.id === groupId ? { ...group, nodeIds } : group));
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
  // 把指定组的矩形按 delta 平移（保持宽高不变，成员在拖拽里已同量移动）。用于
  // 「整组一起被拖」时让组框随成员一起走，而不是固定不动、成员被判离组后删掉。
  // 只平移不重算尺寸，所以手动拉大过的「区域框」不会被缩回紧贴成员。无 undo：
  // 它是拖拽手势的一部分，手势开始已压过一次快照。
  translateGroupBoxes: (groupIds, delta) => set((state) => {
    if (!groupIds.length || (!delta.x && !delta.y)) return {};
    const idSet = new Set(groupIds);
    let touched = false;
    const groups = state.groups.map((group) => {
      if (!idSet.has(group.id) || group.nodeIds.length === 0) return group;
      touched = true;
      return {
        ...group,
        position: { x: (group.position?.x ?? 0) + delta.x, y: (group.position?.y ?? 0) + delta.y },
      };
    });
    if (!touched) return {};
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
    const { horizontalGap: H_GAP, verticalGap: V_GAP, groupPadding: PAD } = useCanvasPreferences.getState().values;

    const originX = (group.position?.x ?? Math.min(...members.map((n) => n.position.x))) + PAD;
    const originY = (group.position?.y ?? Math.min(...members.map((n) => n.position.y))) + PAD;
    const ordered = [...members].sort((a, b) =>
      Math.abs(a.position.y - b.position.y) > 24 ? a.position.y - b.position.y : a.position.x - b.position.x,
    );

    const nextPos = new Map<string, { x: number; y: number }>();
    if (mode === 'horizontal') {
      let x = originX;
      for (const n of ordered) { nextPos.set(n.id, { x, y: originY }); x += nodeWidth(n) + H_GAP; }
    } else if (mode === 'vertical') {
      let y = originY;
      for (const n of ordered) { nextPos.set(n.id, { x: originX, y }); y += nodeHeight(n) + V_GAP; }
    } else {
      const cols = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
      const cellW = Math.max(...ordered.map(nodeWidth)) + H_GAP;
      const cellH = Math.max(...ordered.map(nodeHeight)) + V_GAP;
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

    const { horizontalGap: COL_GAP, verticalGap: ROW_GAP } = useCanvasPreferences.getState().values;

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
    let columnX = 0;
    layerKeys.forEach((l) => {
      const ids = byLayer.get(l)!;
      ids.sort((a, b) => (nodeById.get(a)!.position.y) - (nodeById.get(b)!.position.y));
      const x = columnX;
      columnX += Math.max(...ids.map(id => { const n = nodeById.get(id)!; return n.measured?.width ?? n.width ?? 300; })) + COL_GAP;
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
      const bounds = computeGroupBounds(members, useCanvasPreferences.getState().values.groupPadding);
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
    if (computeActiveProjectReadOnly(state)) return {};
    const undoStack = pushUndoState(state);
    const nodes = state.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const data = (node.data ?? {}) as Record<string, unknown>;
      const versions = Array.isArray(data.versions) ? (data.versions as NodeVersion[]) : [];
      const target = versions.find((v) => v.id === versionId);
      if (!target) return node;
      if (node.type === 'imageNode' || node.type === 'panoramaNode') {
        clearReferencePayloadValue(nodeId);
        return { ...node, data: { ...data, ...imageGallerySelectionPatch(data, target.url) } };
      }
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
          status: 'done',
          error: undefined,
          lastGenerationError: undefined,
          lastGenerationFailedAt: undefined,
          queuedAfterTimeout: false,
          taskPhase: undefined,
        },
      };
    });
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return { nodes, undoStack, redoStack: [], projectStateById, ...syncActiveSpaceSnapshot(state, { projectStateById }) };
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
  setNodePrimaryImage: (nodeId, url) => set((state) => {
    if (computeActiveProjectReadOnly(state)) return {};
    const source = state.nodes.find(node => node.id === nodeId);
    if (!source || source.data.url === url) return {};
    const patch = imageGallerySelectionPatch(source.data, url);
    if (!patch) return {};
    clearReferencePayloadValue(nodeId);
    const nodes = state.nodes.map(node => node.id === nodeId ? {
      ...node,
      data: {
        ...node.data,
        ...patch,
      },
    } : node);
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return {
      nodes,
      undoStack: pushUndoState(state),
      redoStack: [],
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  addNodeImagesToCanvas: (nodeId) => set((state) => {
    if (computeActiveProjectReadOnly(state)) return {};
    const source = state.nodes.find(node => node.id === nodeId);
    if (!source) return {};
    const copies = buildImageResultNodes(source, state.nodes);
    if (copies.length === 0) return {};
    const nodes = [...state.nodes, ...copies];
    const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
    return {
      nodes,
      undoStack: pushUndoState(state),
      redoStack: [],
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  applyRemoteCanvasDelta: (delta) => set((state) => {
    // Merge a collaborator's delta into the local canvas. NO pushUndoState —
    // remote edits aren't part of THIS user's undo history. Local interaction
    // state (selection/drag/measured size) is preserved so a peer's edit never
    // steals our selection or fights our drag.
    const nodesRm = delta.nodesRemove?.length ? new Set(delta.nodesRemove) : null;
    let nodes = nodesRm ? state.nodes.filter((n) => !nodesRm.has(n.id)) : state.nodes;
    if (delta.nodesUpsert?.length) {
      const localById = new Map(state.nodes.map((n) => [n.id, n]));
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const incoming of delta.nodesUpsert) {
        const local = localById.get(incoming.id) as (Node & { measured?: unknown }) | undefined;
        if (local?.dragging) {
          // Don't fight an in-progress LOCAL drag: keep our node until we release.
          // Our drag-end broadcasts the final position; we pick up their edit next diff.
          byId.set(incoming.id, local);
          continue;
        }
        byId.set(incoming.id, (local
          ? { ...incoming, selected: local.selected, measured: local.measured, width: local.width, height: local.height }
          : incoming) as Node);
      }
      nodes = [...byId.values()];
    }
    const edgesRm = delta.edgesRemove?.length ? new Set(delta.edgesRemove) : null;
    let edges = edgesRm ? state.edges.filter((e) => !edgesRm.has(e.id)) : state.edges;
    if (delta.edgesUpsert?.length) {
      const byId = new Map(edges.map((e) => [e.id, e]));
      for (const incoming of delta.edgesUpsert) byId.set(incoming.id, incoming as Edge);
      edges = [...byId.values()];
    }
    edges = sanitizeCanvasEdges(edges);
    const groupsRm = delta.groupsRemove?.length ? new Set(delta.groupsRemove) : null;
    let groups = groupsRm ? state.groups.filter((g) => !groupsRm.has(g.id)) : state.groups;
    if (delta.groupsUpsert?.length) {
      const byId = new Map(groups.map((g) => [g.id, g]));
      for (const incoming of delta.groupsUpsert) byId.set(incoming.id, incoming as Group);
      groups = [...byId.values()];
    }
    const projectStateById = syncActiveProjectState(state, { nodes, edges, groups }).projectStateById;
    return {
      nodes,
      edges,
      groups,
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
    // 访问者(协作只读)不能生成；检查输入也不能改变已有任务状态。
    // 后端 generate 也按项目角色二次拦截(带 project_id),双保险。
    if (computeActiveProjectReadOnly(get())) {
      toast.warning(get().language === 'zh' ? '你是访问者(只读),无法生成' : 'Read-only (visitor): generation is disabled');
      return;
    }
    const state = get();
    // Determine service type from the node type.
    const currentNode = state.nodes.find((n) => n.id === nodeId);
    if (!currentNode) return;
    const isRunContextCurrent = captureTaskContext(get);
    const runKey = JSON.stringify([taskAccountSession(), storageUserId, state.activeSpaceId,
      state.activeSpaceType, state.activeProjectId, state.activeBackendProjectId, nodeId]);
    const reportInputIssue = (error: string) => {
      // Inspecting a draft must not replace the state of an existing task.
      if (payload.checkOnly || currentNode.data.taskId && ['running', 'generating'].includes(String(currentNode.data.status))) {
        toast.error(error);
        return;
      }
      // Validation is task feedback, not a document edit: preserve the user's undo order.
      set((state) => {
        const nodes = state.nodes.map((node) => node.id === nodeId
          ? { ...node, data: { ...node.data, status: 'error', error } }
          : node);
        const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
        return { nodes, projectStateById, ...syncActiveSpaceSnapshot(state, { projectStateById }) };
      });
    };
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
    const hasExplicitReferences = genParams?.referenceImages?.length || genParams?.referenceVideo || genParams?.referenceVideos?.length || genParams?.referenceAudio || genParams?.referenceAudios?.length;
    const rawReferenceMedia = hasExplicitReferences && !usesConnectedReferenceInputs(currentNode, state.nodes, state.edges)
      ? {
          imageUrls: genParams.referenceImages ?? [],
          videoUrls: [
            ...(genParams.referenceVideo ? [genParams.referenceVideo] : []),
            ...(genParams.referenceVideos ?? []),
          ],
          audioUrls: [
            ...(genParams.referenceAudio ? [genParams.referenceAudio] : []),
            ...(genParams.referenceAudios ?? []),
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
        ? '当前模型需要公网可访问的参考图。请确认后端已启用 OSS/COS 并重新上传图片，或移除本地/旧上传引用后再生成。'
        : 'This model needs public reference image URLs. Ensure OSS/COS is enabled in the backend, then re-upload the image or remove local/stale references before generating.';
      reportInputIssue(error);
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
    const referenceIndexIssues = serviceType === 'video' ? seedanceReferenceIndexIssues(payload.model, effectivePrompt, {
      images: referenceMedia.imageUrls.length,
      videos: referenceMedia.videoUrls.length,
      audios: referenceMedia.audioUrls.length,
    }) : [];
    // A connected unfinished/empty media node must not silently shift later indices.
    const connectedInputs = !hasExplicitReferences || usesConnectedReferenceInputs(currentNode, state.nodes, state.edges)
      ? orderedReferenceConnections(state.nodes, state.edges, nodeId) : [];
    const incompleteInputs = connectedInputs.filter(ref => ref.kind === 'image').length > referenceMedia.imageUrls.length
      || connectedInputs.filter(ref => ref.kind === 'video').length > referenceMedia.videoUrls.length
      || connectedInputs.filter(ref => ref.kind === 'audio').length > referenceMedia.audioUrls.length;
    if (referenceIndexIssues.length || incompleteInputs) {
      const error = incompleteInputs
        ? (get().language === 'zh' ? '已连接的参考素材尚无可用输出。请完成素材上传或上游节点，再检查图片、视频和音频编号。' : 'A connected reference has no usable output. Complete its upload or upstream node, then check the image, video and audio indices.')
        : get().language === 'zh'
        ? `参考编号与实际素材不符：${referenceIndexIssues.map(issue => `${issue.token}（该类实际 ${issue.available} 个）`).join('、')}。请检查连线和提示词编号。`
        : `Reference indices do not match the submitted media: ${referenceIndexIssues.map(issue => `${issue.token} (${issue.available} available)`).join(', ')}. Check connections and prompt indices.`;
      reportInputIssue(error);
      return;
    }
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
          // 文本节点取 content(正文的唯一权威字段——流式生成/手动编辑都只写
          // content,output 可能残留旧一轮的文本),遗留 HTML 展平成纯文本。
          if (upstreamNode.type === 'textNode') {
            const raw = data.content || data.output || '';
            if (!raw) return `@${ref}`;
            return LEGACY_HTML_RE.test(raw) ? htmlToPlainText(raw) : raw;
          }
          // 文本生成里 @ 图片/视频节点：裸 URL 对纯文本模型毫无意义(模型只会
          // 回「无法访问外部链接/查看图片」)。展开成带名字的占位，让模型知道
          // 这里有一张图但内容不可见;真正要用图请连到图片/视频生成节点。
          if (serviceType === 'text' && (data.url || data.output)) {
            const name = data.sourceName || data.customTitle || '';
            return name ? `[图片:${name}]` : '[图片]';
          }
          return data.output ?? data.url ?? data.content ?? `@${ref}`;
        });

    // Get aspectRatio (used as size ratio) and resolution from generation params.
    // aspectRatio → ratio for size param (e.g. "16:9"), resolution → "1k"/"2k"/"4k"
    const requestTemplate = getModelTemplate(payload.model ?? '', referenceProvider);
    const isMidjourneyV82 = payload.model === 'midjourney-v8-2';
    const aspectRatio = requestTemplate?.supportsZImageParams || requestTemplate?.localImageKind || isMidjourneyV82
      ? (requestTemplate?.aspectRatioOptions?.find(option => option === genParams?.aspectRatio?.trim()) ?? requestTemplate?.defaults?.aspectRatio ?? '1:1')
      : genParams?.aspectRatio ?? 'auto';
    // Resolution field might be "自适应·1K" or "1k" — normalize.
    // Preserve the ORIGINAL case of the 'p' / 'P' suffix: some providers
    // (DashScope / 阿里云 HappyHorse) reject lowercase `720p` with
    // "Input should be '1080P' or '720P'". The model templates declare the
    // capitalisation they want (e.g. HappyHorse declares "720P/1080P"),
    // so we just preserve whatever case was set; only fall back to
    // lowercase when there was no suffix at all.
    const resolutionOptions = requestTemplate?.resolutionOptions ?? [];
    const persistedResolution = genParams?.resolution?.trim();
    const canonicalPersistedResolution = persistedResolution
      ? resolutionOptions.find((option) => option.toLowerCase() === persistedResolution.toLowerCase())
      : undefined;
    // When a node switches models, persisted generation params can still
    // contain the previous model's resolution. Prefer a canonical option from
    // the active model; fixed-resolution models (MiniMax H3) must never inherit
    // a stale 720p/1080p value.
    const rawRes = resolutionOptions.length > 0
      ? (canonicalPersistedResolution ?? requestTemplate?.defaults?.resolution ?? resolutionOptions[0])
      : (persistedResolution ?? requestTemplate?.defaults?.resolution ?? '720p');
    const resolution = (() => {
      const text = rawRes.trim();
      if (serviceType === 'image' && (requestTemplate?.supportsZImageParams || requestTemplate?.localImageKind)) return text;
      const imageMatch = text.match(/([124])\s*k/i);
      if (serviceType === 'image' && imageMatch) return `${imageMatch[1]}K`;
      const videoTierMatch = text.match(/([124])\s*k/i);
      if (serviceType === 'video' && videoTierMatch) return `${videoTierMatch[1]}k`;
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
      const template = requestTemplate;
      const declared = template?.referenceModes;
      if (declared && declared.length > 0) {
        const counts = {
          images: referenceMedia.imageUrls.length,
          videos: referenceMedia.videoUrls.length,
          audios: referenceMedia.audioUrls.length,
        };
        const supported = modesForModel(declared);
        const referenceOverrideFor = (key: ReferenceModeKey) =>
          template?.referenceRequirements?.[key]
            ?? (key === 'multi-image' && template?.referenceImageRange
              ? { images: template.referenceImageRange }
              : undefined);
        const persisted = genParams?.referenceVariant as ReferenceModeKey | undefined;
        // Pick the mode the same way the UI does: persisted choice when still
        // valid, else first satisfiable supported mode.
        const satisfied = supported.find((key) => isModeSatisfied(key, counts, referenceOverrideFor(key)));
        const incompleteMultiImage = counts.images > 0 && template?.referenceImageRange && supported.includes('multi-image')
          ? 'multi-image' as const
          : undefined;
        const chosen: ReferenceModeKey | undefined =
          counts.audios > 0 && supported.includes('all-in-one')
            ? 'all-in-one'
            : persisted && supported.includes(persisted) && isModeSatisfied(persisted, counts, referenceOverrideFor(persisted))
            ? persisted
            : (satisfied ?? incompleteMultiImage ?? supported[0]);

        if (chosen) {
          const spec = REFERENCE_MODE_SPECS[chosen];
          // Preflight: if the chosen mode's input requirements aren't met,
          // surface the reason on the node and abort without a network call.
          if (!isModeSatisfied(chosen, counts, referenceOverrideFor(chosen))) {
              const lang = get().language;
              const modelRange = chosen === 'multi-image' ? template?.referenceImageRange : undefined;
              const modelRequirementHint = formatReferenceRequirement(referenceOverrideFor(chosen), lang);
              const hint = modelRequirementHint ?? (modelRange
                ? (lang === 'zh'
                  ? `该模型需要 ${modelRange.min}～${modelRange.max} 张参考图`
                  : `This model needs ${modelRange.min}-${modelRange.max} reference images`)
                : (lang === 'zh' ? spec.disabledHint.zh : spec.disabledHint.en));
            reportInputIssue(hint);
            return;
          }
          resolvedReferenceMode = spec.backendMode;
        }
      }
    }

    if (serviceType === 'image' && requestTemplate?.localImageKind) {
      const maxImages = requestTemplate.referenceImageRange?.max ?? 0;
      if (referenceMedia.imageUrls.length > maxImages || referenceMedia.videoUrls.length || referenceMedia.audioUrls.length) {
        const hint = get().language === 'zh'
          ? (maxImages ? 'FLUX.2 Klein 最多接入 4 张参考图片，不支持视频或音频参考。' : 'Krea-2 当前仅支持文生图和 Darkbrush LoRA；多图参考请选 FLUX.2 Klein。')
          : `This model accepts 0–${maxImages} reference images and no video/audio.`;
        reportInputIssue(hint);
        return;
      }
    }

    if (serviceType === 'image' && isMidjourneyV82) {
      if (referenceMedia.imageUrls.length > 1 || referenceMedia.videoUrls.length || referenceMedia.audioUrls.length) {
        reportInputIssue(get().language === 'zh'
          ? 'Midjourney V8.2 最多接入 1 张参考图片，不支持视频或音频参考。'
          : 'Midjourney V8.2 accepts at most one reference image and no video/audio.');
        return;
      }
      if (!(strippedForMedia ?? effectivePrompt).split(/\s*--/)[0].trim()) {
        reportInputIssue(get().language === 'zh'
          ? 'Midjourney V8.2 需要画面描述，不能只提交参考图或参数。'
          : 'Midjourney V8.2 needs a description, not only references or parameters.');
        return;
      }
    }

    // Resolve and validate the same inputs before preview/confirmation. A
    // changed input must be reviewed again instead of submitting an old summary.
    const preview = {
      prompt: resolvedPrompt, projectId: state.activeBackendProjectId,
      provider: referenceProvider?.name ?? referenceProvider?.vendor ?? '',
      images: referenceMedia.imageUrls, videos: referenceMedia.videoUrls, audios: referenceMedia.audioUrls,
      parameters: { model: payload.model, provider_config_id: referenceProvider?.id, service_type: serviceType,
        aspectRatio, resolution, quality: requestTemplate?.supportsQuality ? quality : undefined,
        outputCount: requestTemplate?.fixedOutputCount ?? genParams?.outputCount,
        duration: genParams?.durationSeconds, referenceMode: resolvedReferenceMode,
        // Include every submitted setting in the approval guard; the UI shows
        // the compact effective values above and the remaining settings below.
        seed: requestTemplate?.supportsSeed ? genParams?.seed : undefined },
    };
    const expectedInputs = JSON.stringify({ preview, settings: genParams });
    const changedAfterReview = Boolean(payload.expectedInputs && payload.expectedInputs !== expectedInputs);
    if (payload.checkOnly || (state.confirmBeforeGenerate && !payload.skipConfirm) || changedAfterReview) {
      set(snapshot => ({ pendingRunConfirm: [...snapshot.pendingRunConfirm.filter(p => p.nodeId !== nodeId),
        { nodeId, payload: { prompt: payload.prompt, model: payload.model }, preview, expectedInputs, checkOnly: payload.checkOnly }] }));
      if (changedAfterReview) toast.info(state.language === 'zh' ? '输入已发生变化，请核对更新后的提交内容。' : 'Inputs changed. Review the updated submission.');
      if (!runAborters[runKey] && !currentNode.data.taskId && currentNode.data.status === 'running') {
        get().updateNodeData(nodeId, { status: undefined, error: undefined, queuedAfterTimeout: false });
      }
      return;
    }
    // Optional grace period from the new canvas preferences. It starts only
    // after validation/confirmation, and rechecks ownership plus parameters
    // before any request or running state is created.
    if (['imageNode', 'panoramaNode', 'videoNode'].includes(nodeType)) {
      const delaySeconds = useCanvasPreferences.getState().values.submitDelay;
      if (delaySeconds > 0) {
        const ownerId = storageUserId;
        const projectId = state.activeBackendProjectId;
        const originalParams = JSON.stringify(currentNode.data.generationParams);
        const proceed = await waitForCanvasSubmit(`${ownerId}:${projectId}:${nodeId}`, delaySeconds);
        const latest = get().nodes.find(node => node.id === nodeId);
        if (!proceed || !latest || !isRunContextCurrent() || storageUserId !== ownerId || get().activeBackendProjectId !== projectId || computeActiveProjectReadOnly(get())) return;
        if (JSON.stringify(latest.data.generationParams) !== originalParams) {
          toast.info(get().language === 'zh' ? '生成参数已变更，请确认后重新提交。' : 'Generation settings changed. Review and submit again.');
          return;
        }
      }
    }
    // Input inspection never aborts a running request. Ownership changes only
    // after validation and any requested confirmation have completed.
    runAborters[runKey]?.abort();
    delete runAborters[runKey];
    const runToken = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
      ? crypto.randomUUID() : `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    runTokens[runKey] = runToken;
    const ownsRunToken = () => runTokens[runKey] === runToken;
    const isCurrentRun = () => ownsRunToken() && isRunContextCurrent();

    // Set status to running — clear error but keep old url/content until new result arrives.
    // runningStartedAt is persisted on the node so NodeLoadingTimer can
    // resume from the original start time after a page refresh (instead of
    // counting from 0 each mount).
    const startedAt = Date.now();
    set((snapshot) => {
      const nodes = snapshot.nodes.map((node) => node.id === nodeId
        ? { ...node, data: { ...node.data, status: 'running', generationOwnerId: storageUserId, error: undefined, lastGenerationError: undefined, lastGenerationFailedAt: undefined, taskId: undefined, queuedAfterTimeout: false, output: undefined, content: undefined, prompt: payload.prompt, resolvedPrompt, model: payload.model, runningStartedAt: startedAt } }
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
    runAborters[runKey] = aborter;

    // ── Text nodes: token-by-token SSE streaming into data.content ──────────
    // Text generation streams live via POST /api/app/text/stream instead of the
    // task-queue apiGenerate path — reusing ALL pre-flight above (read-only,
    // confirm, abort, and resolvedPrompt with @mention + upstream-text inlining).
    // Writes bypass updateNodeData (which pushes an undo snapshot per call, and
    // would flood the stack per token): one pushUndoSnapshot up-front makes the
    // whole generation a single undo step, then a no-undo set streams tokens.
    if (serviceType === 'text') {
      const streamTimeout = setTimeout(() => aborter.abort(), Math.max(generationTimeoutMs, 120000));
      const streamWrite = (patch: Record<string, unknown>) => set((s) => {
        if (!isCurrentRun()) return s;
        const nodes = s.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...(n.data ?? {}), ...patch } } : n));
        const projectStateById = syncActiveProjectState(s, { nodes }).projectStateById;
        return { nodes, projectStateById, ...syncActiveSpaceSnapshot(s, { projectStateById }) };
      });
      const fail = (msg: string) => { if (isCurrentRun()) streamWrite({ status: 'error', error: msg }); };
      const zhFail = () => (get().language === 'zh' ? '生成失败' : 'Generation failed');
      get().pushUndoSnapshot();
      streamWrite({ status: 'running', error: undefined });
      let accum = '';
      let lastFlush = 0;
      let cleared = false;
      try {
        // 视觉文本模型(如 qwen3.7-plus)才把连入的参考图一并发过去;纯文本模型
        // (gpt/deepseek/qwen3.7-max…)不带图,后端仍走纯文本 content(零回归)。
        const visionImages = requestTemplate?.supportsVision
          ? referenceMedia.imageUrls
          : [];
        const resp = await generateStream({
          model: payload.model ?? '',
          prompt: resolvedPrompt,
          node_id: nodeId,
          project_id: state.activeBackendProjectId ?? undefined,
          image_urls: visionImages.length > 0 ? visionImages : undefined,
        }, aborter.signal);
        if (!resp.ok) {
          let msg = zhFail();
          try { const j = await resp.json(); if (j?.error) msg = String(j.error); } catch { /* non-JSON */ }
          if (resp.status === 402 && isCurrentRun()) toast.warning(msg, { id: 'insufficient-credits' });
          fail(msg);
          return;
        }
        const reader = resp.body?.getReader();
        if (!reader) { fail(zhFail()); return; }
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!isCurrentRun()) { try { await reader.cancel(); } catch { /* superseded */ } return; }
          buffer += decoder.decode(value, { stream: true });
          let sep = buffer.indexOf('\n\n');
          while (sep >= 0) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            sep = buffer.indexOf('\n\n');
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue; // ": connected" / ": ping" comments
            const data = dataLine.slice(5).trim();
            if (!data) continue;
            let evt: { type?: string; content?: string; message?: string };
            try { evt = JSON.parse(data); } catch { continue; }
            if (evt.type === 'token') {
              // Clear the old body only when the first token actually arrives, so
              // a 402/error never wipes existing content.
              if (!cleared) { cleared = true; streamWrite({ content: '' }); }
              accum += evt.content ?? '';
              const now = Date.now();
              if (now - lastFlush > 40 && isCurrentRun()) { lastFlush = now; streamWrite({ content: accum }); }
            } else if (evt.type === 'done') {
              if (isCurrentRun()) {
                const finalContent = evt.content || accum;
                // Empty result (provider returned nothing): keep the old content
                // rather than wiping it to ''; just clear the running state.
                if (finalContent) streamWrite({ content: finalContent, status: 'done' });
                else { toast.warning(get().language === 'zh' ? '生成结果为空' : 'Empty result'); streamWrite({ status: undefined }); }
              }
              return;
            } else if (evt.type === 'error') {
              fail(evt.message || zhFail());
              return;
            }
          }
        }
        // Stream closed without an explicit done/error frame → finalize with
        // whatever accumulated; empty → preserve old content, just clear running.
        if (isCurrentRun()) {
          if (accum) streamWrite({ content: accum, status: 'done' });
          else { toast.warning(get().language === 'zh' ? '生成结果为空' : 'Empty result'); streamWrite({ status: undefined }); }
        }
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        fail(err instanceof Error ? err.message : zhFail());
      } finally {
        clearTimeout(streamTimeout);
        if (ownsRunToken()) {
          delete runAborters[runKey];
          delete runTokens[runKey];
        }
      }
      return;
    }

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
    const activeTemplate = requestTemplate;

    // Make sure the recovery poller is running. Idempotent — first call
    // wires up the interval, subsequent calls are no-ops.
    ensureTaskPollerStarted(get, set as never);
    trackedTaskNodes.add(nodeId);

    try {
      const result = await apiGenerate({
        node_id: nodeId,
        project_id: state.activeBackendProjectId ?? undefined,
        request_id: requestId,
        provider_config_id: referenceProvider?.id,
        service_type: serviceType,
        model: payload.model ?? '',
        prompt: resolvedPrompt,
        size: aspectRatio,
        resolution: serviceType === 'image' || serviceType === 'video' ? resolution : undefined,
        // Quality is capability-scoped, not image-only: local LTX-2.5 uses it
        // for 极速 / 标准 / 高质量 workflow selection.
        quality: activeTemplate?.supportsQuality ? quality : undefined,
        edit_operation: genParams?.editOperation,
        mask_image: genParams?.maskImage,
        output_count: activeTemplate?.fixedOutputCount ?? (activeTemplate?.localImageKind ? 1 : genParams?.outputCount),
        expand_direction: genParams?.expandDirection,
        derive_from_node_id: genParams?.deriveFromNodeId,
        trim_range: genParams?.trimRange,
        crop_rect: genParams?.cropRect,
        target_tracks: genParams?.targetTracks,
        output_format: isMidjourneyV82 ? undefined : genParams?.outputFormat,
        parameters: !isMidjourneyV82 && ((serviceType === 'image' && (activeTemplate?.supportsZImageParams || activeTemplate?.localImageKind)) || genParams?.outputFormat || (serviceType === 'audio' && (activeTemplate?.audioSpeedRange || activeTemplate?.supportsVoiceDescription)))
          ? {
              ...(serviceType === 'image' && activeTemplate?.supportsZImageParams
                ? buildZImageParams(genParams?.zImage) : {}),
              ...(serviceType === 'image' && activeTemplate?.localImageKind
                ? buildLocalImageParams(activeTemplate.localImageKind, genParams?.localImage) : {}),
              ...(genParams?.outputFormat && !activeTemplate?.supportsZImageParams && !activeTemplate?.localImageKind ? { output_format: genParams.outputFormat } : {}),
              ...(serviceType === 'audio' && activeTemplate?.audioSpeedRange
                ? { speed: genParams?.audioSpeed ?? activeTemplate.audioSpeedRange.defaultValue }
                : {}),
              ...(serviceType === 'audio' && activeTemplate?.supportsVoiceDescription
                ? {
                    voice_description: genParams?.voiceDescription ?? '',
                    language: genParams?.audioLanguage ?? activeTemplate.audioLanguageOptions?.[0] ?? 'Auto',
                    temperature: 0.9,
                    top_p: 0.95,
                  }
                : {}),
            }
          : undefined,
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
        reference_audio: referenceMedia.audioUrls.length === 1 ? referenceMedia.audioUrls[0] : undefined,
        reference_audios: referenceMedia.audioUrls.length > 1 ? referenceMedia.audioUrls : undefined,
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
        seed: (serviceType === 'video' || serviceType === 'image' || serviceType === 'audio') && activeTemplate?.supportsSeed && typeof genParams?.seed === 'number' ? genParams.seed : undefined,
        // wan2.7 组图 (grid) mode → the backend sets enable_sequential so one
        // request yields up to 12 images. Gated to the image 组图 tab.
        enable_sequential: serviceType === 'image' && activeTemplate?.referenceModes?.includes('wan-group') && genParams?.referenceVariant === 'wan-group' ? true : undefined,
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
            .then((task) => {
              if (isRunContextCurrent() && get().nodes.find(node => node.id === nodeId)?.data.taskId === result.task_id) {
                applyTaskResultToNode(task, get, set as never);
              }
            })
            .catch((err) => {
              // eslint-disable-next-line no-console
              console.warn('[runNode] initial queued task lookup failed', { taskId: result.task_id, error: err });
            });
        }
        return;
      }

      const persistedImageResults = serviceType === 'image' && result.type === 'url'
        ? await Promise.all(imageResultUrls(result.content_list, result.content).map(url => rehostToStableUrl(url)))
        : undefined;
      const persistedContent = persistedImageResults?.[0] ?? await persistGeneratedMediaUrl(result);
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
            ? {
                ...node,
                data: generationFailureData((node.data ?? {}) as Record<string, unknown>, message, { taskId: result.task_id }),
              }
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

      if (serviceType === 'image') clearReferencePayloadValue(nodeId);
      set((snapshot) => {
        const nodes = snapshot.nodes.map((node) => {
          if (node.id !== nodeId) return node;
          // 把旧 url 压进 versions[]、新 url 提升为当前. 跟
          // applyTaskResultToNode 同样的语义,保证两条成功路径
          // (同步路径 + SSE / 轮询恢复路径) 都维护历史.
          const prevData = (node.data ?? {}) as Record<string, unknown>;
          const isUrlResult = result.type === 'url';
          const nextTs = Date.now();
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
              lastGenerationError: undefined,
              lastGenerationFailedAt: undefined,
              ...(isUrlResult
                ? {
                    ...(serviceType === 'image'
                      ? imageResultGroupPatch(prevData, persistedContent, persistedImageResults, result.task_id || `sync-${nodeId}-${startedAt}`, nextTs)
                      : { ...taskMediaPatch(prevData, persistedContent, result.task_id || `sync-${nodeId}-${startedAt}`, nextTs), originalUrl: result.content }),
                    prompt: payload.prompt,
                    model: payload.model,
                  }
                : { content: result.content, output: result.content }),
            },
          };
        });
        const projectStateById = syncActiveProjectState(snapshot, { nodes }).projectStateById;
        return {
          activeRun: null,
          nodes,
          projectStateById,
          ...syncActiveSpaceSnapshot(snapshot, { projectStateById }),
        };
      });
      if (!isCurrentRun()) return;
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
            ? {
                ...node,
                data: generationFailureData((node.data ?? {}) as Record<string, unknown>, message),
              }
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
      if (ownsRunToken()) {
        delete runAborters[runKey];
        delete runTokens[runKey];
      }
    }
  },
  cancelNode: async (nodeId) => {
    const isCurrentContext = captureTaskContext(get);
    const node = get().nodes.find(item => item.id === nodeId);
    const taskId = typeof node?.data.taskId === 'string' ? node.data.taskId : '';
    if (!taskId) {
      toast.info(get().language === 'zh' ? '正在确认任务编号，暂不能取消；任务仍会继续跟踪。' : 'Waiting for the server task ID. Task tracking remains active.');
      return;
    }
    try {
      const result = await cancelTask(taskId);
      if (!isCurrentContext()) return;
      applyTaskResultToNode(result.task, get, set as never);
      if (!result.cancelled && result.reason !== 'already_cancelled') {
        toast.info(result.task.cancel_reason || (get().language === 'zh' ? '任务已开始或已结束，保留真实状态与结果。' : 'The task has started or finished. Its status and result are retained.'));
      }
    } catch (error) {
      if (!isCurrentContext()) return;
      toast.error(get().language === 'zh' ? '取消未确认，任务仍在跟踪。请稍后重试。' : 'Cancellation was not confirmed. Tracking continues; please retry.');
    }
  },

  shortcuts: { ...DEFAULT_SHORTCUTS },
  setShortcut: (action, combo) => set((state) => ({ shortcuts: { ...state.shortcuts, [action]: combo } })),
  resetShortcuts: () => set({ shortcuts: { ...DEFAULT_SHORTCUTS } }),

  isSettingsOpen: false,
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),

  layerEditorNodeId: null,
  videoEditorNodeId: null,
  openVideoEditor: (nodeId) => set({ videoEditorNodeId: nodeId }),
  closeVideoEditor: () => set({ videoEditorNodeId: null }),
  openLayerEditor: (nodeId) => set({ layerEditorNodeId: nodeId }),
  closeLayerEditor: () => set({ layerEditorNodeId: null }),

  // 默认开启(新用户);老用户显式关过的在 applyLightPrefsOverride 里被独立小键
  // 的存值覆盖回关闭。初始 true 只对“从未设置过”的用户生效。
  confirmBeforeGenerate: true,
  setConfirmBeforeGenerate: (v) => {
    set({ confirmBeforeGenerate: v });
    // 立即写独立小键(同步、无防抖)——主持久化超配额失败也丢不了它。
    persistLightPrefs({ confirmBeforeGenerate: v });
  },
  lastVideoParams: null,
  setLastVideoParams: (params) => {
    set({ lastVideoParams: params });
    persistLightPrefs({ lastVideoParams: params });
  },
  pendingRunConfirm: [],
  setPendingRunConfirm: (v) => set({ pendingRunConfirm: v }),

  isTaskQueueCollapsed: false,
  setTaskQueueCollapsed: (value) => set({ isTaskQueueCollapsed: value }),
  showMiniMap: false,
  setShowMiniMap: (value) => { set({ showMiniMap: value }); useCanvasPreferences.getState().setPreference('showMiniMap', value); },
  snapToGrid: false,
  setSnapToGrid: (value) => { set({ snapToGrid: value }); useCanvasPreferences.getState().setPreference('snapToGrid', value); },
  isConnectionDragging: false,
  connectionDragType: null,
  setConnectionDragging: (value, handleType) => set({
    isConnectionDragging: value,
    // 结束拖线时清空;开始时未知类型按 source(正向)处理,保持旧调用兼容。
    connectionDragType: value ? (handleType ?? 'source') : null,
  }),
  positionStudio: null,
  openPositionStudio: (payload) => set({ positionStudio: payload }),
  closePositionStudio: () => set({ positionStudio: null }),
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
  merge: (persistedState, currentState) => {
    const changedAssetOwner = assetLibraryOwner !== storageUserId;
    assetLibraryOwner = storageUserId;
    return {
      ...currentState,
      // A new account with no persisted library must not inherit the previous
      // account's live assets. Existing per-user saved libraries still merge.
      ...(changedAssetOwner ? { savedAssets: [], assetFolders: [], assetSync: { pending: 0, syncing: false, error: null } } : {}),
      ...(persistedState && typeof persistedState === 'object'
        ? sanitizePersistedAppState(persistedState as Partial<AppState>)
        : {}),
    };
  },
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
      assetFolders: state.assetFolders,
      shortcuts: state.shortcuts,
      isTaskQueueCollapsed: state.isTaskQueueCollapsed,
      showMiniMap: state.showMiniMap,
      snapToGrid: state.snapToGrid,
      // 使用偏好(storage key 按用户隔离,天然每用户独立)。生成前确认另有
      // 独立小键权威覆盖,这里只是兜底;上次视频参数同样双写。
      confirmBeforeGenerate: state.confirmBeforeGenerate,
      lastVideoParams: state.lastVideoParams,
    };
    lastPartializedSnapshot = snapshot;
    return snapshot;
  },
}));

/** 组件订阅:当前打开的协作项目里我是否只读(访问者)。用于禁用/隐藏画布写入口。 */
useCanvasPreferences.subscribe(({ values }) => {
  const state = useStore.getState();
  if (state.showMiniMap !== values.showMiniMap || state.snapToGrid !== values.snapToGrid) {
    useStore.setState({ showMiniMap: values.showMiniMap, snapToGrid: values.snapToGrid });
  }
});
useStore.subscribe((state, previous) => {
  if (state.activeBackendProjectId !== previous.activeBackendProjectId) cancelCanvasSubmissions();
});
export const useActiveProjectReadOnly = (): boolean => useStore(computeActiveProjectReadOnly);

setChunkReloadSafety(() => useStore.getState().prepareCanvasPageReload());
const unsubscribeTaskUpdates = subscribeTaskUpdates(task => applyTaskResultToNode(task, useStore.getState, useStore.setState as never));
if (import.meta.hot) import.meta.hot.dispose(unsubscribeTaskUpdates);

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
