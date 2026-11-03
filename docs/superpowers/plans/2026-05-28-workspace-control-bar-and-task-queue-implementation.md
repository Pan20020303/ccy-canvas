# Workspace Control Bar And Task Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the task queue into the top-right personal activity zone and replace the default bottom-left React Flow controls with a fully custom three-button canvas control bar.

**Architecture:** Keep the current workspace route and major layout intact, but split the behavior across focused components: the navbar hosts the compact personal task queue entry, while the canvas owns custom control-bar state for minimap visibility, grid snapping, and fit-to-view. Use lightweight store state for control persistence and keep task visibility scoped to the current user experience.

**Tech Stack:** React 19, TypeScript, Zustand, React Router, React Flow, Tailwind CSS, Vitest

---

### Task 1: Add Store State For Canvas Controls

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\store.ts`
- Test: `D:\code\ccy-canvas\src\app\store.test.ts`

- [ ] **Step 1: Write a failing test for default control-bar state**

Add to `src/app/store.test.ts`:

```ts
it("starts with minimap hidden and grid snap disabled", async () => {
  const { useStore } = await loadStore();

  const state = useStore.getState() as Record<string, unknown>;
  expect(state.showMiniMap).toBe(false);
  expect(state.snapToGrid).toBe(false);
});
```

- [ ] **Step 2: Run the test and verify the failure is about missing control state**

Run:

```powershell
npm test -- src/app/store.test.ts -t "starts with minimap hidden and grid snap disabled"
```

Expected: FAIL because the store does not yet expose `showMiniMap` or `snapToGrid`.

- [ ] **Step 3: Write a second failing test for toggling control state**

Add to `src/app/store.test.ts`:

```ts
it("toggles minimap and grid snap independently", async () => {
  const { useStore } = await loadStore();

  useStore.getState().setShowMiniMap(true);
  useStore.getState().setSnapToGrid(true);

  const state = useStore.getState();
  expect(state.showMiniMap).toBe(true);
  expect(state.snapToGrid).toBe(true);
});
```

- [ ] **Step 4: Run the second test and verify the failure is about missing setters**

Run:

```powershell
npm test -- src/app/store.test.ts -t "toggles minimap and grid snap independently"
```

Expected: FAIL because the control setters do not exist yet.

- [ ] **Step 5: Add the minimal control state to `store.ts`**

Implement state and setters:

```ts
showMiniMap: false,
setShowMiniMap: (value) => set({ showMiniMap: value }),
snapToGrid: false,
setSnapToGrid: (value) => set({ snapToGrid: value }),
```

Expected: canvas-control state is now explicit and can be shared across components.

- [ ] **Step 6: Re-run the targeted tests**

Run:

```powershell
npm test -- src/app/store.test.ts -t "minimap|grid snap"
```

Expected: PASS.

### Task 2: Move The Personal Task Queue Into The Top-Right Navbar Zone

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\TaskQueue.tsx`
- Modify: `D:\code\ccy-canvas\src\app\components\Navbar.tsx`
- Modify: `D:\code\ccy-canvas\src\app\routes.tsx`

- [ ] **Step 1: Keep `TaskQueue` as a compact trigger-plus-panel component**

Refactor `TaskQueue.tsx` so it no longer absolutely positions itself. It should render a compact trigger and a dropdown-like panel anchored by its parent container.

Expected: the queue can be embedded inside the navbar without layout hacks.

- [ ] **Step 2: Place `TaskQueue` beside the language switcher in `Navbar.tsx`**

Render the top-right utility order as:

```tsx
language switcher -> task queue -> avatar menu
```

Expected: personal activity and personal settings live together in the same zone.

- [ ] **Step 3: Remove the standalone queue mount from the workspace route**

Delete the independent `<TaskQueue />` render from `routes.tsx`.

Expected: there is only one task-queue instance in the workspace.

### Task 3: Replace React Flow Default Controls With A Custom Control Bar

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\Canvas.tsx`

- [ ] **Step 1: Remove the default `Controls` import and render**

Delete:

```tsx
import { Controls } from '@xyflow/react';
...
<Controls ... />
```

Expected: the old plus/minus/fit control cluster disappears completely.

- [ ] **Step 2: Add a custom bottom-left control bar**

Render a floating bar with three icon buttons:

```tsx
MiniMap toggle
Grid snap toggle
Fit view
```

Expected: the workspace now uses product-designed controls instead of framework defaults.

- [ ] **Step 3: Keep the minimap above the control bar when enabled**

Render `MiniMap` only when `showMiniMap` is true.

Expected: hidden minimap does not reserve space; visible minimap feels attached to the control bar.

### Task 4: Implement Grid Snap And Fit-To-Canvas Behavior

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\Canvas.tsx`
- Check: `D:\code\ccy-canvas\src\app\store.ts`

- [ ] **Step 1: Wire the fit button to React Flow `fitView`**

Use the `useReactFlow()` instance:

```tsx
const { fitView, screenToFlowPosition } = useReactFlow();
```

Expected: clicking the fit button immediately frames the current canvas content.

- [ ] **Step 2: Implement node-position snapping for dragged nodes**

Apply grid snapping during node movement by normalizing positions to a fixed step such as `24` when `snapToGrid` is enabled.

Expected: node dragging feels aligned without needing advanced snapping logic.

- [ ] **Step 3: Keep the behavior scoped to node movement only**

Do not add edge, group-boundary, or magnetic snapping in this pass.

Expected: the implementation stays focused and low-risk.

### Task 5: Verify Build And Browser Flows

**Files:**
- Check: `D:\code\ccy-canvas\src\app\components\Navbar.tsx`
- Check: `D:\code\ccy-canvas\src\app\components\TaskQueue.tsx`
- Check: `D:\code\ccy-canvas\src\app\components\Canvas.tsx`

- [ ] **Step 1: Run the targeted tests**

Run:

```powershell
npm test -- src/app/store.test.ts src/app/model-config.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the production build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 3: Smoke-test the workspace in the browser**

Manual checklist:

```text
1. Open /app.
2. Confirm the task queue appears in the top-right beside the language switcher.
3. Expand the queue and confirm it still shows the current user's tasks only.
4. Confirm the bottom-left default React Flow controls are gone.
5. Toggle the minimap on and off.
6. Toggle grid snap and drag a node to confirm alignment changes.
7. Click fit-to-canvas and confirm the viewport recenters correctly.
```

Expected: the custom control layer behaves as designed and the workspace layout matches the new interaction model.

## Self-Review

- Spec coverage: the plan covers top-right personal task queue placement, personal-only task visibility, custom minimap toggle, grid snap toggle, and fit-to-canvas.
- Placeholder scan: each task points to exact files, exact behaviors, and exact verification commands.
- Type consistency: `showMiniMap`, `snapToGrid`, `setShowMiniMap`, and `setSnapToGrid` are reused consistently across tests, store state, and UI wiring.
