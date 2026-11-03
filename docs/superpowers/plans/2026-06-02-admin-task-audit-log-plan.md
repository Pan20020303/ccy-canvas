# Admin Task Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the admin log page into a first-version task audit console with real backend filtering, compact default columns, and a task detail drawer.

**Architecture:** Extend the existing admin logs API with focused query filters for status, user, and model, keeping the response shape compatible with the current log records. On the frontend, rework `AdminLogsPage` into a filterable audit surface with compact default columns, a field visibility picker, and a dedicated detail drawer for full task inspection.

**Tech Stack:** Go, sqlc, PostgreSQL, React 19, TypeScript, Vite, Tailwind CSS, lucide-react

---

### Task 1: Extend Backend Log Queries for Audit Filters

**Files:**
- Modify: `backend/db/queries/generation_logs.sql`
- Modify: generated sqlc files under `backend/internal/platform/database/sqlc/`
- Test: backend query compilation through `go test ./...`

- [ ] **Step 1: Replace the current joined list query with a filter-aware version**

Update `backend/db/queries/generation_logs.sql` so `ListGenerationLogsWithUser` becomes:

```sql
-- name: ListGenerationLogsWithUser :many
SELECT g.id, g.user_id, g.node_id, g.service_type, g.model, g.prompt, g.status, g.result_url, g.error_msg, g.duration_ms, g.cost, g.created_at,
       COALESCE(u.email, '') AS user_email,
       COALESCE(u.name, '')  AS user_name
FROM generation_logs g
LEFT JOIN users u ON u.id = g.user_id
WHERE ($1::text = '' OR g.status = $1)
  AND ($2::text = '' OR COALESCE(u.name, '') ILIKE '%' || $2 || '%' OR COALESCE(u.email, '') ILIKE '%' || $2 || '%')
  AND ($3::text = '' OR g.model ILIKE '%' || $3 || '%')
ORDER BY g.created_at DESC
LIMIT $4 OFFSET $5;
```

- [ ] **Step 2: Add a count query that matches the same filters**

Append this query to the same file:

```sql
-- name: CountGenerationLogsWithFilter :one
SELECT count(*)::int AS total
FROM generation_logs g
LEFT JOIN users u ON u.id = g.user_id
WHERE ($1::text = '' OR g.status = $1)
  AND ($2::text = '' OR COALESCE(u.name, '') ILIKE '%' || $2 || '%' OR COALESCE(u.email, '') ILIKE '%' || $2 || '%')
  AND ($3::text = '' OR g.model ILIKE '%' || $3 || '%');
```

- [ ] **Step 3: Regenerate sqlc output**

Run:

```bash
cd backend
go run github.com/sqlc-dev/sqlc/cmd/sqlc generate
```

Expected: generated `generation_logs.sql.go` includes new params for list and count queries.

- [ ] **Step 4: Run backend tests to verify the generated code compiles**

Run:

```bash
cd backend
go test ./...
```

Expected: PASS, or only unrelated pre-existing failures if any exist in the workspace.

- [ ] **Step 5: Commit the backend query layer**

```bash
git add backend/db/queries/generation_logs.sql backend/internal/platform/database/sqlc
git commit -m "feat: add filtered admin generation log queries"
```

### Task 2: Update the Admin Logs API Contract

**Files:**
- Modify: `backend/internal/identity/interfaces/admin_handler.go`
- Test: `cd backend && go test ./...`

- [ ] **Step 1: Extend the admin logs input type**

Update `listLogsInput` in `backend/internal/identity/interfaces/admin_handler.go` to:

```go
type listLogsInput struct {
	Limit  int32  `query:"limit" minimum:"1" maximum:"100" default:"50"`
	Offset int32  `query:"offset" minimum:"0" default:"0"`
	Status string `query:"status"`
	User   string `query:"user"`
	Model  string `query:"model"`
}
```

- [ ] **Step 2: Call the new filter-aware queries**

Update `listLogs` so it uses the filter inputs and count query:

```go
rows, err := h.q.ListGenerationLogsWithUser(ctx, sqlc.ListGenerationLogsWithUserParams{
	Status: input.Status,
	Column2: input.User,
	Column3: input.Model,
	Limit: input.Limit,
	Offset: input.Offset,
})
if err != nil {
	return nil, huma.Error500InternalServerError("Failed to list logs")
}
total, _ := h.q.CountGenerationLogsWithFilter(ctx, sqlc.CountGenerationLogsWithFilterParams{
	Status: input.Status,
	Column2: input.User,
	Column3: input.Model,
})
```

If sqlc generates different field names than `Column2` / `Column3`, use the actual generated names exactly as emitted.

- [ ] **Step 3: Keep the response item structure backward-compatible**

Do not change `LogItem` fields yet; keep the JSON response shape so frontend changes are isolated to new query params and improved rendering.

- [ ] **Step 4: Run backend tests again**

Run:

```bash
cd backend
go test ./...
```

Expected: PASS, or only unrelated existing failures outside this work.

- [ ] **Step 5: Commit the handler update**

```bash
git add backend/internal/identity/interfaces/admin_handler.go
git commit -m "feat: support admin log filters in api handler"
```

### Task 3: Extend Frontend Admin Log API Types and Parameters

**Files:**
- Modify: `src/app/api/admin.ts`
- Test: `npm run build`

- [ ] **Step 1: Add a typed filter input for logs**

In `src/app/api/admin.ts`, add:

```ts
export type AdminLogFilters = {
  status?: "" | "pending" | "success" | "error";
  user?: string;
  model?: string;
};
```

- [ ] **Step 2: Update `listLogs` to accept filters**

Replace the current helper with:

```ts
export function listLogs(limit = 50, offset = 0, filters: AdminLogFilters = {}): Promise<GenerationLog[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });

  if (filters.status) params.set("status", filters.status);
  if (filters.user?.trim()) params.set("user", filters.user.trim());
  if (filters.model?.trim()) params.set("model", filters.model.trim());

  return apiClient.get<GenerationLog[]>(`/api/admin/logs?${params.toString()}`);
}
```

- [ ] **Step 3: Verify the frontend still builds**

Run:

```bash
npm run build
```

Expected: build succeeds, or fails only on the not-yet-updated log page usage.

- [ ] **Step 4: Commit the API helper update**

```bash
git add src/app/api/admin.ts
git commit -m "feat: add typed frontend filters for admin logs"
```

### Task 4: Rebuild the Admin Logs Page Into a Task Audit Console

**Files:**
- Modify: `src/app/components/admin/AdminLogsPage.tsx`
- Test: `npm run build`

- [ ] **Step 1: Replace broad default columns with compact defaults**

Update the column defaults in `AdminLogsPage.tsx` to:

```ts
const DEFAULT_VISIBLE: Record<ColumnKey, boolean> = {
  user: true,
  type: false,
  model: true,
  prompt: false,
  status: true,
  duration: false,
  time: true,
};
```

- [ ] **Step 2: Add page-level filter state**

Add frontend state:

```ts
const [statusFilter, setStatusFilter] = useState<"" | "pending" | "success" | "error">("");
const [userFilter, setUserFilter] = useState("");
const [modelFilter, setModelFilter] = useState("");
const [selectedLog, setSelectedLog] = useState<GenerationLog | null>(null);
```

- [ ] **Step 3: Wire load calls to backend filters**

Update `load` to call:

```ts
setLogs(await listLogs(100, 0, {
  status: statusFilter,
  user: userFilter,
  model: modelFilter,
}));
```

Wrap it in a `useCallback` with dependencies on those three filters so the page reloads when the filters change.

- [ ] **Step 4: Add the audit filter strip**

Above the table, add a control strip with:

- a status `<select>`
- a user keyword `<input>`
- a model keyword `<input>`

Use the existing dark admin surfaces:

```tsx
<div data-admin-card className="grid gap-3 rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)]">
```

- [ ] **Step 5: Add a task detail drawer**

Inside the same file, create a `TaskDetailDrawer` component that opens when `selectedLog` is non-null and shows:

- user name / email / id
- service type
- model
- full prompt in a scrollable pre-wrap block
- status
- created time
- duration
- error message block when failed
- result URL when present
- node id

The drawer should be opened by clicking the table row or a “查看详情” button.

- [ ] **Step 6: Keep prompt out of the default scanning surface**

When the prompt column is visible, keep it truncated. The full prompt should only be comfortably readable inside the drawer.

- [ ] **Step 7: Normalize status labels in Chinese**

Keep the real backend values but render:

```ts
pending -> 生成中
success -> 成功
error -> 失败
```

- [ ] **Step 8: Preserve and refine auto-refresh**

Keep the 8-second polling only when there is at least one `pending` task in the currently loaded result set.

- [ ] **Step 9: Build the frontend**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 10: Commit the audit-console UI**

```bash
git add src/app/components/admin/AdminLogsPage.tsx
git commit -m "feat: turn admin logs into task audit console"
```

### Task 5: Verify the End-to-End Audit Workflow

**Files:**
- Revisit if needed: backend and frontend log files above
- Test: backend route probe + frontend build + local route probe

- [ ] **Step 1: Verify backend filters manually**

Run:

```bash
Invoke-WebRequest -Uri "http://localhost:8080/api/admin/logs?limit=20&status=pending" -UseBasicParsing
Invoke-WebRequest -Uri "http://localhost:8080/api/admin/logs?limit=20&user=test" -UseBasicParsing
Invoke-WebRequest -Uri "http://localhost:8080/api/admin/logs?limit=20&model=gpt" -UseBasicParsing
```

Expected: all three requests return HTTP 200 and filtered JSON payloads.

- [ ] **Step 2: Verify frontend routes still render**

Run:

```bash
Invoke-WebRequest -Uri "http://localhost:5173/admin/logs" -UseBasicParsing
```

Expected: HTTP 200.

- [ ] **Step 3: Browser-check the audit console behavior**

Confirm manually in the running app:

- default visible columns are user/model/status/time
- field picker can re-enable hidden columns
- changing status/user/model filters refreshes the list
- clicking a row opens the detail drawer
- full prompt is visible in the drawer
- pending rows show as “生成中”

- [ ] **Step 4: Commit follow-up fixes if needed**

```bash
git add backend/db/queries/generation_logs.sql backend/internal/identity/interfaces/admin_handler.go src/app/api/admin.ts src/app/components/admin/AdminLogsPage.tsx
git commit -m "fix: polish admin task audit log workflow"
```

## Self-Review

### Spec Coverage

- Backend status/user/model filtering: Tasks 1 and 2
- Compact default columns: Task 4
- Detail drawer for full prompt and metadata: Task 4
- Status semantics in Chinese: Task 4
- Audit-console verification: Task 5

### Placeholder Scan

- No TODO/TBD placeholders remain
- Query shape, handler fields, API helper shape, and verification commands are explicit
- The only sqlc field-name caveat is called out because the exact generated parameter names depend on sqlc output and must be matched after regeneration

### Type Consistency

- Backend uses `status`, `user`, and `model` consistently
- Frontend filter type mirrors those same keys
- Log detail drawer uses existing `GenerationLog` fields without inventing a second log shape
