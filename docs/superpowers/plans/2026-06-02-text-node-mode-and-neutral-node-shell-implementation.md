# Text Node Mode And Neutral Node Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify all canvas nodes into a neutral dark shell, convert text nodes into two-mode nodes (`文本编辑器` and `反推提示词`), and allow edge connections by dragging onto the node body instead of only the tiny left handle.

**Architecture:** Keep the existing canvas/store architecture, but separate the work into three layers: a neutralized `BaseNode` shell, text-node-specific mode popovers, and a connection-target overlay that widens node hit areas without rewriting the flow graph model. Reuse the existing store and provider model registry instead of introducing a new node framework.

**Tech Stack:** React, TypeScript, Zustand store, React Flow (`@xyflow/react`), Vitest, Vite.

---

## File Structure

**Modify**
- `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`
  - Neutralize node shell styling
  - Move text node to a two-mode body
  - Keep reference node rename + resolution behavior working
  - Add full-card connection target overlay behavior hooks where needed
- `D:\code\ccy-canvas\src\app\components\Canvas.tsx`
  - Adjust connection behavior so dragging onto node body resolves to a target connection
  - Keep double-click, right-click, upload, and history insertion behavior intact
- `D:\code\ccy-canvas\src\app\store.ts`
  - Persist text-node mode state, custom titles, reverse prompt draft/model, and any helper updates
- `D:\code\ccy-canvas\src\app\model-templates.ts`
  - Expose model capability filtering needed for reverse-prompt mode if current helpers are insufficient

**Create**
- `D:\code\ccy-canvas\src\app\components\nodes\TextEditorPopover.tsx`
  - Floating editor for plain-text editing
- `D:\code\ccy-canvas\src\app\components\nodes\ReversePromptPopover.tsx`
  - Floating reverse-prompt panel bound to the first upstream reference image
- `D:\code\ccy-canvas\src\app\text-node-modes.ts`
  - Small pure helpers for text-node mode state, upstream-image gating, and model filtering
- `D:\code\ccy-canvas\src\app\text-node-modes.test.ts`
  - Unit tests for helper logic

**Test**
- `D:\code\ccy-canvas\src\app\store.test.ts`
- `D:\code\ccy-canvas\src\app\history-assets.test.ts`

---

### Task 1: Add Pure Helpers For Text-Node Modes

**Files:**
- Create: `D:\code\ccy-canvas\src\app\text-node-modes.ts`
- Test: `D:\code\ccy-canvas\src\app\text-node-modes.test.ts`

- [ ] **Step 1: Write the failing helper tests**

```ts
import { describe, expect, it } from "vitest";
import {
  getTextNodeMode,
  canUseReversePrompt,
  getFirstUpstreamReferenceImage,
  filterReversePromptModels,
} from "./text-node-modes";

describe("text-node modes", () => {
  it("defaults text node mode to editor", () => {
    expect(getTextNodeMode(undefined)).toBe("editor");
  });

  it("enables reverse prompt only when a reference image exists", () => {
    expect(canUseReversePrompt([])).toBe(false);
    expect(
      canUseReversePrompt([
        { id: "n1", type: "referenceImageNode", data: { url: "/uploads/a.png" } },
      ] as any),
    ).toBe(true);
  });

  it("uses only the first upstream reference image", () => {
    const result = getFirstUpstreamReferenceImage([
      { id: "v1", type: "referenceVideoNode", data: { url: "/uploads/v.mp4" } },
      { id: "i1", type: "referenceImageNode", data: { url: "/uploads/a.png" } },
      { id: "i2", type: "referenceImageNode", data: { url: "/uploads/b.png" } },
    ] as any);
    expect(result?.data.url).toBe("/uploads/a.png");
  });

  it("filters reverse-prompt models to vision-capable entries only", () => {
    const result = filterReversePromptModels([
      { service_type: "image", vendor: "A", name: "plain-image", model_list: ["m1"] },
      { service_type: "image", vendor: "B", name: "vision-model", model_list: ["m2"], capabilities: ["vision"] },
    ] as any);
    expect(result.map((item) => item.name)).toEqual(["vision-model"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/text-node-modes.test.ts`

Expected: FAIL because `src/app/text-node-modes.ts` does not exist yet.

- [ ] **Step 3: Write minimal helper implementation**

```ts
import type { Node } from "@xyflow/react";

export type TextNodeMode = "editor" | "reverse_prompt";

export function getTextNodeMode(value: unknown): TextNodeMode {
  return value === "reverse_prompt" ? "reverse_prompt" : "editor";
}

export function canUseReversePrompt(upstreamNodes: Node[]): boolean {
  return upstreamNodes.some((node) => node.type === "referenceImageNode" && Boolean((node.data as any)?.url));
}

export function getFirstUpstreamReferenceImage(upstreamNodes: Node[]): Node | null {
  return (
    upstreamNodes.find((node) => node.type === "referenceImageNode" && Boolean((node.data as any)?.url)) ?? null
  );
}

export function filterReversePromptModels(models: any[]) {
  return models.filter((model) => {
    const caps = Array.isArray(model?.capabilities) ? model.capabilities : [];
    return caps.includes("vision") || caps.includes("image_understanding");
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/app/text-node-modes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/text-node-modes.ts src/app/text-node-modes.test.ts
git commit -m "feat: add text node mode helpers"
```

---

### Task 2: Persist Text-Node UI State In Store

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\store.ts`
- Test: `D:\code\ccy-canvas\src\app\store.test.ts`

- [ ] **Step 1: Write the failing store tests**

Add tests that verify:

```ts
it("updates arbitrary node data for text-node mode state", () => {
  const store = useStore.getState();
  store.addNode({
    id: "text-mode-node",
    type: "textNode",
    position: { x: 0, y: 0 },
    data: {},
  } as any);

  store.updateNodeData("text-mode-node", {
    textMode: "reverse_prompt",
    reversePromptDraft: "draft content",
    customTitle: "自定义标题",
  });

  const node = useStore.getState().nodes.find((item) => item.id === "text-mode-node");
  expect(node?.data).toMatchObject({
    textMode: "reverse_prompt",
    reversePromptDraft: "draft content",
    customTitle: "自定义标题",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/store.test.ts`

Expected: FAIL if `updateNodeData` is missing or does not persist data correctly.

- [ ] **Step 3: Implement the minimal store support**

Ensure `AppState` includes:

```ts
updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
```

And the setter implementation merges `patch` into `node.data` and syncs the active project snapshot.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/app/store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts
git commit -m "feat: persist editable node ui state"
```

---

### Task 3: Neutralize The Shared Node Shell

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`

- [ ] **Step 1: Write a focused visual/behavior checklist in code comments before editing**

Add a short comment near `NODE_TONE_STYLES` or `BaseNode`:

```ts
// All node types now share a neutral shell; semantic color is removed from the outer frame.
```

- [ ] **Step 2: Replace colored shell styles with a unified neutral shell**

Change `NODE_TONE_STYLES` so all variants point to a neutral dark palette like:

```ts
const NEUTRAL_NODE_SHELL = {
  shell: "border-white/10 before:from-white/6 before:to-transparent shadow-[0_18px_48px_-28px_rgba(0,0,0,0.85)]",
  selected: "shadow-[0_0_0_1px_rgba(255,255,255,0.22),0_20px_56px_-28px_rgba(0,0,0,0.92)]",
  surface: "border-white/8 bg-[linear-gradient(180deg,rgba(42,42,42,0.92),rgba(29,29,29,0.96))]",
} as const;
```

Then map each tone to that shared object, optionally keeping tiny content-level differences only if required for readability.

- [ ] **Step 3: Keep reference-node header metadata working**

Do not remove:

```ts
headerRight={resolutionLabel}
title={<EditableNodeTitle ... />}
```

The neutral shell task must preserve rename and resolution behavior.

- [ ] **Step 4: Run build to verify neutral shell changes compile**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/nodes/CustomNodes.tsx
git commit -m "style: unify node shells with neutral theme"
```

---

### Task 4: Add The Text Editor Popover

**Files:**
- Create: `D:\code\ccy-canvas\src\app\components\nodes\TextEditorPopover.tsx`
- Modify: `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`

- [ ] **Step 1: Add the new popover component**

Create:

```tsx
import { useEffect, useState } from "react";

export function TextEditorPopover({
  isOpen,
  initialValue,
  onClose,
  onSave,
}: {
  isOpen: boolean;
  initialValue: string;
  onClose: () => void;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initialValue);

  useEffect(() => {
    setDraft(initialValue);
  }, [initialValue]);

  if (!isOpen) return null;

  return (
    <div className="absolute left-0 top-full z-50 mt-3 w-[420px] rounded-[20px] border border-white/12 bg-[#1f1f1f] p-4 shadow-2xl">
      <div className="mb-3 flex items-center gap-2 rounded-2xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-xs text-neutral-300">
        <span>H1</span>
        <span>H2</span>
        <span>H3</span>
        <span>B</span>
        <span>I</span>
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="输入内容..."
        className="min-h-[180px] w-full rounded-xl border border-white/10 bg-[#171717] p-3 text-sm text-neutral-100 outline-none"
      />
      <div className="mt-3 flex justify-end">
        <button
          onClick={() => {
            onSave(draft);
            onClose();
          }}
          className="rounded-xl bg-white px-4 py-2 text-sm text-black"
        >
          保存
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update the text node to open the editor mode**

In `CustomNodes.tsx`, add local state for:

```ts
const [isEditorOpen, setEditorOpen] = useState(false);
```

And render the popover when the node mode is `"editor"`.

- [ ] **Step 3: Save editor content back into the node**

Use:

```ts
updateNodeData(id, { content: value, textMode: "editor" });
```

- [ ] **Step 4: Run build to verify the popover compiles**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/nodes/TextEditorPopover.tsx src/app/components/nodes/CustomNodes.tsx
git commit -m "feat: add text editor popover for text nodes"
```

---

### Task 5: Add The Reverse Prompt Popover

**Files:**
- Create: `D:\code\ccy-canvas\src\app\components\nodes\ReversePromptPopover.tsx`
- Modify: `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`
- Modify: `D:\code\ccy-canvas\src\app\model-templates.ts` (only if current model registry cannot expose a vision-capable list)

- [ ] **Step 1: Create the reverse-prompt UI shell**

Create:

```tsx
export function ReversePromptPopover({
  isOpen,
  imageUrl,
  draft,
  models,
  selectedModel,
  disabledReason,
  onChangeDraft,
  onChangeModel,
  onSubmit,
  onClose,
}: {
  isOpen: boolean;
  imageUrl: string | null;
  draft: string;
  models: Array<{ label: string; value: string }>;
  selectedModel: string;
  disabledReason?: string;
  onChangeDraft: (value: string) => void;
  onChangeModel: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  if (!isOpen) return null;

  return (
    <div className="absolute left-0 top-full z-50 mt-3 w-[520px] rounded-[24px] border border-white/12 bg-[#1f1f1f] p-4 shadow-2xl">
      <div className="mb-3 flex items-start gap-3">
        {imageUrl ? <img src={imageUrl} alt="" className="h-12 w-12 rounded-xl object-cover" /> : null}
        <p className="text-sm text-neutral-200">
          根据图片生成结构化中文提示词，包括主体描述、环境、光影、镜头语言、风格关键词。
        </p>
      </div>
      <textarea
        value={draft}
        onChange={(event) => onChangeDraft(event.target.value)}
        className="min-h-[180px] w-full rounded-xl border border-white/10 bg-[#171717] p-3 text-sm text-neutral-100 outline-none"
      />
      <div className="mt-3 flex items-center justify-between">
        <select
          value={selectedModel}
          onChange={(event) => onChangeModel(event.target.value)}
          className="rounded-xl border border-white/10 bg-[#171717] px-3 py-2 text-sm text-neutral-100"
        >
          {models.map((model) => (
            <option key={model.value} value={model.value}>{model.label}</option>
          ))}
        </select>
        <button
          onClick={onSubmit}
          disabled={!imageUrl || !selectedModel || Boolean(disabledReason)}
          className="rounded-xl bg-white px-4 py-2 text-sm text-black disabled:opacity-40"
        >
          发送
        </button>
      </div>
      {disabledReason ? <div className="mt-2 text-xs text-rose-300">{disabledReason}</div> : null}
    </div>
  );
}
```

- [ ] **Step 2: Wire the text node to the first upstream reference image**

Inside the text-node implementation:

```ts
const upstreamIds = edges.filter((edge) => edge.target === id).map((edge) => edge.source);
const upstreamNodes = useMemo(() => upstreamIds.map((sourceId) => nodes.find((node) => node.id === sourceId)).filter(Boolean), [edges, id, nodes]);
const firstReferenceImage = getFirstUpstreamReferenceImage(upstreamNodes as any);
const reversePromptEnabled = canUseReversePrompt(upstreamNodes as any);
```

- [ ] **Step 3: Filter models to vision-capable entries and guard empty states**

Build options from the backend model list using `filterReversePromptModels(...)`.

If none are available:

```ts
const disabledReason = "当前没有可用的视觉模型";
```

- [ ] **Step 4: Implement submit behavior with minimal integration**

For this task, reuse the closest current node-run path:

```ts
updateNodeData(id, {
  textMode: "reverse_prompt",
  reversePromptDraft: draft,
  content: draft,
});
```

If a direct reverse-prompt API already exists in the codebase, call it here; otherwise keep this step as UI + state wiring and add a short inline comment documenting the future API integration boundary.

- [ ] **Step 5: Run build to verify the reverse-prompt panel compiles**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/components/nodes/ReversePromptPopover.tsx src/app/components/nodes/CustomNodes.tsx src/app/model-templates.ts
git commit -m "feat: add reverse prompt mode for text nodes"
```

---

### Task 6: Convert The Text Node Body Into Two Mode Entries

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`

- [ ] **Step 1: Replace the current text-node body with mode entries**

Render a small mode list inside the text node:

```tsx
<div className="space-y-2 rounded-[20px] border border-white/8 bg-[#202020] p-3">
  <button className="flex w-full items-center gap-2 text-left text-sm text-neutral-100">文本编辑器</button>
  <button
    disabled={!reversePromptEnabled}
    className="flex w-full items-center gap-2 text-left text-sm text-neutral-100 disabled:opacity-40"
  >
    反推提示词
  </button>
</div>
```

- [ ] **Step 2: Persist selected mode**

Use:

```ts
updateNodeData(id, { textMode: "editor" });
updateNodeData(id, { textMode: "reverse_prompt" });
```

- [ ] **Step 3: Show the correct popover based on the active mode**

Rules:

- `editor` mode opens `TextEditorPopover`
- `reverse_prompt` mode opens `ReversePromptPopover`
- reverse-prompt entry stays disabled until a reference image exists

- [ ] **Step 4: Run build to verify text-node mode switching compiles**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/nodes/CustomNodes.tsx
git commit -m "feat: convert text node to editor and reverse prompt modes"
```

---

### Task 7: Widen Connection Hit Areas To The Full Node Body

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`
- Modify: `D:\code\ccy-canvas\src\app\components\Canvas.tsx`

- [ ] **Step 1: Add a transparent body-level target overlay to nodes**

Inside `BaseNode`, add:

```tsx
<Handle
  type="target"
  position={Position.Left}
  className="!left-0 !top-0 !h-full !w-full !rounded-[22px] !border-0 !bg-transparent !opacity-0"
  style={{ transform: "none", pointerEvents: "auto" }}
/>
```

Keep the visible circular affordance as a separate decorative element. The full-card handle becomes the actual hit target.

- [ ] **Step 2: Ensure the visible plus buttons still render correctly**

Do not remove the existing left/right visual anchors; convert them to pure visuals if needed.

- [ ] **Step 3: Prevent the new full-card target from breaking click and double-click**

If the full-card handle blocks interactions, constrain it with a child wrapper or use pointer-event layering so:

- node clicks still work
- node double-clicks still work
- context-menu actions still work

- [ ] **Step 4: Run build and a quick manual check**

Run: `npm run build`

Expected: PASS.

Manual check:
- Drag a connection to the body of a text node
- Drag a connection to the body of an image node
- Verify both connect without requiring the tiny left circle

- [ ] **Step 5: Commit**

```bash
git add src/app/components/nodes/CustomNodes.tsx src/app/components/Canvas.tsx
git commit -m "feat: allow edge connections across node bodies"
```

---

### Task 8: Regression Tests And Final Verification

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\store.test.ts`
- Modify: `D:\code\ccy-canvas\src\app\history-assets.test.ts`
- Test: `D:\code\ccy-canvas\src\app\text-node-modes.test.ts`

- [ ] **Step 1: Add regression coverage for rename semantics**

Add tests that verify:

```ts
expect(splitFilenameExtension("demo.png")).toEqual({ basename: "demo", extension: ".png" });
expect(splitFilenameExtension("story")).toEqual({ basename: "story", extension: "" });
```

And, if helper extraction is needed, move the rename logic into a pure helper so it can be tested directly.

- [ ] **Step 2: Run focused tests**

Run: `npm test -- src/app/text-node-modes.test.ts src/app/store.test.ts src/app/history-assets.test.ts`

Expected: PASS.

- [ ] **Step 3: Run the full build**

Run: `npm run build`

Expected: PASS with only the existing chunk-size warning.

- [ ] **Step 4: Manual QA checklist**

Verify all of the following in the browser:

- all nodes use the neutral shell
- text node shows only `文本编辑器` and `反推提示词`
- `反推提示词` is disabled until a reference image is connected
- reverse-prompt panel shows the first upstream image thumbnail
- text editor saves text into the node
- normal generation nodes can be renamed
- reference image/video nodes preserve extensions while renaming
- dragging an edge onto the body of a node creates a connection

- [ ] **Step 5: Commit**

```bash
git add src/app/components/nodes/CustomNodes.tsx src/app/components/Canvas.tsx src/app/store.ts src/app/store.test.ts src/app/history-assets.test.ts src/app/text-node-modes.ts src/app/text-node-modes.test.ts src/app/components/nodes/TextEditorPopover.tsx src/app/components/nodes/ReversePromptPopover.tsx
git commit -m "feat: add text node modes and neutral node shell"
```

---

## Self-Review

### Spec coverage

- Neutral shell: covered in Task 3
- Text node with only two modes: covered in Tasks 4, 5, 6
- Reverse prompt requires uploaded reference image: covered in Tasks 1 and 5
- Other nodes keep functionality but adopt new shell: covered in Task 3
- Connection by dragging onto node body: covered in Task 7
- Rename normal nodes and preserve file extensions for uploaded assets: covered in Tasks 2 and 8

### Placeholder scan

- No `TODO`, `TBD`, or “implement later” markers remain
- API integration boundary for reverse prompt is explicitly constrained instead of left ambiguous

### Type consistency

- `textMode` is consistently `"editor" | "reverse_prompt"`
- `customTitle` is reserved for normal nodes
- `sourceName` remains the reference-node file label
- `updateNodeData` is the common persistence hook

---

Plan complete and saved to `D:\code\ccy-canvas\docs\superpowers\plans\2026-06-02-text-node-mode-and-neutral-node-shell-implementation.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
