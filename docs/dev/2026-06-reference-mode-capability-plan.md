# 视频参考模式 — 能力注册表方案

> 状态：已批准，待实施（P1+P2 先行）
> 日期：2026-06-11
> 关联：节点底部 `首尾帧 / 多图参考 / 动作模仿 / 全能参考 / 视频编辑` tab

---

## 1. 问题陈述

节点底部那排参考模式 tab **目前是纯视觉装饰**，没有任何实际作用。三处断链：

1. **点击只写状态不发请求**
   [CustomNodes.tsx:1058](../../src/app/components/nodes/CustomNodes.tsx) 点 tab 仅写 `params.referenceVariant`。

2. **runNode 根本不读这个状态**
   [store.ts:1740](../../src/app/store.ts) 构造请求时 `reference_mode` 是按"有几张图、有没有视频"自动猜的（`image_reference` / `auto` 二选一），**完全忽略** `referenceVariant`。

3. **前后端词汇表对不上**
   后端 `ReferenceMode` 词汇是 `auto / start_frame / start_end / image_reference`（service.go:612），tab 的 key 是 `first-last / multi-image / motion-mimic / all-in-one / video-edit`，两套没有映射。

4. **无输入校验**
   `动作模仿`（需要上游视频）、`视频编辑`（需要上游视频）这些有硬输入前提的模式，UI 不校验、后端也没有对应 payload 形态——点了等于按普通文生视频发，大概率上游报错。

---

## 2. 核心抽象：能力注册表

一个 mode = 一条能力声明，**输入要求 / 后端语义 / 槽位语义**三件套缺一不可。

```ts
// src/app/reference-modes.ts （新增）
type ReferenceModeSpec = {
  key: 'first-last' | 'multi-image' | 'motion-mimic' | 'all-in-one' | 'video-edit';

  // ① 输入门槛 —— 决定 tab 能否点
  requires: {
    images: { min: number; max: number };
    videos: { min: number; max: number };
  };

  // ② 后端语义 —— 映射到 reference_mode
  backendMode: 'start_end' | 'image_reference' | 'motion_mimic' | 'video_edit' | 'auto';

  // ③ 槽位语义 —— 缩略图条的具名标签
  slots: string[]; // 例：['首帧','尾帧'] / ['动作视频','形象参考(可选)']
};
```

**模型支持矩阵**放进现有 [model-templates.ts](../../src/app/model-templates.ts)：`ModelTemplate` 加 `referenceModes: string[]`。

> tab 实际渲染集合 = `当前模型.referenceModes` ∩ `输入满足的 modes`。

---

## 3. 实施阶段

### P1 — 前端 gating（让 tab 诚实）

- **tab 三态**：激活 / 可切换 / 禁用+原因。禁用半透明，hover 气泡说明（"动作模仿需要连接 1 个视频节点"）。
- **自动回退**：上游引用变化导致当前 mode 失效（如删掉视频）→ 落回第一个合法 mode + 面板顶部轻提示。**反向保护**，不允许停在非法状态。
- **槽位化缩略图条**：现在的 `1/2/3` 编号徽章 → mode 驱动的具名槽位。首尾帧显示"首帧/尾帧"（可交换顺序）；动作模仿显示"动作视频"槽；多图参考保留编号。
- **切 tab 不切模型**（重要修正）：tab 是同一模型的不同调用语义，不是换模型。当前模型不支持某 mode 时，该 tab 直接不渲染，而非切过去后悄悄换模型导致用户丢失选择。

### P2 — 链路打通（让请求正确）

- `runNode` 读 `referenceVariant` → 查注册表 → **preflight 校验**（输入不满足就地在面板报错，**不发请求**，省钱省一次 503）→ 映射 `backendMode` 填 `reference_mode`。
- 后端 `ReferenceMode` 词汇扩充 `start_end / motion_mimic / video_edit`；各 provider adapter 按能力分支：
  - Ark/Seedance：`first-last` → 已有的 first_frame/last_frame role（代码已存在，只是从未被正确触发）。
  - sora 风格：`video-edit` / `motion-mimic` → content 数组带 `video_url` item。
  - 不支持的组合在 `buildCandidates` 阶段过滤该渠道，错误直说"当前渠道不支持视频编辑"。

### P3 — 模型展示名（后台配置）

- migration 013：`provider_configs` 加 `model_labels JSONB`（`{"doubao-seedance-2-0-260128":"Seedance 2.0"}`）。
- admin 模型列表改双列小表：左列模型 ID（发请求用），右列展示名（选填，空则回退 ID）。
- 节点下拉 / 任务队列 / 历史全部走 `displayName(modelId)` 帮助函数。
- **不用** `id|名称` 管道语法塞进 model_list —— 会污染 `buildCandidates` 匹配逻辑，至少 5 处跟改，藏雷。

### P4 — 模型 mode 矩阵填充（数据）

实测/查文档填 `referenceModes`：Seedance 2.0 全系、Seedance 1.5（仅 2 图首尾帧）、sora-v3（文生+首帧）、可灵/Vidu 按文档。未填模型默认只开 `multi-image`（最保守）。

---

## 4. 关键文件

| 文件 | 改动 |
|---|---|
| `src/app/reference-modes.ts` | **新增** 能力注册表 |
| [src/app/model-templates.ts](../../src/app/model-templates.ts) | `ModelTemplate.referenceModes` |
| [src/app/components/nodes/CustomNodes.tsx](../../src/app/components/nodes/CustomNodes.tsx) | tab gating + 槽位条 |
| [src/app/store.ts](../../src/app/store.ts) | runNode preflight + mode 映射 |
| [backend/internal/modelcatalog/application/service.go](../../backend/internal/modelcatalog/application/service.go) | ReferenceMode 扩词 + adapter 分支 |
| `backend/db/migrations/013_model_labels.sql` | **新增** P3 |
| [src/app/components/admin/AdminModelCatalogPage.tsx](../../src/app/components/admin/AdminModelCatalogPage.tsx) | P3 双列模型表 |

**复用**：现有 `referenceVariant`（已持久化在节点 data，刷新/重连保留，不用改）、Ark 的 first_frame/last_frame role 代码（已存在）。

---

## 5. 验证

1. `go test ./internal/modelcatalog/...` + `npx tsc --noEmit` 全绿。
2. tab 禁用态：未连视频时"动作模仿"灰 + hover 提示。
3. 自动回退：动作模仿模式下删上游视频 → 自动落回首尾帧。
4. 链路：首尾帧 2 图 → 后端确实带 first_frame/last_frame role（抓 `backend/api.log`）。
5. 槽位：首尾帧两个缩略图显示"首帧/尾帧"，可交换。
6. 回归：Seedance/sora 现有配置不动，普通文生视频不受影响。

---

## 6. 执行顺序

**P1+P2 一波做**（拆开 P1 仍是"诚实的装饰"，没闭环价值）。P3 独立可并行。P4 随时间补。
