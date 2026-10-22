# Group Container And Bulk Edge Routing Design

## Goal

支持用户对框选内容进行真实打组，并让组容器支持统一入线与统一出线：

- 从组左侧 `+` 统一接收入线
- 从组右侧 `+` 统一发出出线

一次组级连线操作会生成多条真实边，而不是一条抽象组边。

---

## Scope

本轮只做以下内容：

1. 多选节点后真实打组
2. 组容器渲染
3. 组级统一入线
4. 组级统一出线
5. 边去重

本轮明确不做：

- 组折叠
- 组内节点锁定
- 组嵌套组
- 组对组特殊布线
- 自动重排组内布局

---

## Product Requirements

### 1. Group Creation

用户框选多个节点后，点击现有顶部工具条中的“打组”，创建一个真实组容器。

组容器要求：

- 有标题，默认命名如 `分组 N`
- 渲染为大灰色容器框
- 容器尺寸包裹其成员节点，并保留 padding
- 成员节点仍然是独立真实节点，不复制，不改类型

### 2. Group Container Shell

组容器视觉方向参考用户截图：

- 深灰背景
- 轻边框
- 左上角标题
- 左右侧各有一个统一 `+` 连接口

容器本身不是普通生成节点，不参与生成逻辑，只承担组织和批量连线语义。

### 3. Bulk Outbound Routing

从组右侧 `+` 开始拉线到某个目标节点时：

- 不创建“组 -> 目标”的单条抽象边
- 而是为组内每一个成员节点分别创建：
  - `memberNode -> targetNode`

即一次用户操作生成多条真实边。

### 4. Bulk Inbound Routing

从某个来源节点拉线到组左侧 `+` 时：

- 不创建“来源 -> 组”的抽象边
- 而是为该来源节点分别创建：
  - `sourceNode -> memberNode`

也是一次操作生成多条真实边。

### 5. Edge Deduplication

为了避免重复边，本轮固定规则：

- 如果 `source + sourceHandle + target + targetHandle` 完全相同的边已存在
- 则不重复创建

不做更复杂的语义去重。

### 6. Group Membership

组成员来源于用户打组时的多选节点集合。

本轮不处理动态成员编辑，因此：

- 打组完成后成员集合固定存储
- 后续如果要新增/移除组成员，另起需求

---

## Data Model Changes

### Group

现有 `Group` 数据结构需要扩展：

- `id: string`
- `nodeIds: string[]`
- `name: string`
- `position?: { x: number; y: number }`
- `width?: number`
- `height?: number`

其中：

- `position`
- `width`
- `height`

用于渲染组容器壳。

### Group Edge Routing Metadata

本轮不额外持久化“组边”，因为最终落地的是普通真实边。

---

## Layout Rules

### 1. Group Bounds

打组时根据成员节点包围盒计算组容器：

- `left = min(node.left) - padding`
- `top = min(node.top) - padding`
- `right = max(node.right) + padding`
- `bottom = max(node.bottom) + padding`

建议默认 padding：

- 水平 `32`
- 垂直 `32`

### 2. Title Space

组容器顶部需要为标题预留额外空间，避免压住内部节点。

建议：

- 顶部标题区高度 `28-36px`

### 3. Handles

组容器：

- 左侧一个 target 统一入口
- 右侧一个 source 统一出口

成员节点原有 handle 不移除。

---

## Interaction Design

### 1. Multi-Select Toolbar

继续复用当前多选顶部工具条里的“打组”按钮。

### 2. Group Selection

本轮组容器可被看见，但不强制要求支持复杂单独拖动组壳。

优先目标是：

- 组能被渲染
- 组级统一连线能工作

如果现有实现允许后续补组壳拖动即可。

### 3. Routing UX

统一出线：

- 用户从组右侧 `+` 开始拉
- 拖到目标节点主体任意位置即可连接

统一入线：

- 用户从来源节点 `+` 拉到组左侧 `+`
- 放开后批量生成多条边

### 4. Target Resolution

组级连线和当前节点主体可接线规则一致：

- 目标节点主体可作为落点
- 不要求精确命中单个小圆点

---

## Rendering Strategy

推荐实现方式：

- 组容器不作为普通 React Flow node 数据进入 `nodes`
- 而作为独立 overlay 层根据 `groups` 渲染
- 这样不打乱现有节点生成逻辑

但需要同时满足：

- 组壳在画布坐标系中对齐节点
- 组壳的左右 `+` 能参与连接流程

如果 React Flow 的连接体系要求组也必须是 node，则允许将组实现为特殊 node type，如：

- `groupNode`

推荐优先评估哪条集成成本更低，再落实现。

---

## Edge Creation Rules

### Bulk Outbound

输入：

- `groupId`
- `targetNodeId`

输出：

- 对 `group.nodeIds` 中每个成员：
  - 创建 `member -> target`

### Bulk Inbound

输入：

- `sourceNodeId`
- `groupId`

输出：

- 对 `group.nodeIds` 中每个成员：
  - 创建 `source -> member`

### Validation

创建前需要跳过：

- 已存在的重复边
- 自环边（如果成员正好等于 source 或 target）

---

## Error Handling

### Invalid Group

如果组没有成员：

- 不允许绘制统一连线

### Missing Target

如果组级拉线最终没有落到合法目标：

- 不创建任何边

---

## Testing Requirements

至少验证以下内容：

1. 多选后打组会生成组容器数据
2. 组容器 bounds 正确覆盖成员节点
3. 从组右侧连到目标节点时，会生成多条真实出边
4. 从来源节点连到组左侧时，会生成多条真实入边
5. 已存在完全相同边时不会重复创建
6. 自环场景会被跳过
7. 原有节点间普通连线不回归

---

## Files Likely To Change

- `D:\code\ccy-canvas\src\app\store.ts`
- `D:\code\ccy-canvas\src\app\components\Canvas.tsx`
- `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`
- `D:\code\ccy-canvas\src\app\store.test.ts`

Possible new files:

- `D:\code\ccy-canvas\src\app\group-routing.ts`
- `D:\code\ccy-canvas\src\app\group-routing.test.ts`

---

## Non-Goals

本轮不处理：

- 自动布局重排
- 组折叠展开
- 组内成员动态管理
- 组对组特殊连线语义
- 批量删除/批量运行等组级操作
