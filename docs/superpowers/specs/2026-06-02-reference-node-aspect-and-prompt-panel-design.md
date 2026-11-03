# Reference Node Aspect And Prompt Panel Design

## Goal

本轮解决两个直接影响画布体验的问题：

1. 上传后的参考图片 / 参考视频节点要按真实媒体比例显示，而不是统一裁成固定横图卡片
2. 节点下方的提示词对话框要限制在固定面板内，顶部能看到参考图预览，右上角能放大查看全文

---

## Scope

本轮包含：

1. `referenceImageNode` 按真实图片比例显示
2. `referenceVideoNode` 按真实视频比例显示
3. 生成节点底部 `PromptPanel` 收成固定高度对话框
4. `PromptPanel` 顶部显示已连接参考图/参考视频缩略图
5. `PromptPanel` 右上角增加放大查看全文入口
6. 放大态支持滚动阅读长提示词

本轮不做：

- 普通生成结果节点按真实比例重排
- 新的富文本编辑器体系
- 独立的 prompt 历史版本管理
- 为不同厂商做不同风格的 prompt 面板

---

## Product Requirements

### 1. Reference Nodes Must Use Real Media Aspect Ratio

当前参考节点预览区固定为 `aspect-video`，导致：

- 竖图被裁成横图
- 横图/竖图都看起来不对

目标行为：

- 图片加载完成后，读取 `naturalWidth / naturalHeight`
- 视频 metadata 加载完成后，读取 `videoWidth / videoHeight`
- 用真实比值渲染节点预览区

例如：

- `16:9` 保持横图
- `9:16` 保持竖图
- 其他尺寸按真实值显示

右上角分辨率标签继续保留。

### 2. Prompt Panel Must Stay Inside A Fixed Dialog

当前 prompt 面板会因为内容太长而显得失控，文本视觉上容易“超出对话框”的预期。

目标行为：

- prompt 面板使用固定外框高度
- 正文输入区独立滚动
- 底部模型与发送区域固定在面板底部
- 不因为长文本把整个面板无限撑高

### 3. Top Preview Strip

在 prompt 面板顶部增加参考素材预览：

- 如果当前节点有上游参考图片 / 参考视频
- 顶部显示一个横向预览条
- 至少显示第一张参考图缩略图
- 如果有多个素材，可以横向排列多个小缩略图

目标是让用户在写 prompt 时，一眼能知道当前参考的是哪张图。

### 4. Expand Button

在 prompt 面板右上角加入一个“放大查看全文”入口：

- 点击后打开更大的阅读/编辑面板
- 展开态仍保留顶部参考图预览
- 展开态正文支持滚动
- 展开态底部继续保留模型和发送区域

这不是全新功能弹窗，而是当前 prompt 面板的放大阅读态。

---

## Interaction Design

### 1. Reference Nodes

- 双击参考图/参考视频仍然保留原有预览能力
- 节点左上角文件名保留
- 节点右上角分辨率保留
- 仅调整内容区比例逻辑

### 2. Prompt Panel Default State

默认态：

- 固定宽度
- 固定最大高度
- 顶部预览条
- 中间文本区域滚动
- 底部控制条固定

### 3. Prompt Panel Expanded State

展开态：

- 使用更大的浮层或 modal 呈现
- 仍旧显示同一份 prompt 内容
- 与默认态实时同步
- 关闭后回到普通态

---

## Architecture

### 1. Media Aspect Ratio

在 `CustomNodes.tsx` 中为参考节点增加一个小的真实比例计算逻辑：

- 如果 `data.mediaWidth` 和 `data.mediaHeight` 已知
- 优先使用 `style={{ aspectRatio: width / height }}`
- 否则回退到现有默认比例

不新建复杂状态管理，也不引入额外 store 字段，只复用已有的：

- `mediaWidth`
- `mediaHeight`

### 2. Prompt Panel Refactor

继续复用现有 `PromptPanel` 组件，不单独拆出全新路由。

调整策略：

- 提取顶部 preview strip
- 提取可滚动正文区
- 增加本地 `expanded` 状态
- 展开态通过 `createPortal` 渲染到 `document.body`

这样改动集中，回归面最小。

---

## Testing Requirements

至少验证：

1. 参考图片节点能记录并使用真实宽高
2. 参考视频节点能记录并使用真实宽高
3. prompt 面板在长文本下仍保持固定框体
4. prompt 面板展开态可打开和关闭
5. 现有模型选择、比例/分辨率设置、发送按钮不回归

---

## Files Likely To Change

- `D:\code\ccy-canvas\src\app\components\nodes\CustomNodes.tsx`

如需要补测试，可能新增：

- `D:\code\ccy-canvas\src\app\prompt-panel.test.ts`

---

## Non-Goals

本轮不处理：

- 普通生成节点预览区改成真实比例
- 新的独立 prompt 编辑页面
- redo / 历史恢复
- 节点布局自动重排
