# Group Shell Layering And Canvas Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make group shells render as a background with an external title label, and add working canvas-level `Ctrl+Z`, `Ctrl+C`, and `Ctrl+V`.

**Architecture:** Keep the current overlay-based group shell approach, but split shell body and title label into a lower visual layer that never blocks node interactions. Add a lightweight canvas snapshot undo stack and a store-owned clipboard that copies selected nodes plus their internal edges and pastes them back with remapped ids and offset positions.

**Tech Stack:** React, TypeScript, Zustand, React Flow (`@xyflow/react`), Vitest, Vite.

---

## File Structure

**Modify**
- `D:\code\ccy-canvas\src\app\store.ts`
  - Add undo stack state and clipboard state
  - Wrap mutating canvas operations with undo snapshot capture
  - Implement `undoCanvas`, `copySelectedNodes`, `pasteCopiedNodes`
- `D:\code\ccy-canvas\src\app\store.test.ts`
  - Cover undo and clipboard behavior
- `D:\code\ccy-canvas\src\app\components\Canvas.tsx`
  - Lower group shell layer behind nodes
  - Move title label outside shell
  - Register global keyboard shortcuts for `Ctrl+Z`, `Ctrl+C`, `Ctrl+V`

**Create**
- `D:\code\ccy-canvas\src\app\canvas-clipboard.ts`
  - Pure helpers for copying selected nodes and remapping pasted nodes/edges
- `D:\code\ccy-canvas\src\app\canvas-clipboard.test.ts`
  - Unit tests for clipboard helpers

---

### Task 1: Add Pure Clipboard Helpers

**Files:**
- Create: `D:\code\ccy-canvas\src\app\canvas-clipboard.ts`
- Test: `D:\code\ccy-canvas\src\app\canvas-clipboard.test.ts`

- [ ] **Step 1: Write the failing helper tests**

```ts
import { describe, expect, it, vi } from 'vitest';

import {
  buildCanvasClipboardSelection,
  remapClipboardSelectionForPaste,
} from './canvas-clipboard';

describe('canvas clipboard helpers', () => {
  it('copies only selected nodes and internal edges', () => {
    const selection = buildCanvasClipboardSelection({
      nodes: [
        { id: 'a', selected: true, position: { x: 10, y: 20 }, data: {} },
        { id: 'b', selected: true, position: { x: 40, y: 80 }, data: {} },
        { id: 'c', selected: false, position: { x: 90, y: 120 }, data: {} },
      ] as never,
      edges: [
        { id: 'ab', source: 'a', target: 'b' },
        { id: 'ac', source: 'a', target: 'c' },
      ] as never,
    });

    expect(selection?.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(selection?.edges.map((edge) => edge.id)).toEqual(['ab']);
  });

  it('remaps nodes and internal edges on paste', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);

    const remapped = remapClipboardSelectionForPaste({
      selection: {
        nodes: [
          { id: 'a', selected: true, position: { x: 10, y: 20 }, data: {} },
          { id: 'b', selected: true, position: { x: 40, y: 80 }, data: {} },
        ] as never,
        edges: [{ id: 'ab', source: 'a', target: 'b' }] as never,
      },
      offset: { x: 48, y: 48 },
    });

    expect(remapped.nodes).toHaveLength(2);
    expect(remapped.nodes.map((node) => node.position)).toEqual([
      { x: 58, y: 68 },
      { x: 88, y: 128 },
    ]);
    expect(remapped.nodes.every((node) => node.selected === true)).toBe(true);
    expect(remapped.edges).toHaveLength(1);
    expect(remapped.edges[0]?.source).toBe(remapped.nodes[0]?.id);
    expect(remapped.edges[0]?.target).toBe(remapped.nodes[1]?.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/canvas-clipboard.test.ts`

Expected: FAIL because `canvas-clipboard.ts` does not exist yet.

- [ ] **Step 3: Write minimal helper implementation**

```ts
import type { Edge, Node } from '@xyflow/react';

export type CanvasClipboardSelection = {
  nodes: Node[];
  edges: Edge[];
};

export function buildCanvasClipboardSelection({
  nodes,
  edges,
}: {
  nodes: Node[];
  edges: Edge[];
}): CanvasClipboardSelection | null {
  const selectedNodes = nodes
    .filter((node) => node.selected)
    .map((node) => ({
      ...node,
      position: { ...node.position },
      data: { ...(node.data ?? {}) },
    }));

  if (!selectedNodes.length) return null;

  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdges = edges
    .filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target))
    .map((edge) => ({
      ...edge,
      style: edge.style ? { ...edge.style } : edge.style,
    }));

  return { nodes: selectedNodes, edges: selectedEdges };
}

export function remapClipboardSelectionForPaste({
  selection,
  offset,
}: {
  selection: CanvasClipboardSelection;
  offset: { x: number; y: number };
}) {
  const idMap = new Map<string, string>();
  const stamp = Date.now();

  const nodes = selection.nodes.map((node, index) => {
    const nextId = `node-paste-${stamp}-${index}`;
    idMap.set(node.id, nextId);
    return {
      ...node,
      id: nextId,
      selected: true,
      position: {
        x: node.position.x + offset.x,
        y: node.position.y + offset.y,
      },
      data: { ...(node.data ?? {}) },
    };
  });

  const edges = selection.edges.flatMap((edge, index) => {
    const source = idMap.get(edge.source);
    const target = idMap.get(edge.target);
    if (!source || !target) return [];
    return [{
      ...edge,
      id: `edge-paste-${stamp}-${index}`,
      source,
      target,
      selected: false,
      style: edge.style ? { ...edge.style } : edge.style,
    }];
  });

  return { nodes, edges };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/app/canvas-clipboard.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/canvas-clipboard.ts src/app/canvas-clipboard.test.ts
git commit -m "feat: add canvas clipboard helpers"
```

---

### Task 2: Add Undo Stack And Clipboard To The Store

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\store.ts`
- Test: `D:\code\ccy-canvas\src\app\store.test.ts`

- [ ] **Step 1: Add failing store tests for undo and clipboard actions**

Add:

```ts
it('undoes the last canvas mutation with ctrl-z semantics', async () => {
  const { useStore } = await loadStore();

  useStore.getState().addNode({
    id: 'undo-a',
    type: 'textNode',
    position: { x: 10, y: 20 },
    data: {},
  } as never);

  expect(useStore.getState().nodes.some((node) => node.id === 'undo-a')).toBe(true);

  useStore.getState().undoCanvas();

  expect(useStore.getState().nodes.some((node) => node.id === 'undo-a')).toBe(false);
});

it('copies selected nodes and pastes them with a new offset', async () => {
  const { useStore } = await loadStore();

  useStore.getState().addNode({
    id: 'copy-a',
    type: 'textNode',
    selected: true,
    position: { x: 100, y: 120 },
    data: {},
  } as never);
  useStore.getState().addNode({
    id: 'copy-b',
    type: 'imageNode',
    selected: true,
    position: { x: 180, y: 240 },
    data: {},
  } as never);
  useStore.getState().onConnect({ source: 'copy-a', target: 'copy-b' });

  useStore.getState().copySelectedNodes();
  useStore.getState().pasteCopiedNodes();

  const state = useStore.getState();
  expect(state.nodes).toHaveLength(4);
  expect(state.edges).toHaveLength(2);
  const pastedNodes = state.nodes.filter((node) => node.id !== 'copy-a' && node.id !== 'copy-b');
  expect(pastedNodes.map((node) => node.position)).toEqual(
    expect.arrayContaining([
      { x: 148, y: 168 },
      { x: 228, y: 288 },
    ]),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/store.test.ts`

Expected: FAIL because `undoCanvas`, `copySelectedNodes`, and `pasteCopiedNodes` do not exist yet.

- [ ] **Step 3: Extend store state and implement the actions**

Update the `AppState` interface to add:

```ts
  undoStack: ProjectCanvasState[];
  pushUndoSnapshot: () => void;
  undoCanvas: () => void;
  copiedCanvasSelection: CanvasClipboardSelection | null;
  copySelectedNodes: () => void;
  pasteCopiedNodes: () => void;
```

Import the clipboard helpers:

```ts
import {
  buildCanvasClipboardSelection,
  remapClipboardSelectionForPaste,
  type CanvasClipboardSelection,
} from './canvas-clipboard';
```

Add a small helper near `syncActiveProjectState`:

```ts
const cloneCanvasState = (state: Pick<AppState, 'nodes' | 'edges' | 'groups'>): ProjectCanvasState =>
  createCanvasSnapshot(state.nodes, state.edges, state.groups);
```

Initialize store state:

```ts
  undoStack: [],
  copiedCanvasSelection: null,
```

Implement actions:

```ts
  pushUndoSnapshot: () => set((state) => ({
    undoStack: [...state.undoStack, cloneCanvasState(state)],
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

    const undoStack = [...state.undoStack, cloneCanvasState(state)];
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
```

Wrap mutating canvas actions with undo snapshot capture:

```ts
const undoStack = [...state.undoStack, cloneCanvasState(state)];
```

Apply that pattern to:

- `onNodesChange`
- `onEdgesChange`
- `onConnect`
- `addNode`
- `createGroup`
- `pasteCopiedNodes`

Only push if the mutation actually changes `nodes`, `edges`, or `groups`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/app/store.test.ts src/app/canvas-clipboard.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts src/app/canvas-clipboard.ts src/app/canvas-clipboard.test.ts
git commit -m "feat: add canvas undo and clipboard state"
```

---

### Task 3: Fix Group Shell Layering And Title Placement

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\Canvas.tsx`

- [ ] **Step 1: Lower the group shell behind nodes**

Replace the current group overlay wrapper:

```tsx
<div className="pointer-events-none absolute inset-0 z-[15]">
```

with:

```tsx
<div className="pointer-events-none absolute inset-0 z-[2]">
```

This keeps the shell behind React Flow nodes while preserving its own connector buttons.

- [ ] **Step 2: Move the title outside the shell**

Replace the inner title:

```tsx
<div className="absolute left-4 top-3 text-xs text-neutral-400">
  {group.name} {group.nodeIds.length}{language === 'zh' ? '个节点' : ' nodes'}
</div>
```

with an external label:

```tsx
<div className="pointer-events-none absolute left-3 top-0 -translate-y-[115%] rounded-full border border-white/10 bg-[#111418]/92 px-2.5 py-1 text-[11px] text-neutral-400 shadow-[0_10px_24px_-18px_rgba(0,0,0,0.9)]">
  {group.name} {group.nodeIds.length}{language === 'zh' ? '个节点' : ' nodes'}
</div>
```

- [ ] **Step 3: Keep only the two `+` buttons interactive**

Make sure the shell body remains non-interactive:

```tsx
<div
  className="absolute rounded-[26px] border border-white/10 bg-white/[0.035] shadow-[0_18px_42px_-30px_rgba(0,0,0,0.88)] backdrop-blur-sm"
  style={{ left, top, width, height }}
>
```

and only the left/right connector buttons keep `pointer-events-auto`.

- [ ] **Step 4: Run build to verify layering changes compile**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/Canvas.tsx
git commit -m "fix: move group shell behind nodes"
```

---

### Task 4: Add Global Keyboard Shortcuts

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\Canvas.tsx`

- [ ] **Step 1: Add keyboard shortcut handlers**

Inside `InnerCanvas`, read the new store actions:

```ts
  const undoCanvas = useStore((state) => state.undoCanvas);
  const copySelectedNodes = useStore((state) => state.copySelectedNodes);
  const pasteCopiedNodes = useStore((state) => state.pasteCopiedNodes);
```

Add a focus guard:

```ts
function isEditableTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return Boolean(element.closest('input, textarea, [contenteditable="true"]'));
}
```

Add effect:

```ts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier || isEditableTarget(event.target)) return;

      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        undoCanvas();
        return;
      }
      if (key === 'c') {
        event.preventDefault();
        copySelectedNodes();
        return;
      }
      if (key === 'v') {
        event.preventDefault();
        pasteCopiedNodes();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [copySelectedNodes, pasteCopiedNodes, undoCanvas]);
```

- [ ] **Step 2: Ensure normal text inputs keep native behavior**

Do not add any shortcut handling inside node textareas or rename inputs. The `isEditableTarget(...)` guard is the whole rule for this round.

- [ ] **Step 3: Run tests and build**

Run:
- `npm test -- src/app/store.test.ts src/app/canvas-clipboard.test.ts`
- `npm run build`

Expected: PASS.

- [ ] **Step 4: Manual QA checklist**

Verify in the browser:

- drag/select nodes, press `Ctrl+C`, then `Ctrl+V`, and confirm pasted nodes appear offset
- press `Ctrl+Z` once and confirm the last paste disappears
- create a group and confirm the shell sits behind nodes
- confirm the title floats above the shell rather than inside it
- click inside a textarea/input and confirm `Ctrl+Z` no longer triggers canvas undo there

- [ ] **Step 5: Commit**

```bash
git add src/app/components/Canvas.tsx src/app/store.ts src/app/store.test.ts src/app/canvas-clipboard.ts src/app/canvas-clipboard.test.ts
git commit -m "feat: add canvas shortcuts and group shell layering"
```

---

## Self-Review

### Spec coverage

- Group shell becomes a background: covered in Task 3
- Group title moves outside shell: covered in Task 3
- `Ctrl+Z` global canvas undo: covered in Tasks 2 and 4
- `Ctrl+C` copy selected nodes/internal edges: covered in Tasks 1, 2, and 4
- `Ctrl+V` paste copied nodes with offset: covered in Tasks 1, 2, and 4
- Explicit non-goals like redo/delete/group-copy are not included in any task

### Placeholder scan

- No `TODO` / `TBD`
- Each code-changing task includes exact code blocks or explicit target changes
- Test commands and expected outcomes are specified

### Type consistency

- Clipboard type is consistently `CanvasClipboardSelection`
- Undo state always uses `ProjectCanvasState`
- Store action names are consistently `undoCanvas`, `copySelectedNodes`, `pasteCopiedNodes`

---

Plan complete and saved to `docs/superpowers/plans/2026-06-02-group-shell-layering-and-canvas-shortcuts-implementation.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
