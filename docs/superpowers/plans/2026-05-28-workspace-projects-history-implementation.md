# Workspace Projects And History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build real per-project canvas isolation in `/app`, improve the project switcher UX, and turn history browsing into a masonry-style media surface without leaving the workspace.

**Architecture:** Extend the Zustand workspace store so each project owns its own canvas snapshot instead of sharing one global `nodes / edges / groups` state. Keep the existing left-rail entry points, but upgrade the `Projects` panel into a true project switcher and the `Files / History` panel into a masonry-oriented browser backed by richer history metadata.

**Tech Stack:** React 19, TypeScript, Zustand, Vite, Tailwind CSS, `react-responsive-masonry`, Vitest

---

### Task 1: Define Project-Scoped Canvas State In The Store

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\store.ts`
- Test: `D:\code\ccy-canvas\src\app\store.test.ts`

- [ ] **Step 1: Write a failing test for project creation producing isolated canvas state**

Add to `src/app/store.test.ts`:

```ts
it('creates a new project with its own empty canvas snapshot', () => {
  const store = createTestStore();

  store.getState().createProject('Storyboard B');

  const state = store.getState();
  expect(state.projects).toHaveLength(2);
  expect(state.activeProjectId).not.toBe('p-default');
  expect(state.nodes).toEqual([]);
  expect(state.edges).toEqual([]);
  expect(state.groups).toEqual([]);
});
```

- [ ] **Step 2: Run the test and verify the failure is about shared canvas state**

Run:

```powershell
npm test -- src/app/store.test.ts -t "creates a new project with its own empty canvas snapshot"
```

Expected: FAIL because project creation does not yet isolate or restore a project-owned snapshot.

- [ ] **Step 3: Write a second failing test for switching back to a previous project**

Add to `src/app/store.test.ts`:

```ts
it('restores the correct nodes, edges, and groups when switching projects', () => {
  const store = createTestStore();

  store.getState().addNode({
    id: 'text-1',
    type: 'textNode',
    position: { x: 40, y: 60 },
    data: { content: 'Project A' },
  } as never);
  store.getState().createGroup(['1', 'text-1']);
  store.getState().createProject('Storyboard B');
  store.getState().addNode({
    id: 'image-1',
    type: 'imageNode',
    position: { x: 120, y: 140 },
    data: { caption: 'Project B' },
  } as never);

  store.getState().switchProject('p-default');

  const state = store.getState();
  expect(state.nodes.some((node) => node.id === 'text-1')).toBe(true);
  expect(state.nodes.some((node) => node.id === 'image-1')).toBe(false);
  expect(state.groups).toHaveLength(1);
});
```

- [ ] **Step 4: Run the second test and verify the failure is about missing snapshot restoration**

Run:

```powershell
npm test -- src/app/store.test.ts -t "restores the correct nodes, edges, and groups when switching projects"
```

Expected: FAIL because switching projects currently only flips `activeProjectId`.

- [ ] **Step 5: Implement a project snapshot model in `store.ts`**

Add and use a store-internal shape like:

```ts
type ProjectCanvasState = {
  nodes: Node[];
  edges: Edge[];
  groups: Group[];
};

type Project = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};
```

And keep a keyed map in state:

```ts
projectStateById: Record<string, ProjectCanvasState>;
```

Expected: each project now owns its own canvas snapshot.

- [ ] **Step 6: Save snapshots before switching and hydrate snapshots after switching**

Implement logic in `createProject`, `switchProject`, `addNode`, `onNodesChange`, `onEdgesChange`, `onConnect`, and `createGroup` so the active project snapshot is always the source of truth.

Expected: the visible canvas tracks the active project and survives switching.

- [ ] **Step 7: Run the targeted tests again**

Run:

```powershell
npm test -- src/app/store.test.ts -t "project"
```

Expected: PASS.

### Task 2: Add Store Tests For History Shaping

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\store.ts`
- Test: `D:\code\ccy-canvas\src\app\store.test.ts`

- [ ] **Step 1: Write a failing test for normalized history card metadata**

Add to `src/app/store.test.ts`:

```ts
it('stores history items with masonry-friendly metadata defaults', () => {
  const store = createTestStore();

  store.getState().addHistory({
    id: 'h-1',
    title: 'Hero portrait',
    type: 'image',
    timestamp: 1,
    thumbnail: 'https://example.com/image.png',
  });

  const [item] = store.getState().history;
  expect(item.mediaType).toBe('image');
  expect(item.aspectRatio).toBe('square');
  expect(item.projectId).toBe('p-default');
});
```

- [ ] **Step 2: Run the history test and verify the failure is about missing metadata**

Run:

```powershell
npm test -- src/app/store.test.ts -t "stores history items with masonry-friendly metadata defaults"
```

Expected: FAIL because the current history item type is too thin.

- [ ] **Step 3: Extend `HistoryItem` for gallery usage**

Update `src/app/store.ts` so `HistoryItem` includes:

```ts
export type HistoryMediaType = 'text' | 'image' | 'video' | 'audio';
export type HistoryAspectRatio = 'portrait' | 'square' | 'landscape' | 'text';

export type HistoryItem = {
  id: string;
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
```

Expected: history entries can drive masonry layout without view-specific hacks.

- [ ] **Step 4: Normalize incoming history entries in `addHistory`**

Implement a helper that fills missing fields from the current active project and media type:

```ts
const normalizeHistoryItem = (
  item: Omit<HistoryItem, 'projectId' | 'mediaType' | 'aspectRatio'> & Partial<Pick<HistoryItem, 'projectId' | 'mediaType' | 'aspectRatio'>>
) => ({
  ...item,
  projectId: item.projectId ?? get().activeProjectId,
  mediaType: (item.mediaType ?? item.type) as HistoryMediaType,
  aspectRatio: item.aspectRatio ?? (item.type === 'image' ? 'square' : item.type === 'text' ? 'text' : 'landscape'),
});
```

Expected: all history rows are render-ready when inserted.

- [ ] **Step 5: Re-run the history test**

Run:

```powershell
npm test -- src/app/store.test.ts -t "stores history items with masonry-friendly metadata defaults"
```

Expected: PASS.

### Task 3: Upgrade The Project Panel UX

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\Toolbar.tsx`
- Check: `D:\code\ccy-canvas\src\app\i18n.ts`

- [ ] **Step 1: Replace garbled inline project copy with explicit Chinese/English labels**

Use inline labels like:

```ts
const PROJECT_LABELS = {
  title: { zh: '画布项目', en: 'Canvas Projects' },
  newProject: { zh: '新建项目', en: 'New Project' },
  emptyName: { zh: '未命名项目', en: 'Untitled Project' },
  createdAt: { zh: '创建于', en: 'Created' },
};
```

Expected: project UI copy is readable and consistent.

- [ ] **Step 2: Replace `window.prompt` with an inline mini composer**

Implement local state in `Toolbar.tsx`:

```ts
const [newProjectName, setNewProjectName] = useState('');
const [isCreatingProject, setIsCreatingProject] = useState(false);
```

Expected: project creation feels anchored to the panel rather than like a browser fallback.

- [ ] **Step 3: Render richer project rows**

Each project row should show:

```tsx
<div className="flex items-center justify-between">
  <div>
    <div className="text-sm font-medium">{project.name}</div>
    <div className="text-[10px] text-neutral-500">{formatProjectDate(project.createdAt)}</div>
  </div>
  {project.id === activeProjectId ? <Check ... /> : null}
</div>
```

Expected: the active project is obvious and the list feels less temporary.

- [ ] **Step 4: Add empty-safe default naming**

Generate defaults in the store using a stable pattern:

```ts
const nextProjectName = name?.trim() || `Project ${state.projects.length + 1}`;
```

With Chinese display fallback handled at render time:

```ts
const displayName = project.name.trim() || (language === 'zh' ? '未命名项目' : 'Untitled Project');
```

Expected: no project appears blank or accidental.

### Task 4: Build A Real Masonry History Surface

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\Toolbar.tsx`
- Check: `D:\code\ccy-canvas\src\app\store.ts`

- [ ] **Step 1: Write a small rendering test or use existing component coverage if present**

If no component test harness exists, skip adding a new UI test file and verify via browser in Task 5. Keep logic test coverage in `store.test.ts`.

- [ ] **Step 2: Replace the flat history tile treatment with card metadata**

Render cards with:

```tsx
<div className="rounded-2xl border border-white/8 bg-[#12161b] overflow-hidden">
  <div className={thumbnail ? 'bg-black/30' : 'p-3'}>
    ...
  </div>
  <div className="p-3">
    <div className="line-clamp-2 text-xs text-neutral-100">{item.title}</div>
    <div className="mt-2 flex items-center justify-between text-[10px] text-neutral-500">
      <span>{historyTypeLabel}</span>
      <span>{formatHistoryTime(item.timestamp)}</span>
    </div>
  </div>
</div>
```

Expected: history looks like a browseable media feed, not leftover debug output.

- [ ] **Step 3: Use aspect-ratio-aware preview shells**

Map `aspectRatio` to preview classes:

```ts
const previewClassByAspectRatio = {
  portrait: 'aspect-[3/4]',
  square: 'aspect-square',
  landscape: 'aspect-[4/3]',
  text: 'min-h-[120px]',
};
```

Expected: mixed media cards feel intentionally staggered in masonry.

- [ ] **Step 4: Keep filters working with the masonry feed**

Filter rules should continue to support:

```ts
search -> all
image -> item.mediaType === 'image'
video -> item.mediaType === 'video'
audio -> item.mediaType === 'audio'
```

Expected: type filtering works without leaving the masonry pattern.

- [ ] **Step 5: Improve empty states**

Use copy like:

```tsx
{language === 'zh' ? '这个项目还没有历史生成内容' : 'No generated history for this project yet'}
```

Expected: empty states explain the feature rather than looking broken.

### Task 5: Verification And Browser Smoke Test

**Files:**
- Check: `D:\code\ccy-canvas\src\app\store.test.ts`
- Check: `D:\code\ccy-canvas\src\app\components\Toolbar.tsx`

- [ ] **Step 1: Run the targeted tests**

Run:

```powershell
npm test -- src/app/store.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the production build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 3: Verify the workspace in the in-app browser**

Manual smoke checklist:

```text
1. Open /app.
2. Open the project panel and create a second project.
3. Add a node in project A, switch to project B, and confirm the canvas is isolated.
4. Switch back to project A and confirm the original node returns.
5. Open Files -> History and confirm masonry cards render cleanly for mixed item types.
6. Toggle image/video/audio filters and confirm the masonry feed updates correctly.
```

Expected: the workspace now behaves like a multi-project surface with visual history browsing.

## Self-Review

- Spec coverage: this plan covers project creation, project switching, project-scoped canvas state, masonry history presentation, and filter continuity.
- Placeholder scan: every task points to exact files, concrete tests, concrete state shapes, and concrete verification commands.
- Type consistency: `Project`, `ProjectCanvasState`, `HistoryItem`, `mediaType`, `aspectRatio`, and toolbar filter behavior use one shared naming model throughout.
