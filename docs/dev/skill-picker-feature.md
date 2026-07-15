# 技能上拉框 / 技能驱动生成 —— 设计与 TODO

> 状态：**设计中（已搁置，待实施）** · 起草 2026-06-30
> 目标：把后端已有的 creator-suite skills 作为「参考提示词模板」接入图像生成；在图片二次创作对话框里做一个分类「上拉框」选择技能；并把「九宫格」下拉改造成技能驱动（选技能 → 建派生节点生成）。参考产品：NeoWow 的「九宫格」下拉 + 对话框上拉框。

---

## 1. 背景 / 目标

参考 UI（NeoWow）里：
- 「九宫格」按钮下拉是一组**技法模板**（多机位九宫格 / 角色脸部三视图 / 角色设定图 / 场景设定图 / 产品设定图 / 25宫格连贯分镜 / 剧情推演四宫格 / 电影级光影校正 …）。
- 选一项会**创建一个新节点**，该节点引用对应技能作为参考提示词进行生成。
- 节点对话框底部有一个**分类上拉框**（分镜叙事 / 空间与机位 / 设定图 / 质感调节），可在其中切换技能。

我们要在自己的画布里实现「同理」的能力，技能数据来自**我们自己的后端**。

---

## 2. 现状调研（关键事实 + 代码位置）

### 2.1 后端 skills 体系
- HTTP 路由（`backend/internal/skills/interfaces/handler.go`）：
  - `GET /api/app/skills` —— 列出可见技能（global + 个人），返回扁平 `SkillItem[]`
  - `POST/PUT/DELETE /api/app/skills[/{id}]`、`POST /api/app/skills/{id}/invoke`
  - 管理端：`GET/POST/PUT/DELETE /api/admin/skills`
- 技能数据模型（`backend/db/migrations/007_skills_and_agents.sql`）：
  `id, scope(global|personal|team), owner_id, name, description, category, icon, kind(http|prompt|code), spec(JSON), input_schema, output_schema, enabled, created_at, updated_at`
  - **模板正文**在 `spec` 里：code 类技能是 `spec.content_md`；prompt 类是 `spec.user_template`（含 `prompt_type` / `slash_command`）。
  - `category` 是**按种子目录路径自动生成**的（如 `creator-suite/art_skills/2D_chinese_guofeng/art_prompt`）——目前**无服务端分组接口**，分组要前端按 `category` 解析。
- 种子（187 个）：`backend/internal/skills/application/seeds/creator_suite_skills/**` 与 `creator_suite_prompts/**`，经 `//go:embed` 嵌入，启动时 `EnsureCreatorSuiteSeeds()`（`creator_suite_seed.go`）写库。

### 2.2 种子结构（关键：画风 × 类型 矩阵）
`creator_suite_skills/`
- `art_skills/<画风>/art_prompt/`：`art_character`、`art_prop`、`art_scene`（各含 `_derivative`）、`art_storyboard_video`
- `art_skills/<画风>/driector_skills/`：`director_planning_style`、`director_storyboard`、`director_storyboard_table_style`
- `story_skills/<题材>/driector_skills/`：导演类（**偏文本/叙事，不适合图像生成**）
- `production_skills/`：`storyboard_prompt_techniques`、`storyboard_table_techniques`

画风（~12 种）：`2D_90s_japanese_anime`、`2D_chinese_guofeng`、`2D_flat_design`、`2D_mature_urban_romance`、`3D_anime_render`、`3D_chinese_traditional`、`3D_clay_stopmotion`、`3D_guofeng_cyber`、`realpeople_ancient_chinese`、`realpeople_modern_city`、`realpeople_urban_modern` …

`creator_suite_prompts/`：`audioBindPrompt`、`eventExtraction`、`scriptAssetExtraction`、`videoPromptGeneration`（偏文本/视频）

**适合图像生成的类型**：`art_character`（角色设定/三视图）、`art_scene`（场景设定图）、`art_prop`（产品/道具设定图）、`art_storyboard_video` + `director_storyboard` + `production_skills`（分镜/技法）。**每个类型按画风各存一份**。

### 2.3 前端
- 已有技能 client：`src/app/api/skills.ts` —— `listSkills()` → `GET /api/app/skills`，返回扁平 `Skill[]`（含 `category`）。
- 生成请求：`src/app/store.ts` 的 `apiGenerate(...)`（约 2586 行）当前只传 `prompt` 文本，**无 skill_id**。
- 图片二次创作工具栏 / 对话框：`src/app/components/nodes/CustomNodes.tsx` 的 `ImageActionToolbar`（约 3067 行起）；动作编辑器 + Dialog footer（约 3500–3630）。**当前 image action 对话框没有底部参数行**（上拉框要新加）。
- 「九宫格」下拉：`GRID_COMPOSE_PRESETS`（4/9/16/25），`openDraft('grid-compose'/'split')` → `handleGenerate()`。

### 2.4 后端生成链路（skill_id 注入点）
- `backend/internal/modelcatalog/application/service.go`
  - `GenerateRequest`（约 919 行）：含 `ServiceType/Model/Prompt/Size/.../ReferenceImages/Parameters` 等，**无 SkillID**。
  - `Generate()`（约 1213 行）：组装 prompt 并下发 provider —— 注入技能模板就在这里。
  - service 目前**不持有 skills 仓储**，需新增跨域依赖（modelcatalog → skills repo）。

---

## 3. 已确认决策
1. **生成接入方式：后端 skill_id 集成**。生成请求带 `skill_id`，后端加载技能、取模板与用户 prompt 合并后再发模型（非前端拼字符串）。
2. **技能范围/分组：由我筛选并映射成干净分组**（只露出适合图像生成的，过滤掉 story/纯文本类）。
3. **「九宫格」下拉：改成技能驱动**（选技能 → 建派生节点、绑定 skill_id 生成），对标参考图。

## 4. 待定决策（实施前需拍板）
- **画风 × 类型 的呈现方式**（设定图/分镜每种画风一份，上拉框怎么列）：
  - A.（推荐）顶层按类型（角色设定图/场景设定图/产品设定图/分镜…），选中后**二级选画风**。最贴参考图且不丢画风信息。
  - B. 只列类型单条，画风用**默认/项目当前画风**（需先定义"项目当前画风"或一个默认值）。
  - C. 扁平全列「类型·画风」（条目多）。
- 是否需要"项目级画风"概念（与 B 相关；当前 app 似乎没有显式画风状态，参考图里有"素材-风格"节点）。

---

## 5. 实施计划

### 5.1 后端
- [ ] `GenerateRequest` 增 `SkillID string`；HTTP 请求 DTO（modelcatalog interfaces 的 generate handler）同步加 `skill_id`。
- [ ] 给 modelcatalog `Service` 注入 skills 仓储/读取器（main.go 装配处补依赖）。
- [ ] `Generate()` 中：`SkillID` 非空 → 加载技能 → 取 `spec.content_md`（code）或 `spec.user_template`（prompt）→ 作为**系统级参考提示词**与用户 `Prompt` 合并（建议拼接策略：技能模板在前作约束，用户 prompt 在后作具体诉求；或作为 system/instruction 段）。
- [ ]（可选但推荐）技能"图像可用性"标记：给技能 `spec` 加 `applicable_to: ["image"]` 或新增 `GET /api/app/skills?usage=image`，避免前端硬编码白名单。否则前端用白名单过滤（见 §6）。
- [ ] 生成日志记录所用 skill_id（便于追溯）。
- [ ] 单测：带 skill_id 的 Generate 注入模板正确；skill 不存在/不可用时降级（仅用用户 prompt）。

### 5.2 前端
- [ ] `src/app/api/skills.ts`：若后端加了过滤参数则支持 `listSkills({usage:'image'})`；否则前端按白名单过滤。
- [ ] 新增 `SkillPicker` 上拉框组件（分类、二级画风、图标、当前选中），放在 image action 对话框底部参数行（参考 `MediaParamsPopover` 的位置/样式，约 CustomNodes 1862）。
- [ ] `ImageActionDraft` 增 `skillId?`（约 2296）；`openDraft()` 接受 `skillId`（约 3114）；`handleGenerate()` 把 `skillId` 透传；`spawnDerivedNode()` payload 加 `skillId`（约 3148）。
- [ ] `store.ts` 的 `apiGenerate(...)` 调用与类型加 `skill_id`（约 2586）。
- [ ] 「九宫格」下拉：由 `GRID_COMPOSE_PRESETS` 改为**技能列表**（按 §4 决策的分组），点击 → `openDraft` 建派生节点并绑定 skillId。
- [ ] 分组数据：实现 §6 的"筛选 + 干净分组映射"（前端常量或来自后端标记）。

### 5.3 验收
- [ ] 选技能 → 生成结果体现该技能模板（如角色三视图/场景设定图）。
- [ ] 九宫格下拉选项创建带 skill 的派生节点并成功生成。
- [ ] 上拉框分组清晰、只含图像相关技能。
- [ ] `tsc` / 前端测试 / `go build` / 后端测试 全绿。

---

## 6. 筛选 + 干净分组 映射（草案，待 §4 决策后定稿）

只露出图像相关类型，映射到参考图式分组：

| 分组 | 条目（类型） | 后端技能 name | 取值 |
|---|---|---|---|
| 设定图 | 角色设定图 / 角色三视图 | `art_character` | 各画风一份 |
| 设定图 | 场景设定图 | `art_scene` | 各画风一份 |
| 设定图 | 产品设定图 | `art_prop` | 各画风一份 |
| 分镜叙事 | 分镜（出视频镜头） | `art_storyboard_video` | 各画风一份 |
| 分镜叙事 | 分镜技法 / 表格分镜 | `director_storyboard` / `director_storyboard_table_style` / `production_skills/*` | 画风相关/通用 |

> 画风维度的具体呈现按 §4 决策（A/B/C）落地。story_skills、creator_suite_prompts（事件提取/剧本资产/视频提示词/音频绑定）**不进图像上拉框**。

---

## 7. 风险 / 备注
- **跨域依赖**：modelcatalog 引用 skills 仓储，注意分层与循环依赖；可只传一个最小读取接口（`GetSkillTemplate(id) -> (text, kind)`）。
- **模板很长**：`spec.content_md` 含大量约束表格，拼进 prompt 可能超长/影响出图，需要裁剪或作为 system 段并控制长度。
- **画风矩阵**：12 画风 × 多类型，二级菜单层级别太深；A 方案二级选画风较平衡。
- **既有数据兼容**：skill_id 为空时完全走旧逻辑，保证不回归。
- 与本次会话其它改动（下载链路、视频悬停、多角度/打光编辑器）相互独立。
