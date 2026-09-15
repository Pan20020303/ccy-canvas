# Canvas Context Menu And History Picker Design

## Goal

Add a two-level canvas context menu that matches the provided references, support local file upload from the menu, add placeholder disabled node entries for future capabilities, and provide a dedicated "select from generation history" image picker modal.

This round also fixes the current `HistoryAssetsModal` hook-order crash.

## Scope

### Included

- Fix `HistoryAssetsModal` so opening history assets no longer throws a React hook-order error
- Replace the current simple canvas picker with a reference-style menu flow:
  - top-level context menu
  - nested "add node" menu
- Add menu-driven local upload flow
- Add a dedicated image history picker modal for selecting generated images back onto the canvas
- Add placeholder disabled node entries for:
  - video compose
  - director desk
  - script

### Excluded

- Real director desk behavior
- Real script generation behavior
- Real video compose behavior
- Full third-party source tabs like LibTV / WebUI / ComfyUI with remote backends
- Persistent asset library storage beyond existing local history state

## User Experience

### Top-Level Canvas Context Menu

Right-clicking the empty canvas should open a dark context menu with:

- `上传`
- `保存到我的素材`
- `添加节点`
- divider
- `撤销`
- `重做`
- divider
- `粘贴`

Behavior for this round:

- `上传`
  - opens local file picker
  - image creates `referenceImageNode`
  - video creates `referenceVideoNode`
- `保存到我的素材`
  - disabled placeholder
- `添加节点`
  - opens the nested add-node panel
- `撤销 / 重做 / 粘贴`
  - disabled placeholders unless already supported by existing app state

### Add Node Menu

The nested add-node panel should visually match the provided reference structure:

- `文本`
- `图片`
- `视频`
- `视频合成` `Beta`
- `导演台` `NEW`
- `音频`
- `脚本` `Beta`
- divider / section label
- `上传`
- `从生成历史选择`

Behavior:

- `文本 / 图片 / 视频 / 音频`
  - create normal generation nodes
- `视频合成 / 导演台 / 脚本`
  - show as disabled grey placeholders
- `上传`
  - same local upload flow as top-level `上传`
- `从生成历史选择`
  - opens the dedicated image picker modal

### History Image Picker Modal

This is separate from the general history assets modal.

For this round it should visually echo the reference:

- title `选择图片`
- top source tabs shown as static structure:
  - `LibTV`
  - `Lib生成器`
  - `WebUI`
  - `ComfyUI`
  - `AI应用`
- media tabs:
  - `图片`
  - `视频`
  - `音频`
- right side selected count
- image grid
- footer pagination shell
- confirm button

Behavior this round:

- only the `图片` tab is interactive
- content comes from existing local history items where `mediaType === "image"`
- selecting images highlights them and updates selected count
- confirm inserts selected images as `referenceImageNode` near the menu invocation position
- other source tabs and non-image media tabs can be visual placeholders

## Architecture

### Canvas

Extend the existing context-menu state in `Canvas.tsx` from a single picker popup into a menu mode model:

- top-level context menu mode
- add-node submenu mode
- stored flow position for insertion

Add a hidden file input so menu-triggered upload can reuse the same upload pipeline already used by drag-and-drop.

### History Picker Modal

Create a dedicated modal component rather than overloading `HistoryAssetsModal`.

Recommended responsibilities:

- own local selection state
- read image history from store
- confirm action calls a store helper or callback to insert reference image nodes

### Store

Minimal additions only if needed:

- modal open/close state for the history image picker
- optional insertion helper for adding reference image nodes from selected history items at a target position

Keep source-tab UI state local to the picker modal.

## Error Handling

- Opening history assets must no longer crash due to conditional hook execution
- Upload failures continue using the existing visible error surface
- Empty history in image picker shows a graceful empty state
- Disabled placeholder menu items should be visibly unavailable and non-clickable

## Success Criteria

- Right-clicking the canvas shows a reference-style menu
- The add-node submenu visually matches the requested structure
- Upload from the menu can select local files and add reference nodes
- Selecting from generation history opens a dedicated image picker modal
- Confirming selected images inserts reference image nodes on canvas
- Opening history assets no longer throws the React hook-order error
