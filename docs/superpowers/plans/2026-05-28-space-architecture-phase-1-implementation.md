# Space Architecture Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add personal and team space awareness to `/app`, then expose minimal team-space assignment controls in `/admin`.

**Architecture:** Extend the frontend state model so `space` becomes the top-level workspace context above projects, history, and assets. Keep the first implementation frontend-persisted and permission-shaped, while introducing a lightweight `/app` space switcher plus admin-facing members and invitations scaffolding that can later connect to real backend APIs.

**Tech Stack:** React 19, TypeScript, Zustand, React Router, Tailwind CSS, Vitest

---

### Task 1: Define Space-Aware Store State

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\store.ts`
- Test: `D:\code\ccy-canvas\src\app\store.test.ts`

- [ ] **Step 1: Write a failing test for default personal-space context**

Add to `src/app/store.test.ts`:

```ts
it("starts in the authenticated user's personal space", async () => {
  const { useStore } = await loadStore();

  const state = useStore.getState() as Record<string, unknown>;
  expect(state.activeSpaceId).toBe("space-personal");
  expect(state.activeSpaceType).toBe("personal");
});
```

- [ ] **Step 2: Run the test and verify the failure is about missing space state**

Run:

```powershell
npm test -- src/app/store.test.ts -t "starts in the authenticated user's personal space"
```

Expected: FAIL because the store does not yet model spaces.

- [ ] **Step 3: Write a second failing test for switching team spaces**

Add to `src/app/store.test.ts`:

```ts
it("switches spaces and restores the correct space-scoped project list", async () => {
  const { useStore } = await loadStore();

  useStore.getState().switchSpace("space-team-alpha");
  useStore.getState().createProject("Team Board");
  useStore.getState().switchSpace("space-personal");

  const personalState = useStore.getState();
  expect(personalState.projects.some((project) => project.name === "Team Board")).toBe(false);

  useStore.getState().switchSpace("space-team-alpha");
  expect(useStore.getState().projects.some((project) => project.name === "Team Board")).toBe(true);
});
```

- [ ] **Step 4: Run the second test and verify the failure is about missing space switching**

Run:

```powershell
npm test -- src/app/store.test.ts -t "switches spaces and restores the correct space-scoped project list"
```

Expected: FAIL because project data is not yet partitioned by space.

- [ ] **Step 5: Add space types and ownership fields in `store.ts`**

Implement:

```ts
export type SpaceType = "personal" | "team";

export type WorkspaceSpace = {
  id: string;
  name: string;
  type: SpaceType;
  role: "owner" | "editor" | "viewer";
  createdAt: number;
};
```

Expected: the store can now represent personal and team contexts explicitly.

- [ ] **Step 6: Make project and history state keyed by `spaceId`**

Add state like:

```ts
activeSpaceId: string;
activeSpaceType: SpaceType;
spaces: WorkspaceSpace[];
spaceProjectIds: Record<string, string[]>;
spaceHistoryIds: Record<string, string[]>;
switchSpace: (spaceId: string) => void;
```

Expected: switching spaces changes the visible project/history collection without route changes.

- [ ] **Step 7: Re-run the targeted space tests**

Run:

```powershell
npm test -- src/app/store.test.ts -t "space"
```

Expected: PASS.

### Task 2: Make Personal Space The Default Workspace Context

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\auth\AuthProvider.tsx`
- Modify: `D:\code\ccy-canvas\src\app\routes.tsx`
- Modify: `D:\code\ccy-canvas\src\app\store.ts`

- [ ] **Step 1: Add optional frontend-only workspace metadata to `AuthUser`**

Extend `AuthUser` with:

```ts
workspaceSpaces?: Array<{
  id: string;
  name: string;
  type: "personal" | "team";
  role: "owner" | "editor" | "viewer";
}>;
```

Expected: authenticated user context can carry default space membership.

- [ ] **Step 2: Seed a default personal space and example team spaces on login/refresh**

Normalize returned auth user data so the frontend always sees:

```ts
[
  { id: "space-personal", name: "我的空间", type: "personal", role: "owner" },
  { id: "space-team-alpha", name: "团队空间 A", type: "team", role: "editor" },
]
```

Expected: `/app` always has a valid initial space model even before backend support exists.

- [ ] **Step 3: Keep route behavior stable while defaulting `/app` to personal context**

Do not change the route structure yet. Only ensure the workspace store can initialize from the current auth user and land in personal space first.

Expected: members still enter `/app`, admins still enter `/admin`, but `/app` is now space-aware.

### Task 3: Add The `/app` Space Switcher

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\components\Toolbar.tsx`
- Check: `D:\code\ccy-canvas\src\app\components\Navbar.tsx`

- [ ] **Step 1: Add a visible space section above the project list**

Render a new section in `Toolbar.tsx`:

```tsx
<PanelTitle>{language === "zh" ? "空间切换" : "Spaces"}</PanelTitle>
```

Expected: the user can distinguish space switching from project switching.

- [ ] **Step 2: Render personal and team spaces with clear badges**

Each space row should show:

```tsx
<span>{space.name}</span>
<span>{space.type === "personal" ? "个人" : "团队"}</span>
```

Expected: private vs shared context is obvious at a glance.

- [ ] **Step 3: Wire the rows to `switchSpace`**

Use:

```tsx
onClick={() => switchSpace(space.id)}
```

Expected: switching spaces updates the visible project list and history panel immediately.

### Task 4: Make History Space-Aware And Team-Aware

**Files:**
- Modify: `D:\code\ccy-canvas\src\app\store.ts`
- Modify: `D:\code\ccy-canvas\src\app\components\Toolbar.tsx`
- Test: `D:\code\ccy-canvas\src\app\store.test.ts`

- [ ] **Step 1: Write a failing test for history isolation by space**

Add to `src/app/store.test.ts`:

```ts
it("stores history inside the active space only", async () => {
  const { useStore } = await loadStore();

  useStore.getState().addHistory({ id: "h-1", title: "Personal", type: "image", timestamp: 1, thumbnail: "x" });
  useStore.getState().switchSpace("space-team-alpha");

  expect(useStore.getState().history).toEqual([]);
});
```

- [ ] **Step 2: Run the test and verify the failure is about flat history state**

Run:

```powershell
npm test -- src/app/store.test.ts -t "stores history inside the active space only"
```

Expected: FAIL because history is still global.

- [ ] **Step 3: Filter visible history by `activeSpaceId`**

Implement selectors so `history` remains the visible collection for the active space while the persisted backing store keeps all entries keyed by space.

Expected: the masonry panel reflects the current personal or team context.

- [ ] **Step 4: Re-run the history isolation test**

Run:

```powershell
npm test -- src/app/store.test.ts -t "stores history inside the active space only"
```

Expected: PASS.

### Task 5: Add Minimal Admin Team-Space Management Scaffolding

**Files:**
- Create: `D:\code\ccy-canvas\src\app\components\admin\AdminMembersPage.tsx`
- Create: `D:\code\ccy-canvas\src\app\components\admin\AdminInvitationsPage.tsx`
- Modify: `D:\code\ccy-canvas\src\app\components\admin\AdminSidebar.tsx`
- Modify: `D:\code\ccy-canvas\src\app\components\admin\AdminOverviewPlaceholder.tsx`
- Modify: `D:\code\ccy-canvas\src\app\routes.tsx`
- Modify: `D:\code\ccy-canvas\src\app\store.ts`

- [ ] **Step 1: Add frontend seed data for team spaces and memberships**

Implement store types like:

```ts
type SpaceMember = {
  userId: string;
  name: string;
  email: string;
  role: "owner" | "editor" | "viewer";
  spaceId: string;
};
```

Expected: admin pages have real data to render before backend APIs exist.

- [ ] **Step 2: Build a real `Members` page**

Render a table showing:

```text
成员名 | 邮箱 | 全局角色 | 所属空间 | 空间权限
```

Expected: `/admin/members` becomes the first visible team-space control surface.

- [ ] **Step 3: Build a real `Invitations` page**

Render invitation cards or rows with:

```text
邀请码 | 状态 | 默认团队空间 | 已使用次数
```

Expected: `/admin/invitations` starts reflecting team-aware onboarding.

- [ ] **Step 4: Localize the sidebar and placeholder copy to clean Chinese**

Replace garbled strings with:

```ts
"概览" "成员" "邀请码" "模型配置" "日志" "管理后台" "受保护"
```

Expected: admin pages read coherently in Chinese.

### Task 6: Verify Tests, Build, And Browser Flows

**Files:**
- Check: `D:\code\ccy-canvas\src\app\store.test.ts`
- Check: `D:\code\ccy-canvas\src\app\components\Toolbar.tsx`
- Check: `D:\code\ccy-canvas\src\app\components\admin\AdminMembersPage.tsx`

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

- [ ] **Step 3: Smoke-test `/app` and `/admin` in the browser**

Manual checklist:

```text
1. Open /app.
2. Confirm the default space is personal.
3. Switch to a team space and confirm project/history context updates.
4. Open /admin/members and confirm team-space membership is visible.
5. Open /admin/invitations and confirm default team-space assignment is visible.
```

Expected: the first visible personal-vs-team architecture loop works end to end.

## Self-Review

- Spec coverage: this plan covers personal default space, team-space switching, space-aware projects/history, and minimal admin control surfaces.
- Placeholder scan: each task names exact files, tests, and commands with explicit expected outcomes.
- Type consistency: `WorkspaceSpace`, `SpaceType`, `SpaceMember`, `activeSpaceId`, and `switchSpace` are reused consistently across workspace and admin tasks.
