# Group Container And Bulk Edge Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real multi-select groups with visible group containers and group-level left/right `+` connectors that fan a single user routing action into multiple real edges.

**Architecture:** Keep group membership in the existing `groups` store state, extend each group with geometry for rendering, and implement fan-in/fan-out edge creation through a small pure routing helper. Render group shells in the canvas overlay so ordinary nodes remain ordinary React Flow nodes, while group connectors use a lightweight interaction state in `Canvas.tsx`.

**Tech Stack:** React, TypeScript, Zustand store, React Flow (`@xyflow/react`), Vitest, Vite.

---

## File Structure

**Modify**
- `D:\code\ccy-canvas\src\app\store.ts`
  - Extend `Group` with geometry
  - Persist geometry when creating groups
- `D:\code\ccy-canvas\src\app\components\Canvas.tsx`
  - Render group containers
  - Add group-level bulk in/out routing interactions
  - Integrate routing completion with existing connection flow
- `D:\code\ccy-canvas\src\app\store.test.ts`
  - Cover group creation geometry and deduplicated bulk routing behavior

**Create**
- `D:\code\ccy-canvas\src\app\group-routing.ts`
  - Pure helpers for bounds calculation and bulk edge creation
- `D:\code\ccy-canvas\src\app\group-routing.test.ts`
  - Unit tests for group routing helpers

---

### Task 1: Add Pure Group Geometry And Routing Helpers

**Files:**
- Create: `D:\code\ccy-canvas\src\app\group-routing.ts`
- Test: `D:\code\ccy-canvas\src\app\group-routing.test.ts`

- [ ] **Step 1: Write the failing helper tests**

```ts
import { describe, expect, it } from "vitest";
import {
  computeGroupBounds,
  buildBulkInboundEdges,
  buildBulkOutboundEdges,
} from "./group-routing";

describe("group routing helpers", () => {
  it("computes padded bounds around member nodes", () => {
    const bounds = computeGroupBounds([
      { id: "a", position: { x: 100, y: 120 }, width: 200, height: 160 },
      { id: "b", position: { x: 360, y: 220 }, width: 180, height: 140 },
    ] as any);

    expect(bounds).toEqual({
      x: 68,
      y: 88,
      width: 504,
      height: 304,
    });
  });

  it("builds deduplicated outbound bulk edges", () => {
    const edges = buildBulkOutboundEdges({
      groupId: "g1",
      memberNodeIds: ["n1", "n2"],
      targetNodeId: "target",
      existingEdges: [{ source: "n1", target: "target", sourceHandle: null, targetHandle: null }] as any,
    });

    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([["n2", "target"]]);
  });

  it("builds deduplicated inbound bulk edges", () => {
    const edges = buildBulkInboundEdges({
      sourceNodeId: "source",
      groupId: "g1",
      memberNodeIds: ["n1", "n2"],
      existingEdges: [{ source: "source", target: "n2", sourceHandle: null, targetHandle: null }] as any,
    });

    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([["source", "n1"]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/group-routing.test.ts`

Expected: FAIL because the helper file does not exist yet.

- [ ] **Step 3: Write minimal helper implementation**

```ts
import type { Edge, Node } from "@xyflow/react";

const GROUP_PADDING = 32;

export function computeGroupBounds(nodes: Node[]) {
  const left = Math.min(...nodes.map((node) => node.position.x));
  const top = Math.min(...nodes.map((node) => node.position.y));
  const right = Math.max(...nodes.map((node) => node.position.x + (node.measured?.width ?? node.width ?? 300)));
  const bottom = Math.max(...nodes.map((node) => node.position.y + (node.measured?.height ?? node.height ?? 200)));

  return {
    x: left - GROUP_PADDING,
    y: top - GROUP_PADDING,
    width: right - left + GROUP_PADDING * 2,
    height: bottom - top + GROUP_PADDING * 2,
  };
}

function edgeExists(existingEdges: Edge[], source: string, target: string) {
  return existingEdges.some(
    (edge) =>
      edge.source === source &&
      edge.target === target &&
      (edge.sourceHandle ?? null) === null &&
      (edge.targetHandle ?? null) === null,
  );
}

export function buildBulkOutboundEdges({
  groupId,
  memberNodeIds,
  targetNodeId,
  existingEdges,
}: {
  groupId: string;
  memberNodeIds: string[];
  targetNodeId: string;
  existingEdges: Edge[];
}) {
  return memberNodeIds
    .filter((memberNodeId) => memberNodeId !== targetNodeId)
    .filter((memberNodeId) => !edgeExists(existingEdges, memberNodeId, targetNodeId))
    .map((memberNodeId, index) => ({
      id: `group-out-${groupId}-${targetNodeId}-${memberNodeId}-${index}`,
      source: memberNodeId,
      target: targetNodeId,
      sourceHandle: null,
      targetHandle: null,
      animated: false,
      style: { stroke: "#94a3b8", strokeWidth: 1.6 },
    }));
}

export function buildBulkInboundEdges({
  sourceNodeId,
  groupId,
  memberNodeIds,
  existingEdges,
}: {
  sourceNodeId: string;
  groupId: string;
  memberNodeIds: string[];
  existingEdges: Edge[];
}) {
  return memberNodeIds
    .filter((memberNodeId) => memberNodeId !== sourceNodeId)
    .filter((memberNodeId) => !edgeExists(existingEdges, sourceNodeId, memberNodeId))
    .map((memberNodeId, index) => ({
      id: `group-in-${groupId}-${sourceNodeId}-${memberNodeId}-${index}`,
      source: sourceNodeId,
      target: memberNodeId,
      sourceHandle: null,
      targetHandle: null,
      animated: false,
      style: { stroke: "#94a3b8", strokeWidth: 1.6 },
    }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/app/group-routing.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/group-routing.ts src/app/group-routing.test.ts
git commit -m "feat: add group routing helpers"
```

---

### Task 2: Persist Group Geometry In Store

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\store.ts`
- Test: `D:\code\ccy-canvas\src\app\store.test.ts`

- [ ] **Step 1: Add failing store test for group bounds persistence**

Add:

```ts
it("creates groups with persisted geometry around selected nodes", async () => {
  const { useStore } = await loadStore();

  useStore.getState().addNode({
    id: "a",
    type: "imageNode",
    position: { x: 100, y: 100 },
    width: 200,
    height: 160,
    data: {},
  } as never);
  useStore.getState().addNode({
    id: "b",
    type: "textNode",
    position: { x: 360, y: 200 },
    width: 180,
    height: 140,
    data: {},
  } as never);

  useStore.getState().createGroup(["a", "b"]);

  const group = useStore.getState().groups.at(-1);
  expect(group).toMatchObject({
    nodeIds: ["a", "b"],
  });
  expect(group?.position).toBeTruthy();
  expect(group?.width).toBeGreaterThan(0);
  expect(group?.height).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/app/store.test.ts`

Expected: FAIL because `Group` has no geometry yet.

- [ ] **Step 3: Extend the store types and createGroup implementation**

Update `Group`:

```ts
export type Group = {
  id: string;
  nodeIds: string[];
  name: string;
  position?: { x: number; y: number };
  width?: number;
  height?: number;
};
```

Update `createGroup` to:

```ts
const memberNodes = state.nodes.filter((node) => nodeIds.includes(node.id));
const bounds = computeGroupBounds(memberNodes);
const groups = [
  ...state.groups,
  {
    id: `g-${Date.now()}`,
    nodeIds,
    name: `分组 ${state.groups.length + 1}`,
    position: { x: bounds.x, y: bounds.y },
    width: bounds.width,
    height: bounds.height,
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/app/store.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts
git commit -m "feat: persist geometry for groups"
```

---

### Task 3: Render Group Containers In The Canvas Overlay

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\Canvas.tsx`

- [ ] **Step 1: Add a group overlay renderer**

Render groups above the flow background but below context menus:

```tsx
{groups.map((group) => (
  <div
    key={group.id}
    className="pointer-events-none absolute rounded-[22px] border border-white/10 bg-white/[0.04] shadow-[0_12px_36px_-24px_rgba(0,0,0,0.75)]"
    style={{
      left: group.position?.x,
      top: group.position?.y,
      width: group.width,
      height: group.height,
    }}
  >
    <div className="px-4 py-2 text-sm text-neutral-300">{group.name}</div>
  </div>
))}
```

- [ ] **Step 2: Convert overlay positioning into flow-space positioning**

Use the current viewport transform so group shells stay aligned while panning and zooming. Mirror the approach already used by `AlignmentGuides`.

- [ ] **Step 3: Visually reserve left and right connector zones**

Add decorative `+` affordances on the left and right edges:

```tsx
<div className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15 bg-[#1a1d22]/90 p-1.5">
  <Plus className="h-3 w-3 text-neutral-300" />
</div>
```

and the mirrored right-side version.

- [ ] **Step 4: Run build to verify overlay rendering compiles**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/Canvas.tsx
git commit -m "feat: render group container overlays"
```

---

### Task 4: Add Group-Level Routing Interaction State

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\Canvas.tsx`

- [ ] **Step 1: Add local routing state for group connectors**

Add:

```ts
const [groupRouting, setGroupRouting] = useState<null | {
  groupId: string;
  direction: "in" | "out";
}>(null);
```

- [ ] **Step 2: Start group routing only from the visible left/right `+` affordances**

Attach handlers to the connector buttons:

```tsx
onMouseDown={(event) => {
  event.stopPropagation();
  setGroupRouting({ groupId: group.id, direction: "out" });
}}
```

Use `"in"` for the left connector and `"out"` for the right connector.

- [ ] **Step 3: Clear group routing when canvas interaction ends**

In the existing global connection-end / pane-click cleanup logic, add:

```ts
setGroupRouting(null);
```

- [ ] **Step 4: Run build to verify state wiring compiles**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/Canvas.tsx
git commit -m "feat: add group routing interaction state"
```

---

### Task 5: Fan Group Outbound Connections Into Multiple Real Edges

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\Canvas.tsx`
- Modify: `D:\code\ccy-canvas\src\app\store.test.ts`

- [ ] **Step 1: Add a failing store/canvas-level behavior test for outbound group routing**

If you keep this as a store-like unit, test the pure helper output; if you add a small canvas helper, test that helper directly:

```ts
expect(
  buildBulkOutboundEdges({
    groupId: "g1",
    memberNodeIds: ["a", "b"],
    targetNodeId: "target",
    existingEdges: [],
  }).map((edge) => [edge.source, edge.target]),
).toEqual([
  ["a", "target"],
  ["b", "target"],
]);
```

- [ ] **Step 2: Hook outbound routing into node-body drop resolution**

When `groupRouting?.direction === "out"` and the user releases over a target node:

```ts
const group = groups.find((item) => item.id === groupRouting.groupId);
const nextEdges = buildBulkOutboundEdges({
  groupId: group.id,
  memberNodeIds: group.nodeIds,
  targetNodeId,
  existingEdges: edges,
});
nextEdges.forEach((edge) => onConnect(edge));
setGroupRouting(null);
```

- [ ] **Step 3: Ensure duplicate edges are skipped**

Do not add additional canvas-side dedupe if the helper already enforces it.

- [ ] **Step 4: Run tests and build**

Run:
- `npm test -- src/app/group-routing.test.ts src/app/store.test.ts`
- `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/Canvas.tsx src/app/store.test.ts src/app/group-routing.ts src/app/group-routing.test.ts
git commit -m "feat: fan out group outbound routing"
```

---

### Task 6: Fan Group Inbound Connections Into Multiple Real Edges

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\Canvas.tsx`
- Modify: `D:\code\ccy-canvas\src\app\store.test.ts`

- [ ] **Step 1: Add a failing behavior test for inbound group routing**

```ts
expect(
  buildBulkInboundEdges({
    sourceNodeId: "source",
    groupId: "g1",
    memberNodeIds: ["a", "b"],
    existingEdges: [],
  }).map((edge) => [edge.source, edge.target]),
).toEqual([
  ["source", "a"],
  ["source", "b"],
]);
```

- [ ] **Step 2: Hook inbound routing into drop on the left group connector**

When `groupRouting?.direction === "in"` and the origin node is known:

```ts
const nextEdges = buildBulkInboundEdges({
  sourceNodeId: draggingSourceNodeId,
  groupId: group.id,
  memberNodeIds: group.nodeIds,
  existingEdges: edges,
});
nextEdges.forEach((edge) => onConnect(edge));
setGroupRouting(null);
```

- [ ] **Step 3: Skip self loops automatically**

Rely on the helper filter:

```ts
memberNodeId !== sourceNodeId
```

- [ ] **Step 4: Run tests and build**

Run:
- `npm test -- src/app/group-routing.test.ts src/app/store.test.ts`
- `npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/Canvas.tsx src/app/store.test.ts src/app/group-routing.ts src/app/group-routing.test.ts
git commit -m "feat: fan in group inbound routing"
```

---

### Task 7: Final Verification And Manual QA

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\store.test.ts`
- Test: `D:\code\ccy-canvas\src\app\group-routing.test.ts`

- [ ] **Step 1: Add any remaining regression coverage**

Add tests for:

```ts
it("does not duplicate bulk edges when the same route already exists", () => {
  // helper-level assertion
});

it("skips member nodes that would create self loops", () => {
  // helper-level assertion
});
```

- [ ] **Step 2: Run focused tests**

Run: `npm test -- src/app/group-routing.test.ts src/app/store.test.ts`

Expected: PASS.

- [ ] **Step 3: Run final build**

Run: `npm run build`

Expected: PASS with only the existing chunk-size warning.

- [ ] **Step 4: Manual QA checklist**

Verify all of the following in the browser:

- multi-select still works
- clicking “打组” creates a visible group shell
- group shell title and frame align with selected nodes
- dragging from the right group `+` to a target node creates one edge per member
- dragging from a source node to the left group `+` creates one edge per member
- duplicate routes are not added twice
- normal node-to-node routing still works

- [ ] **Step 5: Commit**

```bash
git add src/app/group-routing.ts src/app/group-routing.test.ts src/app/store.ts src/app/store.test.ts src/app/components/Canvas.tsx
git commit -m "feat: add group containers with bulk edge routing"
```

---

## Self-Review

### Spec coverage

- Real grouping after multi-select: covered in Tasks 2 and 3
- Visible group container shell: covered in Task 3
- Unified outbound routing: covered in Task 5
- Unified inbound routing: covered in Task 6
- Deduplication and self-loop skipping: covered in Tasks 1 and 7

### Placeholder scan

- No `TODO`/`TBD` placeholders remain
- Every code-changing task includes concrete code or exact implementation targets

### Type consistency

- `Group` geometry fields are consistently `position`, `width`, `height`
- Bulk routing helpers always produce real edges, never abstract group edges
- Left connector = inbound, right connector = outbound throughout the plan

---

Plan complete and saved to `D:\code\ccy-canvas\docs\superpowers\plans\2026-06-02-group-container-and-bulk-edge-routing-implementation.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
