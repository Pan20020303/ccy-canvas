# Group Shell Layering And Canvas Shortcuts Design

## Goal

修正当前打组视觉层级错误，并补上真正可用的基础画布快捷键：

1. 组框是背景层，不覆盖组内节点
2. 组标题浮在组框左上外侧，而不是压在框内正上方
3. `Ctrl+Z` 支持画布级撤销
4. `Ctrl+C` 支持复制当前选中节点
5. `Ctrl+V` 支持粘贴复制出的节点与内部边

本轮只做这 5 个点，不扩展到完整 command system，也不做 redo。

---

## Scope

本轮包含：

1. 组框背景层修正
2. 组标题位置修正
3. 画布快照级 undo
4. 选中节点复制
5. 粘贴复制节点与内部边

本轮明确不做：

- `Ctrl+Shift+Z` / `Ctrl+Y` 重做
- `Delete` 删除快捷键
- `Ctrl+A` 全选
- 组容器复制
- 跨项目 / 跨页面剪贴板
- 文本编辑器内部独立撤销栈

---

## Product Requirements

### 1. Group Shell Must Behave Like A Background

当前组框覆盖在节点上层，视觉上像半透明罩子。目标行为：

- 组框作为背景层渲染
- 组内节点永远显示在组框上方
- 组框只表达“这个区域属于一个组”
- 组框不能阻挡节点点击、拖动、编辑和普通连线

实现结果应接近普通设计工具里的 group background，而不是 modal overlay。

### 2. Group Title Placement

组标题需要从框内挪到框外：

- 标题位于组框左上角外侧
- 标题和组框边缘保持小间距
- 标题文本格式保留 `分组 N + 节点数`
- 标题不可阻挡节点交互

标题应像一枚浮在框外的小标签，而不是框体内部内容。

### 3. Canvas-Level Undo With Ctrl+Z

`Ctrl+Z` 必须是整个画布的全局撤销，而不是某个单独节点或输入框的局部撤销。

本轮撤销范围：

- `nodes`
- `edges`
- `groups`

只要这三个集合发生变化，就进入 undo 栈，例如：

- 新增节点
- 拖动节点
- 删除边
- 连线
- 打组
- 粘贴节点

按一次 `Ctrl+Z` 时：

- 还原到上一个画布快照
- 当前画布立刻重渲染
- 不要求本轮支持 redo

### 4. Copy Selected Nodes With Ctrl+C

当用户选中一个或多个节点时，按 `Ctrl+C`：

- 复制当前选中节点集合
- 同时复制这些选中节点之间已经存在的内部边
- 不复制未选中节点相关的外部边
- 不复制组容器

如果当前没有选中节点：

- `Ctrl+C` 不做任何事

### 5. Paste Copied Nodes With Ctrl+V

当用户按 `Ctrl+V`：

- 在当前画布中创建一份复制内容
- 所有新节点生成新 id
- 所有内部边重写为新的 source/target id
- 粘贴结果整体偏移一段距离，避免与原节点完全重叠

建议偏移量：

- `x + 48`
- `y + 48`

粘贴后行为：

- 新粘贴出的节点变为当前选中状态
- 原节点取消选中

如果当前没有可粘贴内容：

- `Ctrl+V` 不做任何事

---

## Architecture

### 1. Group Shell Rendering

现有组框仍然保持 overlay 思路，但层级调整为：

- 组框背景层：低 z-index
- React Flow 节点层：高于组框
- 组框连接口：只保留可点击的左右 `+`
- 标题标签：位于组框外侧，但仍在低干扰层

这样既保留现有组框实现路径，又不会压住节点。

### 2. Undo History

在 store 中新增轻量历史栈：

- `undoStack: ProjectCanvasState[]`
- 可选 `isRestoringHistory: boolean`

记录内容只包含：

- `nodes`
- `edges`
- `groups`

记录策略：

- 在会修改画布的操作前，先把当前快照压入 `undoStack`
- 撤销时弹出最后一个快照并恢复

不引入 command pattern，不做 action-level inverse。

### 3. Clipboard

在 store 中新增临时画布剪贴板：

- `copiedCanvasSelection: { nodes: Node[]; edges: Edge[] } | null`

复制时：

- 从当前 `selected === true` 的节点提取节点快照
- 过滤出 source/target 都在该集合内的边

粘贴时：

- 建立 old id -> new id 映射
- 复制节点并重写 id / position / selected
- 复制内部边并重写 source / target / id

---

## Data Model Changes

### AppState Additions

新增：

- `undoStack: ProjectCanvasState[]`
- `pushUndoSnapshot: () => void`
- `undoCanvas: () => void`
- `copiedCanvasSelection: { nodes: Node[]; edges: Edge[] } | null`
- `copySelectedNodes: () => void`
- `pasteCopiedNodes: () => void`

### Snapshot Policy

undo 快照和当前项目强绑定。

项目切换时：

- 可以先采用最简单策略：只保留当前运行态 undo 栈
- 切项目后清空 undo 栈

这样能避免不同项目之间历史串线。

---

## Interaction Design

### 1. Ctrl+Z

触发条件：

- Windows: `Ctrl+Z`
- macOS 兼容可顺手支持 `Meta+Z`

生效前提：

- 当前焦点不在明确的文本输入控件中

也就是说：

- 如果用户正在 textarea / input 中输入文本，保留浏览器原生编辑行为
- 如果焦点在画布层，触发画布撤销

### 2. Ctrl+C

触发条件：

- 当前焦点不在文本输入控件中
- 画布上存在选中节点

行为：

- 更新画布剪贴板
- 不立刻修改画布

### 3. Ctrl+V

触发条件：

- 当前焦点不在文本输入控件中
- 画布剪贴板非空

行为：

- 将复制内容粘贴到当前画布
- 粘贴出的节点成为新选中项
- 这次粘贴动作本身也进入 undo 栈

---

## Error Handling

### 1. Empty Undo Stack

如果 `undoStack` 为空：

- `Ctrl+Z` 直接无操作

### 2. Empty Clipboard

如果没有复制内容：

- `Ctrl+V` 直接无操作

### 3. Invalid Copied Edges

如果复制时某条边的 source/target 找不到对应复制节点：

- 粘贴时跳过该边

---

## Testing Requirements

至少覆盖以下测试：

1. 打组后组框渲染数据仍正确
2. `createGroup` 不受组框层级改动影响
3. `copySelectedNodes` 只复制选中节点和内部边
4. `pasteCopiedNodes` 会生成新 id、偏移位置、重写内部边
5. `undoCanvas` 能恢复到上一个 `nodes / edges / groups` 快照
6. 空 clipboard / 空 undo 栈不会抛错

---

## Files Likely To Change

- `D:\code\ccy-canvas\src\app\store.ts`
- `D:\code\ccy-canvas\src\app\store.test.ts`
- `D:\code\ccy-canvas\src\app\components\Canvas.tsx`

可能新增：

- `D:\code\ccy-canvas\src\app\canvas-clipboard.ts`
- `D:\code\ccy-canvas\src\app\canvas-clipboard.test.ts`

---

## Non-Goals

本轮不处理：

- redo 栈
- 复杂历史压缩
- 文本编辑器内部富文本快捷键体系
- 组整体复制
- 组层级嵌套
- 跨项目持久化剪贴板
