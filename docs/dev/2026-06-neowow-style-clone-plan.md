# Neowow 画布样式 1:1 复刻方案(组 + 连线)

参考站点: `https://neowow.cn/workflow?sessionId=...`(已登录态用 Chrome MCP 抓取)
采样时间: 2026-06-11
范围: 视觉 + 交互
对应文件: [src/app/components/Canvas.tsx](../../src/app/components/Canvas.tsx) · [src/app/components/FlowEdge.tsx](../../src/app/components/FlowEdge.tsx) · [src/app/components/nodes/CustomNodes.tsx](../../src/app/components/nodes/CustomNodes.tsx)

---

## 1. 采集到的 neowow 真实样式(computed style + CSS 规则双向核对)

### 1.1 画布底色

| 元素 | 值 |
|---|---|
| `<html>` / `<body>` | `rgb(0,0,0)` |
| `.app-layout` / `#app` | `rgb(10,10,10)` |
| `.vue-flow__pane` / `.workflow-main` | 完全透明(继承 #0a0a0a) |
| 网格/点阵 | **无** —— 纯黑底,没有任何 grid/dots 背景图 |
| 字体栈 | `Poppins, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ...` |
| CSS vars | `--panel-bg-rgba: rgba(24,24,27,.98)` `--text-primary:#f0f0f0` `--text-secondary:#a0a0a0` |

### 1.2 组(group)— `.group-node-container`

```css
.group-node-container {
  background: rgba(255, 255, 255, 0.08);
  border: 2px dashed rgba(255, 255, 255, 0.4);
  border-radius: 20px;
  box-shadow: none;
  backdrop-filter: none;       /* 没有毛玻璃 */
}
.group-node-container.selected {
  border-color: rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.1);
}
```

- 结构是 vue-flow 的 `.vue-flow__node-group`(就是普通节点,不是 ReactFlow 的 parent 容器),里面是一个 `.group-node-container`。
- **没有标题栏**,组名是一个独立的小标签 `.group-label`(顶部外侧/角上),`color: rgba(255,255,255,0.6)` `font-size:12px` `font-weight:500`,无背景。
- 组内的节点**不是 ReactFlow 的子节点**,只是 z-index 落在组矩形上的独立节点。membership 看坐标。
- 选中态只改 border-color 和 bg 的透明度,不上彩色。整体是高级灰风。

### 1.3 节点(node)— `.ai-node`

```css
.ai-node {
  background: var(--panel-bg-rgba);  /* rgba(24,24,27,.98) */
  border: 0;                         /* 没有边框 */
  border-radius: 20px;               /* 注意:计算值显示 16px 是因为子级 override,根规则是 20 */
  box-shadow: none;
  min-width: 280px;
  color: #f0f0f0;
  transition: .2s;
}
.ai-node.selected {
  box-shadow: 0 0 0 1px rgb(255,255,255);   /* 唯一的选中态:1px 纯白描边 */
}
```

标题/图标**在节点外面浮在上方**(`.ai-node-external-title`,`top:-32px`):

```css
.ai-node-external-title {
  position:absolute; top:-32px; left:0;
  display:flex; align-items:center; gap:8px; padding:6px 0;
}
.ai-node-external-title .ai-node-icon {
  width:24px; height:24px; border-radius:6px;
  display:flex; align-items:center; justify-content:center; font-size:14px;
}
.ai-node-external-title .ai-node-title {
  font-size:13px; font-weight:600; color:#fff; white-space:nowrap;
}
.ai-node-external-title .ai-node-status {
  width:6px; height:6px; border-radius:50%;
  background: rgba(255,255,255,0.2);   /* idle */
}
```

特殊变体:
- `.vue-flow__node-comment .ai-node` → 48×48 圆形(`border-radius:999px`),黄色调 `rgba(250,204,21,.14)` + `1px solid rgba(250,204,21,.28)`。

### 1.4 连线(edge)— `.vue-flow__edge-path`

实际生效的规则(来自 `.workflow-container.is-performance-mode`,默认就开):

```css
.workflow-container.is-performance-mode
  .vue-flow__edge path:not(.vue-flow__edge-interaction) {
  stroke: rgba(255, 255, 255, 0.2);
  stroke-width: 2px;
}
```

- **路径形状**: 默认 vue-flow bezier(`d` 用 `C` 控制点),不是 step/straight。
- **箭头**: `<marker>` 元素数量为 **0**,即所有连线**没有箭头**。
- **动画**: 默认关闭。工具条里有个"开启连线动画"开关,开了之后才走 `.vue-flow__edge.animated path { stroke-dasharray:5; animation:dashdraw .5s linear infinite }`。
- **选中态**(vue-flow 默认): `stroke: rgb(85,85,85)`(更暗的灰),无颜色高亮。
- **hover/交互轨道**: `.vue-flow__edge-interaction` 是一条 `stroke-width:12px; stroke:transparent` 的不可见粗管,作扩大命中区。
- **用户可改色**: 站内有 `.edge-color-presets` 调色板,但默认就是上面那条惨白半透明灰。

### 1.5 视觉总结

> 纯黑底 + 极淡描边 + 无箭头 + 无网格 + 圆角大(20px) + 标题外置。整体是"克制的暗夜灰"。没有任何 cyan/蓝调高亮,选中也只是把白色提一档不饱和度。

---

## 2. ccy-canvas 当前实现 vs neowow 对照

### 2.1 组

| 维度 | ccy-canvas 当前 | neowow | 差异 |
|---|---|---|---|
| 类名/位置 | [Canvas.tsx:1042-1095](../../src/app/components/Canvas.tsx) 在 ReactFlow 之外的覆盖层绘制 | vue-flow 内部节点 `.vue-flow__node-group` | 架构不同,但视觉可对齐 |
| 圆角 | `rounded-[26px]` | `20px` | 26 → **20** |
| 边框 | `border-white/8`(实线,1px) | `2px dashed rgba(255,255,255,.4)` | 改成 **2px 虚线、透明度更高** |
| 背景 | `bg-white/[0.025]` + `backdrop-blur-[2px]` | `rgba(255,255,255,0.08)`,**无毛玻璃** | 调浓 + 去 blur |
| 选中态 | `border-cyan-400/40 bg-cyan-400/[0.04]`(青色) | `border:rgba(255,255,255,.6); bg:rgba(255,255,255,.1)`(纯白提亮) | **去青色,改纯白档位** |
| 标题位置 | 在容器外上方,`-translate-y-[110%]` | 同样外置,但更克制 | 位置一致,样式要简化 |
| 标题文案 | `⋮⋮  Name · N 个节点` + 灰底 hover | `Name`(12px / weight 500 / `rgba(255,255,255,.6)`),无 `⋮⋮`,无数量计数 | **去掉 `⋮⋮` 把柄和数量后缀**(或保留作为我们的特色,见 §4 决策点) |
| 编辑态 | 输入框带 cyan ring | 同区域改成简单输入,去 cyan | ring 改 `ring-white/30` |

### 2.2 连线(`FlowEdge`)

[FlowEdge.tsx:23-44](../../src/app/components/FlowEdge.tsx) 当前是 **双轨**:灰底线 + 青色虚线流动动画。

| 维度 | ccy-canvas 当前 | neowow | 差异 |
|---|---|---|---|
| 路径 | bezier | bezier | ✅ |
| 底线 stroke | `rgba(148,163,184,.55)` 蓝灰 | `rgba(255,255,255,.2)` 中性灰白 | **改色** |
| 底线 width | 1.6 | 2 | 1.6 → **2** |
| 流动叠加层 | `#22d3ee` cyan,`8 12` 虚线,`animate stroke-dashoffset` | **不存在** | **整段删掉**(或挪到 hover/run-active 态,见 §4) |
| 箭头 | 通过 `markerEnd` prop 透传(默认 ReactFlow 会画) | **没有箭头** | 在 `defaultEdgeOptions` 关掉 `markerEnd` |
| 选中态 | 跟 ReactFlow 默认 | 暗灰 `rgb(85,85,85)` | 加一条 `.react-flow__edge.selected .react-flow__edge-path` override |
| hover 命中区 | 无显式增粗 | `.edge-interaction` 12px 透明粗管 | ReactFlow 有 `interactionWidth` prop,设 `interactionWidth={12}` |

### 2.3 节点(`CustomNodes`)

只列对齐 neowow 视觉时需要碰的全局点(不动业务结构):

| 维度 | 当前 | neowow | 备注 |
|---|---|---|---|
| 卡片背景 | 各节点自己写 | `rgba(24,24,27,.98)` | 我们已经接近(`#1a1d22/95` 之类),统一抽到 token |
| 圆角 | 多处 `rounded-lg`/`rounded-xl` | **20px** | 统一改 `rounded-[20px]` |
| 描边 | 多处有 1px 半透白 | **0** | 平时去边,只在 `.selected` 加 |
| 选中态 | 各处不一 | `box-shadow:0 0 0 1px #fff` | 统一用 ReactFlow 的 `.selected` 钩子加白色 1px ring |
| 标题位置 | 多数在卡内 | **外置**(top:-32px) | **改动较大,见 §4 决策点** |
| 字体 | 系统默认 | Poppins | 引入 Poppins 或就用系统 |

### 2.4 画布底色

| 元素 | 当前 | neowow | |
|---|---|---|---|
| 画布底 | 有 grid/dots `<Background />` | 纯黑 #0a0a0a,无 pattern | 把 `<Background />` 关掉或换 `BackgroundVariant.Lines` 极淡 |

---

## 3. 落地补丁清单(按文件)

> 真正改代码前我再跟你确认一次。下面是要改的最小集合。

**[src/app/components/Canvas.tsx:1051-1056](../../src/app/components/Canvas.tsx)**(组容器壳)
```diff
- className={clsx(
-   'pointer-events-auto absolute rounded-[26px] border bg-white/[0.025] backdrop-blur-[2px] transition-colors',
-   selected ? 'border-cyan-400/40 bg-cyan-400/[0.04]' : 'border-white/8',
- )}
+ className={clsx(
+   'pointer-events-auto absolute rounded-[20px] border-2 border-dashed transition-colors',
+   selected
+     ? 'border-white/60 bg-white/[0.10]'
+     : 'border-white/40 bg-white/[0.08]',
+ )}
```

**[src/app/components/Canvas.tsx:1665-1671](../../src/app/components/Canvas.tsx)**(标题)
- 去掉 `⋮⋮` 与 `· N 个节点` 后缀,或仅保留主名(看 §4 决策)
- 颜色 → `text-white/60`,font-size 12,weight 500

**[src/app/components/FlowEdge.tsx](../../src/app/components/FlowEdge.tsx)** —— 整文件替换为单层灰线版,去掉流动动画与箭头(把动画挪到"运行中"态的另一个 edge type,见 §4)。

**[src/app/components/Canvas.tsx:67](../../src/app/components/Canvas.tsx)**
```ts
const defaultEdgeOptions = {
  type: 'flow' as const,
  markerEnd: undefined,
  interactionWidth: 12,
};
```

**全局 CSS / Tailwind layer** —— 新增:
```css
.react-flow__edge.selected .react-flow__edge-path { stroke: rgb(85,85,85); }
```

**[src/app/components/Canvas.tsx 的 `<Background />`]** —— 改成不渲染,或 `variant="lines" gap={64} color="rgba(255,255,255,0.04)"`。

---

## 4. 需要你拍板的 3 个决策点

1. **要不要去掉 `⋮⋮` 拖把柄 + `· N 个节点` 计数**?
   - neowow 是没有的,但你的"双击重命名 / 拖动整组"的可发现性靠这个把柄。建议:**保留把柄但配色拉到 `text-white/40`**,去掉 `· N 个节点` 后缀(信息冗余,小地图能看)。

2. **流动动画(cyan 虚线)还要不要**?
   - neowow 默认是关的,只有用户开关打开才动。建议:**默认像 neowow 一样静态**;给"正在运行的 Agent"那条边单独走 `flow-active` edgeType,只在 run 进行时虚线流动(并且**改成白色虚线**,不要 cyan,保持冷淡风)。

3. **节点标题外置(`top:-32px`)**?
   - 这是 neowow 最有辨识度的一个手法,但牵动 `CustomNodes` 里所有节点的布局。建议:**先做 §2.1 / §2.2(组 + 线)的复刻,这部分留作 Phase 2**,不然这次改动太散。

---

## 5. 下一步

等你回:
- 决策点 1/2/3 的取舍
- 是否授权我直接改上面 §3 的几个文件(改之前我会再贴一遍最终 diff)

改完后我会在 [Canvas.tsx](../../src/app/components/Canvas.tsx) 起本地 dev,截图前后对比放在这里。
