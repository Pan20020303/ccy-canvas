# Reference Media Node Drag And Drop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make dragging local images and videos onto the canvas create reference media nodes instead of generated output nodes.

**Architecture:** Add a tiny pure helper that maps dropped files to dedicated reference node types, then render those node types with lightweight preview-only components in the existing node registry. Keep backend upload and generated image/video node behavior unchanged so this round only changes node semantics for dropped assets.

**Tech Stack:** React, TypeScript, React Flow, Vitest, Vite

---

## File Structure

### New files

- `src/app/reference-media.ts`
  - Pure helpers for dropped-media node typing and preview labels.
- `src/app/reference-media.test.ts`
  - TDD coverage for dropped image/video classification.

### Modified files

- `src/app/components/Canvas.tsx`
  - Use the helper when creating nodes from dropped files.
- `src/app/components/nodes/CustomNodes.tsx`
  - Add preview-only reference image and reference video node components and register them.

## Task 1: Add Pure Reference Media Helpers

**Files:**
- Create: `src/app/reference-media.ts`
- Create: `src/app/reference-media.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/reference-media.test.ts` with:

```ts
import { describe, expect, it } from "vitest";

import { getReferenceNodeTypeFromMimeType } from "./reference-media";

describe("reference media helpers", () => {
  it("maps image mime types to reference image nodes", () => {
    expect(getReferenceNodeTypeFromMimeType("image/png")).toBe("referenceImageNode");
  });

  it("maps video mime types to reference video nodes", () => {
    expect(getReferenceNodeTypeFromMimeType("video/mp4")).toBe("referenceVideoNode");
  });

  it("returns null for unsupported mime types", () => {
    expect(getReferenceNodeTypeFromMimeType("application/pdf")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/app/reference-media.test.ts
```

Expected: FAIL because `src/app/reference-media.ts` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/app/reference-media.ts` with:

```ts
export type ReferenceNodeType = "referenceImageNode" | "referenceVideoNode";

export function getReferenceNodeTypeFromMimeType(mimeType: string): ReferenceNodeType | null {
  if (mimeType.startsWith("image/")) {
    return "referenceImageNode";
  }

  if (mimeType.startsWith("video/")) {
    return "referenceVideoNode";
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- src/app/reference-media.test.ts
```

Expected: PASS.

## Task 2: Render Dedicated Reference Media Nodes

**Files:**
- Modify: `src/app/components/nodes/CustomNodes.tsx`

- [ ] **Step 1: Add preview-only reference node components**

Add two components:

- `ReferenceImageNode`
- `ReferenceVideoNode`

They should:

- reuse the existing `BaseNode`
- show a source-asset style title
- preview `data.url`
- omit `promptPanel`
- keep double-click preview for convenience

- [ ] **Step 2: Register the new node types**

Extend `nodeTypes` with:

```ts
referenceImageNode: ReferenceImageNode,
referenceVideoNode: ReferenceVideoNode,
```

- [ ] **Step 3: Run build verification**

Run:

```bash
npm run build
```

Expected: PASS.

## Task 3: Change Drag-And-Drop Node Creation

**Files:**
- Modify: `src/app/components/Canvas.tsx`
- Use: `src/app/reference-media.ts`

- [ ] **Step 1: Replace direct generated-node mapping**

In the drop handler, stop doing:

```ts
type: isImage ? "imageNode" : "videoNode"
```

Use `getReferenceNodeTypeFromMimeType(file.type)` instead.

- [ ] **Step 2: Create reference nodes with stable uploaded URLs**

Use the returned type in the inserted node:

```ts
const nodeType = getReferenceNodeTypeFromMimeType(file.type);
if (!nodeType) continue;

addNode({
  id,
  type: nodeType,
  position: pos,
  data: { url, status: "done", sourceName: file.name },
});
```

- [ ] **Step 3: Run targeted verification**

Run:

```bash
npm test -- src/app/reference-media.test.ts
npm run build
```

Expected: PASS.

## Self-Review

- Spec coverage:
  - dropped image/video become reference nodes: Task 1 + Task 3
  - generated image/video semantics stay unchanged: Task 2 + Task 3
  - upload flow remains unchanged: Task 3
- Placeholder scan:
  - No TODO/TBD placeholders remain.
- Type consistency:
  - `ReferenceNodeType` and `getReferenceNodeTypeFromMimeType` are defined before use.
