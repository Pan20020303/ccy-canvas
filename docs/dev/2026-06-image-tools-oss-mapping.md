# Neowow 图像工具栏 → 开源方案映射 + 接入计划

参考站点: `https://neowow.cn/workflow`
配套文档: [2026-06-neowow-style-clone-plan.md](./2026-06-neowow-style-clone-plan.md)(视觉层),本文聚焦**功能层**
落点: [src/app/components/nodes/CustomNodes.tsx](../../src/app/components/nodes/CustomNodes.tsx) 的 `ImageActionToolbar` / `VideoActionToolbar` + [backend/internal/modelcatalog](../../backend/internal/modelcatalog)

---

## 1. 工具盘点

Neowow 的"图片二次创作"工具栏覆盖以下动作(对照截图采样):

| 动作 | Neowow UI | 当前 ccy-canvas | AI 能力点 |
|---|---|---|---|
| 全景 | `全景`(横/竖向外扩,可生成 360 全景) | 占位 `panorama` action,后端是普通 outpaint | outpaint / 真 360 全景 |
| 多角度 | `多角度`(三视图、八方位、自由旋转视角) | 占位 `angles` action,prompt 拼接 | 单图 → 多视图 |
| 打光 | `打光`(3D 灯位 + 预设) | 占位 `lighting` action,只送 prompt | 真正的"重打光"(relight) |
| 九宫格 | `九宫格`(N 张图排版) | `grid-compose` action,送 prompt | 简单合成,可纯前端 |
| 高清 | `高清`(超分,多档引擎) | `enhance` action,送 prompt | 超分(SR) |
| 宫格切分 | `宫格切分`(1 → N 切片) | `grid split`,前端 canvas 切 | 纯前端,无需模型 |
| 局部编辑 | 蒙版 + 编辑 | `edit` action,蒙版 + 改写 | inpaint |
| 去背景 | 工具栏右侧未截到,但常见 | 没有 | matting |
| 角色一致 | (多见于 IP 流) | 没有 | identity preservation |

下面**逐项**给开源方案 + API 选项 + 前端面板设计 + 接入要做的事。

---

## 2. 全景 (Panorama)

### 2.1 实际拆分

Neowow 的"全景"实际是两个能力混在一个按钮里:

| 子模式 | 含义 | 模型类别 |
|---|---|---|
| 横向 / 竖向扩展 | 像 Photoshop 的 Generative Expand,把画面向左右(或上下)外扩 | **outpaint**(Flux/SD inpaint + 边缘蒙版) |
| 720° 全景 | 输出 equirectangular(2:1 球面投影),可丢进 360 viewer | **panorama diffusion** 专用模型 |

### 2.2 开源方案

**A. 外扩(主流场景,占 90%)**
- **[black-forest-labs/FLUX.1-Fill-dev](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev)** —— Flux 官方 inpaint/outpaint 权重,质量最稳。
- **[lllyasviel/Fooocus](https://github.com/lllyasviel/Fooocus)** 的 Outpaint pipeline —— SDXL 基础,UX 成熟。
- **[diffusers](https://github.com/huggingface/diffusers)** `FluxFillPipeline` —— 自部署直用。
- Hosted: **Replicate `black-forest-labs/flux-fill-pro`**、**fal.ai `flux/dev/fill`**。

**B. 真 720° 全景**
- **[chengzhag/PanFusion](https://github.com/chengzhag/PanFusion)** —— 全景扩散,可从单图/文字直接出 equirect。
- **[ArchAaron/Diffusion360](https://github.com/archerfmy/sd-t2i-360panoimage)** —— 老牌但有效。
- **[PanoDiffusion](https://github.com/PanoDiffusion/PanoDiffusion)** —— RGBD 全景。

### 2.3 前端面板

复刻 neowow 的"扩展方向 / 比例 / 提示词"面板即可,我们 [CustomNodes.tsx:2174](../../src/app/components/nodes/CustomNodes.tsx:2174) 的 `openDraft('panorama', ...)` session 已经在:
- `expandDirection: 'horizontal' | 'vertical' | 'both'`
- 现在补 `mode: 'outpaint' | 'pano360'` 切换 + 输出比例(21:9 / 32:9 / 2:1)

### 2.4 接入要做

1. **后端**:在 [modelcatalog](../../backend/internal/modelcatalog) 注册两个 capability —— `image.outpaint`、`image.panorama360`,模型可选 Flux-Fill / PanFusion。
2. **mask 构造**:已经有 [buildPanoramaReference](../../src/app/components/nodes/CustomNodes.tsx) 工具函数,只需让它根据 `mode` 出不同 mask:外扩 mask 还是球面 mask。
3. **节点**:新增 `panoramaViewerNode`(可选,360 模式才挂),里面塞 [pannellum](https://github.com/mpetroff/pannellum) 或 [marzipano](https://github.com/google/marzipano)。

---

## 3. 多角度 (Multi-view)

### 3.1 开源方案

| 模型 | 长处 | 仓库 |
|---|---|---|
| **Zero123++** | 单图 → 6 固定视角,工业级稳定 | [SUDO-AI-3D/zero123plus](https://github.com/SUDO-AI-3D/zero123plus) |
| **Stable Video 3D (SV3D)** | 单图 → 21 帧轨道环绕,适合"自由角度"演示 | [Stability-AI/generative-models](https://github.com/Stability-AI/generative-models) |
| **Era3D** | 多视角 + 法线,质量更高 | [pengHTYX/Era3D](https://github.com/pengHTYX/Era3D) |
| **CRM / InstantMesh** | 直接出 3D mesh,可任意角度渲染 | [thu-ml/CRM](https://github.com/thu-ml/CRM)、[TencentARC/InstantMesh](https://github.com/TencentARC/InstantMesh) |

**推荐组合**:
- **预设三视图 / 八方位** → Zero123++(固定方位,速度快,prompt 不重要)
- **自由旋转**(用户拖动) → InstantMesh 先出 mesh,前端用 r3f 渲染任意视角(零延迟,体验最佳,**强烈推荐**)

Hosted:Replicate 上 `zero123-plus` / `instantmesh` 都有。

### 3.2 前端面板

- "预设"模式:复用现在的下拉,后端跑 Zero123++ 一次出 6 张,自动展开成 6 个派生节点(我们已有 `outputCount` 机制)。
- "自由相机"模式:派生节点改成 `meshPreviewNode`,内部嵌 r3f + GLB loader,挂一个 OrbitControls。

### 3.3 接入要做

1. 后端 capability:`image.multiview`(返回 N 张)、`image.to3d`(返回 GLB URL)。
2. 新节点类型 `meshPreviewNode`,渲染 GLB。
3. 工具栏 `多角度` 下拉里新增"3D mesh"档位,触发 `image.to3d`。

---

## 4. 打光 (Relight)

### 4.1 开源方案

- **[lllyasviel/IC-Light](https://github.com/lllyasviel/IC-Light)** —— **首选**。Lvmin Zhang(ControlNet 作者)做的图像重打光,输入图 + 光源条件(方向贴图 / 文字),输出重打光结果。**Neowow 的"三点布光 / 伦勃朗 / 黄金时刻"几乎一定是它在背后**。
- **IC-Light V2** —— 同仓更新版,质量更好。
- **[SwitchLight](https://github.com/beeble-ai/SwitchLight)**(Beeble,商业 + 部分开源)—— 工业级人像重打光,贵但稳。
- **[Relightful Harmonization](https://github.com/adobe-research/RelightfulHarmonization)**(Adobe Research)—— 学术,质量好但部署门槛高。

Hosted:Replicate `ic-light` 直接调,不想买 GPU 选这个。

### 4.2 前端面板("灯光调节")

Neowow 那个 3D 灯位控件就是一个 r3f 场景:
- 一张 `<Plane>` 贴预览图作为"被照物体"
- 一个或多个可拖的 `<directionalLight>` / `<pointLight>` 头(给灯加 Gizmo)
- 一个网格地板提供空间感

需要的库:
- **[@react-three/fiber](https://github.com/pmndrs/react-three-fiber)** + **[@react-three/drei](https://github.com/pmndrs/drei)**(`<TransformControls>`、`<Gizmo>`、`<Environment>`)
- **[leva](https://github.com/pmndrs/leva)**(可选,做强度/色温滑杆)

输出 → IC-Light 输入:
- 灯位 `{ azimuth, elevation, distance }` → 渲一张 normal/light direction 贴图(我们在 r3f 里用一个离屏 RenderTarget 出,128×128 就够)
- 灯色 / 强度 → 文字 prompt 增强:"warm golden hour" 之类
- IC-Light 拿"原图 + 光照 condition 图 + prompt"出新图

### 4.3 接入要做

1. 后端 capability:`image.relight`,入参 `{ image, lightDirectionMap?, prompt, intensity, color, preset? }`。
2. 前端新增 `<LightingComposer/>` 面板组件,挂到现在的"打光"下拉里,替换"只送 prompt"的占位实现。
3. preset(三点布光 / 伦勃朗 / 顶光戏剧 / 赛博朋克 / 黄金时刻 / 蓝调时刻 ...)是一组预置的 `{ lightDir + color + prompt }`,JSON 存在 [src/app/model-templates.ts](../../src/app/model-templates.ts) 同级。

---

## 5. 九宫格 (Grid Compose)

### 5.1 开源方案

这个**不需要 AI 模型**,纯 layout:
- 前端 canvas / [konva](https://github.com/konvajs/konva) / Pillow(后端 Go 起一个 imaging 服务)拼接即可。
- 或用 **[sharp](https://github.com/lovell/sharp)**(后端 Node 处理,如果有 Node 端)。
- Go 端可以用 **[disintegration/imaging](https://github.com/disintegration/imaging)** 或 **[fogleman/gg](https://github.com/fogleman/gg)**。

如果想要**风格统一化的智能排版**(比如同色调、补边、自动留白):
- 先做几何拼接,再走一遍 Flux 重绘 → 等价于做了风格化版的九宫格。

### 5.2 接入要做

- 在 backend 加 `image.compose-grid`,只跑 Go imaging,几乎不耗资源。
- 前端面板已经够用,不动。

---

## 6. 高清 (Super Resolution)

### 6.1 开源方案

| 档位 | 推荐模型 | 仓库 |
|---|---|---|
| 标准 / 通用(2-4×) | **Real-ESRGAN** | [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) |
| 写实人像 | **GFPGAN**(脸) + Real-ESRGAN(身体/背景) | [TencentARC/GFPGAN](https://github.com/TencentARC/GFPGAN) |
| 极致质量(4K/8K) | **SUPIR** —— SDXL 驱动,可调细节再生程度 | [Fanghua-Yu/SUPIR](https://github.com/Fanghua-Yu/SUPIR) |
| 现代轻量 | **AuraSR** —— GAN 4×,速度快 | [fal-ai/aura-sr](https://github.com/fal-ai/aura-sr) |
| 人脸专项 | **CodeFormer** | [sczhou/CodeFormer](https://github.com/sczhou/CodeFormer) |
| 一键打包 GUI | **Upscayl**(用了 Real-ESRGAN ncnn) | [upscayl/upscayl](https://github.com/upscayl/upscayl) |

**Neowow 档位对应推测**:
- 标准版 → Real-ESRGAN
- 专业版 → Real-ESRGAN + tiled + 大上限
- 极致版 V3 → **SUPIR**(描述里的"可调节细节生成程度"是 SUPIR 标志特征)
- Neo Nano Pro → 自研或 Flux 基底的引导式 SR

### 6.2 前端面板("高清增强配置")

参考 [Upscayl](https://github.com/upscayl/upscayl) 的 UI 几乎可以直接照抄:
- 引擎档位(单选卡片)
- 目标分辨率(2K / 4K / 8K 切换)
- 画幅比例选项(原比例 / 16:9 / 1:1)
- 原图预览(左右拖动对比 slider) → 用 [react-compare-slider](https://github.com/nerdyman/react-compare-slider)

### 6.3 接入要做

1. 后端 capability:`image.upscale`,参数 `{ image, engine, targetResolution, denoise }`。
2. 模型路由:engine='realesrgan' / 'supir' / 'gfpgan' / 'aurasr',按选择走不同 provider。
3. 大图返回:SUPIR 4K 输出动辄 10MB+,后端要分块下载 + 进度推送。

---

## 7. 宫格切分 (Grid Split)

纯前端,**[src/app/components/nodes/CustomNodes.tsx:2137](../../src/app/components/nodes/CustomNodes.tsx:2137)** 已经在用 `splitImageIntoTiles`。无需改动。

---

## 8. 局部编辑 (Inpaint)

### 8.1 开源方案

- **FLUX.1-Fill-dev**(同 §2,Flux 官方 inpaint)
- **SDXL Inpaint**
- **[advimman/lama](https://github.com/advimman/lama)** —— 老牌 LaMa,擦除/去物体一绝,**速度快、不需要 GPU 也能跑**。
- **[lllyasviel/Omost](https://github.com/lllyasviel/Omost)** —— 区域驱动的 SDXL,适合带语义的局部修改。

### 8.2 前端

蒙版工具需要画笔:
- **[fabric.js](https://github.com/fabricjs/fabric.js)** —— 画 mask 经典选择
- 或 [tldraw](https://github.com/tldraw/tldraw) 里抠 draw layer

### 8.3 接入

ccy-canvas 已经有 `edit` action + [buildSelectionMask](../../src/app/components/nodes/CustomNodes.tsx),只缺一个真正的画笔 UI。建议:
- 新增 `<MaskEditor/>` 组件(fabric.js,200 行内)
- 后端 `image.inpaint` capability,先 LaMa(纯擦)再 Flux-Fill(带 prompt 替换)

---

## 9. 去背景 (Matting,Neowow 上虽未截到但常见)

### 9.1 开源方案

| 模型 | 长处 | 仓库 |
|---|---|---|
| **BRIA RMBG-1.4** | 商用免费,边缘干净 | [briaai/RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) |
| **BiRefNet** | SOTA,发丝细节强 | [ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet) |
| **rembg** | Python 一行集成,fallback 用 | [danielgatis/rembg](https://github.com/danielgatis/rembg) |
| **MODNet** | 人像专项 | [ZHKKKe/MODNet](https://github.com/ZHKKKe/MODNet) |

### 9.2 接入

- 后端 capability:`image.matting`,默认 BiRefNet,人像走 MODNet。
- 工具栏加一个"抠图"按钮,出一个透明 PNG 派生节点。

---

## 10. 角色一致性 (Identity Preservation)

Neowow 漫剧场景下"同一角色出不同图"是核心刚需,工具栏虽然没显式按钮,但工作流里到处都是。

### 10.1 开源方案

| 模型 | 用法 | 仓库 |
|---|---|---|
| **PuLID** | 单图 → 强身份一致,SDXL/Flux 都有版本 | [ToTheBeginning/PuLID](https://github.com/ToTheBeginning/PuLID) |
| **InstantID** | 单图人脸 ID,IP-Adapter 风格 | [InstantID/InstantID](https://github.com/instantX-research/InstantID) |
| **PhotoMaker** | 多图融合一个角色 | [TencentARC/PhotoMaker](https://github.com/TencentARC/PhotoMaker) |
| **Flux + Redux** | 通用主体迁移 | Flux Redux 官方 |

### 10.2 接入

- 在节点参数里加 `identityRef: nodeId` 字段(已经有 referenceImages,只是要"标记为身份锚")
- 后端 capability:`image.generate-with-identity`,自动加载 PuLID adapter
- 前端给 reference 缩略图加一个"📌 锁定为人物"toggle

---

## 11. 全图模型路由表(总表)

| 能力 | 推荐主力 | 备用 / Hosted |
|---|---|---|
| outpaint | FLUX.1-Fill-dev | Replicate `flux-fill-pro` |
| 360 panorama | PanFusion | Diffusion360 |
| 单图多视图 | Zero123++ | SV3D / Era3D |
| 单图 → 3D mesh | InstantMesh | CRM |
| 重打光 | IC-Light V2 | SwitchLight(贵) |
| 超分通用 | Real-ESRGAN | AuraSR |
| 超分极致 | SUPIR | Flux upscaler |
| 人脸修复 | GFPGAN | CodeFormer |
| inpaint(擦) | LaMa | Flux-Fill |
| inpaint(改) | FLUX.1-Fill-dev | SDXL Inpaint |
| 抠图 | BiRefNet | RMBG-1.4 / rembg |
| 角色一致 | PuLID | InstantID / PhotoMaker |
| 网格拼接 | 纯 Go imaging | — |
| 切片 | 纯前端 Canvas | — |

---

## 12. 部署路线两条腿走

### 12.1 全 Hosted(推荐 MVP)

- **[Replicate](https://replicate.com)** —— 上面那些模型 90% 都有,按 token 计费,**不用买卡**。
- **[fal.ai](https://fal.ai)** —— 速度最快,Flux 系列原生,适合走线上 demo。
- **[Together AI](https://together.ai)** —— Flux 跑得好。

后端只要给每个 capability 写一个 provider adapter,模型替换就是改个 model id。我们 [backend/internal/modelcatalog/application/service.go](../../backend/internal/modelcatalog/application/service.go) 那一层抽象正好接住。

### 12.2 自部署(降本 / 数据私密)

- **[ComfyUI](https://github.com/comfyanonymous/ComfyUI)** + 各种 custom nodes —— 把每个 capability 做成一个 workflow JSON,通过 ComfyUI HTTP API 触发。**这是产业事实标准**,Neowow 大概率底层就是这个。
- **[BentoML](https://github.com/bentoml/BentoML)** / **[Ray Serve](https://github.com/ray-project/ray)** —— 自己做服务化更可控。
- GPU:单卡 A10/L4(24G)能跑大部分,SUPIR / Flux 全量需要 A100(40G+)。

**建议**:MVP 阶段全走 Replicate(几分钱一次,验证产品),验证后哪个工具被用得最多,就把那个迁到自部署 ComfyUI 省钱。

---

## 13. 实施阶段建议

| 阶段 | 内容 | 估时 |
|---|---|---|
| **P0** | 后端 capability 抽象层 + Replicate adapter;选 1 个工具(打光)端到端打通,验证管线 | 2-3 天 |
| **P1** | 高清(Real-ESRGAN) + 抠图(BiRefNet) —— **两个无 UI 需求、出效果最快的** | 1 天 |
| **P2** | 灯光面板(r3f + IC-Light)—— **整篇里 UI 工作量最大的**,但视觉冲击最强 | 3-4 天 |
| **P3** | 多视图(Zero123++ → 6 张) + 3D mesh 节点(InstantMesh + r3f viewer) | 3 天 |
| **P4** | outpaint(Flux-Fill) + 蒙版画笔(fabric.js) | 2 天 |
| **P5** | 角色一致(PuLID 适配现有 reference 流) | 2 天 |
| **P6** | 360 全景(PanFusion + pannellum viewer 节点) | 2 天 |

---

## 14. 需要你拍板

1. **MVP 走 Hosted 还是先自部署?** —— 我的建议是 Hosted(Replicate / fal.ai),原因见 §12.1。需要你确认有没有现成账号/预算。
2. **第一个端到端打通的工具选哪个?** —— 我的建议是**打光**(IC-Light),因为它视觉效果最强、最像 neowow 的卖点。但如果你更想看到"立即对图像质量有提升",选**高清**(Real-ESRGAN)更安全。
3. **3D mesh 节点要不要做?** —— 这是相对最有差异化的能力(neowow 都没做到自由相机),也是工作量最大的一块(r3f viewer + InstantMesh 后端)。可以 P3 再决定。

---

## 15. 下一步

回话告诉我 §14 三个问题的取舍,我就把 §13 的 P0 拆成 commit-sized 任务清单(还是不动代码,只规划)。
