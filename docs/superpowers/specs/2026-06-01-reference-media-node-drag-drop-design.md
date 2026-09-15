# Reference Media Node Drag And Drop Design

- Date: 2026-06-01
- Scope: Change canvas drag-and-drop behavior so uploaded images and videos become reference media nodes instead of generation result nodes.

## Goal

When a user drags local image or video files onto the canvas:

1. The files should still upload to the backend and receive stable URLs.
2. The created canvas nodes should represent reference assets, not generated outputs.
3. Downstream image/video generation nodes should be able to treat these nodes as reusable references.

## Problem

Current drag-and-drop creates:

- `imageNode` for uploaded images
- `videoNode` for uploaded videos

Those node types currently mean generated output in the workspace. This mixes two different concepts:

- generated media
- user-provided reference media

That makes the UI semantics blurry and creates confusion for future reference workflows.

## Approved Direction

Use dedicated reference node types instead of overloading existing generation nodes with a flag.

## Node Model

Add two new node types:

- `referenceImageNode`
- `referenceVideoNode`

These nodes:

- display uploaded media
- do not show the prompt panel
- do not imply that generation has already happened
- can be connected into generation flows as upstream reference sources

Existing node meanings remain unchanged:

- `imageNode` = generated image result
- `videoNode` = generated video result

## Drag-And-Drop Behavior

When dropping files on the canvas:

1. Upload the file through the existing backend upload endpoint.
2. Create a reference node based on MIME type:
   - image -> `referenceImageNode`
   - video -> `referenceVideoNode`
3. Store the uploaded URL on the node.
4. Render the node as a stable asset preview card.

## UX Rules

- Reference nodes should visually read as source assets, not outputs.
- They should keep existing canvas affordances such as positioning and connecting.
- They should not open the generation prompt bar when selected.
- Double-click preview behavior can stay similar to generated media nodes when useful.

## Downstream Flow Contract

This round focuses on node semantics and drag-and-drop creation.

It does not require fully wiring reference extraction into generation requests yet, but the structure should support that next step by:

- preserving media URL on the reference node
- allowing generation nodes to detect upstream reference nodes

## Implementation Boundaries

### In scope

- Add the two reference node components
- Register them in `nodeTypes`
- Change drag-and-drop node creation in the canvas
- Keep upload behavior unchanged

### Out of scope

- Full reference-image and reference-video request mapping
- New prompt-bar controls for choosing reference modes
- Automatic conversion of existing generated nodes into reference nodes

## Files Expected To Change

- `src/app/components/Canvas.tsx`
- `src/app/components/nodes/CustomNodes.tsx`
- possibly `src/app/store.ts` only if shared helpers are needed

## Verification

- Dragging an image creates a `referenceImageNode`
- Dragging a video creates a `referenceVideoNode`
- Generated image/video nodes continue to behave as output nodes
- Build passes
