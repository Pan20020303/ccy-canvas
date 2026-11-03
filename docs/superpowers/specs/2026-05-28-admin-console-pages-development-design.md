# Admin Console Pages Development Design

Date: 2026-05-28

## Purpose

This document expands the admin development scope from a single `Model Config` page to the broader admin console surface.

The goal is to ensure the currently visible admin navigation is not treated as decorative scaffolding. Every visible admin section should now be considered part of the active development roadmap.

## Confirmed Direction

The user explicitly requested two things:

- the admin UI should be presented in Chinese,
- the related admin pages should all enter the development spec.

This means the admin console should no longer be documented as a one-page exception around `Model Config` only.

## Admin Surface In Scope

The following admin sections are now in development scope:

- `Overview` with Chinese UI label `概览`
- `Members` with Chinese UI label `成员`
- `Invitations` with Chinese UI label `邀请码`
- `Model Config` with Chinese UI label `模型配置`
- `Logs` with Chinese UI label `日志`

These are the exact top-level sections currently exposed in the admin navigation and should be treated as first-class product areas.

## Language Direction

The admin console should use Chinese as the primary visible language for:

- left navigation,
- page titles,
- page descriptions,
- table headers,
- form labels,
- button labels,
- placeholder state messaging.

English can remain in internal variable names, component names, and low-level technical structures, but the user-facing admin product should read as a Chinese interface.

## Product Intent By Page

### 1. Overview

Chinese UI label: `概览`

This page should become the top-level admin dashboard.

Its eventual role is to summarize:

- system usage,
- active members,
- invitation status,
- model routing health,
- recent admin activity.

For now, it can remain lightweight, but it is no longer out of scope.

### 2. Members

Chinese UI label: `成员`

This page should manage team members and their basic admin-facing state.

Expected long-term responsibilities:

- member list,
- role visibility,
- active or disabled state,
- quota-related summary hooks,
- entry point for later member operations.

### 3. Invitations

Chinese UI label: `邀请码`

This page should own invitation creation and invitation review workflows.

Expected responsibilities:

- creating invitation codes,
- displaying invitation status,
- usage counts,
- expiration status,
- revocation entry points.

This page is especially important because the auth flow already depends on invite-based registration.

### 4. Model Config

Chinese UI label: `模型配置`

This remains the most actively implemented admin module in the current phase.

Its approved structure stays the same:

- standalone menu entry,
- list and table management,
- right-side drawer for create and edit,
- orange brand accents,
- workspace consumption of the shared config state.

### 5. Logs

Chinese UI label: `日志`

This page should become the admin-facing visibility surface for system activity.

Expected future directions:

- configuration changes,
- generation-related events,
- admin actions,
- troubleshooting-oriented records.

It does not need to be fully built immediately, but it now belongs to the planned admin surface.

## Development Priority

The priority order should be:

1. `Model Config`
2. `Invitations`
3. `Members`
4. `Overview`
5. `Logs`

Reasoning:

- `Model Config` is already connected to workspace behavior.
- `Invitations` is directly tied to the current auth model.
- `Members` and `Overview` become more useful once auth and admin flows deepen.
- `Logs` depends on more real backend activity to feel meaningful.

## UX Principles

All admin pages should share a coherent shell:

- persistent left navigation,
- dark visual language with orange brand accents,
- Chinese product copy,
- card or table-based content areas,
- clear separation from the user-facing `/app` workspace.

The admin console should feel like a real operational surface rather than a temporary collection of placeholders.

## Near-Term Scope Boundary

Adding these pages to the development spec does not mean they must all be fully implemented in the current coding pass.

It means:

- they are officially part of the admin roadmap,
- their responsibilities are now defined,
- future implementation plans should treat them as real modules instead of background ideas.

## Success Criteria

This expanded admin spec is successful when:

- the admin UI reads coherently in Chinese,
- all visible admin navigation items are recognized as planned product modules,
- future implementation work can proceed page by page without re-deciding whether those pages belong in scope.
