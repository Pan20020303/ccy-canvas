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

import {
  getDefaultSubmitEndpoint,
  ModelConfig,
  normalizeModelBaseUrl,
  resolveModelConfigForSelection,
  ServiceType,
} from './model-config';
import { buildModelRequestBody, getModelTemplate } from './model-templates';

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
  modelConfigs: ModelConfig[];
  upsertModelConfig: (config: ModelConfig) => void;
  removeModelConfig: (id: string) => void;
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

const seedModelConfigs: ModelConfig[] = [
  {
    id: 'cfg-text-openai',
    serviceType: 'text',
    vendor: 'OpenAI',
    protocol: 'openai',
    name: 'OpenAI Text',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    submitEndpoint: '/chat/completions',
    queryEndpoint: '',
    modelList: ['gpt-4.1-mini', 'gpt-4.1'],
    defaultModel: 'gpt-4.1-mini',
    priority: 1,
    enabled: true,
    isDefault: true,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'cfg-image-openai',
    serviceType: 'image',
    vendor: 'OpenAI',
    protocol: 'openai',
    name: 'OpenAI Image',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    submitEndpoint: '/images/generations',
    queryEndpoint: '',
    modelList: ['gpt-image-1', 'gpt-image-2'],
    defaultModel: 'gpt-image-2',
    priority: 1,
    enabled: true,
    isDefault: true,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'cfg-video-runway',
    serviceType: 'video',
    vendor: 'Runway',
    protocol: 'custom',
    name: 'Runway Video',
    baseUrl: 'https://api.runwayml.com/v1',
    apiKey: '',
    submitEndpoint: '/generations',
    queryEndpoint: '',
    modelList: ['runway-gen3'],
    defaultModel: 'runway-gen3',
    priority: 1,
    enabled: true,
    isDefault: true,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'cfg-audio-suno',
    serviceType: 'audio',
    vendor: 'Suno',
    protocol: 'custom',
    name: 'Suno Audio',
    baseUrl: 'https://api.suno.ai/v1',
    apiKey: '',
    submitEndpoint: '/generations',
    queryEndpoint: '',
    modelList: ['suno-v4'],
    defaultModel: 'suno-v4',
    priority: 1,
    enabled: true,
    isDefault: true,
    createdAt,
    updatedAt: createdAt,
  },
];

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

  modelConfigs: seedModelConfigs,
  upsertModelConfig: (config) => set((state) => {
    const candidate = { ...config, updatedAt: Date.now() };
    const next = state.modelConfigs.some((item) => item.id === candidate.id)
      ? state.modelConfigs.map((item) => item.id === candidate.id ? candidate : item)
      : [{ ...candidate, createdAt: candidate.createdAt || Date.now() }, ...state.modelConfigs];

    return {
      modelConfigs: next.map((item) => {
        if (item.serviceType === candidate.serviceType && candidate.isDefault && item.id !== candidate.id) {
          return { ...item, isDefault: false };
        }
        return item;
      }),
    };
  }),
  removeModelConfig: (id) => set((state) => ({ modelConfigs: state.modelConfigs.filter((item) => item.id !== id) })),

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
    const currentNode = state.nodes.find((node) => node.id === nodeId);
    const generationParams = ((currentNode?.data as Record<string, unknown> | undefined)?.generationParams ?? {}) as NodeGenerationParams;
    const nodeTypeToServiceType: Record<string, ServiceType> = {
      textNode: 'text',
      imageNode: 'image',
      videoNode: 'video',
      audioNode: 'audio',
      panoramaNode: 'image',
    };
    const serviceType = nodeTypeToServiceType[currentNode?.type ?? 'textNode'] ?? 'text';
    const config = resolveModelConfigForSelection(state.modelConfigs, serviceType, payload.model);
    const patch = (data: Record<string, unknown>) =>
      set((snapshot) => {
        const nodes = snapshot.nodes.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node);
        const projectStateById = syncActiveProjectState(snapshot, { nodes }).projectStateById;
        return {
          nodes,
          projectStateById,
          ...syncActiveSpaceSnapshot(snapshot, { projectStateById }),
        };
      });

    if (!config || !config.baseUrl || !config.apiKey) {
      patch({ status: 'error', error: 'Model URL or API key not configured' });
      return;
    }

    const resolvedPrompt = payload.prompt.replace(/@([a-zA-Z0-9_-]{1,12})/g, (_match, ref) => {
      const upstreamNode = state.nodes.find((node) => node.id.startsWith(ref));
      if (!upstreamNode) return `@${ref}`;
      const data = (upstreamNode.data ?? {}) as Record<string, string>;
      return data.output ?? data.url ?? data.content ?? `@${ref}`;
    });

    const taskId = `t-${Date.now()}`;
    const startedAt = Date.now();
    const controller = new AbortController();
    runAborters[nodeId] = controller;
    const timeout = setTimeout(() => controller.abort(), 8 * 60 * 1000);
    const modelName = payload.model?.trim() || config.defaultModel;
    const template = getModelTemplate(modelName);

    set((snapshot) => ({
      activeRun: { nodeId, startedAt },
      nodes: snapshot.nodes.map((node) => node.id === nodeId
        ? { ...node, data: { ...node.data, status: 'generating', error: undefined, prompt: payload.prompt, model: modelName } }
        : node),
      tasks: [{ id: taskId, type: config.serviceType, status: 'generating', progress: 0 }, ...snapshot.tasks],
    }));

    const finishTask = (status: TaskStatus) => {
      set((snapshot) => ({
        tasks: snapshot.tasks.map((task) => task.id === taskId ? { ...task, status, progress: 100 } : task),
        activeRun: snapshot.activeRun?.nodeId === nodeId ? null : snapshot.activeRun,
      }));
    };

    const baseUrl = normalizeModelBaseUrl(config.baseUrl);
    const endpointPath = getDefaultSubmitEndpoint(config);
    const endpoint = `${baseUrl}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    };

    try {
      let body: Record<string, unknown>;
      if (config.serviceType === 'text') {
        body = { model: modelName, messages: [{ role: 'user', content: resolvedPrompt }] };
      } else if (config.serviceType === 'image') {
        body = {
          ...buildModelRequestBody(template, resolvedPrompt, {
            ...generationParams,
            model: modelName,
          }),
          n: 1,
        };
      } else {
        body = buildModelRequestBody(template, resolvedPrompt, {
          ...generationParams,
          model: modelName,
        });
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${rawText ? `: ${rawText.slice(0, 200)}` : ''}`);
      }

      let json: any;
      try {
        json = JSON.parse(rawText);
      } catch {
        const hint = rawText.trim().startsWith('<')
          ? 'endpoint returned HTML (check base URL and endpoint path)'
          : 'response was not JSON';
        throw new Error(`${hint}: ${rawText.slice(0, 160)}`);
      }

      if (json.error) {
        const error = json.error;
        throw new Error(error.message || error.code || JSON.stringify(error).slice(0, 200));
      }

      const title = resolvedPrompt.slice(0, 60) || config.name;
      if (config.serviceType === 'text') {
        const output = json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text ?? '';
        patch({ status: 'completed', output, content: output });
        get().addHistory({ id: `h-${Date.now()}`, title, type: 'text', timestamp: Date.now(), content: output, promptExcerpt: resolvedPrompt });
      } else if (config.serviceType === 'image') {
        const url = json.data?.[0]?.url || (json.data?.[0]?.b64_json ? `data:image/png;base64,${json.data[0].b64_json}` : null);
        if (!url) throw new Error('No image in response');
        patch({ status: 'completed', url });
        get().addHistory({ id: `h-${Date.now()}`, title, type: 'image', timestamp: Date.now(), thumbnail: url, promptExcerpt: resolvedPrompt });
      } else {
        const url = json.url || json.data?.[0]?.url || json.output?.url;
        patch({ status: 'completed', url, output: JSON.stringify(json).slice(0, 500) });
        get().addHistory({ id: `h-${Date.now()}`, title, type: config.serviceType, timestamp: Date.now(), thumbnail: url, promptExcerpt: resolvedPrompt });
      }
      finishTask('completed');
    } catch (error: any) {
      const message = controller.signal.aborted ? 'Aborted (timeout or cancelled)' : (error?.message || 'Request failed');
      patch({ status: 'error', error: message });
      finishTask('failed');
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
    modelConfigs: state.modelConfigs,
    spaceMembers: state.spaceMembers,
    invitations: state.invitations,
    groups: state.groups,
    shortcuts: state.shortcuts,
    isTaskQueueCollapsed: state.isTaskQueueCollapsed,
    showMiniMap: state.showMiniMap,
    snapToGrid: state.snapToGrid,
  }),
}));
