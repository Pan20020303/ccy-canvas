# Admin Task Audit Log Design

## Goal

Upgrade the admin log page into a first-version task audit console that shows real generation task activity with practical operations-focused filtering.

The page should let administrators answer:

- which user triggered a task
- which model was used
- what prompt was sent
- whether the task is pending, successful, or failed
- when the task ran
- how long it took

It should also let administrators choose which columns are visible from the top-right field picker.

## User-Confirmed Direction

- Default visible columns should be compact: user, model, status, time
- Prompt content should be viewed in a dedicated detail drawer instead of inline expansion
- Scope should cover both frontend and backend where needed, forming a first-version audit console

## Current State

### Backend

The existing admin logs route already exposes real generation log data backed by the database:

- `user_id`
- `user_name`
- `user_email`
- `service_type`
- `model`
- `prompt`
- `status`
- `result_url`
- `error_msg`
- `duration_ms`
- `created_at`

The route currently supports pagination via `limit` and `offset`, but not focused filtering for audit workflows.

### Frontend

`AdminLogsPage` already has:

- table rendering for logs
- basic field visibility toggle
- status badges
- pending-task auto-refresh behavior

However, it is still missing the core audit-console behavior:

- no keyword filtering for user or model
- no status filter
- no detail drawer for full task inspection
- prompt visibility is still inline-table oriented instead of detail-first
- default visible fields are too broad

## Proposed Solution

### 1. Promote Logs Into an Audit Console

Turn the current logs page into a dedicated task audit surface with:

- compact metrics row
- control bar for filters and visible columns
- table optimized for scanning
- task detail drawer for full inspection

This keeps the existing workbench shell and aligns logs with an operations-monitoring workflow instead of a passive table.

### 2. Add Backend Filtering

Extend `/api/admin/logs` to accept lightweight query filters:

- `status`
- `user`
- `model`

These filters should be optional and independently composable.

Filtering should stay simple:

- `status` matches exact task states
- `user` searches `user_name` and `user_email`
- `model` searches the logged model string

No advanced sorting, exporting, or date-range filtering in this pass.

### 3. Default Compact Columns

Default visible columns:

- user
- model
- status
- time

Optional columns exposed through the field picker:

- task type
- prompt
- duration

This keeps the list scan-friendly while allowing admins to pull in extra context when needed.

### 4. Task Detail Drawer

Each row should open a dedicated detail drawer that includes:

- user name
- user email
- user id
- service type
- model
- full prompt
- status
- created time
- duration
- result url when present
- error message when failed
- node id when useful for tracing

The prompt should no longer rely on inline table display as the main reading surface.

### 5. Clear Status Semantics

Status display should map to the real task states:

- `pending` -> `生成中`
- `success` -> `成功`
- `error` -> `失败`

The audit UI should visually emphasize these states consistently across the table and detail drawer.

## Approaches Considered

### Approach A: Frontend-Only Polish

- Pros: fastest
- Cons: cannot support true filtering against real backend data; weak audit value

### Approach B: Filterable Table Without Detail Drawer

- Pros: simpler UI
- Cons: prompt and error inspection remain awkward; less suitable for admin investigation

### Approach C: Filterable Audit Console With Detail Drawer

- Pros: strong operator workflow, minimal scope creep, reuses real backend data
- Cons: touches both backend query layer and frontend page state

### Recommendation

Use Approach C.

It delivers the first useful audit-console version without requiring a larger analytics system.

## UX Design

### Header Controls

Top-right controls should include:

- field visibility picker
- refresh button

Top filter strip should include:

- status selector
- user keyword input
- model keyword input

### Table Behavior

- compact default columns for fast scanning
- click row or explicit action to open task details
- pending tasks keep auto-refresh behavior

### Detail Drawer

The drawer should feel like a trace inspector:

- top section for task identity and status
- metadata grid for user/model/type/time/duration
- full prompt block
- result or error block

## Technical Design

### Backend Files Likely To Change

- `backend/internal/identity/interfaces/admin_handler.go`
- `backend/db/queries/generation_logs.sql`
- generated sqlc files under `backend/internal/platform/database/sqlc/`

### Frontend Files Likely To Change

- `src/app/api/admin.ts`
- `src/app/components/admin/AdminLogsPage.tsx`

### Backend Contract

Update the admin logs endpoint to accept:

- `limit`
- `offset`
- `status`
- `user`
- `model`

The response shape can remain compatible with the current log item structure.

### Frontend State

The page should manage:

- visible columns
- selected status filter
- user filter text
- model filter text
- open/closed detail drawer
- selected log row

Persist visible columns locally as already established by the current page pattern.

## Out of Scope

- exporting logs
- date-range filtering
- server-side sorting controls
- bulk task actions
- deep trace linking into non-admin workflow pages

## Testing and Verification

1. Build frontend successfully with `npm run build`
2. Build backend successfully or verify Go compilation for changed packages
3. Verify `/api/admin/logs` returns filtered results for:
   - `status=pending`
   - `user=<keyword>`
   - `model=<keyword>`
4. Verify admin logs page:
   - defaults to compact columns
   - opens detail drawer
   - shows full prompt in drawer
   - shows status as pending/success/error with Chinese UI labels
   - keeps field visibility picker working

## Risks and Mitigations

### Risk: Filter query complexity grows too far

Mitigation:

- keep only status, user, and model filters
- no generalized query builder

### Risk: Prompt text overwhelms the table

Mitigation:

- keep prompt hidden by default
- move full prompt reading into the detail drawer

### Risk: Pending tasks feel stale

Mitigation:

- preserve auto-refresh when pending rows exist
- keep manual refresh available
