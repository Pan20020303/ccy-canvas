# Text Node Mode And Neutral Node Shell Design

## Goal

把当前画布节点统一成深灰中性色样式，并把文本节点改造成双模式节点：

- `文本编辑器`
- `反推提示词`

同时放宽画布连线命中范围，让用户把线拖到节点主体上也能完成连接，不再强依赖左侧小圆点。

---

## Scope

本轮只做以下内容：

1. 所有节点统一视觉外壳
2. 文本节点改成双模式交互
3. 文本编辑器浮层
4. 反推提示词浮层
5. 连线命中范围放宽

本轮明确不做：

- 图片节点/视频节点/音频节点的模式化改造
- 文生视频、文生音乐入口
- 导演台、视频合成、脚本节点能力实现
- 全量富文本文档模型

---

## Product Requirements

### 1. Node Visual Shell

所有节点统一采用中性深灰视觉：

- 去掉当前按类型区分的橙色、紫色、青色高饱和边框与光晕
- 节点统一为深灰背景、低对比细边框、轻微阴影
- 标题区保留左上角图标与标题
- 参考素材节点继续保留：
  - 左上角文件名
  - 右上角分辨率
  - 双击重命名
- 普通生成节点也支持双击标题改名

节点统一外壳只改变视觉，不改变除文本节点之外的核心功能。

### 2. Text Node Modes

文本节点内容区不再直接表现为结果或大段 prompt 面板，而改成两种模式入口：

- `文本编辑器`
- `反推提示词`

默认规则：

- 新建文本节点默认选中 `文本编辑器`
- 如果文本节点已经保存过模式，则恢复上次模式

展示规则：

- 节点主体内展示两项模式入口
- 当前激活项高亮
- 点击某一项后打开对应浮层

### 3. Text Editor Mode

`文本编辑器` 模式用于手工编写文本内容。

交互要求：

- 点击 `文本编辑器` 后打开悬浮编辑器面板
- 面板位置优先贴近当前文本节点
- 面板风格参考用户截图图二
- 面板至少支持：
  - 基础文本输入
  - 占位文案
  - 保存到当前文本节点 `data.content`

本轮不要求：

- 真正的富文本结构化存储
- 标题层级、加粗、斜体、列表等全部可用

工具条策略：

- 可以先保留用户截图中的工具条样式作为 UI 外观
- 但只有基础纯文本编辑是本轮强要求
- 未实现的富文本按钮可以表现为占位，不应误导成真正已生效功能

### 4. Reverse Prompt Mode

`反推提示词` 模式依赖上游参考图片。

可用条件：

- 文本节点必须至少连接 1 个上游 `referenceImageNode`
- 如果没有参考图，则：
  - 入口显示禁用态，或
  - 点击后提示“请先连接参考图片”

启用后行为：

- 打开悬浮反推面板
- 面板内容参考用户截图图三
- 需要包含：
  - 参考图片缩略图
  - 一段说明文案
  - 可编辑提示词区域
  - 模型选择
  - 提交按钮

说明文案固定方向：

- “根据图片生成结构化中文提示词，包括主体描述、环境、光影、镜头语言、风格关键词。”

数据流：

1. 读取该文本节点直接上游的第一张参考图片
2. 使用当前选定模型进行图像理解/提示词反推
3. 将生成结果写入：
   - 面板编辑区
   - 文本节点 `data.content`

模型约束：

- 只有支持图像理解或视觉输入的模型才允许出现在这个模式的模型选择里
- 如果当前后端没有可用视觉模型：
  - 面板中显示不可用提示
  - 提交按钮禁用

### 5. Other Nodes

图片节点、视频节点、音频节点、全景节点、参考图片节点、参考视频节点：

- 先统一中性深灰样式
- 保留当前已有业务行为
- 不增加新的模式入口

### 6. Edge Connection Behavior

当前用户必须拖到节点左侧小圆点才容易完成连接，这需要放宽。

本轮规则：

- 当一条连接线被拖到目标节点卡片主体区域时，也应判定为可连接
- 小圆点继续保留，作为视觉锚点
- 但小圆点不再是唯一命中区域

优先级：

- 节点主体命中应自动映射到默认 target handle
- 如果未来节点支持多个 target handle，再细化命中规则

---

## Data Model Changes

### Node Data Additions

文本节点新增字段：

- `customTitle?: string`
- `textMode?: "editor" | "reverse_prompt"`
- `content?: string`
- `reversePromptModel?: string`
- `reversePromptDraft?: string`

普通生成节点继续允许：

- `customTitle?: string`

参考素材节点继续使用：

- `sourceName?: string`
- `mediaWidth?: number`
- `mediaHeight?: number`

---

## Component Design

### 1. BaseNode

`BaseNode` 负责：

- 中性化节点外壳
- 标题区渲染
- 右侧可选补充信息
- 错误渲染
- 连线按钮

需要调整：

- 去除当前 type-tone 的强彩色视觉
- 保留统一尺寸与结构
- 支持标题传入可编辑组件

### 2. TextNode

文本节点负责：

- 显示两种模式入口
- 记录当前选中模式
- 触发对应浮层

不再直接在节点主体里展示大块 prompt 输入区。

### 3. TextEditorPopover

新增独立组件，负责：

- 文本编辑浮层
- 本地编辑状态
- 保存回节点内容

### 4. ReversePromptPopover

新增独立组件，负责：

- 上游参考图读取
- 模型选项过滤
- 反推请求触发
- 结果写回节点

### 5. Connection Target Overlay

需要在连线交互层上增加“节点主体可命中”能力。

实现方向：

- 优先利用 React Flow 已有的连接校验/命中回调能力
- 如果默认 handle hitbox 不够，则为节点主体增加透明 target overlay
- overlay 必须不干扰普通点击、双击和拖拽

---

## UX Details

### Title Renaming

普通生成节点：

- 双击标题进入编辑
- 保存到 `customTitle`

参考素材节点：

- 双击文件名进入编辑
- 如果文件名有扩展名，例如 `.png`、`.jpg`、`.mp4`
- 编辑时只允许修改主文件名
- 保存时自动拼回原扩展名

### Reverse Prompt Without Image

如果文本节点没有连接参考图片：

- `反推提示词` 入口为禁用态
- hover 或点击可提示：
  - “请先连接参考图片”

### Reverse Prompt With Multiple Images

本轮策略：

- 如果连接多张参考图，只使用第一张
- 其余图片暂不参与
- 在 spec 中固定此行为，避免实现歧义

---

## Error Handling

### Reverse Prompt Errors

如果反推失败：

- 错误信息显示在反推面板内
- 不污染节点标题区
- 不清空已有编辑内容

### Missing Model Support

如果没有支持视觉理解的模型：

- 模型下拉为空
- 面板显示说明
- 提交按钮禁用

---

## Testing Requirements

至少验证以下内容：

1. 所有节点外壳样式统一后仍可正常渲染
2. 文本节点默认进入 `文本编辑器` 模式
3. 切换到 `反推提示词` 时：
   - 无图片连接则禁用
   - 有图片连接则可用
4. 反推提示词面板只读取第一张上游参考图
5. 普通节点双击标题可改名
6. 参考节点改名保留文件扩展名
7. 连线拖到节点主体时可完成连接
8. 现有历史资产、上传、参考节点预览不回归

---

## Files Likely To Change

- `src/app/components/nodes/CustomNodes.tsx`
- `src/app/components/Canvas.tsx`
- `src/app/store.ts`
- `src/app/model-templates.ts`
- `src/app/store.test.ts`
- `src/app/history-assets.test.ts`

Possible new files:

- `src/app/components/nodes/TextEditorPopover.tsx`
- `src/app/components/nodes/ReversePromptPopover.tsx`
- `src/app/text-node-modes.ts`

---

## Non-Goals

本轮不处理：

- 完整富文本编辑器生态
- 图片节点/视频节点内部模式系统
- 多图联合反推
- 视频/音频反推逻辑
- 模型能力自动推理之外的大规模模型配置重构
