# 3D 导演台节点(directorStageNode)接入方案 — 复刻 neowow sceneComposer

需求来源: 用户 2026-06-11 提问 + 截图(neowow `导演台` 节点)
配套文档: [2026-06-image-tools-oss-mapping.md](./2026-06-image-tools-oss-mapping.md) §4(打光) / §3(多角度)
落点: [src/app/components/nodes/CustomNodes.tsx:3996](../../src/app/components/nodes/CustomNodes.tsx:3996) `nodeTypes` 注册表

---

## 1. Neowow 真实实现摸底(浏览器实测)

通过 Chrome MCP 进 neowow 工作流页面 + 进入"导演台"全屏编辑器后探测出的关键事实:

### 1.1 技术栈
- **纯 three.js** —— `window.__THREE__` 存在,**没有** react-three-fiber、babylon、theatre.js 任何一个。
- WebGL2 + ANGLE/D3D11,自管 Renderer/Scene/Camera 生命周期。
- DOM 结构(主类名):`.vue-flow__node-sceneComposer` → 画布上的节点;`.composer-overlay` → 全屏编辑器;`.composer-body` → 内容区;`.three-viewport` → 三维视口;`.composer-toolbar` → 顶部条;`corner-close-btn` 关闭按钮。

### 1.2 交互模型 —— **节点 + 全屏 overlay 两段式**
这是关键设计,**不是把 r3f viewport 嵌进节点里**:
1. 画布节点本身只是一张**缩略图 + 状态徽章 +「打开导演台」按钮**(截图 2/3 的样子)。
2. 点开后**全屏 overlay** 接管 —— 这才是真正的 three.js 视口和资产面板。
3. 编辑完点右下「确认构图」→ 关闭 overlay → 节点 data 更新 → 缩略图 + 「构图完成」徽章 + 「编辑」按钮。

**好处**(我们应该照搬):
- 节点不需要 inline WebGL,画布滚动 / 缩放 / 多节点时 GPU 压力 0。
- overlay 用 fullscreen 高分辨率出图,质量更高。
- 跟我们已经有的全屏对比 modal / 全屏图片预览 modal 一致体验。

### 1.3 资产库(4 个 tab)
浏览器实测拿到的全清单:

**道具(11+)**: 椅子 / 方桌 / 圆桌 / 沙发 / 墙段 2m / 墙段 3m / 柱子 / 楼梯段 / 小树 / 大树 / 石头 / 灌木 / 轿车 / 自行车 / 路灯 / 长椅 ... 卡通低多边形风。

**人物(7)**: 标准素体 / 女性素体 / 儿童素体 / 壮实素体 / 纤细素体 / 群众(3 人) / 群众(5 人) —— **全是 T-pose 关节人偶,没纹理**,像 Daz 基础素体。

**机位**: 独立相机预设 + FOV / 画幅。

**模板(9+)**: 空白场景 / 对话双人 / 三人对话 / 采访场景 / 独白特写 / 课堂演讲 / 追逐场景 / 户外行走 / 会议室 —— 整套现成的"场景 + 人物 + 机位"打包。

### 1.4 顶部操作提示栏(画布交互速记)
- `左键点击=选中` `左键拖拽=旋转` `右键拖拽=平移` `滚轮=视图缩放`
- `W=移动 / R=旋转 / S=缩放 / C=应用视图到机位`(典型 DCC 软件快捷键,符合用户预期)

### 1.5 右下角浮窗 = 机位列表 + 实时缩略图
每个机位卡片显示 `FOV / 画幅比例` + 它当前视角的小预览(实时跟着场景变化)。可以加机位、删机位、点机位切换主视图。

### 1.6 底部右下
- `全景` / `标签` / `16:9`(画幅切换) / `动画(BETA)` / **`确认构图`**(回画布的出口)。

---

## 2. 选型重判 —— 从原方案的 r3f + drei + Theatre.js 改成什么?

知道 neowow 用**纯 three.js + Vue 而非 r3f** 之后,对我们的影响:

| 方案 | 取舍 |
|---|---|
| **纯 three.js + 自己写 React 包装**(neowow 同款) | 代码量大、学习曲线陡,但运行时最轻 |
| **react-three-fiber + drei**(原方案) | DX 最好、可读性强、组件化思维 ✅ |
| **Babylon.js + Inspector** | 自带场景编辑器但风格不一致 |

**结论:还是用 r3f + drei**,理由:
1. 我们整个 codebase 是 React,r3f 心智模型一致,后续迭代友好;
2. drei 自带 `<TransformControls>` `<GizmoHelper>` `<PivotControls>` `<CameraControls>` 全套,**neowow 那些 Gizmo / 选中圈 / 坐标轴助手不用自己实现**;
3. r3f 也是包 three.js,bundle 差异 < 30KB;
4. Theatre.js **暂时不上**(neowow 也没用,"动画"还在 BETA),P5 再说,先不引入。

---

## 3. directorStageNode 节点设计(对齐 neowow)

### 3.1 画布上的节点(inline,无 WebGL)

```
┌─────────────────────┐
│ ✏️ 导演台           │   ← 外置标题(沿用 neowow 暗夜灰风格)
├─────────────────────┤
│                     │
│   [缩略图 / 默认]   │   ← 280×180,从 lastCapture.image 或占位 icon
│                     │
├─────────────────────┤
│ ✓ 构图完成 │ ✏ 编辑  │   ← 左:状态徽章 右:打开 overlay 的按钮
└─────────────────────┘
```

- 缩略图:有 `lastCapture.image` 就显示,没有就显示默认占位(三层叠图标 + "3D 构图编辑器" 副标题 + 「打开导演台」按钮,完全照搬 neowow 截图 2 的空状态)。
- 状态徽章:`未构图` / `构图完成` / `已应用` 三态。
- inline **完全无 WebGL**,跟一个普通 imageNode 一样轻。

### 3.2 全屏编辑器 overlay

新组件 `<DirectorStageOverlay nodeId={id} onClose />`,渲染逻辑:

```
┌──────────────────────────────────────────────┐
│ [≡大纲] [▦资产]    [操作提示栏]       [×]   │
├──────────────────────────────────────────────┤
│                                              │
│  <Canvas> (r3f)                              │
│   ├ <Grid />                                 │
│   ├ <axesHelper>                             │
│   ├ characters.map → <Mannequin/>            │
│   ├ props.map → <Prop/>                      │
│   ├ lights.map → <Light/>                    │
│   ├ cameras.map → <CameraRig/>               │
│   └ <CameraControls> 主视口                  │
│                                  ┌─────────┐ │
│                                  │ 属性面板 │ │  ← 选中对象时弹出
│                                  │ 位置 旋转│ │
│                                  │ LookAt  │ │
│                                  │ FOV     │ │
│                                  └─────────┘ │
│ [移动W][旋转E][缩放R][吸附X] ...  [机位列表] │
│                              [全景][标签][16:9][确认构图]
└──────────────────────────────────────────────┘
```

资产库面板从左侧滑出(`左-float-btns`),4 tab 同 neowow。

### 3.3 数据形状(`node.data`)

```ts
type DirectorStageData = {
  // 场景内容
  characters: Array<{
    id: string;
    assetId: string;              // 'mannequin-standard' | 'mannequin-female' ...
    label: string;                // '角色A'(节点上方文字标)
    position: [number, number, number];
    rotationY: number;
    scale: number;
  }>;
  props: Array<{
    id: string;
    assetId: string;              // 'chair' | 'sofa' | 'wall-2m' ...
    position: [number, number, number];
    rotationY: number;
    scale: number;
  }>;
  lights: Array<{
    id: string;
    type: 'directional' | 'point';
    position: [number, number, number];
    color: string;
    intensity: number;
  }>;
  cameras: Array<{
    id: string;
    label: string;                // '机位1'
    position: [number, number, number];
    lookAt: [number, number, number] | { followCharacterId: string };
    fov: number;                  // 默认 50
    aspect: '16:9' | '9:16' | '1:1' | '4:3' | '21:9';
  }>;
  activeCameraId?: string;
  // 输出
  lastCapture?: {
    cameraId: string;
    image: string;                // 渲染出的 RGB(给下游 imageNode 用作 ref)
    depth?: string;               // 可选 ControlNet condition
    pose?: string;
    normal?: string;
    timestamp: number;
  };
  status: 'idle' | 'composing' | 'done';
};
```

### 3.4 资产实现策略 —— **轻量、不下 Mixamo**

neowow 的素体是无纹理 T-pose,**我们用程序化几何或最简 GLB**:

| 类别 | 实现 |
|---|---|
| 人物素体 | 7 个内置 GLB,每个 < 200KB(用 [Blender Mannequin](https://www.blendswap.com/blends/category/mannequin) 类 CC0 资源或自建)|
| 道具 | **程序化生成** —— `<BoxGeometry>`、`<CylinderGeometry>` 等几个原语组合即可,**0 资源体积**。例:`<Chair>` = 座面 box + 4 条腿 + 椅背 box。低多边形卡通风跟 neowow 一致。|
| 灯 | three.js `DirectionalLight/PointLight`,**helper 用 drei `<TransformControls>`** |
| 相机 | `<PerspectiveCamera makeDefault={false}>` + 离屏 RenderTarget 拍预览 |
| 模板 | 9 个模板 = 9 段 JSON,直接 `setState(templateJson)` |

**总资产体积估算 < 2MB**(7 个人偶 GLB),道具/灯/相机 0 资源。

### 3.5 出图机制

**主视图**用 `<CameraControls>` 自由飞,**机位**是独立的 `<PerspectiveCamera>` 实例。

- 实时机位缩略图:每个机位用一个 `useFrame` + 离屏 `WebGLRenderTarget`(128×72)持续渲染,丢给 `<canvas>` 显示。30fps 就够。
- 「确认构图」点击:
  1. 拿 active camera 的 `WebGLRenderTarget` 高分辨率渲染 1920×1080;
  2. `renderer.readRenderTargetPixels()` 或直接 `toDataURL()` 得到 PNG;
  3. 上传到我们后端的资源存储(同 `imageNode` 的上传路径),拿回 URL;
  4. 写入 `node.data.lastCapture`,关 overlay,节点显示缩略图 + 「构图完成」。
- 附加 condition 图(可选,P4 才上):用 `MeshDepthMaterial` / `MeshNormalMaterial` 替换 scene 材质再渲一遍,出 depth/normal。Pose 直接根据人偶骨骼坐标投影到 2D 画 OpenPose 骨架。

### 3.6 连接

- 出 handle(右):连 `imageNode` → 自动写入 `referenceImages: [lastCapture.image]` 和(P4 后)`controlImages: { depth, pose, normal }`。
- 入 handle(左,P6):接 `imageNode` → 调用 backend `image.to3d`(InstantMesh)→ 生成新 character,加进场景。

---

## 4. 依赖清单

新增 npm 依赖(MVP 最小集):

```
three                     ~700KB gz (~150KB tree-shaken if只用核心)
@react-three/fiber        ~30KB
@react-three/drei         按需:CameraControls + Grid + TransformControls + 
                          PivotControls + Gizmo + Helper ~80KB
```

**不引入**:`@theatre/*`(动画 BETA 阶段再说)、`leva`(我们自己写属性面板)、`@react-three/cannon`(无物理需求)。

bundle 增量 ~1MB,**走动态 import**: `<DirectorStageOverlay>` 用 `React.lazy()` 只在用户点「打开导演台」时加载,首屏 0 影响。

---

## 5. 实施阶段

| 阶段 | 内容 | 估时 |
|---|---|---|
| **P0** | 装依赖 + 注册 `directorStageNode` 类型 + 画布上的空状态节点(无 overlay) + 类型选择菜单加入口 | 0.5 天 |
| **P1** | `<DirectorStageOverlay>` 框架:全屏 modal + r3f 空场景 + Grid + 顶部条 + 关闭按钮 + 「确认构图」按钮 | 1 天 |
| **P2** | 1 个内置 mannequin GLB 默认加载 + drei `<TransformControls>` 拖动 + 选中圈 + 「确认构图」拍当前主视口 → 写 lastCapture → 节点更新缩略图 + 状态 | 1.5 天 |
| **P3** | 资产库面板(4 tab UI)+ 道具用程序化几何实现 6-8 个(chair/sofa/box/wall/lamp/tree)+ 拖入场景 | 2 天 |
| **P4** | 机位系统:多机位列表 + 离屏 RenderTarget 实时缩略图 + 「应用视图到机位(C)」+ FOV / 画幅切换 | 2 天 |
| **P5** | 属性面板(位置/旋转/缩放/LookAt/FOV 表单)+ 「大纲」面板(场景树) | 1.5 天 |
| **P6** | 模板系统(9 个模板 JSON) + 灯光系统(可拖光源 + 属性)| 1.5 天 |
| **P7** | depth/normal/pose 三张 condition 图导出(配合 image-tools §4 打光、§8 inpaint) | 1.5 天 |
| **P8**(可选) | 图片节点 → InstantMesh → 3D 演员入场,跟 backend `image.to3d` 打通 | 2 天 |

**P0-P2 跑通就能出 MVP**(摆一个角色 → 拍图 → 连下游 imageNode 当 ref),3 天工作量。

---

## 6. 跟原 §2 计划的差异回顾

原 plan 写的是 r3f + drei + **Theatre.js** + Mixamo 角色。实测 neowow 之后改:

| 维度 | 原方案 | 新方案(本文) |
|---|---|---|
| 编辑器形态 | inline 在节点内 | **全屏 overlay**(neowow 同款,更优) |
| 3D 框架 | r3f + drei + Theatre.js | r3f + drei,**砍 Theatre.js**(neowow 都没动画) |
| 角色资产 | Mixamo GLB(几 MB) | 7 个轻量 GLB(< 2MB 总量) |
| 道具资产 | (未规划) | **程序化几何**,0 资源体积 |
| 模板系统 | 未规划 | 加入 9 个场景模板 JSON |
| 多机位 | 未规划 | 显式加入(neowow 核心卖点) |

---

## 7. 需要你拍板

1. **同意"节点 + 全屏 overlay"两段式架构(neowow 同款)**,而不是 inline 编辑?
2. **MVP 范围到 P 几?** —— 我的建议:
   - **最小可用 = P0-P2**(3 天):空场景 + 1 角色 + 拍图回流
   - **像 neowow 的 demo = P0-P5**(8 天):资产库 + 机位 + 属性面板都齐
   - **完整对标 = P0-P7**(10.5 天):再加模板 + 灯 + ControlNet condition
3. **角色 GLB 怎么准备?** 三个选项:
   - **A.** 自建 7 个低多边形 GLB(Blender 一晚上,工作量我吃)
   - **B.** 用 CC0 资源(Quaternius / Kenney 等),改一下比例
   - **C.** 先只内置 1 个标准素体,后续慢慢加
4. **道具走程序化几何 OK?**(neowow 也是程序化卡通风,贴合)
5. **bundle 增量 ~1MB(动态 import,首屏 0)可接受?**

---

## 8. 下一步

回答 §7 之后,我把 P0 拆成 commit-sized 任务清单(还是只规划,不动代码),包括:
- 具体新增哪几个文件、放哪
- nodeTypes 注册行号
- 节点类型选择菜单([Canvas.tsx](../../src/app/components/Canvas.tsx) 改动点)
- 资产 GLB 的具体来源 / 制作步骤
