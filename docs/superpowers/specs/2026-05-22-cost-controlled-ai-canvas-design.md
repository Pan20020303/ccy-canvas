# Cost-Controlled AI Canvas Design

Date: 2026-05-22

## Purpose

This project is a single-team internal AI canvas system. Its product goal is to improve team cost management while helping members work faster through an infinite canvas workflow.

The system has two clear product surfaces:

- User app: a creation workspace built around canvas projects, model-powered nodes, reusable assets, personal history, and collaboration.
- Admin app: a control console for members, invitations, daily quotas, NewAPI-compatible model configuration, pricing, statistics, logs, and audit trails.

The first implementation should be a pragmatic MVP, but the architecture should preserve long-term extensibility for model providers, dynamic model parameters, cost calculation, and collaboration.

## Current Project Context

The existing repository contains a React-based MVP under `src/app`. It already has a canvas, login page, toolbar panels, task queue, settings modal, model config modal, local model configuration, and local generation calls.

Important current gaps:

- Model API keys and model URLs are stored in frontend state/localStorage.
- The user app contains admin-like model configuration.
- The app has no real backend authentication or authorization.
- Model lists and model parameters are hard-coded in the frontend.
- Credits, daily quotas, audit logs, model usage, and generated asset ownership are not backend-backed.
- Chinese UI text has encoding issues and should be cleaned up during frontend integration.

## Approved Technical Direction

Frontend:

- React 19
- TypeScript
- Vite
- React Router
- Tailwind CSS
- shadcn/ui components
- `@xyflow/react` for the infinite canvas
- Recharts with shadcn chart wrappers for the first admin dashboard

Backend:

- Go
- DDD-style modular monolith
- chi for HTTP routing
- PostgreSQL
- pgx and sqlc for database access
- River for PostgreSQL-backed background jobs
- OpenAPI 3.1 output for the project's own backend API contracts

Model platform:

- First version supports one NewAPI-like relay/aggregation platform.
- Provider calls use OpenAI-compatible APIs where possible.
- The code should keep a provider adapter boundary so non-compatible providers can be added later.

## Architecture

The system is a single deployable backend with DDD boundaries inside the Go codebase.

```text
React frontend
  /login
  /app
  /admin

Go backend
  interfaces
  application
  domain
  infrastructure

PostgreSQL
  identity data
  model catalog data
  credit and quota ledgers
  generation jobs and invocations
  assets and canvas snapshots
  audit logs and statistics
```

Dependency direction:

```text
interfaces -> application -> domain
infrastructure -> domain/application interfaces
domain depends on no external framework
```

The frontend never calls NewAPI directly. All authentication, permissions, model lookup, parameter validation, price estimation, credit reservation, model invocation, asset persistence, and audit logging happen through the Go backend.

## DDD Bounded Contexts

### Identity & Access

Owns:

- Users
- Password authentication
- Roles
- Invitations
- Login sessions
- Future email verification

Core concepts:

- `User`
- `Invitation`
- `InvitationRedemption`

Rules:

- Team members can register only with an administrator-issued invitation code.
- Invitation plaintext is shown only at creation time; only a hash is stored.
- Admin-only routes must not be visible or callable by members.
- Future email verification should fit the registration flow without changing user identity semantics.

### Credit & Quota

Owns:

- Member daily quota
- Current daily balance
- Credit reservations
- Charges, refunds, and manual adjustments
- Credit ledger

Core concepts:

- `CreditAccount`
- `DailyQuota`
- `CreditReservation`
- `CreditLedgerEntry`

Rules:

- Each member has an independent daily balance.
- The daily reset sets `current_balance` back to the admin-configured `daily_quota`.
- Unused credits do not accumulate.
- Model generation reserves credits before execution.
- Successful jobs confirm charges and release any over-reserved amount.
- Failed jobs release or refund reserved credits.
- Every balance change is recorded in the ledger.

### Model Catalog

Owns:

- Relay provider configuration
- NewAPI-compatible model synchronization
- Model capability classification
- Dynamic parameter schema
- Pricing rule
- Model permissions

Core concepts:

- `RelayProvider`
- `ModelDefinition`
- `ParameterSchema`
- `PricingRule`
- `CostSnapshot`

Rules:

- First version supports one NewAPI-like provider.
- API keys are encrypted at rest and never returned to the frontend.
- Synced models start as drafts until admins classify capability, pricing, and parameter schema.
- Users only see enabled, permitted, price-valid models.
- Dynamic parameter schemas drive frontend controls.
- Pricing rules are calculated server-side and can use synced platform cost snapshots plus admin overrides.

### Generation

Owns:

- Generation request orchestration
- Parameter validation
- Credit reservation orchestration
- Model invocation lifecycle
- Job status
- Retry and timeout behavior

Core concepts:

- `GenerationJob`
- `GenerationRequest`
- `ModelInvocation`

Rules:

- Every model call must enter through the generation application service.
- Generation validates identity, model permission, schema, and estimated credit cost.
- Jobs are recorded before provider execution.
- Provider responses and usage are stored as invocation records.
- Jobs publish asset creation and credit settlement outcomes.

### Asset Library

Owns:

- Generated assets
- Uploaded assets
- Canvas-to-library assets
- Project assets
- Personal and team visibility
- Canvas snapshots

Core concepts:

- `Project`
- `CanvasSnapshot`
- `Asset`
- `CanvasNodeSnapshot`

Rules:

- Generated content becomes an asset when a job succeeds.
- Canvas node content can be added to the asset library.
- Assets can be personal or team-scoped.
- Team assets are visible to permitted project collaborators.
- File history and reusable assets are distinct product concepts.

### Admin Analytics

Owns:

- Dashboard summaries
- Member consumption statistics
- Model success and failure statistics
- Asset statistics
- Daily usage snapshots

Core concepts:

- `DailyUsageSnapshot`
- `UsageMetric`

Rules:

- First version can query live tables for charts.
- River can later materialize daily or hourly snapshots.
- Statistics must be explainable from ledger, job, invocation, and asset records.

### Audit

Audit is a cross-cutting concern rather than a primary bounded context in the first version.

The application layer emits audit events for:

- Creating or revoking invitations
- Changing member quota
- Manually adjusting credits
- Configuring relay provider credentials
- Syncing models
- Changing model pricing or parameter schema
- Enabling or disabling models
- Enabling or disabling users

Audit logs cannot be deleted through the admin UI.

## Data Model

Tables are grouped here by bounded context. PostgreSQL can use a single schema in the MVP; code ownership remains separated by context.

### Identity & Access

```text
users
  id
  email
  password_hash
  name
  role: admin/member
  status: active/disabled
  email_verified_at
  last_login_at
  created_at
  updated_at

invitations
  id
  code_hash
  role
  initial_daily_quota
  max_uses
  used_count
  expires_at
  created_by
  note
  created_at
  revoked_at

invitation_redemptions
  id
  invitation_id
  user_id
  email
  redeemed_at
```

### Credit & Quota

```text
credit_accounts
  id
  user_id
  daily_quota
  current_balance
  reset_timezone
  last_reset_on
  status
  updated_at

credit_reservations
  id
  user_id
  generation_job_id
  reserved_amount
  status: reserved/confirmed/released
  expires_at
  created_at
  updated_at

credit_ledger_entries
  id
  user_id
  account_id
  type: daily_reset/reserve/charge/refund/admin_adjustment
  amount
  balance_after
  generation_job_id
  model_id
  reason
  created_by
  created_at
```

### Model Catalog

```text
relay_providers
  id
  name
  provider_type: newapi_openai_compatible
  base_url
  encrypted_api_key
  status
  last_sync_at
  created_at
  updated_at

model_definitions
  id
  provider_id
  external_model_name
  display_name
  capability: text/image/video/audio
  status: draft/enabled/disabled
  parameter_schema jsonb
  default_parameters jsonb
  pricing_rule jsonb
  cost_snapshot jsonb
  sort_order
  created_at
  updated_at

model_permission_rules
  id
  model_id
  user_id nullable
  role nullable
  allowed
  created_at
```

### Generation

```text
generation_jobs
  id
  user_id
  project_id
  canvas_node_id
  model_id
  capability
  prompt
  parameters jsonb
  resolved_inputs jsonb
  status: queued/running/provider_pending/succeeded/failed/cancelled/expired
  estimated_credits
  reserved_credits
  final_credits
  error_code
  error_message
  started_at
  finished_at
  created_at

model_invocations
  id
  generation_job_id
  provider_id
  model_id
  request_payload jsonb
  response_payload jsonb
  usage_payload jsonb
  provider_request_id
  http_status
  latency_ms
  created_at
```

### Asset Library & Canvas

```text
projects
  id
  owner_id
  name
  created_at
  updated_at

project_members
  id
  project_id
  user_id
  role: owner/editor/viewer
  created_at

canvas_snapshots
  id
  project_id
  user_id
  nodes jsonb
  edges jsonb
  version
  created_at

assets
  id
  user_id
  project_id
  canvas_node_id
  generation_job_id
  type: text/image/video/audio
  category: person/scene/object/uncategorized
  visibility: personal/team
  source: generated/uploaded/canvas_saved
  title
  prompt_summary
  content_text
  storage_url
  thumbnail_url
  metadata jsonb
  credit_cost
  created_at
```

### Admin Analytics & Audit

```text
audit_logs
  id
  actor_user_id
  action
  target_type
  target_id
  metadata jsonb
  ip
  user_agent
  created_at

daily_usage_snapshots
  id
  date
  user_id nullable
  model_id nullable
  asset_type nullable
  jobs_count
  success_count
  failed_count
  credits_used
  assets_count
  avg_latency_ms
  created_at
```

Key traceability chains:

```text
member -> generation job -> model invocation -> asset
member -> credit account -> ledger entry -> generation job
model definition -> parameter schema/pricing rule -> job -> actual usage
project -> canvas snapshot -> node -> generated asset
```

## Backend API Design

API routes are use-case based and do not expose database tables directly.

```text
/api/auth/*
/api/app/*
/api/admin/*
```

The backend should return OpenAPI 3.1 documentation for these APIs:

```text
GET /api/openapi.json
```

### Auth

```text
POST /api/auth/login
POST /api/auth/register-by-invite
POST /api/auth/logout
GET /api/auth/me
POST /api/auth/email-verifications
POST /api/auth/email-verifications/confirm
```

Email verification endpoints are reserved for the later verification flow.

### User App

```text
GET /api/app/models
POST /api/app/pricing/estimate
POST /api/app/generations
GET /api/app/generations/:job_id
GET /api/app/generations?project_id=&status=

GET /api/app/credits/summary

GET /api/app/projects
POST /api/app/projects
GET /api/app/projects/:id/canvas
PUT /api/app/projects/:id/canvas
GET /api/app/projects/:id/members
POST /api/app/projects/:id/members
PATCH /api/app/projects/:id/members/:user_id

GET /api/app/assets?project_id=&type=&visibility=&category=&date=
POST /api/app/assets/upload
POST /api/app/assets/from-canvas-node
GET /api/app/assets/:asset_id
```

Future realtime endpoint:

```text
GET /api/app/events
```

The first version can use polling for jobs, then add SSE for `job.updated`, `asset.created`, and `credit.updated`.

### Admin

```text
GET /api/admin/members
PATCH /api/admin/members/:id
PATCH /api/admin/members/:id/daily-quota
POST /api/admin/members/:id/credit-adjustments

POST /api/admin/invitations
GET /api/admin/invitations
PATCH /api/admin/invitations/:id/revoke

GET /api/admin/relay-provider
PUT /api/admin/relay-provider
POST /api/admin/relay-provider/test

POST /api/admin/models/sync
GET /api/admin/models
GET /api/admin/models/:id
PATCH /api/admin/models/:id
POST /api/admin/models/:id/test
PATCH /api/admin/models/:id/enable
PATCH /api/admin/models/:id/disable

GET /api/admin/dashboard/summary
GET /api/admin/dashboard/credit-trend
GET /api/admin/dashboard/member-ranking
GET /api/admin/dashboard/model-usage
GET /api/admin/dashboard/asset-breakdown

GET /api/admin/members/:id/today-assets
GET /api/admin/generation-jobs
GET /api/admin/credit-ledger
GET /api/admin/audit-logs
```

### Response Shape

Success:

```json
{
  "data": {},
  "request_id": "req_xxx"
}
```

Error:

```json
{
  "error": {
    "code": "INSUFFICIENT_CREDITS",
    "message": "今日积分不足",
    "details": {}
  },
  "request_id": "req_xxx"
}
```

Important error codes:

```text
UNAUTHENTICATED
FORBIDDEN
INVITATION_INVALID
MODEL_DISABLED
MODEL_PERMISSION_DENIED
INVALID_MODEL_PARAMETERS
INSUFFICIENT_CREDITS
GENERATION_FAILED
PROVIDER_UNAVAILABLE
```

## Dynamic Model Parameters

The backend returns a `parameter_schema` per model. The frontend renders model-specific controls from that schema.

Example:

```json
{
  "fields": [
    {
      "key": "size",
      "label": "尺寸",
      "type": "select",
      "options": ["1024x1024", "1024x1536", "1536x1024"],
      "default": "1024x1024",
      "required": true
    },
    {
      "key": "quality",
      "label": "质量",
      "type": "select",
      "options": ["standard", "hd"],
      "default": "standard"
    },
    {
      "key": "n",
      "label": "数量",
      "type": "number",
      "min": 1,
      "max": 4,
      "default": 1
    }
  ]
}
```

Supported first-version field types:

```text
select
number
slider
toggle
text
textarea
```

The frontend can render controls from the schema, but the backend remains authoritative for validation.

## Pricing and Credits

The pricing flow is:

```text
estimate -> reserve -> invoke provider -> settle or release
```

### Estimation

`POST /api/app/pricing/estimate` validates:

- User authentication
- Model enabled status
- User or role permission
- Parameter schema
- Pricing rule validity

It returns:

- Estimated credits
- Human-readable breakdown
- Pricing source information

### Reservation

When a user starts generation, the backend transaction:

1. Validates user, project permission, model permission, prompt, and parameters.
2. Recalculates estimated credits.
3. Locks the member's `credit_accounts` row.
4. Checks that `current_balance >= estimated_credits`.
5. Decrements `current_balance` by the estimated amount.
6. Creates a `credit_reservation`.
7. Writes a `reserve` ledger entry.
8. Creates a `generation_job`.
9. Enqueues a River job.

### Settlement

On success:

- Store provider usage in `model_invocations`.
- Calculate `final_credits` from actual usage when available.
- Confirm the charge.
- Refund any over-reserved credits.
- Record undercharged cases when actual usage exceeds the reservation and balance is insufficient.
- Create an asset.
- Mark the job `succeeded`.

On failure:

- Mark the job `failed`.
- Release reserved credits.
- Write refund or release ledger entries.
- Store provider or validation error details.

On cancellation:

- If provider execution has not started, release all reserved credits.
- If provider execution has started, transition through provider-specific cancellation or final settlement.

## Generation Job UX

Canvas nodes must show clear progress after a generation starts.

Node visual states:

```text
queued
running
provider_pending
succeeded
failed
cancelled
expired
```

Running animation:

- The node content area fills from left to right like a water-flow animation.
- The node border highlights and subtly glows.
- The node title row shows elapsed time in the top-right area.
- When a job succeeds, the fill completes, fades out, and the result fades in.
- When a job fails, the fill stops and the node shows an error state.

Progress rules:

- If provider/backend progress is available, show real progress.
- If no real progress is available, use perceived progress:
  - Move gradually from 0% to 80%.
  - Slow down between 80% and 95%.
  - Complete to 100% only when the job succeeds.
  - Stop and show failure state when the job fails.
- Respect `prefers-reduced-motion` by falling back to a static progress indicator.

Elapsed timer:

- Display values like `12.3s`, `68.1s`, or `333.9s`.
- Base the timer on backend `generation_job.started_at`, not local click time.
- Refreshing the page must not reset elapsed time to zero.

## User App Design

### Routes

```text
/login
/app
/admin
```

`/admin` is visible only for admins and uses a separate backend permission boundary.

### Login

The login page should be redesigned around:

- Email
- Password
- Login button
- Invitation-code registration entry
- Reserved future email verification flow

Registration requires:

- Email
- Password
- Display name
- Invitation code

### Top Bar

Left:

- Brand logo
- Current project name

Right:

- Today's remaining credits
- Task queue entry
- Language switch
- User avatar menu

User menu:

- Profile
- History
- Settings
- Admin app link for admins only
- Logout

The user menu must not include inline model/API-key configuration.

### Left Toolbar

Toolbar entries:

- Add node
- Canvas projects
- Asset library
- File manager
- Settings

Each entry opens a left-side floating panel. Only one panel is open at a time.

### Canvas Projects

The canvas project panel supports:

- Project list
- Current project highlight
- Create new project
- Switch project
- Project collaboration entry

Switching project should:

- Save the current canvas snapshot.
- Load the selected project's nodes and edges.
- Refresh project-scoped tasks.
- Refresh project-scoped assets.

Collaboration:

- Project roles: owner, editor, viewer.
- Owners can invite existing team members to a project.
- Editors can edit the canvas and run generations.
- Viewers can inspect only.

### Asset Library

The asset library is a reusable creative asset pool.

Filters:

- Personal/team
- Person/scene/object
- Generated/uploaded/canvas-saved

Core actions:

- Upload asset.
- Add canvas node content to the asset library.
- Drag or add an asset back to the current canvas.
- View source project, source node, creator, type, and visibility.

Adding canvas content to the library prompts for:

- Asset name
- Category: person, scene, object
- Visibility: personal or team
- Optional note

### File Manager

The file manager is personal history and outputs, not the reusable asset pool.

History:

- Shows only the current user's generated history.
- Supports all/image/video/audio/text filters.
- Uses masonry layout for images and video thumbnails.
- Uses summary cards for text.
- Uses compact media cards for audio.

Output folder:

- Holds saved, exported, or archived results.
- Can later expand into download history or project delivery packages.

### Canvas Layout

Approved layout:

```text
top-right:
  credits, task queue, language, user menu

left:
  vertical tool panel

bottom-left:
  custom canvas control bar and optional MiniMap

bottom-right:
  assistant/help entry
```

Task queue:

- Located in the top-right bar.
- Shows active count badge.
- Opens as a dropdown panel toward the left/down.
- Shares top-bar popover exclusivity with language/user menu.

Canvas control bar:

- Remove default React Flow controls.
- Add a custom horizontal control bar in the bottom-left.
- Buttons from left to right:
  - Toggle MiniMap.
  - Toggle auto alignment/snap.
  - Fit view.
  - Zoom slider with percentage.

MiniMap:

- Opens from the bottom-left control area.
- Does not overlap the assistant/help entry.

Auto alignment:

- Controls guide lines, snap-to-grid, and alignment behavior.
- Active state is visibly highlighted.

## Admin App Design

The first admin app is functional and information-dense. It can be visually redesigned later with Pencil without changing the information architecture.

Navigation:

```text
Dashboard
Members
Invitations
Models
Generation Logs
Assets
Credit Ledger
Audit Logs
System Settings
```

### Dashboard

KPI cards:

- Today's total credits used
- Today's successful jobs
- Today's generated assets
- Today's failure rate
- Enabled model count
- Average remaining member quota

Charts:

- Credit trend over 7/30 days
- Member consumption ranking
- Model consumption share
- Asset type distribution
- Failure reason distribution

Alerts:

- High-consuming members
- High-failure models
- Jobs where actual charge exceeded reservation
- Jobs with credits consumed but no generated asset

### Members

Member list fields:

- Name/email
- Role
- Status
- Daily quota
- Remaining credits today
- Credits used today
- Assets generated today
- Last login

Actions:

- Set daily quota.
- Reset today's quota immediately.
- Manual credit adjustment.
- Enable or disable member.
- View member details.
- View today's assets.
- View usage history.

### Invitations

Invitation list fields:

- Note
- Role
- Initial daily quota
- Used count and max uses
- Expiration
- Creator
- Status

Create invitation:

- Role
- Initial daily quota
- Max uses, default 1
- Expiration, default 7 days
- Note

### Models

Sections:

- NewAPI provider configuration
- Model list
- Model detail drawer/page

Provider configuration:

- Base URL
- API key encrypted status
- Test connection
- Sync models
- Last sync time

Model list fields:

- Display name
- External model name
- Capability
- Status
- Pricing status
- Parameter template
- Calls today
- Credits today
- Success rate

Model detail:

- Basic information
- Parameter schema editor
- Default parameters
- Pricing rule editor
- Permission rules
- Test connection
- Enable or disable

Parameter schema and pricing rule should offer form editing plus advanced JSON mode.

### Generation Logs

Fields:

- Time
- Member
- Model
- Type
- Status
- Estimated credits
- Actual credits
- Latency
- Error reason
- Project/node

Filters:

- Member
- Model
- Status
- Asset type
- Date range
- Error code

Details:

- Prompt summary
- Parameters
- Usage
- Pricing breakdown
- Provider response summary
- Linked asset
- Credit ledger entries

### Asset Review

Default view:

- Today's assets
- Filter by member
- Filter by type
- Filter by model

Asset display:

- Preview or text summary
- Member
- Model
- Credits consumed
- Generation time
- Project
- Status

The first version is view-only; moderation workflows can be added later.

### Credit Ledger

Fields:

- Time
- Member
- Type
- Amount
- Balance after
- Linked job
- Operator
- Reason

Types:

- `daily_reset`
- `reserve`
- `charge`
- `refund`
- `admin_adjustment`

### Audit Logs

Records admin operations. The admin UI must not support deleting audit logs.

## Frontend Capability Boundaries

The user app must remove or hide:

- API key input
- Model URL input
- Provider connection test
- Local model configuration
- Pricing rule editing
- Admin-only model configuration modal

These move to `/admin`.

The user app keeps:

- User settings
- Keyboard shortcuts
- Canvas alignment preferences
- Notifications
- File and save preferences

## Implementation Task Groups

These are design-level task groups to guide future planning.

### Backend Foundation

- Create Go DDD modular monolith structure.
- Configure PostgreSQL, pgx, sqlc, migrations, and River.
- Add request IDs, logging, error format, authentication middleware, and admin middleware.
- Generate OpenAPI 3.1 documentation for backend APIs.

### Identity & Access

- Implement email/password login.
- Implement invitation-based registration.
- Add admin-only invitation creation.
- Add user roles and route guards.
- Reserve email verification flow.

### Credit & Quota

- Implement credit accounts.
- Implement daily quota reset jobs.
- Implement credit ledger.
- Implement reservation, charge, refund, and admin adjustment.
- Expose user credit summary.

### Model Catalog

- Implement encrypted NewAPI provider configuration.
- Implement provider test connection.
- Implement model sync.
- Implement model definitions, parameter schema, pricing rule, and permissions.
- Expose enabled permitted models to the user app.

### Generation

- Implement price estimation.
- Implement generation job creation and credit reservation.
- Implement River generation workers.
- Implement NewAPI/OpenAI-compatible adapter.
- Implement invocation records, settlement, refunds, and asset creation.

### User App

- Redesign login and invitation registration.
- Add protected `/app` route.
- Remove user-facing API key/model URL configuration.
- Load model list and parameter schema from backend.
- Add credit summary to the top bar.
- Move task queue to top-right.
- Add project creation, switching, and collaboration basics.
- Add personal/team asset library.
- Add canvas-to-library save flow.
- Add file manager history with masonry layout.
- Replace default React Flow controls with bottom-left custom control bar.
- Add MiniMap toggle, auto alignment toggle, fit view, and zoom slider.
- Add node running animation and elapsed timer.

### Admin App

- Add separate `/admin` route and layout.
- Add dashboard charts and KPI cards.
- Add member management and quota controls.
- Add invitation management.
- Add NewAPI provider and model management.
- Add generation logs.
- Add asset review.
- Add credit ledger.
- Add audit logs.

### Testing

- Domain tests for credit reservation, charge, refund, and daily reset.
- Domain tests for pricing rule calculations.
- Application tests for generation creation and settlement.
- API tests for auth, admin guards, model visibility, and credit summary.
- Worker tests for successful generation and provider failure.
- Frontend tests for protected routes and dynamic parameter rendering.

## Non-Goals For The First Version

- Multi-tenant SaaS.
- Multiple relay providers at the same time.
- Full arbitrary API workflow builder.
- Complex moderation workflows for assets.
- Real-time multi-user canvas cursors.
- Public self-registration.
- Accumulating unused daily credits across days.

## Final Design Decision

Build a DDD modular monolith with a React canvas user app and a separate admin console. The backend is the source of truth for identity, model access, dynamic parameters, pricing, credits, generation jobs, assets, and analytics. The frontend focuses on creation workflows and never stores or exposes provider secrets, pricing rules, or sensitive model configuration.
