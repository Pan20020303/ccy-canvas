# Workspace Control Bar And Task Queue Design

Date: 2026-05-28

## Purpose

This document captures the next interaction pass for the `/app` workspace surface.

The current workspace still exposes two interaction patterns that now feel misaligned with the intended product direction:

- the task queue sits in the lower-right corner as a large floating panel,
- the left-lower canvas controls still rely on the default React Flow control cluster.

The goal of this pass is to replace both with a more intentional custom control layer.

## Confirmed Direction

The user explicitly requested two changes:

1. move the task queue to the top-right area beside the language switcher,
2. remove the current bottom-left plus/minus control group and replace it with a custom three-button control bar.

The user also clarified an important product rule:

- task queues and generation operations are user-private,
- generated images and generation tasks shown in the queue should be visible only to the current user,
- team spaces may expose shared resources and shared project context later, but the real-time task queue itself should remain personal.

These are now committed interaction requirements.

## Product Intent

This pass should make the workspace feel less like a canvas demo with framework-default controls and more like a deliberate creation tool.

Two interaction zones are being redefined:

- the top-right becomes the lightweight personal activity zone,
- the bottom-left becomes the custom canvas navigation and control zone.

The result should feel closer to a real product cockpit while preserving the current dark, minimal visual language.

## Feature 1: Top-Right Personal Task Queue

### Required Behavior

The task queue must move out of the bottom-right floating card position.

It should instead:

- sit in the top-right region beside the language switcher and avatar entry,
- default to a compact collapsed state,
- expand downward into a lightweight panel when clicked,
- display only the current user's tasks.

### Privacy Rule

The queue is explicitly personal.

This means:

- users see only their own generation tasks,
- switching into a team space does not turn the queue into a shared activity feed,
- team-shared assets and history can remain separate concepts from the personal task queue.

The queue should behave as "my active work" rather than "space activity".

### Visual Direction

The queue trigger should feel like a compact utility pill rather than a large panel.

Expected content in collapsed state:

- queue label,
- active-task count or status marker.

Expected content in expanded state:

- current user's task rows,
- generating, completed, and failed states,
- minimal visual feedback without taking over the screen.

## Feature 2: Custom Bottom-Left Canvas Control Bar

### Required Behavior

The default React Flow `Controls` cluster should be removed.

It must be replaced with a custom horizontal floating control bar in the bottom-left region.

This control bar should expose exactly three primary actions:

1. mini-map toggle,
2. grid-snap toggle,
3. fit-to-canvas action.

### Button 1: Mini-Map Toggle

This button controls whether the mini-map is visible.

Expected behavior:

- when off, the mini-map is hidden,
- when on, the mini-map appears above the control bar,
- toggling should be immediate,
- hidden state should not reserve empty layout space.

### Button 2: Grid Snap Toggle

This button controls node snapping behavior.

Expected behavior:

- when on, dragged nodes align to a fixed grid,
- when off, nodes move freely,
- this phase only needs node-position snapping,
- this phase does not need advanced snapping such as edge anchoring, group-boundary snapping, or magnetic alignment between arbitrary objects.

The interaction should be predictable and visually stable.

### Button 3: Fit To Canvas

This button performs a one-shot fit-to-view action.

Expected behavior:

- clicking it immediately fits the current canvas content into view,
- it is not a persistent toggle,
- it does not require a confirmation step.

This is the replacement for the old bottom-left fit-view control.

## Visual Structure

### Top-Right Zone

The top-right utility order should become:

- language switcher,
- task queue trigger,
- avatar or profile menu.

This keeps personal context and personal activity clustered together.

### Bottom-Left Zone

The bottom-left region should become a compact floating system:

- mini-map displayed above when enabled,
- custom three-button control bar below it.

The visual feel should be:

- dark,
- rounded,
- lightweight,
- clearly product-designed rather than framework-default.

The custom control bar does not need to replicate every aspect of the reference images, but it should follow the same structural idea.

## Data And State Expectations

This pass introduces a small set of explicit UI-control state:

- `showMiniMap`
- `snapToGrid`
- task-queue expand or collapse state

Task data itself should remain filtered to the current user.

This does not require full backend user-task partitioning in this pass if the frontend is still using local seeded task state, but the architecture should clearly encode the rule that the queue is personal.

## Interaction Principles

This pass should follow these product principles:

- keep the queue lightweight and personal,
- remove framework-default controls when they reduce visual quality,
- favor intentional placement over generic floating panels,
- make canvas controls discoverable without dominating the workspace,
- keep the surface consistent with the existing dark product language.

## Out Of Scope For This Pass

This pass does not need to include:

- a team-shared task feed,
- admin visibility into all members' real-time tasks,
- a full zoom slider and percentage control system,
- advanced snapping rules beyond node-position snapping,
- a full top-nav redesign,
- collaborative presence indicators.

Those can follow in later phases if needed.

## Success Criteria

This pass is successful when:

- the task queue sits in the top-right as a compact personal activity entry,
- only the current user's tasks appear in the queue,
- the bottom-left React Flow default controls are gone,
- the new three-button control bar works for mini-map toggle, grid snapping, and fit-to-canvas,
- the workspace feels more intentional and closer to the visual direction shown in the reference images.
