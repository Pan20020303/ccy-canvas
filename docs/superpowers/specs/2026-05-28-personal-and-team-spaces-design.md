# Personal And Team Spaces Design

Date: 2026-05-28

## Purpose

This document captures a newly confirmed product direction for the `/app` workspace and `/admin` console.

The current frontend is no longer enough if it only models a single user-local canvas surface.

The workspace must now support two distinct scope types:

- personal space, where each user's canvas projects, history, and assets are independent,
- team space, where members can switch into a shared workspace context and access shared resources based on permissions.

This requirement also makes team-space permissions an explicit admin responsibility rather than a vague future idea.

## Confirmed Direction

The user explicitly confirmed the following behavior:

- when a user logs in, their default canvas and resources should be independent from other users,
- the user should be able to switch team spaces,
- after switching into a team space, the user should see shared resources in that space,
- team-space permissions should be controlled by administrators from the admin console.

These are now product requirements, not optional collaboration polish.

## Product Model

The workspace now needs a hierarchy above project level:

1. `Space`
2. `Project`
3. `Canvas / Assets / History`

This means project switching alone is no longer the full context model.

Every project, history item, and reusable asset should belong to a specific space:

- `personal space`
- `team space`

The active user session should always know:

- current user,
- active space,
- active project inside that space,
- whether the space is personal or team-scoped,
- the user's permission level inside the active team space.

## Workspace Behavior

### 1. Personal Space

Personal space is the default entry context after login for regular members.

Expected behavior:

- users enter their own independent workspace first,
- their personal projects are not mixed with team projects,
- their personal generation history is separate from team history,
- their personal assets remain private unless later promoted into a shared team resource flow.

This should feel like "my private canvas home".

### 2. Team Space Switching

The workspace should provide a lightweight space switcher above or alongside the existing project panel.

Expected behavior:

- users can see their personal space and any team spaces they belong to,
- switching spaces should feel similar to switching projects: fast, in-context, and without route changes,
- after switching to a team space, the project list, history list, and resource panels should all update to the shared space context,
- the active space should always be visually obvious.

The space switcher is a higher-level context control than the current project switcher.

### 3. Shared Team Resources

Inside a team space, the user should be able to see shared team-scoped resources.

At minimum this direction applies to:

- team projects,
- team history,
- team asset library.

The team-space experience should not imply that all data is globally shared across all teams.

Resources should be shared within the selected team space only.

## Permission Model

### Admin-Owned Controls

Team-space permissions are explicitly an admin concern.

The admin console should eventually control:

- creating team spaces,
- renaming or disabling team spaces,
- assigning members to team spaces,
- defining permission levels inside a team space,
- removing members from a team space,
- determining which users can view, edit, or manage shared resources.

### Member Experience

Members should not manage team-space permissions from the normal `/app` workspace.

Members can:

- switch into team spaces they have been granted access to,
- use shared team resources according to their permission level.

Members should not:

- see team spaces they do not belong to,
- escalate their own permissions,
- manage other members from the workspace UI.

## Admin Console Scope Expansion

This requirement expands the meaning of several existing admin pages.

### Members

The `Members` page should now evolve beyond a flat member list.

It should eventually support:

- member list,
- global role visibility,
- space membership visibility,
- assignment into team spaces,
- removal or disablement flows.

### Invitations

The `Invitations` page remains relevant because invited users become potential team-space members after registration.

Future invitation handling may need to support:

- default team assignment,
- invitation metadata tied to a team space,
- invite usage tracking by space or team.

### Overview

The `Overview` page should later summarize:

- number of team spaces,
- active members per team,
- shared resource activity,
- permission-sensitive operational signals.

### Logs

The `Logs` page should later include events such as:

- space creation,
- space membership changes,
- permission changes,
- resource sharing actions.

## Data Expectations

The frontend state model should move toward space-aware ownership.

At minimum, these entities should become space-scoped:

- projects,
- history items,
- assets,
- resource folders or libraries.

Suggested ownership fields:

- `spaceId`
- `spaceType` as `personal` or `team`

This does not require full backend persistence in the immediate next pass, but it does require the frontend architecture to stop assuming one flat workspace context.

## UX Principles

This feature should preserve the product's current interaction philosophy:

- stay inside the canvas context,
- use lightweight switchers instead of route-heavy navigation,
- make scope boundaries visually clear,
- keep personal and team contexts understandable at a glance,
- avoid enterprise complexity in the first visible version.

The user should always be able to answer:

- which space am I in,
- is this private or shared,
- who controls access here.

## Near-Term Scope Recommendation

This direction is larger than the current "projects plus history" pass, so the next implementation phase should treat it as a new workspace architecture step rather than a small add-on.

Recommended implementation order:

1. Add a visible space model in frontend state.
2. Add personal space as the default authenticated context.
3. Add team-space switching UI in `/app`.
4. Make projects and history space-aware.
5. Extend admin specs for team-space membership and permission management.

## Success Criteria

This design is successful when:

- each user clearly has an independent personal workspace,
- users can switch into team spaces without confusion,
- shared resources appear only within the selected team context,
- admin ownership of team-space permissions is explicit in the product model,
- future implementation work can proceed without re-deciding whether collaboration belongs in `/app` or `/admin`.
