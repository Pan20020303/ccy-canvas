# Admin Model Configuration Design

Date: 2026-05-28

## Purpose

This document defines the first real admin-side model configuration surface for `ccy-canvas`.

The goal is to replace the current `/admin` placeholder with a usable management entry for configuring model providers and routing behavior through a structured admin UI.

This slice is frontend-first. It establishes the page structure, visual direction, and configuration workflow even before the full backend model-catalog subsystem is implemented.

## Approved Direction

The user approved the following direction:

- `Model Config` is a standalone admin menu, not a child page under system settings.
- The admin visual tone should align with the orange brand logo rather than cyan.
- The configuration workflow uses a right-side drawer instead of a centered modal.
- The page supports both list management and add/edit configuration in one view.

## Product Role

This page is the first real management surface for model configuration.

In the near term, it should let an administrator:

- view existing model configurations,
- open a drawer to add a configuration,
- edit an existing configuration,
- understand which configuration is default,
- see priority and enabled state at a glance.

This page is explicitly separate from the user-facing `/app` workspace and should reinforce the admin-only capability boundary.

## Information Architecture

### Admin Navigation

The admin area should evolve from a single placeholder card into a lightweight admin shell with persistent left navigation.

Initial top-level items:

- `Overview`
- `Members`
- `Invitations`
- `Model Config`
- `Logs`

Only `Model Config` must be meaningfully implemented in this pass. The other items can remain lightweight placeholders.

### Model Config Page

The `Model Config` page has two primary regions:

1. a central list/table area for existing configurations,
2. a right-side drawer for add/edit actions.

This layout is preferred over a full-screen form or centered modal because administrators need to compare existing records while editing.

## Visual Direction

### Theme

The page stays within the product's dark admin aesthetic, but shifts the accent system toward brand orange.

Recommended palette direction:

- background: near-black charcoal
- panel: deep graphite
- accent: vivid orange derived from the logo
- accent hover: slightly brighter orange
- muted text: warm gray
- borders: low-contrast gray with subtle orange focus states

### Accent Usage

Orange should be concentrated in meaningful interaction points rather than flooding the whole page.

Use orange for:

- active navigation state,
- primary actions such as `Add Config` and `Save Config`,
- focused input outlines,
- enabled/default indicators,
- selected controls inside the drawer.

Avoid turning large surfaces fully orange. The orange should feel like a branded signal inside a disciplined dark admin UI.

## Page Layout

### Header

The page header should include:

- page title: `Model Config`
- short supporting description explaining that admins manage vendors, endpoints, and default model routing here
- primary action button: `Add Config`

Search and filters can be added later, but are not required for the first pass.

### List Area

The central list should show existing configurations in a management-friendly table or card-table hybrid.

Recommended columns:

- `Service Type`
- `Vendor`
- `Name`
- `Base URL`
- `Default Model`
- `Priority`
- `Status`
- `Actions`

Visible row actions:

- `Edit`
- `Enable/Disable`
- `Delete`

For the first pass, these actions may be locally driven if the backend API is not ready, but the structure should assume real persistence later.

### Drawer

The right-side drawer is the primary editing surface.

It should:

- slide in from the right,
- keep the list visible in the background,
- support both create and edit mode,
- include a clear title such as `Add Config` or `Edit Config`,
- include footer actions for `Cancel` and `Save Config`.

## Drawer Form Structure

The form follows the enterprise-style structure the user referenced.

Recommended fields:

- `Service Type`
- `Vendor`
- `Protocol`
- `Name`
- `Base URL`
- `API Key`
- `Submit Endpoint`
- `Query Endpoint`
- `Model List`
- `Default Model`
- `Priority`
- `Set As Default`

### Field Intent

- `Service Type`: classify the configuration surface, such as text, image, video, or audio generation.
- `Vendor`: choose a preset vendor or custom vendor mode.
- `Protocol`: choose protocol style, especially useful for custom vendors.
- `Name`: admin-readable display name.
- `Base URL`: root API endpoint.
- `API Key`: secret credential input.
- `Submit Endpoint`: used when the provider requires a custom submit path.
- `Query Endpoint`: used when the provider requires a custom polling or task lookup path.
- `Model List`: comma-separated or multi-line list of models available under this configuration.
- `Default Model`: select one model from the configured list.
- `Priority`: determines ordering or routing precedence.
- `Set As Default`: marks this configuration as the default one for its service type.

## Interaction Model

### Open Flow

- Clicking `Add Config` opens the drawer in create mode.
- Clicking `Edit` on a row opens the drawer in edit mode with prefilled values.

### Close Flow

The drawer closes when:

- the user clicks `Cancel`,
- the user clicks the overlay,
- the user presses `Esc`,
- the save action succeeds.

If the form has unsaved changes, the implementation may later add a confirmation step, but that is not required for the first pass.

### Save Feedback

Saving should provide visible feedback through existing product patterns, such as button loading state and toast-style confirmation if already available in the codebase.

### Default Behavior

When `Set As Default` is enabled, the UI should make it visually obvious that this configuration will become the default for its service type.

If multiple defaults would conflict, the frontend should prepare the user for replacement behavior even if true enforcement is deferred to backend logic.

## First Implementation Scope

The first implementation pass should include:

- a real admin shell layout,
- standalone `Model Config` navigation entry,
- list view with seeded or local data,
- add/edit drawer UI,
- orange-aligned branding treatment,
- basic client-side interaction states.

The first pass does not need to include:

- full backend persistence for model catalog,
- vendor synchronization,
- dynamic schema fetching,
- full validation against provider-specific rules,
- production-grade secret management UX.

## Reuse Guidance

The implementation should prefer existing project patterns and components:

- keep using the current React, Tailwind, and shadcn-style UI foundation,
- reuse existing drawer, input, select, switch, and button primitives where possible,
- preserve the current app's dark visual language while shifting the accent tokens.

## Success Criteria

This design is successful when:

- `/admin` no longer feels like a dead-end placeholder,
- administrators can clearly discover `Model Config` as a primary area,
- the page communicates a credible management workflow through list plus drawer,
- the brand orange makes the admin surface feel product-aligned rather than generic,
- the structure is ready for later backend model-catalog integration without requiring a full UI rewrite.
