# Frontend Acceptance And Interaction Pass Design

Date: 2026-05-28

## Purpose

This document defines a narrow, execution-oriented frontend pass for the current `ccy-canvas` MVP.

The goal of this pass is not to expand product scope. It is to:

- run the real user-facing flow end to end,
- validate whether the current frontend is usable enough for continued iteration,
- fix the most important blocking issues immediately, and
- improve a first batch of high-value interaction details without destabilizing the app.

This pass is intentionally constrained so that acceptance, repair, and interaction refinement can happen in the same cycle.

## Current Context

The repository already contains:

- a React 19 + Vite frontend under `src/app`,
- real authentication plumbing with protected routes,
- a workspace route at `/app`,
- an admin-protected route at `/admin`,
- an existing canvas surface with node creation, connection flows, toolbar panels, modals, and task queue concepts.

Known context from the current code and progress documents:

- `/admin` is still a placeholder surface rather than a full admin console.
- the frontend still contains some MVP-era capability boundaries and interaction patterns.
- Chinese UI copy includes encoding corruption in some surfaces and must be corrected during this pass.
- this pass should preserve the existing architecture and improve the current implementation rather than redesigning the product.

## In Scope

This pass covers one realistic user journey:

`/login -> /register -> authenticated redirect -> /app workspace -> /admin permission path`

The validated scope includes:

- login and registration usability,
- session-aware redirects,
- route protection and role-based entry behavior,
- workspace first-load experience,
- essential canvas interactions that are already present,
- navigation/account menu behavior,
- admin-route access behavior for the purpose of smoke validation only.

## Out Of Scope

This pass does not include:

- building the full `/admin` application,
- implementing model catalog, pricing, generation, or asset-library backend systems,
- large-scale visual redesign,
- major information architecture changes,
- speculative refactors unrelated to this acceptance slice.

## Acceptance Strategy

The implementation and validation loop should follow a smoke-driven approach.

### Primary Smoke Flow

The pass should validate the following sequence in order:

1. open `/login` and verify form readiness, copy quality, and submit behavior,
2. open `/register` and verify invite-based account creation behavior,
3. verify post-auth redirect behavior for authenticated users,
4. enter `/app` and validate first-screen usability plus essential interactions,
5. verify `/admin` protection behavior and the admin redirect path.

### Issue Triage

All findings should be classified into two groups.

#### Blocking Issues

A finding is blocking if it:

- breaks the main route flow,
- causes incorrect permission or redirect behavior,
- makes a core form or action fail or become unclear,
- leaves a key interaction without a clear completion state,
- visibly degrades acceptance quality, such as corrupted copy in primary surfaces.

Blocking issues should be fixed during this pass if the fix is frontend-local and reasonably bounded.

#### First-Batch Experience Issues

These are issues that do not fully block use, but create friction in obvious, repeated workflows.

Only the highest-value items should be fixed in this pass.

## First Batch Of Interaction Improvements

This pass should prioritize the following improvements after blocking issues are identified:

1. Clean up corrupted or inconsistent user-facing copy in authentication and workspace surfaces.
2. Tighten auth-flow interaction details, including submit state behavior, error-state consistency, and clearer redirect outcomes.
3. Improve the canvas node-creation loop, especially right-click creation, connection-to-create flow, menu dismissal, and creation feedback.
4. Clarify navbar/account-menu behavior and make the admin/user capability boundary more understandable.

These improvements should reuse existing components where possible and avoid introducing parallel patterns.

## Execution Rules

Work should proceed in small, verifiable increments.

- Prefer editing existing components rather than introducing new abstractions unless the existing structure clearly blocks the change.
- Re-test the affected flow after each focused batch of edits.
- Separate findings into `fixed now` and `follow-up later`.
- Keep `/admin` work limited to route/access validation and minor clarity improvements consistent with its placeholder status.

## Expected Deliverables

This pass should produce:

- a concise acceptance findings list,
- a first batch of landed frontend fixes,
- a short summary of what remains for the next iteration.

## Success Criteria

This pass is successful when:

- the auth-to-workspace smoke flow can be exercised without major confusion or breakage,
- role-based routing behaves correctly for user and admin paths,
- the most visible copy-quality problems are removed,
- the existing canvas creation interactions feel more reliable and self-explanatory,
- the remaining issues are narrowed to follow-up work rather than immediate blockers.
