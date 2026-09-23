# Admin Model Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real `/admin` model-configuration experience with orange-branded list-plus-drawer management, then make the `/app` workspace consume that configuration source instead of the old inline admin modal flow.

**Architecture:** Replace the current admin placeholder with a lightweight admin shell that hosts a standalone `Model Config` page backed by a shared frontend config store. Move the existing workspace-side model config responsibility behind that shared store so node execution reads from the admin-managed configuration model rather than the old user-facing settings UI.

**Tech Stack:** React 19, TypeScript, Zustand, React Router, Tailwind CSS, shadcn-style primitives, existing app auth and store patterns

---

### Task 1: Inventory And Reshape The Shared Model Config State

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\store.ts`
- Check: `D:\code\ccy-canvas\src\app\components\Modals.tsx`
- Check: `D:\code\ccy-canvas\src\app\components\Toolbar.tsx`

- [ ] **Step 1: Identify the current model config shape and usage sites**

Run:

```powershell
rg -n "modelConfigs|upsertModelConfig|removeModelConfig|isApiKeysOpen|setApiKeysOpen|runNode" src/app
```

Expected: results point to `store.ts`, `Modals.tsx`, `Navbar.tsx`, and node execution logic.

- [ ] **Step 2: Expand the config type to match the new admin form**

Implement in `src/app/store.ts`:

```ts
export type ServiceType = "text" | "image" | "video" | "audio";

export type ModelConfig = {
  id: string;
  serviceType: ServiceType;
  vendor: string;
  protocol: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  submitEndpoint: string;
  queryEndpoint: string;
  modelList: string[];
  defaultModel: string;
  priority: number;
  enabled: boolean;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
};
```

Expected: the shared state now supports the admin drawer fields and later workspace consumption.

- [ ] **Step 3: Replace old seeded configs with admin-shaped seed data**

Implement in `src/app/store.ts`:

```ts
const seedModelConfigs: ModelConfig[] = [
  {
    id: "cfg-text-openai",
    serviceType: "text",
    vendor: "OpenAI",
    protocol: "openai",
    name: "OpenAI Text",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    submitEndpoint: "/chat/completions",
    queryEndpoint: "",
    modelList: ["gpt-4.1-mini", "gpt-4.1"],
    defaultModel: "gpt-4.1-mini",
    priority: 1,
    enabled: true,
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];
```

Expected: `/admin` has meaningful local data to render before backend persistence exists.

- [ ] **Step 4: Update store actions to work with the richer type**

Implement in `src/app/store.ts`:

```ts
upsertModelConfig: (config) => set((state) => {
  const next = state.modelConfigs.some((item) => item.id === config.id)
    ? state.modelConfigs.map((item) => item.id === config.id ? config : item)
    : [config, ...state.modelConfigs];

  return {
    modelConfigs: next.map((item) =>
      item.serviceType === config.serviceType && config.isDefault && item.id !== config.id
        ? { ...item, isDefault: false }
        : item
    ),
  };
}),
```

Expected: default-state replacement and local persistence work correctly.

### Task 2: Replace The Placeholder Admin Route With A Shell And Standalone Menu

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\routes.tsx`
- Create: `D:\code\ccy-canvas\src\app\components\admin\AdminShell.tsx`
- Create: `D:\code\ccy-canvas\src\app\components\admin\AdminSidebar.tsx`
- Create: `D:\code\ccy-canvas\src\app\components\admin\AdminOverviewPlaceholder.tsx`

- [ ] **Step 1: Create a lightweight admin shell**

Implement `src/app/components/admin/AdminShell.tsx` with:

```tsx
export function AdminShell({ children, title, description, action }: AdminShellProps) {
  return (
    <div className="min-h-screen bg-[#090909] text-neutral-100">
      <div className="mx-auto flex min-h-screen max-w-[1600px]">
        <AdminSidebar />
        <main className="flex-1 px-8 py-8">
          <header className="mb-8 flex items-start justify-between gap-6">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-[#ff7a33]">Admin</p>
              <h1 className="mt-3 text-3xl font-semibold">{title}</h1>
              <p className="mt-2 max-w-3xl text-sm text-neutral-400">{description}</p>
            </div>
            {action}
          </header>
          {children}
        </main>
      </div>
    </div>
  );
}
```

Expected: `/admin` has a consistent shell that can host real modules.

- [ ] **Step 2: Add standalone admin navigation with `Model Config`**

Implement `src/app/components/admin/AdminSidebar.tsx` with static items:

```ts
const items = [
  { key: "overview", label: "Overview" },
  { key: "members", label: "Members" },
  { key: "invitations", label: "Invitations" },
  { key: "model-config", label: "Model Config" },
  { key: "logs", label: "Logs" },
];
```

Expected: `Model Config` is clearly a first-class admin area.

- [ ] **Step 3: Route `/admin` to `Model Config` as the implemented landing page**

Update `src/app/routes.tsx` so the admin page uses the new shell and defaults to the model config surface.

Expected: the old invitation placeholder is removed from the primary admin experience.

### Task 3: Build The Orange-Branded Model Config List And Drawer

**Files:**
- Create: `D:\code\ccy-canvas\src\app\components\admin\ModelConfigPage.tsx`
- Create: `D:\code\ccy-canvas\src\app\components\admin\ModelConfigTable.tsx`
- Create: `D:\code\ccy-canvas\src\app\components\admin\ModelConfigDrawer.tsx`
- Modify: `D:\code\ccy-canvas\src\app\components\ui\drawer.tsx`
- Check: `D:\code\ccy-canvas\src\app\components\ui\input.tsx`
- Check: `D:\code\ccy-canvas\src\app\components\ui\select.tsx`
- Check: `D:\code\ccy-canvas\src\app\components\ui\switch.tsx`

- [ ] **Step 1: Build the page container and page actions**

Implement `ModelConfigPage.tsx` to:

```tsx
const [drawerOpen, setDrawerOpen] = useState(false);
const [editingId, setEditingId] = useState<string | null>(null);

return (
  <AdminShell
    title="Model Config"
    description="Manage vendors, endpoints, defaults, and routing priority for workspace generation."
    action={
      <Button className="bg-[#ff6a1f] hover:bg-[#ff7b35] text-white" onClick={() => setDrawerOpen(true)}>
        Add Config
      </Button>
    }
  >
    <ModelConfigTable ... />
    <ModelConfigDrawer ... />
  </AdminShell>
);
```

Expected: the main admin page follows the approved layout and accent direction.

- [ ] **Step 2: Build the list/table view**

Implement `ModelConfigTable.tsx` with columns:

```ts
["Service Type", "Vendor", "Name", "Base URL", "Default Model", "Priority", "Status", "Actions"]
```

Each row should support:

```tsx
<button>Edit</button>
<button>{config.enabled ? "Disable" : "Enable"}</button>
<button>Delete</button>
```

Expected: admins can scan and act on existing configs without opening every record.

- [ ] **Step 3: Build the drawer form with the approved fields**

Implement `ModelConfigDrawer.tsx` with:

```tsx
type DraftConfig = {
  serviceType: ServiceType;
  vendor: string;
  protocol: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  submitEndpoint: string;
  queryEndpoint: string;
  modelListText: string;
  defaultModel: string;
  priority: number;
  enabled: boolean;
  isDefault: boolean;
};
```

Expected: the drawer covers the enterprise-style configuration surface approved in the spec.

- [ ] **Step 4: Add orange accent tokens only where they matter**

Use these styles inside the page:

```tsx
const primaryButton = "bg-[#ff6a1f] hover:bg-[#ff7b35] text-white";
const activeNav = "bg-[#ff6a1f]/12 text-[#ff8a4c] border border-[#ff6a1f]/20";
const focusRing = "focus-visible:ring-[#ff6a1f]/50 focus-visible:border-[#ff6a1f]/60";
```

Expected: the admin page feels brand-aligned without turning into an orange wall.

### Task 4: Remove Workspace-Side Admin Configuration Leakage

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\Navbar.tsx`
- Modify: `D:\code\ccy-canvas\src\app\components\Modals.tsx`
- Modify: `D:\code\ccy-canvas\src\app\store.ts`

- [ ] **Step 1: Remove the old admin model-config modal trigger from the workspace navbar**

Update `Navbar.tsx` so admin users go to `/admin` instead of opening the old `setApiKeysOpen(true)` surface:

```tsx
{user.role === "admin" ? (
  <MenuItem
    icon={Shield}
    label={dict.admin_settings}
    onClick={() => {
      setMenuOpen(false);
      navigate("/admin");
    }}
  />
) : null}
```

Expected: admin-only system configuration is now routed through the admin app rather than the user workspace.

- [ ] **Step 2: Remove or retire the old `isApiKeysOpen` modal block**

Delete the API-key modal in `Modals.tsx` once `/admin` replaces it.

Expected: there is a single source of truth for config management UX.

- [ ] **Step 3: Keep the store API clean**

Remove `isApiKeysOpen` and related setters from `store.ts` if no longer used.

Expected: workspace state no longer carries dead admin modal state.

### Task 5: Make Workspace Node Execution Read The Admin-Managed Config Model

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\store.ts`
- Check: `D:\code\ccy-canvas\src\app\components\Canvas.tsx`
- Check: `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`

- [ ] **Step 1: Add a selector that resolves the active config by service type**

Implement in `store.ts`:

```ts
const resolveConfigForType = (configs: ModelConfig[], type: ServiceType) =>
  configs
    .filter((config) => config.serviceType === type && config.enabled)
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.priority - b.priority;
    })[0] ?? null;
```

Expected: the workspace can always choose the correct admin-managed configuration source.

- [ ] **Step 2: Update `runNode` to use `serviceType`, `baseUrl`, endpoints, and `defaultModel`**

Replace the old lookup:

```ts
const cfg = state.modelConfigs.find(c => c.name === payload.model);
```

With:

```ts
const nodeTypeToServiceType: Record<string, ServiceType> = {
  textNode: "text",
  imageNode: "image",
  videoNode: "video",
  audioNode: "audio",
};
const serviceType = nodeTypeToServiceType[currentNode.type] ?? "text";
const cfg = resolveConfigForType(state.modelConfigs, serviceType);
const modelName = payload.model || cfg?.defaultModel;
```

Expected: the generation flow now depends on admin-managed config selection instead of ad hoc workspace-side model rows.

- [ ] **Step 3: Respect custom submit endpoints when present**

Implement in `runNode`:

```ts
const endpointPath =
  cfg.submitEndpoint.trim() ||
  (cfg.serviceType === "text"
    ? "/chat/completions"
    : cfg.serviceType === "image"
      ? "/images/generations"
      : "/generations");
const endpoint = `${normalizedBase}${endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`}`;
```

Expected: the new admin form fields directly influence workspace-side provider calls.

### Task 6: Verify Build And Route Smoke Flow

**Files:**
- Check: `D:\code\ccy-canvas\src\app\routes.tsx`
- Check: `D:\code\ccy-canvas\src\app\components\admin\ModelConfigPage.tsx`

- [ ] **Step 1: Run the frontend build**

Run:

```powershell
npm run build
```

Expected: Vite build succeeds with no TypeScript errors.

- [ ] **Step 2: Re-open the main flows**

Run:

```powershell
Start-Process 'http://127.0.0.1:5173/admin'
Start-Process 'http://127.0.0.1:5173/app'
```

Expected: `/admin` shows the new model config shell and drawer workflow, and `/app` still loads without breaking the workspace.

- [ ] **Step 3: Smoke-test the integration behavior**

Verify manually:

```text
1. Admin can open Add Config drawer.
2. Admin can create or edit a local config row.
3. Workspace no longer exposes the old admin config modal.
4. Workspace node execution reads the shared config state and surfaces missing-config errors clearly.
```

Expected: admin config ownership and workspace config consumption are now aligned.

## Self-Review

- Spec coverage: the plan covers standalone admin navigation, orange list-plus-drawer UI, and workspace handoff to the admin-managed config source.
- Placeholder scan: all tasks include exact files, concrete field shapes, and concrete UI/logic changes.
- Type consistency: `ModelConfig`, `ServiceType`, drawer fields, and workspace resolution logic all use the same naming and responsibility boundaries.
