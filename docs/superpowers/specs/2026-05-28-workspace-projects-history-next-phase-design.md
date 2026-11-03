# Workspace Projects And History Next-Phase Design

Date: 2026-05-28

## Purpose

This document captures the next-phase workspace requirements confirmed during live frontend review.

The goal of this phase is to make the `/app` workspace feel more usable as a daily creation surface by improving two high-frequency flows:

- canvas project creation and switching,
- browsing generated history in a masonry-style gallery.

## Confirmed Scope

The user explicitly wants the next phase to include:

- creating new canvas projects from the workspace toolbar,
- switching between canvas projects from the same workspace surface,
- displaying generated history in a masonry layout rather than a plain empty-state or flat list.

These items should be treated as committed next-phase requirements rather than optional polish ideas.

## Product Intent

The current workspace already exposes lightweight entry points for `Projects` and `Files / History`.

The next phase should turn those entry points into more credible product features:

- `Projects` becomes a real project switcher and creation surface,
- `History` becomes a visual browsing surface for generated outputs,
- both features should support repeated use without forcing the user to leave the canvas context.

## Feature 1: Canvas Project Creation And Switching

### Required Behavior

The workspace must support:

- creating a new canvas project,
- showing the current active project clearly,
- switching between existing projects,
- preserving per-project canvas context instead of treating project names as cosmetic only.

### UI Direction

The existing left-toolbar `Projects` panel is the correct entry point for this feature.

The next phase should keep the same interaction pattern:

- open the project panel from the left rail,
- show a compact project list,
- show the active project state,
- provide a clear `New Project` action inside the same panel.

### UX Expectations

Project switching should feel lightweight and fast.

At minimum:

- the active project should be visually obvious,
- creating a project should not feel like leaving the canvas,
- switching projects should update the visible canvas state in a predictable way,
- empty or default project naming should be improved so the experience does not feel temporary.

### Data Expectations

The next phase should define clearer project boundaries for:

- project name,
- created time,
- active state,
- project-specific nodes and edges,
- later compatibility with project-scoped history and assets.

True backend persistence can remain a later step, but the frontend state model should stop implying that all projects share one loose canvas state.

## Feature 2: Generated History In Masonry Layout

### Required Behavior

The `Files / History` area should display generated results in a masonry-style visual feed.

This applies especially to image-first and media-heavy outputs, where visual scanning is more important than strict row alignment.

### UI Direction

The current `Files` panel already hints at a gallery-like direction.

The next phase should formalize that:

- `History` should render generated assets as masonry cards,
- cards should support mixed heights based on image ratio or content length,
- the layout should feel like a browseable media wall rather than a utility list.

### Card Content

Each history card should be able to show:

- thumbnail or preview media,
- title or prompt excerpt,
- generation type,
- timestamp,
- optional quick action hooks for later expansion.

Text-only outputs can still appear in the same feed, but they should use a card treatment that fits naturally beside images and media.

### Filtering Expectations

The existing quick filters for image, video, audio, and search are worth keeping.

In the next phase, they should work cleanly with the masonry feed so the user can:

- scan all history,
- narrow to one media type,
- keep the same visual browsing pattern after filtering.

## Interaction Principles

These two features should follow the existing workspace philosophy:

- stay inside the canvas context,
- avoid route changes for lightweight management actions,
- keep interactions fast and panel-based,
- favor visual clarity over enterprise-heavy controls.

## Out Of Scope For This Phase

This next phase does not need to include:

- full backend project persistence,
- cross-user collaboration on projects,
- advanced history search indexing,
- asset-library taxonomy redesign,
- final production analytics for project usage.

Those can follow after the workspace interaction layer is stabilized.

## Success Criteria

This phase is successful when:

- users can create and switch canvas projects naturally from the left toolbar,
- project context feels meaningfully separated in the workspace,
- generated history becomes visually useful through a masonry layout,
- the workspace feels closer to a real creation tool rather than a single-session prototype.
