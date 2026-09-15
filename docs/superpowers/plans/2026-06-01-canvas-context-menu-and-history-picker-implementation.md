# Canvas Context Menu And History Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the requested canvas right-click menus and dedicated history image picker, while fixing the current history-assets hook crash.

**Architecture:** Keep the visual menus and picker modal state local to `Canvas.tsx` and the new picker component, while reusing existing store history and upload helpers. Fix the hook crash by ensuring `HistoryAssetsModal` never conditionally skips hooks before later hook declarations.

**Tech Stack:** React, Zustand, TypeScript, Vitest, existing canvas upload/history infrastructure.

---

### Task 1: Fix the history assets hook-order crash

**Files:**
- Modify: `src/app/components/HistoryAssetsModal.tsx`

- [ ] Move the `isOpen` guard so all hooks run consistently before any conditional return.
- [ ] Verify history assets can render without React hook-order exceptions.

### Task 2: Add helper coverage for history image picker behavior

**Files:**
- Modify: `src/app/history-assets.ts`
- Modify: `src/app/history-assets.test.ts`

- [ ] Add any pure helpers needed for selectable image-history lists.
- [ ] Run: `npm test -- src/app/history-assets.test.ts`
- [ ] Expected: PASS

### Task 3: Build the dedicated history image picker modal

**Files:**
- Create: `src/app/components/HistoryImagePickerModal.tsx`
- Modify: `src/app/components/Modals.tsx` or `src/app/components/Canvas.tsx`

- [ ] Implement the modal shell matching the reference layout.
- [ ] Populate the image tab from existing image history.
- [ ] Allow multi-select and confirm.
- [ ] Insert selected history images back onto the canvas as `referenceImageNode`.

### Task 4: Replace the simple canvas picker with the requested menu flow

**Files:**
- Modify: `src/app/components/Canvas.tsx`

- [ ] Replace the existing single popup picker with:
  - top-level context menu
  - nested add-node submenu
- [ ] Add disabled placeholders for `视频合成`, `导演台`, `脚本`.
- [ ] Add menu-triggered local upload using a hidden file input.
- [ ] Add menu-triggered history image picker launch.

### Task 5: Verify the full slice

**Files:**
- Verify: `src/app/components/Canvas.tsx`
- Verify: `src/app/components/HistoryAssetsModal.tsx`
- Verify: `src/app/components/HistoryImagePickerModal.tsx`
- Verify: `src/app/history-assets.ts`

- [ ] Run: `npm test -- src/app/history-assets.test.ts src/app/store.test.ts`
- [ ] Expected: PASS
- [ ] Run: `npm run build`
- [ ] Expected: PASS
