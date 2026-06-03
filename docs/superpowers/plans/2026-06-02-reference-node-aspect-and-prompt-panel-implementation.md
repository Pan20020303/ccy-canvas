# Reference Node Aspect And Prompt Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reference image/video nodes render with their true media aspect ratios and refactor prompt panels into fixed-height dialogs with top previews and an expanded reading mode.

**Architecture:** Keep the existing node and prompt-panel architecture inside `CustomNodes.tsx`, but switch reference nodes to CSS `aspect-ratio` based on measured media dimensions. Refactor `PromptPanel` into a constrained shell with a preview strip, scrollable body, and a portal-based expanded modal that shares the same editing state.

**Tech Stack:** React, TypeScript, Zustand, React Flow, Vite.

---

## File Structure

**Modify**
- `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`

---

### Task 1: Add True Aspect Ratio Rendering For Reference Nodes

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`

- [ ] **Step 1: Replace fixed `aspect-video` fallback in reference nodes**

For `ReferenceImageNode` and `ReferenceVideoNode`, replace:

```ts
const aspectClass = getAspectRatioClass(undefined, "aspect-video");
```

with a style-driven ratio:

```ts
const mediaAspectRatio = data.mediaWidth && data.mediaHeight
  ? `${data.mediaWidth} / ${data.mediaHeight}`
  : undefined;
```

and apply it to the frame:

```tsx
style={mediaAspectRatio ? { aspectRatio: mediaAspectRatio } : undefined}
```

while keeping a fallback class such as:

```tsx
mediaAspectRatio ? 'min-h-[120px]' : 'aspect-video'
```

- [ ] **Step 2: Keep resolution capture logic intact**

Do not remove the existing `onLoad` / `onLoadedMetadata` updates for:

```ts
updateNodeData(id, { mediaWidth: naturalWidth, mediaHeight: naturalHeight });
updateNodeData(id, { mediaWidth: videoWidth, mediaHeight: videoHeight });
```

- [ ] **Step 3: Verify by build**

Run: `npm run build`

Expected: PASS.

---

### Task 2: Refactor Prompt Panel Into A Fixed Dialog With Top Preview

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`

- [ ] **Step 1: Add prompt panel local expanded state**

Inside `PromptPanel`, add:

```ts
const [expanded, setExpanded] = useState(false);
```

- [ ] **Step 2: Add top preview strip**

Before the prompt body, render a preview strip when `upstreamNodes.length > 0`:

```tsx
{upstreamNodes.length ? (
  <div className="mb-3 flex items-center gap-2 overflow-x-auto pb-1">
    {upstreamNodes.map((up) => (
      <div key={up.id} className="flex shrink-0 items-center gap-2 rounded-xl border border-white/8 bg-white/[0.03] px-2 py-2">
        {up.thumb ? (
          <img src={up.thumb} alt="" className="h-10 w-10 rounded-lg object-cover" />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-400">{up.icon}</div>
        )}
        <div className="max-w-[120px] truncate text-[11px] text-neutral-300">{up.label}</div>
      </div>
    ))}
  </div>
) : null}
```

- [ ] **Step 3: Constrain panel body height**

Turn the current free-height body into a fixed shell:

```tsx
<div className="relative mt-6 -ml-[80px] w-[460px] rounded-2xl border border-white/[0.06] bg-[#15181d]/92 px-5 py-4 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur-2xl nodrag">
```

with scrollable center:

```tsx
<div className="flex max-h-[320px] flex-col">
  ...preview strip...
  <div className="relative min-h-[140px] max-h-[180px] overflow-y-auto rounded-xl border border-white/6 bg-black/10 px-3 py-3">
```

- [ ] **Step 4: Add top-right expand button**

Inside the panel header area, add:

```tsx
<button
  type="button"
  onClick={() => setExpanded(true)}
  className="absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-300 transition hover:bg-white/[0.06]"
>
  <Expand className="h-3.5 w-3.5" />
</button>
```

---

### Task 3: Add Expanded Prompt Reader/Editor Modal

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`

- [ ] **Step 1: Render expanded panel via portal**

At the bottom of `PromptPanel`, render:

```tsx
{expanded ? createPortal(
  <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm">
    <div className="relative flex max-h-[85vh] w-[820px] max-w-[92vw] flex-col rounded-[24px] border border-white/10 bg-[#1a1d22]/96 px-6 py-5 shadow-2xl">
      ...
    </div>
  </div>,
  document.body,
) : null}
```

- [ ] **Step 2: Reuse the same preview strip and prompt text**

The expanded modal should reuse:

- same `upstreamNodes`
- same `text`
- same `mentions`
- same vendor/model controls

The center text region should use:

```tsx
<div className="relative min-h-[280px] max-h-[52vh] overflow-y-auto rounded-2xl border border-white/6 bg-black/10 px-4 py-4">
```

- [ ] **Step 3: Add close button**

Top-right close button:

```tsx
<button
  type="button"
  onClick={() => setExpanded(false)}
  className="absolute right-5 top-5 flex h-8 w-8 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-300 transition hover:bg-white/[0.06]"
>
  <X className="h-4 w-4" />
</button>
```

---

### Task 4: Final Verification

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`

- [ ] **Step 1: Run build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 2: Manual QA**

Verify:

- upload a `16:9` reference image and confirm it stays horizontal
- upload a `9:16` reference image and confirm it stays vertical
- long prompt text no longer visually spills outside the panel
- top preview strip shows connected reference media
- expand button opens large reader/editor
- closing the expanded view preserves prompt text

---
