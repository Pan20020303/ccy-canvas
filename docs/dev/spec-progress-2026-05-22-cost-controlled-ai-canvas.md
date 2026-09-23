# Cost-Controlled AI Canvas Spec Progress

Source spec:
- [2026-05-22-cost-controlled-ai-canvas-design.md](/abs/path/D:/code/ccy-canvas/docs/superpowers/specs/2026-05-22-cost-controlled-ai-canvas-design.md)

This document tracks current implementation status against the full product spec.

## Summary

The codebase currently covers the foundation authentication slice and a small subset of user-app behavior.

In practical terms:

- Core backend and frontend auth plumbing exists.
- Initial credit-account creation exists.
- Docker-based local PostgreSQL setup exists.
- The broader model catalog, pricing, generation, asset, admin analytics, and audit systems are still not implemented as spec-defined subsystems.

## Status Legend

- `Done`: implemented and wired into the current app
- `Partial`: some code exists, but it does not yet meet the full spec
- `Not started`: no meaningful implementation for the spec requirement yet

## Progress By Spec Area

### Backend Foundation

Status: `Partial`

Done:

- Go backend module and app entrypoint
- Configuration loading
- Database connection and sqlc-generated query layer
- Request ID middleware and JSON error envelope
- Basic CORS handling for local frontend development
- Docker Compose local PostgreSQL setup

Partial:

- Logging exists via `chi` middleware, but not a broader observability story
- Error format exists, but OpenAPI 3.1 generation is not implemented

Not started:

- River job infrastructure
- OpenAPI documentation generation

### Identity & Access

Status: `Done` for the foundation slice, `Partial` for the full spec

Done:

- Email/password login
- Invitation-based registration
- Admin-only invitation creation API
- Session cookie authentication
- Role-aware protected routes on the frontend
- Current-user endpoint

Partial:

- Admin UI exists only as a minimal placeholder route

Not started:

- Email verification flow
- Broader team/member management flows from the full spec

### Credit & Quota

Status: `Partial`

Done:

- Credit account schema
- Credit ledger schema
- Initial credit account creation on successful invitation registration
- Current-user credit summary response path exists at the backend service level

Partial:

- Only initial account creation is implemented in application logic
- Ledger writing exists for initial account bootstrap only

Not started:

- Daily quota reset jobs
- Reservation
- Charge
- Refund
- Admin adjustment
- Full user-facing credit summary UX

### Model Catalog

Status: `Not started`

Not implemented yet:

- Provider configuration subsystem
- Model list and sync
- Model enable/disable
- Parameter schema editor
- Pricing rule editor
- Permission rules

Note:

- The current frontend store still contains MVP-style local model config data. That is not the spec-defined model catalog/admin system.

### Generation

Status: `Not started`

Not implemented yet:

- Generation jobs domain
- Provider invocation pipeline
- Reservations before execution
- Settlement after execution
- Cancellation handling
- Provider response persistence
- Asset creation from succeeded jobs
- Background queue processing

Note:

- The current canvas can trigger direct browser-side fetches to model endpoints in the MVP UI. That is not the spec-defined backend generation architecture.

### Dynamic Model Parameters

Status: `Not started`

Not implemented yet:

- Backend `parameter_schema` response per model
- Schema-driven frontend parameter rendering
- Backend authoritative schema validation

### Pricing and Credits

Status: `Not started`

Not implemented yet:

- `estimate -> reserve -> invoke provider -> settle or release` flow
- Pricing estimate endpoint
- Reservation transaction
- Final settlement logic
- Undercharge handling
- Failure release handling
- Cancellation settlement behavior

### Generation Job UX

Status: `Partial`

Partial:

- Existing MVP canvas includes task state and run timer concepts
- Some local loading/progress behavior exists in the frontend

Not started as spec-defined:

- Backend-driven generation job states
- True persisted job lifecycle
- Provider progress integration
- Perceived-progress fallback rules
- Backend-based elapsed timer sourced from `started_at`

### User App Design

Status: `Partial`

Done:

- `/login`, `/register`, `/app`, `/admin` routes exist
- Login page redesigned
- Registration page exists
- Protected route boundary exists

Partial:

- Top bar and user menu exist, but do not yet fully match the spec
- Left toolbar exists in MVP form
- Canvas layout exists in MVP form
- Task queue UI exists, but not as a spec-complete top-bar dropdown workflow

Not started:

- Proper project switching and project-scoped refresh behavior
- Collaboration roles and project invitations
- Full asset library behavior
- Full file manager behavior
- Final custom canvas control bar per spec

### Admin App Design

Status: `Partial`

Done:

- `/admin` route exists and is permission-protected

Partial:

- Minimal admin placeholder screen only

Not started:

- Dashboard
- Members
- Invitations management UI
- Models UI
- Generation logs UI
- Asset review UI
- Credit ledger UI
- Audit logs UI

### Asset Library & Canvas Data Model

Status: `Not started`

Not implemented yet:

- Reusable asset pool model
- Source-project/source-node tracking
- Visibility management
- Canvas save-to-library flow
- Asset categorization flow

### Admin Analytics & Audit

Status: `Not started`

Not implemented yet:

- Admin analytics data model and UI
- Audit logs backend behavior
- Audit log protections

### Frontend Capability Boundaries

Status: `Partial`

Done:

- Real auth state replaces demo login boundary

Partial:

- Some MVP admin/model configuration behavior still exists in the user app UI

Not started:

- Full removal/hiding of all admin-only capability from the user-facing app

### Testing

Status: `Partial`

Done:

- Some backend unit tests
- Backend `go test ./...` passing
- Frontend build passing

Not started:

- End-to-end auth verification against the full spec
- Generation, pricing, admin, and audit test coverage

## What Is Actually Production-Meaningful Today

If we describe only what the current code meaningfully supports, it is this:

- Invitation-based auth backend
- Session-based frontend auth
- Protected user/admin routing
- Initial credit account bootstrap
- Local PostgreSQL setup for development

Everything else in the full spec should be treated as planned but not yet delivered.

## Suggested Next Priority Order

If we continue from here, the most sensible order is:

1. Finish the foundation slice cleanly
   - update the foundation plan progress
   - clean commits
   - run verification end to end

2. Implement `Model Catalog`
   - provider config
   - model records
   - parameter schema
   - admin model management

3. Implement `Pricing and Credits`
   - estimate
   - reserve
   - ledger transitions
   - settle/release

4. Implement `Generation`
   - job records
   - provider invocation
   - queue/worker path
   - result persistence

5. Implement `User App` product behaviors
   - projects
   - asset library
   - file manager
   - spec-complete job UX

6. Implement `Admin App`
   - models
   - members
   - logs
   - analytics
   - audit views

