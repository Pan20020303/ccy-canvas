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

import type { AppProviderConfig } from './api/providerConfigs';
import { generate as apiGenerate } from './api/providerConfigs';
import type { BackendProject } from './api/projects';
import { createProject as apiCreateProject, getCanvas, listProjects, saveCanvas } from './api/projects';

type Language = 'en' | 'zh';

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
};

export type HistoryDraft = Omit<HistoryItem, 'spaceId' | 'spaceType' | 'projectId' | 'mediaType' | 'aspectRatio'> &
  Partial<Pick<HistoryItem, 'spaceId' | 'spaceType' | 'projectId' | 'mediaType' | 'aspectRatio'>>;

export type Project = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type Group = { id: string; nodeIds: string[]; name: string };
type ProjectCanvasState = { nodes: Node[]; edges: Edge[]; groups: Group[] };
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
  aspectRatio?: string;
  durationSeconds?: number;
};

type AppState = {
  language: Language;
  toggleLanguage: () => void;
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
  saveCanvasToBackend: () => Promise<void>;
  spaceMembers: SpaceMember[];
  invitations: AdminInvitation[];
  groups: Group[];
  createGroup: (nodeIds: string[]) => void;
  updateNodeGenerationParams: (nodeId: string, patch: Partial<NodeGenerationParams>) => void;
  runNode: (nodeId: string, payload: { prompt: string; model?: string }) => void;
  cancelNode: (nodeId: string) => void;
  activeRun: { nodeId: string; startedAt: number; timedOut?: boolean } | null;
  shortcuts: Record<string, string>;
  setShortcut: (action: string, combo: string) => void;
  resetShortcuts: () => void;
  isSettingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  isTaskQueueCollapsed: boolean;
  setTaskQueueCollapsed: (v: boolean) => void;
  showMiniMap: boolean;
  setShowMiniMap: (value: boolean) => void;
  snapToGrid: boolean;
  setSnapToGrid: (value: boolean) => void;
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
    },
  },
];

const initialEdges: Edge[] = [{ id: 'e1-2', source: '1', target: '2', animated: true, style: { stroke: '#0891b2', strokeWidth: 2 } }];

const createCanvasSnapshot = (
  nodes: Node[] = [],
  edges: Edge[] = [],
  groups: Group[] = [],
): ProjectCanvasState => ({
  nodes: nodes.map((node) => ({ ...node, position: { ...node.position }, data: { ...(node.data ?? {}) } })),
  edges: edges.map((edge) => ({ ...edge, style: edge.style ? { ...edge.style } : edge.style })),
  groups: groups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })),
});

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

export const appStorage = {
  getItem: (name: string) => localStorage.getItem(name),
  setItem: (name: string, value: string) => localStorage.setItem(name, value),
  removeItem: (name: string) => localStorage.removeItem(name),
};

export const useStore = create<AppState>()(persist((set, get) => ({
  language: 'zh',
  toggleLanguage: () => set((state) => ({ language: state.language === 'en' ? 'zh' : 'en' })),

  spaces: seedSpaces,
  activeSpaceId: 'space-personal',
  activeSpaceType: 'personal',
  spaceSnapshotsById: seedSpaceSnapshotsById,
  nodes: seedSpaceSnapshotsById['space-personal'].projectStateById[seedSpaceSnapshotsById['space-personal'].activeProjectId].nodes,
  edges: seedSpaceSnapshotsById['space-personal'].projectStateById[seedSpaceSnapshotsById['space-personal'].activeProjectId].edges,

  onNodesChange: (changes: NodeChange[]) => {
    set((state) => {
      const nodes = applyNodeChanges(changes, state.nodes);
      const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
      return {
        nodes,
        projectStateById,
        ...syncActiveSpaceSnapshot(state, { projectStateById }),
      };
    });
  },

  onEdgesChange: (changes: EdgeChange[]) => {
    set((state) => {
      const edges = applyEdgeChanges(changes, state.edges);
      const projectStateById = syncActiveProjectState(state, { edges }).projectStateById;
      return {
        edges,
        projectStateById,
        ...syncActiveSpaceSnapshot(state, { projectStateById }),
      };
    });
  },

  onConnect: (connection: Connection) => {
    set((state) => {
      const edges = addEdge({ ...connection, animated: true, style: { stroke: '#0891b2', strokeWidth: 2 } }, state.edges);
      const projectStateById = syncActiveProjectState(state, { edges }).projectStateById;
      return {
        edges,
        projectStateById,
        ...syncActiveSpaceSnapshot(state, { projectStateById }),
      };
    });
  },

  addNode: (node: Node) => {
    set((state) => {
      const nodes = [...state.nodes, node];
      const projectStateById = syncActiveProjectState(state, { nodes }).projectStateById;
      return {
        nodes,
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

  history: [],
  addHistory: (item) => set((state) => ({
    history: [normalizeHistoryItem(item, state.activeSpaceId, state.activeSpaceType, state.activeProjectId), ...state.history].slice(0, 200),
    ...syncActiveSpaceSnapshot(state, {
      history: [normalizeHistoryItem(item, state.activeSpaceId, state.activeSpaceType, state.activeProjectId), ...state.history].slice(0, 200),
    }),
  })),

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
          return { nodes, edges, activeProjectId: first.id, projectStateById };
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
        activeProjectId: id,
        projectStateById: {
          ...state.projectStateById,
          [id]: createCanvasSnapshot(nodes, edges, []),
        },
      }));
    } catch {
      // Canvas not yet saved — load empty canvas.
      set({ nodes: [], edges: [], groups: [], activeProjectId: id });
    } finally {
      set({ backendSyncing: false });
    }
  },

  saveCanvasToBackend: async () => {
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
      await saveCanvas(activeBackendProjectId, cleanNodes, edges);
    } catch {
      // Silent — save errors should not interrupt the user.
    }
  },

  spaceMembers: seedSpaceMembers,
  invitations: seedInvitations,

  groups: seedSpaceSnapshotsById['space-personal'].projectStateById[seedSpaceSnapshotsById['space-personal'].activeProjectId].groups,
  createGroup: (nodeIds) => set((state) => {
    const groups = [...state.groups, { id: `g-${Date.now()}`, nodeIds, name: `Group ${state.groups.length + 1}` }];
    const projectStateById = syncActiveProjectState(state, { groups }).projectStateById;
    return {
      groups,
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),
  updateNodeGenerationParams: (nodeId, patch) => set((state) => {
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
      projectStateById,
      ...syncActiveSpaceSnapshot(state, { projectStateById }),
    };
  }),

  activeRun: null,
  runNode: async (nodeId, payload) => {
    const state = get();
    const resolvedPrompt = payload.prompt.replace(/@([a-zA-Z0-9_-]{1,12})/g, (_match, ref) => {
      const upstreamNode = state.nodes.find((node) => node.id.startsWith(ref));
      if (!upstreamNode) return `@${ref}`;
      const data = (upstreamNode.data ?? {}) as Record<string, string>;
      return data.output ?? data.url ?? data.content ?? `@${ref}`;
    });

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

    // Get aspectRatio (used as size ratio) and resolution from generation params.
    const genParams = (currentNode?.data as Record<string, unknown> | undefined)?.generationParams as NodeGenerationParams | undefined;
    // aspectRatio → ratio for size param (e.g. "16:9"), resolution → "1k"/"2k"/"4k"
    const aspectRatio = genParams?.aspectRatio ?? 'auto';
    // Resolution field might be "自适应·1K" or "1k" — normalize.
    const rawRes = genParams?.resolution ?? '1k';
    const resolution = rawRes.replace(/[^0-9kK]/g, '').toLowerCase() || '1k';

    // Set status to running — clear error but keep old url/content until new result arrives.
    set((snapshot) => ({
      activeRun: { nodeId, startedAt: Date.now() },
      nodes: snapshot.nodes.map((node) => node.id === nodeId
        ? { ...node, data: { ...node.data, status: 'running', error: undefined, prompt: payload.prompt, resolvedPrompt, model: payload.model } }
        : node),
    }));

    // Video-specific: duration from genParams.
    const durationSeconds = genParams?.durationSeconds ?? undefined;

    try {
      const result = await apiGenerate({
        service_type: serviceType,
        model: payload.model ?? '',
        prompt: resolvedPrompt,
        size: aspectRatio,
        resolution,
        duration: durationSeconds,
        aspect_ratio: serviceType === 'video' ? aspectRatio : undefined,
      });

      set((snapshot) => ({
        activeRun: null,
        nodes: snapshot.nodes.map((node) => node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                status: 'done',
                ...(result.type === 'url'
                  ? { url: result.content, output: result.content }
                  : { content: result.content, output: result.content }),
              },
            }
          : node),
      }));

      // Add to history for the file manager panel.
      get().addHistory({
        id: `gen-${Date.now()}`,
        title: payload.prompt.slice(0, 60),
        type: serviceType,
        mediaType: serviceType as 'text' | 'image' | 'video' | 'audio',
        timestamp: Date.now(),
        thumbnail: result.type === 'url' ? result.content : undefined,
        content: result.type === 'text' ? result.content : undefined,
        promptExcerpt: payload.prompt.slice(0, 120),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Generation failed';
      set((snapshot) => ({
        activeRun: null,
        nodes: snapshot.nodes.map((node) => node.id === nodeId
          ? { ...node, data: { ...node.data, status: 'error', error: message } }
          : node),
      }));
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
}), {
  name: 'cineflow-store',
  storage: createJSONStorage(() => appStorage),
  version: 4,
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

      return {
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
      };
    }

    return persistedState;
  },
  partialize: (state) => ({
    language: state.language,
    spaces: state.spaces,
    activeSpaceId: state.activeSpaceId,
    activeSpaceType: state.activeSpaceType,
    spaceSnapshotsById: state.spaceSnapshotsById,
    nodes: state.nodes,
    edges: state.edges,
    history: state.history,
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    projectStateById: state.projectStateById,
    spaceMembers: state.spaceMembers,
    invitations: state.invitations,
    groups: state.groups,
    shortcuts: state.shortcuts,
    isTaskQueueCollapsed: state.isTaskQueueCollapsed,
    showMiniMap: state.showMiniMap,
    snapToGrid: state.snapToGrid,
  }),
}));
