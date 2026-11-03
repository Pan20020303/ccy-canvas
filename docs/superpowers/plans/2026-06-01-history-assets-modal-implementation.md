# History Assets Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the floating history browser with a dedicated history assets modal that supports zoom, time-desc browsing, and batch select actions.

**Architecture:** Keep modal visibility and reusable history mutations in the global store, but keep view-local state such as active tab, zoom, bulk mode, and current selection inside a dedicated modal component. Extract the data shaping logic into pure helpers so the bulk-selection and grouped rendering behavior can be tested without heavy UI harnesses.

**Tech Stack:** React, Zustand, TypeScript, Vitest, Tailwind utility classes, existing modal and canvas node infrastructure.

---

### Task 1: Add store support for the history assets modal

**Files:**
- Modify: `src/app/store.ts`
- Test: `src/app/store.test.ts`

- [ ] **Step 1: Write the failing tests for modal state, history removal, and reuse insertion**

Add tests that prove:
- opening and closing the history modal toggles global state
- removing selected history IDs only affects the active space history
- using selected image/video history items inserts reference nodes onto the canvas

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/store.test.ts`
Expected: FAIL because the new store actions do not exist yet.

- [ ] **Step 3: Write the minimal store implementation**

Add:
- `isHistoryAssetsOpen`
- `setHistoryAssetsOpen(open: boolean)`
- `removeHistoryItems(ids: string[])`
- `reuseHistoryItems(ids: string[])`

Implementation notes:
- `removeHistoryItems` updates both `history` and the current space snapshot
- `reuseHistoryItems` maps image history to `referenceImageNode`, video history to `referenceVideoNode`, and skips unsupported types
- reused nodes should be staggered on canvas and synchronized back into the active project snapshot

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/app/store.test.ts`
Expected: PASS

### Task 2: Extract and test history modal helper logic

**Files:**
- Create: `src/app/history-assets.ts`
- Create or Modify: `src/app/history-assets.test.ts`

- [ ] **Step 1: Write the failing tests for filtering, grouping, counting, zoom mapping, and selectable actions**

Add pure tests that verify:
- media tab filtering by `image`, `video`, `audio`
- history grouping by day in descending order
- tab counts
- zoom percentage to layout token mapping
- batch action availability based on selected history item types

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/history-assets.test.ts`
Expected: FAIL because the helper module does not exist yet.

- [ ] **Step 3: Write the minimal helper implementation**

Implement pure utilities for:
- filtering history by media type
- grouping filtered history into date buckets
- computing tab counts
- mapping `75/100/125` zoom values to layout classes or widths
- determining whether `delete`, `download`, and `use` are enabled for the current selection

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/app/history-assets.test.ts`
Expected: PASS

### Task 3: Build the dedicated history assets modal UI

**Files:**
- Create: `src/app/components/HistoryAssetsModal.tsx`
- Modify: `src/app/components/Modals.tsx`

- [ ] **Step 1: Implement the modal shell and normal browse mode**

Create a dedicated modal with:
- title `历史资产`
- tabs with counts
- zoom controls
- close button
- time-desc label/control
- batch mode entry button
- grouped asset rendering area
- empty state per tab

- [ ] **Step 2: Implement bulk selection mode**

Add:
- selected count display
- batch action buttons
- cancel selection
- per-item checkbox
- per-group checkbox

Keep selection state local to the modal and reset it on close.

- [ ] **Step 3: Wire batch actions to store behavior**

Connect:
- `删除` -> `removeHistoryItems`
- `使用` -> `reuseHistoryItems`
- `下载` -> browser-side download behavior for URL-backed items

- [ ] **Step 4: Render the modal from the shared modal host**

Mount the new modal inside `Modals.tsx` using the global `isHistoryAssetsOpen` state.

### Task 4: Switch the toolbar entry away from the floating history browser

**Files:**
- Modify: `src/app/components/Toolbar.tsx`
- Modify: `src/app/i18n.ts`

- [ ] **Step 1: Remove the old floating history rendering path**

Keep the `files` entry point in the toolbar, but stop rendering the current narrow history masonry browser as the primary history UI.

- [ ] **Step 2: Open the history assets modal from the toolbar flow**

The files/history interaction should now trigger `setHistoryAssetsOpen(true)`.

- [ ] **Step 3: Keep non-history file affordances lightweight**

If `output` remains unavailable this round, preserve a small placeholder rather than a second large browser panel.

- [ ] **Step 4: Add any missing i18n strings**

Add only the new labels needed by the modal and batch controls.

### Task 5: Verify the full slice

**Files:**
- Verify: `src/app/store.ts`
- Verify: `src/app/history-assets.ts`
- Verify: `src/app/components/HistoryAssetsModal.tsx`
- Verify: `src/app/components/Toolbar.tsx`
- Verify: `src/app/components/Modals.tsx`

- [ ] **Step 1: Run focused tests**

Run: `npm test -- src/app/store.test.ts src/app/history-assets.test.ts`
Expected: PASS

- [ ] **Step 2: Run production build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Sanity-check against the approved spec**

Confirm the implementation provides:
- full-screen history modal
- normal mode and bulk mode
- zoom control
- time-desc presentation
- grouped selectable records
- batch `删除 / 下载 / 使用 / 取消选择`

