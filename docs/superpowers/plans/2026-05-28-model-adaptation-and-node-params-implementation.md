# Model Adaptation And Node Params Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build model-template-driven node parameter bars, node-instance-only aspect changes, video duration controls, and admin-side API connectivity checks while keeping front-end model visibility strictly tied to enabled admin routes.

**Architecture:** Add a small front-end model template registry keyed by concrete model name, extend node data to persist per-node generation params, then let the node prompt bar render controls from the selected model template instead of hardcoded assumptions. In admin, keep route configuration ownership in the existing model config screens and add a connectivity probe plus enabled-state-driven filtering so the workspace only exposes valid routes per service type.

**Tech Stack:** React, TypeScript, Zustand, React Flow (`@xyflow/react`), Vitest, Vite

---

## File Structure

### New files

- `src/app/model-templates.ts`
  - Owns the hardcoded developer-maintained template registry for concrete model names.
- `src/app/model-templates.test.ts`
  - Covers template lookup and capability filtering.

### Modified files

- `src/app/model-config.ts`
  - Keep route-layer config helpers, add helpers for enabled vendor/model filtering and connectivity probing.
- `src/app/model-config.test.ts`
  - Extend tests for enabled filtering and connection helper behavior.
- `src/app/store.ts`
  - Persist per-node generation params and use selected model config + model template during node execution.
- `src/app/store.test.ts`
  - Cover instance-only aspect changes and disabled-model visibility rules.
- `src/app/components/nodes/CustomNodes.tsx`
  - Replace hardcoded param assumptions with template-driven vendor/model/mode/aspect/resolution/duration controls and bind node card aspect ratio to current node params.
- `src/app/components/admin/ModelConfigPage.tsx`
  - Surface test status and pass callbacks into the table/drawer.
- `src/app/components/admin/ModelConfigTable.tsx`
  - Show connection status and add a “测试连接” action.
- `src/app/components/admin/ModelConfigDrawer.tsx`
  - Keep route editing as-is, but expose test trigger and feedback region.

## Task 1: Add The Front-End Model Template Registry

**Files:**
- Create: `src/app/model-templates.ts`
- Test: `src/app/model-templates.test.ts`

- [ ] **Step 1: Write the failing template tests**

Add `src/app/model-templates.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import {
  getModelTemplate,
  getTemplatesForServiceType,
  modelTemplates,
} from "./model-templates";

describe("model templates", () => {
  it("looks up a concrete model template by model name", () => {
    const template = getModelTemplate("runway-gen3");
    expect(template?.serviceType).toBe("video");
    expect(template?.supportsDuration).toBe(true);
  });

  it("returns only templates for the requested service type", () => {
    const templates = getTemplatesForServiceType("image");
    expect(templates.every((template) => template.serviceType === "image")).toBe(true);
  });

  it("keeps vendor and model controls separate", () => {
    const template = getModelTemplate("gpt-image-2");
    expect(template?.vendor).toBeTruthy();
    expect(template?.modelName).toBe("gpt-image-2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/app/model-templates.test.ts
```

Expected: FAIL because `src/app/model-templates.ts` does not exist yet.

- [ ] **Step 3: Write the minimal template registry**

Create `src/app/model-templates.ts` with:

```ts
import type { ServiceType } from "./model-config";

export type DurationRange = {
  min: number;
  max: number;
  step: number;
  defaultValue: number;
};

export type ModelTemplate = {
  vendor: string;
  serviceType: ServiceType;
  modelName: string;
  modeOptions?: string[];
  resolutionOptions?: string[];
  aspectRatioOptions?: string[];
  supportsMode?: boolean;
  supportsResolution?: boolean;
  supportsAspectRatio?: boolean;
  supportsAutoAspect?: boolean;
  supportsDuration?: boolean;
  durationRange?: DurationRange;
  defaults?: {
    mode?: string;
    resolution?: string;
    aspectRatio?: string;
  };
};

export const modelTemplates: Record<string, ModelTemplate> = {
  "gpt-image-2": {
    vendor: "OpenAI",
    serviceType: "image",
    modelName: "gpt-image-2",
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    resolutionOptions: ["1K", "2K", "4K"],
    aspectRatioOptions: ["1:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "2:1", "1:2", "9:21"],
    defaults: { resolution: "1K", aspectRatio: "1:1" },
  },
  "runway-gen3": {
    vendor: "Runway",
    serviceType: "video",
    modelName: "runway-gen3",
    supportsMode: true,
    supportsResolution: true,
    supportsAspectRatio: true,
    supportsAutoAspect: true,
    supportsDuration: true,
    modeOptions: ["Standard", "Fast"],
    resolutionOptions: ["720p", "1080p"],
    aspectRatioOptions: ["1:1", "9:16", "16:9", "3:4", "4:3", "5:4", "4:5", "21:9"],
    durationRange: { min: 5, max: 15, step: 5, defaultValue: 5 },
    defaults: { mode: "Standard", resolution: "720p", aspectRatio: "1:1" },
  },
};

export function getModelTemplate(modelName?: string | null): ModelTemplate | null {
  if (!modelName) return null;
  return modelTemplates[modelName] ?? null;
}

export function getTemplatesForServiceType(serviceType: ServiceType): ModelTemplate[] {
  return Object.values(modelTemplates).filter((template) => template.serviceType === serviceType);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- src/app/model-templates.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/model-templates.ts src/app/model-templates.test.ts
git commit -m "feat: add model template registry"
```

## Task 2: Extend Model Config Helpers For Enabled Filtering And Connectivity

**Files:**
- Modify: `src/app/model-config.ts`
- Modify: `src/app/model-config.test.ts`

- [ ] **Step 1: Write failing helper tests**

Extend `src/app/model-config.test.ts` with:

```ts
it("returns enabled configs for a specific service type", () => {
  const configs = [
    makeConfig({ id: "image-on", serviceType: "image", enabled: true }),
    makeConfig({ id: "image-off", serviceType: "image", enabled: false }),
    makeConfig({ id: "video-on", serviceType: "video", enabled: true }),
  ];

  expect(getEnabledConfigsForServiceType(configs, "image").map((config) => config.id)).toEqual(["image-on"]);
});

it("keeps disabled configs out of model choices", () => {
  const configs = [
    makeConfig({ serviceType: "video", enabled: false, modelList: ["runway-gen3"] }),
  ];

  expect(getModelsForServiceType(configs, "video")).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- src/app/model-config.test.ts
```

Expected: FAIL because `getEnabledConfigsForServiceType` is not implemented yet.

- [ ] **Step 3: Add route filtering and connectivity helper contracts**

Update `src/app/model-config.ts` with:

```ts
export function getEnabledConfigsForServiceType(
  configs: ModelConfig[],
  serviceType: ServiceType,
): ModelConfig[] {
  return configs.filter((config) => config.serviceType === serviceType && config.enabled);
}

export type ConnectionTestResult = {
  ok: boolean;
  status: "idle" | "success" | "error";
  message: string;
  checkedAt?: number;
};

export async function probeModelConfigConnection(config: Pick<ModelConfig, "baseUrl" | "apiKey" | "submitEndpoint">): Promise<ConnectionTestResult> {
  const baseUrl = normalizeModelBaseUrl(config.baseUrl);
  const endpointPath = config.submitEndpoint.trim() || "/";
  const endpoint = `${baseUrl}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;

  try {
    const response = await fetch(endpoint, {
      method: "OPTIONS",
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
    });

    if (response.ok || response.status === 401 || response.status === 405) {
      return { ok: true, status: "success", message: "连接成功", checkedAt: Date.now() };
    }

    return { ok: false, status: "error", message: `连接失败（HTTP ${response.status}）`, checkedAt: Date.now() };
  } catch (error) {
    return { ok: false, status: "error", message: error instanceof Error ? error.message : "连接失败", checkedAt: Date.now() };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- src/app/model-config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/model-config.ts src/app/model-config.test.ts
git commit -m "feat: add model config filtering helpers"
```

## Task 3: Persist Node-Instance Generation Params In The Store

**Files:**
- Modify: `src/app/store.ts`
- Modify: `src/app/store.test.ts`

- [ ] **Step 1: Write failing store tests**

Extend `src/app/store.test.ts` with:

```ts
it("updates aspect ratio for only the targeted node", () => {
  const store = useStore.getState();
  store.addNode({
    id: "video-2",
    type: "videoNode",
    position: { x: 0, y: 0 },
    data: {},
  });

  store.updateNodeGenerationParams("1", { aspectRatio: "5:4" });

  const first = useStore.getState().nodes.find((node) => node.id === "1");
  const second = useStore.getState().nodes.find((node) => node.id === "video-2");
  expect(first?.data?.generationParams?.aspectRatio).toBe("5:4");
  expect(second?.data?.generationParams?.aspectRatio).toBeUndefined();
});

it("stores video duration on a single node", () => {
  const store = useStore.getState();
  store.updateNodeGenerationParams("1", { durationSeconds: 10 });
  const first = useStore.getState().nodes.find((node) => node.id === "1");
  expect(first?.data?.generationParams?.durationSeconds).toBe(10);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- src/app/store.test.ts
```

Expected: FAIL because `updateNodeGenerationParams` does not exist yet.

- [ ] **Step 3: Add node param state and update action**

Update `src/app/store.ts`:

```ts
export type NodeGenerationParams = {
  vendor?: string;
  model?: string;
  mode?: string;
  resolution?: string;
  aspectRatio?: string;
  durationSeconds?: number;
};

type AppState = {
  // existing fields...
  updateNodeGenerationParams: (nodeId: string, patch: Partial<NodeGenerationParams>) => void;
};

updateNodeGenerationParams: (nodeId, patch) =>
  set((state) => {
    const nodes = state.nodes.map((node) =>
      node.id !== nodeId
        ? node
        : {
            ...node,
            data: {
              ...(node.data ?? {}),
              generationParams: {
                ...((node.data as any)?.generationParams ?? {}),
                ...patch,
              },
            },
          },
    );

    return {
      nodes,
      ...syncActiveProjectState({ ...state, nodes }),
    };
  }),
```

Also ensure `runNode` reads `generationParams` from the current node when constructing requests later in Task 5.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- src/app/store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts
git commit -m "feat: persist node generation params"
```

## Task 4: Render Template-Driven Parameter Bars In Custom Nodes

**Files:**
- Modify: `src/app/components/nodes/CustomNodes.tsx`
- Modify: `src/app/model-templates.ts`
- Test: `src/app/model-templates.test.ts`

- [ ] **Step 1: Write a failing template capability test for video duration**

Extend `src/app/model-templates.test.ts` with:

```ts
it("defines duration support for video templates only when the model supports it", () => {
  expect(getModelTemplate("runway-gen3")?.durationRange?.defaultValue).toBe(5);
  expect(getModelTemplate("gpt-image-2")?.durationRange).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails if duration metadata is missing**

Run:

```bash
npm test -- src/app/model-templates.test.ts
```

Expected: FAIL only if the template metadata was not added in Task 1. If already passing, treat this as a guard check and continue.

- [ ] **Step 3: Refactor `CustomNodes.tsx` to use registry-driven controls**

Implement these focused changes:

```ts
const VISIBLE_MEDIA_NODE_TYPES = new Set(["imageNode", "videoNode", "panoramaNode"]);

function getNodeParams(data: any): NodeGenerationParams {
  return data?.generationParams ?? {};
}

function getAspectRatioClass(aspectRatio?: string, fallback: string = "aspect-video") {
  switch (aspectRatio) {
    case "1:1":
      return "aspect-square";
    case "9:16":
      return "aspect-[9/16]";
    case "16:9":
      return "aspect-video";
    case "5:4":
      return "aspect-[5/4]";
    case "4:5":
      return "aspect-[4/5]";
    case "2:1":
      return "aspect-[2/1]";
    default:
      return fallback;
  }
}
```

Then in `PromptPanel`:

```ts
const node = allNodes.find((item) => item.id === nodeId);
const params = getNodeParams(node?.data);
const template = getModelTemplate(model);
const serviceConfigs = getEnabledConfigsForServiceType(useStore.getState().modelConfigs, inferredServiceType);
const vendorOptions = [...new Set(serviceConfigs.map((config) => config.vendor))];
const modelOptions = serviceConfigs.flatMap((config) => config.modelList).filter((modelName) => !!getModelTemplate(modelName));
```

Render controls in this order:

1. Vendor dropdown
2. Model dropdown
3. Mode dropdown if `template?.supportsMode`
4. Resolution / aspect / auto panel if supported
5. Duration slider if `template?.supportsDuration`

When a control changes, call:

```ts
updateNodeGenerationParams(nodeId, { aspectRatio: nextRatio });
```

For media node surfaces, swap hardcoded `aspect-video` or `aspect-[2/1]` wrappers to:

```ts
const aspectClass = getAspectRatioClass(currentAspectRatio, "aspect-video");
<div className={clsx("rounded-[20px] ...", aspectClass)}>
```

- [ ] **Step 4: Run targeted tests and build**

Run:

```bash
npm test -- src/app/model-templates.test.ts src/app/store.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/nodes/CustomNodes.tsx src/app/model-templates.ts src/app/model-templates.test.ts src/app/store.ts src/app/store.test.ts
git commit -m "feat: render template-driven node params"
```

## Task 5: Map Node Params Into Runtime Requests

**Files:**
- Modify: `src/app/store.ts`
- Modify: `src/app/model-templates.ts`

- [ ] **Step 1: Write a failing execution-path test**

Add a store test shaped like:

```ts
it("uses node generation params when dispatching a run", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({ data: [{ url: "https://example.com/out.png" }] }),
  });
  vi.stubGlobal("fetch", fetchMock);

  const store = useStore.getState();
  store.updateNodeGenerationParams("2", { aspectRatio: "5:4", resolution: "2K" });
  await store.runNode("2", { prompt: "test", model: "gpt-image-2" });

  const [, init] = fetchMock.mock.calls[0];
  expect(String(init.body)).toContain("5:4");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/app/store.test.ts
```

Expected: FAIL because `runNode` still ignores stored params.

- [ ] **Step 3: Add request mapping through the template registry**

In `src/app/model-templates.ts` add a request mapper:

```ts
export function buildModelRequestBody(
  template: ModelTemplate | null,
  prompt: string,
  params: NodeGenerationParams,
) {
  return {
    prompt,
    model: params.model,
    mode: template?.supportsMode ? params.mode : undefined,
    size: template?.supportsResolution ? params.resolution : undefined,
    aspect_ratio: template?.supportsAspectRatio ? params.aspectRatio : undefined,
    duration: template?.supportsDuration ? params.durationSeconds : undefined,
  };
}
```

Then in `store.ts` inside `runNode`:

```ts
const node = state.nodes.find((item) => item.id === nodeId);
const generationParams = (node?.data as any)?.generationParams ?? {};
const template = getModelTemplate(payload.model?.trim() || config.defaultModel);
const body = buildModelRequestBody(template, payload.prompt, {
  ...generationParams,
  model: payload.model?.trim() || generationParams.model || config.defaultModel,
});
```

Use `body` in the fetch call instead of the current hardcoded payload object.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- src/app/store.test.ts src/app/model-templates.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/store.ts src/app/store.test.ts src/app/model-templates.ts
git commit -m "feat: map node params into generation requests"
```

## Task 6: Add Admin Connectivity Testing UI

**Files:**
- Modify: `src/app/components/admin/ModelConfigPage.tsx`
- Modify: `src/app/components/admin/ModelConfigTable.tsx`
- Modify: `src/app/components/admin/ModelConfigDrawer.tsx`
- Modify: `src/app/model-config.ts`

- [ ] **Step 1: Add the failing UI contract mentally and codify state shape**

Add local state to `ModelConfigPage.tsx`:

```ts
const [connectionResults, setConnectionResults] = useState<Record<string, ConnectionTestResult>>({});
const [testingIds, setTestingIds] = useState<Record<string, boolean>>({});
```

This task is intentionally UI-first; no dedicated test file exists for admin components yet, so rely on focused build verification plus browser checks later.

- [ ] **Step 2: Implement the page-level test action**

In `ModelConfigPage.tsx` add:

```ts
const runConnectionTest = async (config: ModelConfig) => {
  setTestingIds((state) => ({ ...state, [config.id]: true }));
  const result = await probeModelConfigConnection(config);
  setConnectionResults((state) => ({ ...state, [config.id]: result }));
  setTestingIds((state) => ({ ...state, [config.id]: false }));
};
```

Pass `onTestConnection`, `connectionResults`, and `testingIds` into `ModelConfigTable`.

- [ ] **Step 3: Add a table action and visible status**

Update `ModelConfigTable.tsx` to show a new action button:

```tsx
<Button
  type="button"
  variant="outline"
  onClick={() => onTestConnection(config)}
  disabled={testingIds[config.id]}
>
  {testingIds[config.id] ? "测试中" : "测试连接"}
</Button>
```

Add a small status text cell or inline badge:

```tsx
{connectionResults[config.id] ? (
  <span className={connectionResults[config.id].ok ? "text-emerald-300" : "text-rose-300"}>
    {connectionResults[config.id].message}
  </span>
) : null}
```

- [ ] **Step 4: Run build verification**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/admin/ModelConfigPage.tsx src/app/components/admin/ModelConfigTable.tsx src/app/components/admin/ModelConfigDrawer.tsx src/app/model-config.ts
git commit -m "feat: add admin model connectivity tests"
```

## Task 7: Verify Enabled-Only Front-End Visibility And Disabled Legacy Labels

**Files:**
- Modify: `src/app/components/nodes/CustomNodes.tsx`
- Modify: `src/app/store.test.ts`

- [ ] **Step 1: Write the failing disabled-model visibility test**

Extend `src/app/store.test.ts` with:

```ts
it("does not expose disabled models in fresh node choices", () => {
  const store = useStore.getState();
  store.upsertModelConfig({
    ...seedModelConfigs.find((config) => config.serviceType === "video")!,
    id: "video-disabled",
    modelList: ["seedance-2"],
    enabled: false,
  });

  const models = getModelsForServiceType(useStore.getState().modelConfigs, "video");
  expect(models).not.toContain("seedance-2");
});
```

- [ ] **Step 2: Run test to verify it fails only if filtering regressed**

Run:

```bash
npm test -- src/app/store.test.ts src/app/model-config.test.ts
```

Expected: PASS if filtering is already correct; if not, fix before continuing.

- [ ] **Step 3: Add disabled legacy labeling in the node bar**

In `CustomNodes.tsx`, when the current node’s stored model is not in the active options list:

```tsx
const modelIsDisabled = !!params.model && !modelOptions.includes(params.model);
```

Render the model trigger label as:

```tsx
{modelIsDisabled ? `${params.model}（已停用）` : currentModelLabel}
```

Do not include disabled models in the selectable dropdown options.

- [ ] **Step 4: Run tests and build**

Run:

```bash
npm test -- src/app/store.test.ts src/app/model-config.test.ts src/app/model-templates.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/nodes/CustomNodes.tsx src/app/store.test.ts src/app/model-config.test.ts
git commit -m "feat: hide disabled models from node selectors"
```

## Task 8: Browser Verification

**Files:**
- No code changes required unless findings appear.

- [ ] **Step 1: Verify media node aspect changes are instance-only**

Open `/app` and validate:

1. Create or select two image/video nodes.
2. Change the first node to `5:4`.
3. Confirm only that node resizes.

- [ ] **Step 2: Verify template-driven parameter visibility**

Check:

1. Video nodes show vendor, model, mode, aspect/resolution, duration.
2. Image nodes omit duration.
3. Unsupported controls disappear when changing models.

- [ ] **Step 3: Verify admin-side connectivity actions**

Open `/admin`, then:

1. Trigger “测试连接” for one enabled config.
2. Confirm loading text appears.
3. Confirm a success/error message appears afterwards.

- [ ] **Step 4: Re-run final verification**

Run:

```bash
npm test -- src/app/store.test.ts src/app/model-config.test.ts src/app/model-templates.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit or fix follow-up findings**

```bash
git add src/app
git commit -m "test: verify model adaptation flow"
```

## Self-Review

- Spec coverage:
  - Node-instance-only aspect ratio: Task 3 + Task 4
  - Video duration slider: Task 4
  - Hardcoded developer-maintained model templates: Task 1 + Task 5
  - Enabled-only model visibility: Task 2 + Task 7
  - Admin connectivity testing: Task 6
- Placeholder scan:
  - No `TODO` / `TBD` placeholders remain.
- Type consistency:
  - `ModelTemplate`, `NodeGenerationParams`, `ConnectionTestResult`, `updateNodeGenerationParams`, and `buildModelRequestBody` are introduced before downstream usage.
