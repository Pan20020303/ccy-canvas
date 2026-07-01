# HappyHorse 四模式 · 契约整理与对齐方案

> 依据：阿里云百炼 DashScope 官方 API 文档四份（文生 / 图生·首帧 / 参考生 / 视频编辑），
> 由用户于 2026-07-01 提供。本文把四个模式的**输入/参数/输出契约**整理为单一事实源，
> 对照现状代码逐层审计（前端模板/参考模式/门控 + 后端 media 数组/参数/校验），
> 给出分优先级的落地方案。审计由 6 个并行 agent 完成并经人工抽验核实。

## 0. 通用约定（四模式共有）

- **端点**：`POST /api/v1/services/aigc/video-generation/video-synthesis`，请求头 `X-DashScope-Async: enable`（**只支持异步**，缺失报 “does not support synchronous calls”）。
- **流程**：创建任务拿 `task_id` → 轮询 `GET /api/v1/tasks/{task_id}`（建议 15s 间隔）。状态 `PENDING→RUNNING→SUCCEEDED/FAILED`。
- **请求体**：`{ model, input:{ prompt?, media? }, parameters:{…} }`。
- **通用参数**：`resolution`{`720P` / `1080P`=**默认**}、`watermark`(bool，默认 **true**，右下角 “Happy Horse”)、`seed`(int `[0,2147483647]`)。
- **输出**：`output.video_url`（MP4 / H.264 / 24fps / **有效期 24h**，需及时转存）；`usage`{duration, SR, video_count=1, …}。
- **prompt 长度**：≤5000 非中文字符或 2500 中文字符，超出自动截断。

## 1. 模式 × 契约矩阵（单一事实源）

| 维度 | 文生 t2v | 首帧 i2v | 参考生 r2v | 视频编辑 video-edit |
|---|---|---|---|---|
| 模型 | `happyhorse-1.1-t2v`/`-1.0-t2v` | `-1.1-i2v`/`-1.0-i2v` | `-1.1-r2v`/`-1.0-r2v` | **仅** `happyhorse-1.0-video-edit` |
| prompt | **必选** | 可选 | **必选**（用 `[Image N]` 指代） | **必选** |
| media | **无** | 恰好 **1** × `first_frame` | **1~9** × `reference_image` | 恰好 **1** × `video` + **0~5** × `reference_image` |
| `resolution` | ✅ 720P/1080P(默认1080P) | ✅ 同左 | ✅ 同左 | ✅ 同左 |
| `ratio` | ✅ 9 档，默认 16:9 | ❌（跟随首帧） | ✅ 9 档，默认 16:9 | ❌ |
| `duration` | ✅ [3,15] 默认 5 | ✅ [3,15] 默认 5 | ✅ [3,15] 默认 5 | ❌（跟随源视频，输出 3~15s） |
| `watermark` | ✅ | ✅ | ✅ | ✅ |
| `seed` | ✅ | ✅ | ✅ | ✅ |
| `audio_setting` | ❌ | ❌ | ❌ | ✅ {`auto`=默认 / `origin`} |

`ratio` 9 档全集：`16:9, 9:16, 1:1, 4:3, 3:4, 4:5, 5:4, 9:21, 21:9`。

**素材约束要点**
- 首帧图（i2v）：JPEG/JPG/PNG/WEBP，宽高≥300px，比例 1:2.5~2.5:1，≤20MB，URL 或 base64。
- 参考图（r2v/video-edit）：短边≥400px（r2v；video-edit ≥300px），≤20MB，URL 或 base64。
- 待编辑视频（video-edit）：MP4/MOV(H.264)，3~60s，长边≤4096 / 短边≥360，比例 1:2.5~2.5:1，≤100MB，fps>8，**必须公网 URL，不支持 base64**。

**关键澄清**：文档中**没有「音频参考」，也没有「视频作为风格参考」**。视频只作为 video-edit 的*待编辑输入*；音频只作为 video-edit 的 `audio_setting` 参数（保留/自动原声）。此前「参考生支持音视频参考」的设想在官方契约里不成立。（画布已支持音频上传节点，但它是通用能力/供 TTS 与未来音频模型用，不接入任何 HappyHorse 视频模式。）

## 2. 现状对齐结论（分层）

已正确对齐的部分：
- **t2v**：模板参数、9 档比例、时长 [3,15]/默认5、无 media 门控，全部正确。
- **i2v**：`first-frame` 参考模式（恰好 1 图 0 视频）+ 门控 `images===1 && videos===0` 正确（本会话已把模式名正为「首帧」）。
- **r2v**：`multi-image`（1~9 图、0 视频）→ `image_reference` 正确；>9 或带视频时 store 预检拦截，不会发出畸形请求。
- 后端 media type 映射对 i2v→`first_frame`、r2v→`reference_image` 正确且有测试覆盖。

## 3. 差距清单（现状代码 vs 契约，按优先级）

### P0 — 会发出错误/不可用请求
1. **视频编辑根本发不出视频**。`buildDashScopeVideoMedia`（`vendor_video.go:496-510`）只遍历 `req.ReferenceImages`，从不读 `ReferenceVideo/ReferenceVideos`；`dashScopeReferenceImageMediaType`（512-531）对 `-video-edit` 返回 `reference_image`，**永不产出 `type:"video"`**。结果：源视频被静默丢弃，video-edit 无法工作。
2. **video-edit 视频会被当图片处理**。所有 url 走 `localPathToDataURL`（`service.go:2383-2431`，`image.Decode` 图片专用），视频路径会报错或被 base64；而契约要求视频**公网 URL 直传**。
3. **i2v 每次都发被禁止的 `aspect_ratio`**。前端 i2v 模板声明 `supportsAspectRatio:true` + 默认 `16:9`（`model-templates.ts:353-378`），`store.ts:2637` 对所有 video 无差别发 `aspect_ratio`，后端 `buildDashScopeVideoParameters:490` 模式盲转发。测试 `service_test.go:200-217` 还把这个错误行为锁死了。

### P1 — 契约缺项 / 防御缺失
4. **后端零 media 数量校验**（i2v 恰好1 / r2v 1~9 / video-edit ≤5 图）。仅靠前端预检，后端无纵深防御。
5. **`audio_setting` 全链路缺失**（GenerateRequest / handler / 参数构造 / 前端都没有）——video-edit 无法选“保留原声”。
6. **`watermark` 硬编码 false**（`vendor_video.go:482`），与文档默认 true 相悖且用户不可控（若产品有意去水印需显式声明）。
7. **video-edit 的 ratio/duration 是“碰巧没发”**而非强制屏蔽——一旦模板或 API 直连传了值就会漏发。

### P2 — UI 诚实性 / 打磨
8. **video-edit 参考图上限 2，文档是 5**（`reference-modes.ts:119`）——3~5 图合法请求被前端预检误拒。
9. **UI 门控不诚实**：r2v 连了视频或 >9 图时 tab 仍亮（靠 store 预检报错兜底）；video-edit 未强制“恰好 1 视频 / ≤5 图”。
10. **`seed` 全链路缺失**——无法复现生成。
11. **后端无取值/范围校验**（resolution/ratio/duration 白名单、r2v 图数上限），坏值只能等上游 4xx。
12. `watermark`/`seed`/`audio_setting` 在 `ModelTemplate` 类型里无字段，UI 无从表达。

## 4. 落地方案（分阶段）

### 阶段 A — P0 正确性（让 video-edit 真能用 + i2v 合规）
- **A3 i2v 去 ratio** — ✅ **已完成**（2026-07-01）：① 两个 i2v 模板移除 `supportsAspectRatio`/`aspectRatioOptions`/`defaults.aspectRatio`；② 后端 `buildDashScopeVideoParameters` 按模式网关 `aspect_ratio`，`-i2v`/`-video-edit` 一律不发，仅 `-t2v`/`-r2v` 发；③ 测试改为断言 i2v/video-edit 不含 ratio、r2v 含 ratio（含前端 model-templates.test）。同时把 `watermark:false` 注明为**产品有意去水印**（见下）。验证：前端 164 测试 + build，后端 modelcatalog 全套 go test，均通过。
- **A1 后端 media 构造支持视频** — ✅ **已完成**（2026-07-01）：`buildDashScopeVideoMedia` 现改为收 `ctx`，当 video-edit（模型 `-video-edit` 或 `ReferenceMode=="video_edit"`）时先 `prepend {type:"video", url}`（取自 `ReferenceVideo`/`ReferenceVideos[0]`，**绕过** `localPathToDataURL`），再 append 0~5 个 `reference_image`；`generateVideoDashScope` 改为无条件构造 media、非空才设 `input["media"]`（修好“有视频无图”被丢弃）。无源视频 / base64 视频均硬报错。
- **A2 视频 URL 公网化** — ✅ **已完成**（选①的简化版）：无需注入依赖——`assetstore.PresignGet` 是**包级函数**（`upload_handler` 亦直接调用），故 `resolveDashScopePublicVideoURL(ctx, url)` 直接调它把私有 COS 视频签成限时 URL（TTL=1h），非 COS/公网 URL 透传，data:/本地一律拒。核实结论保留：上传媒体在**私有 COS**（commit 9183f7a）；`isPublicHttpAssetUrl` 会把私有 COS URL 误判为公网 → 若不预签名会 403。图片走 base64（≤20MB）绕开，视频不能 base64（文档禁 + 100MB）。
- **C1（顺带）** — ✅ `reference-modes.ts` video-edit 参考图上限 **2→5**，对齐文档“1 视频 + 0~5 图”。
- 覆盖测试：新增 `TestBuildDashScopeVideoMediaEmitsVideoElementForVideoEdit` / `…WithoutReferenceImages` / `…RequiresVideo` / `…RejectsDataURLVideo`。后端 modelcatalog 全套 + 前端 164 测试 + build 全通过。

### 水印决策（B2 已定）
`watermark` 保持后端硬编码 `false`（**默认去水印**，产品有意为之，非 bug）。已在 `buildDashScopeVideoParameters` 注释说明；不做用户可控开关。

### 阶段 B — P1 参数与校验 — ✅ 已完成（2026-07-01）
- **B1 `audio_setting`** — ✅：`GenerateRequest.AudioSetting` + `generateInput.Body`(json `audio_setting`) + `store.ts` payload + `NodeGenerationParams.audioSetting`；参数面板仅 video-edit（`audioSettingOptions`）暴露「自动/保留原声」；后端仅对 video-edit 写 `parameters["audio_setting"]`（默认 auto）。
- **B2 `watermark`** — ✅ 定为**默认去水印**（硬编码 false + 代码注释声明意图，不做开关）。
- **B3 后端纵深校验** — ✅：新增 `validateDashScopeVideoRequest`（inline+async 两路都过），数量校验（t2v 无 / i2v==1 无视频 / r2v 1~9 无视频 / video-edit 恰好1视频+≤5图）；参数网关（video-edit 跳 ratio+duration；i2v 跳 ratio）。

### 阶段 C — P2 打磨 — ✅ 已完成（2026-07-01）
- **C1** — ✅ video-edit 图上限 2→5。
- **C2** — ✅ `happyHorseSuffixSatisfied`（抽为 reference-modes.ts 纯函数、单测覆盖）：r2v=1~9图·无视频；video-edit=恰好1视频·≤5图；分场景禁用提示。
- **C3** — ✅ `seed` 全链路（`GenerateRequest.Seed *int` + payload + 参数面板 numeric 输入，留空=随机、0~2147483647 钳制）；按当前模型 `supportsSeed` 门控 payload，防跨模型泄漏。
- **C4** — ✅ 后端取值白名单：resolution{720P/1080P}、ratio 9档(t2v/r2v)、duration[3,15]、seed 范围。

### 对抗式复审（3 lens）后修正
复审确认核心正确 + 完整（含 Seed/AudioSetting 经 Asynq request_payload 往返无损、校验双路径覆盖、无门控 flip-flop）。据其发现补修：①4 处 video_edit 检测统一走 `isDashScopeVideoEdit` + media-type 补 `video_edit` case；②video-edit 强制恰好 1 视频；③修 video-edit 参数标签的幽灵「5s」；④TS-provider payload 补 `seed`/`audio_setting`；⑤前端 payload + C2 门控补单测；⑥`allowed_parameters` 对齐 + 陈旧注释。

### 与本会话已完成工作的关系
- i2v→「首帧」重命名 + `images===1 && videos===0` 门控：与契约一致，阶段 A 前置。
- 画布音频上传节点（AudioReferenceNode）：与 HappyHorse 无关（r2v 不吃音频），保留为通用能力。

### 最终状态
四模式（t2v/i2v/r2v/video-edit）的输入媒体、参数网关、数量/取值校验、UI 门控与面板全部对齐 DashScope 文档。video-edit 从「完全不可用」→ 可用。验证：前端 170 测试 + build ✅ · 后端 modelcatalog/interfaces 全套 ✅。全部改动尚未提交。
