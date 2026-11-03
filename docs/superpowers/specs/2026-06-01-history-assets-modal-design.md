# History Assets Modal Design

## Goal

Replace the current left-side floating history browser with a dedicated full-screen history assets modal that matches the confirmed interaction:

- normal mode: browse grouped history assets
- bulk mode: select records and run batch actions
- controls: zoom percentage, time-desc ordering, media tabs

## Current State

History browsing currently lives inside the `files` panel in [src/app/components/Toolbar.tsx](/D:/code/ccy-canvas/src/app/components/Toolbar.tsx). It renders as a narrow floating panel with inline masonry cards and lightweight media filters. This does not match the desired large modal interaction shown in the reference screenshots.

The shared modal host in [src/app/components/Modals.tsx](/D:/code/ccy-canvas/src/app/components/Modals.tsx) already handles overlay, close behavior, and dashboard/profile modals, but it has no dedicated history assets experience yet.

History data is already available in the store via [src/app/store.ts](/D:/code/ccy-canvas/src/app/store.ts) as `HistoryItem[]`, including:

- `mediaType`
- `timestamp`
- `thumbnail`
- `content`
- `promptExcerpt`
- `title`

## User Experience

### Entry

- The left toolbar keeps its `files` entry point.
- Clicking into history opens a centered large modal instead of showing the current narrow floating history browser.
- The old floating history content is removed from the toolbar panel to avoid duplicate history UIs.

### Normal Mode

When the modal opens, it starts in normal browse mode:

- title: `历史资产`
- top tabs: image history, video history, audio history with counts
- top-right controls:
  - zoom percentage stepper
  - close button
- secondary controls row:
  - `时间降序`
  - `批量操作`
- content:
  - history records grouped by calendar day
  - each group has a date label
  - assets render as cards or tiles sized according to zoom percentage

### Bulk Mode

Clicking `批量操作` switches the modal into selection mode:

- right-side controls become:
  - `已选 N 项`
  - `删除`
  - `下载`
  - `使用`
  - `取消选择`
- each date group shows a selectable checkbox
- each asset card shows a selectable checkbox
- users can select individual assets or whole date groups

### Batch Actions

This round supports front-end executable behavior only:

- `删除`
  - removes the selected items from the current space history list
  - does not delete provider files from remote storage
- `下载`
  - triggers browser download/open for selected asset URLs
  - skips text-only records without a downloadable URL
- `使用`
  - inserts selected history assets back onto the canvas
  - image history creates `referenceImageNode`
  - video history creates `referenceVideoNode`
  - audio history is not inserted in this round

If no compatible items are selected for an action, the button is disabled.

## Visual Direction

The modal should follow the screenshot direction rather than the existing compact panel:

- wide centered dark surface
- soft border and backdrop blur
- large empty breathing space
- small top tabs, understated controls
- grid density controlled by zoom rather than fixed masonry width

The result should feel like a dedicated asset management layer, not a stretched version of the current side panel.

## Behavior Details

### Tabs

- `图片历史`
  - shows only `mediaType === "image"`
- `视频历史`
  - shows only `mediaType === "video"`
- `音频历史`
  - shows only `mediaType === "audio"`

Tab labels include counts based on current filtered history.

### Ordering

- Initial order is always timestamp descending.
- Group order is newest day first.
- Inside each group, items are newest first.
- This round only exposes `时间降序` as a visible stateful control; it does not need an ascending toggle yet.

### Zoom

Zoom controls affect tile size only, not modal scale.

Suggested supported percentages:

- `75%`
- `100%`
- `125%`

Implementation can map these values to card widths, grid columns, and preview heights.

### Selection Model

- Selection state is local to the modal session.
- Closing the modal clears selection mode and selected IDs.
- Switching tabs keeps normal browsing, but bulk mode can remain active if desired.
- Group checkbox behavior:
  - checked when all items in the day group are selected
  - unchecked when none are selected
  - indeterminate styling is optional this round

## Architecture

### Store Additions

Add focused UI state for the history modal in [src/app/store.ts](/D:/code/ccy-canvas/src/app/store.ts):

- modal open/close state
- open/close actions
- optional history removal action

Keep selection, zoom, active tab, and bulk mode local to the modal component unless a cross-component need appears. This avoids bloating the global store with one-off view state.

### Component Structure

Add a dedicated modal component under the modal layer rather than expanding `Toolbar.tsx` further.

Recommended split:

- `HistoryAssetsModal`
  - owns modal-local UI state
  - reads history and actions from store
- lightweight helpers inside the same file or a nearby utility:
  - grouping by date
  - filtering by media type
  - zoom-to-layout mapping

`Toolbar.tsx` should only be responsible for opening the modal, not rendering the full history browser.

### Canvas Reinsertion

The `使用` action needs a way to place selected assets back on canvas.

This round can reuse the existing `addNode` flow:

- create staggered positions
- use thumbnail/content URL as node `data.url`
- map history media type to reference node type

This does not need a new backend call.

## Error Handling

- Empty tab state shows a calm empty-state message
- Unsupported batch operations are disabled instead of failing late
- Download failures should fail item-by-item without breaking the entire modal
- `使用` skips unsupported media types cleanly

## Testing

Add coverage for:

- history removal from the active space
- history counts and filtering logic
- batch selection behavior
- `使用` action mapping image/video history items to reference nodes

Prefer extracting pure helpers where practical so logic can be tested without rendering-heavy UI tests.

## Out of Scope

This round does not include:

- backend persistence for history deletion
- provider-side file deletion
- pagination or infinite scroll
- text history insertion back to canvas
- audio history insertion back to canvas
- drag-select inside the modal
- advanced sorting beyond time-desc default

## Success Criteria

The feature is complete when:

- the old floating history browser is no longer the primary history experience
- users open a full-screen history assets modal from the left toolbar flow
- normal mode matches the screenshot structure
- clicking `批量操作` switches into selectable bulk mode
- selected history records can be batch deleted from local history, batch downloaded, and batch used on canvas where supported
