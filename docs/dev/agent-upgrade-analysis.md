# CCY Canvas 智能体（Agent）体验升级 —— 分析与设计

> 状态：**实施中** · 2026-06-30 · 对标 NeoWow agent 面板

## 实施进度（2026-06-30）
**P0 完成并验证**（全前端，`src/app/components/AgentRunPanel.tsx`）：面板保持挂载（display 切显隐，不再 unmount）；历史会话**常驻侧栏** + 空态 + 删除 + 新建（`ConversationSidebar`）；**执行模式 toggle**（`ExecutionModeToggle`，手动确认/自动生成，localStorage，仅改前端 `needsConfirmation`）；**问候 + 快捷 chips**（空态，来源 `getAllInvokableSlashSkills`）；header 侧栏折叠按钮。
**P1 部分完成并验证**：问候用户名（`src/app/api/me.ts` `getCurrentUser`→`/api/auth/me`）；composer **"+" 菜单**（`AttachMenu`：从画布添加 @引用 / 技能 picker / 模型 picker）；**per-message 模型覆盖**（前端 run body `model` + 后端 `agentRunRequest.Model` 覆盖 `catalogModel`，`agent_run_handler.go`）。
验证：`tsc` ✅、前端 162 测试 ✅、前端生产构建 ✅、后端 `go build` ✅、skills 测试 ✅；后端已重启 :9090。
**P1 剩余 / P2 未做**：execution_mode 落库（migration+sqlc+run body）；会话重命名端点+inline；技能管理弹窗+单文件.md 上传；技能文件夹上传/references（COS）；模板版本/更新；语音输入；sessions/grid 视图。详见 §4。

---
> 原分析（下文）：**对标 NeoWow agent 面板**
> 目标：把 **后端 agent 配置 + prompt/技能模板管理** 与 **新 UI/交互** 串联起来。
> 方法：多代理只读探查（5 子系统映射）→ 综合设计 → 对照代码的可行性审查。本文档已并入审查的关键修正。

---

## 0. 一句话结论
现有智能体**比截图(空状态)丰富得多**——`AgentRunPanel.tsx`(886 行)已有 agent 选择 / 多会话 / SSE 流式 / slash 技能 / 画布实时 patch / video·audio 待确认卡;后端有 17 个层级化种子 agent、会话持久化、`agent_settings`。**升级 ≈ 在已有骨架上补 UI 与少量后端字段**,大量可复用。**P0 可做到 100% 前端、零新端点、零 schema 变更。**

---

## 1. 现状总览（end-to-end）

- **前端面板** `src/app/components/AgentRunPanel.tsx:77-886`(680×560 浮层,`Canvas.tsx:303,1593-1602` 的 FAB 切换)。打开时并发 `listAgents()`+`listSkills()`(`:152-163`),默认选 `agents[0]`。结构:agent 下拉 `AgentPicker:888+`、会话下拉 `ConversationMenu:1430-1547`、聊天区、composer(`textarea`+`SlashMenu:1341-1428`+发送)。底部 "输入 / 唤出技能（共 N 个）"。
- **会话/历史**:每 `${agentId}::${convId}` 一组 turns,懒加载 12 条(`:188-204`)。会话列表 `listAgentConversations`(`skills.ts:247`)已存在,但只藏在下拉里,无常驻面板/空态。
- **运行链路(SSE)**:`start()`→`buildAgentRunMessage()`(`agent-skill-commands.ts` 解析 slash)→`runAgent()`(`agent-run.ts:45`)POST `/api/app/agents/{id}/run`。后端 `agent_run_handler.go:75-234`:鉴权→`GetAgent`→`resolveAgentRoute`(子 agent 在 simple 模式继承父路由 `creator_suite_agents.go:264-281`)→`ResolveModelEndpoints`→工具集 = canvas tools(`tools.go:77-199`,受 `agent.CanvasTools`)+ `LoadBoundSkills(agent.SkillIDs)` 技能工具 + deep_retrieve + sub-agent tools。`ResolveSlashSkillMessage`(`slash_skill_commands.go:16-51`)进循环前把 `/command` 内联成模板。`Runner.Run`(`agent_runner.go:27-188`)≤12 步流式,收尾写 `agent_runs` + 两条 `agent_conversation_messages`,首轮自动取标题。
- **prompt/模板管理**:技能存 `skills` 表,`kind='prompt'` 的 `spec` 含 `{slash_command, content_md, user_template}`。creator-suite 由 Go embed FS 启动时 upsert(`creator_suite_seed.go`),靠 `source_path`+spec diff 检测变更,**无版本字段、无用户侧更新按钮**。Agent `system_prompt` = `name+description+通用后缀`(`creator_suite_agents.go:118-120`),UI 不可见。技能上传仅前端单文件 `.md`(`settings/skill-import.ts:17-55`→`POST /api/app/skills`),**无文件夹**。
- **执行模式(关键修正)**:确认门是**前端**逻辑,**不在后端**。`AgentRunPanel.tsx:282-288` `serviceTypeMap` + `:329` `needsConfirmation = serviceType==='video'||'audio'`,`serviceType` 取自**画布节点类型**。后端 `tools.go:243-257` 的 `run_node` **无条件**发 `canvas_patch op=run_node`,不含任何 pending/service_type 逻辑。后端的 `AgentUseModeSettingKey`(`creator_suite_agents.go:14-18`,`admin` 端点 `admin_handler.go:101-114`)语义是**子 agent 路由继承(simple/advanced)**,与"手动/自动确认"**正交**,不可复用。

---

## 2. 差距分析（对照参考 UX）

| 参考 UX 能力 | 现状 | 缺口 | 命中代码 |
|---|---|---|---|
| 问候 header(Hi 用户0105!) | 无 | **无用户名数据源**(全仓 0 命中 user store/`/api/app/me`) | `AgentRunPanel.tsx:77-213`;后端仅 session claims |
| 快捷 chips(优化提示词/创作音乐/生成3D构图) | 无 | 无 chips 组件;来源需选 | 静态 placeholder `:769-775` |
| 历史会话面板(列表+切换+空态) | 部分(复用) | 仅藏在下拉;无常驻面板/空态/grid 切换 | 数据就绪 `skills.ts:247`;UI `ConversationMenu:1430-1547` |
| 执行模式 toggle(手动确认/自动生成) | 部分 | 行为硬编码在**前端** `:329`;无 UI;后端 use-mode 是另一语义 | `:282-288`,`:329`,`PendingRunCard:1164-1244` |
| Composer "+" — 从画布添加 | 无 | 无入口 | 可复用 `useStore(nodes):80`,run body 已带 nodes/edges |
| Composer "+" — 技能 picker | 部分 | 只有 `/` slash;无可视面板 | `SlashMenu:1341-1428` |
| Composer "+" — 模型 picker | 部分 | 模型是 agent 级;run 无 model 入参 | `agent.model`;`backendModels store.ts:227` |
| 技能管理弹窗(list/search) | 部分(复用) | 在 Settings→Skills,非 agent 面板浮层 | `settings/SkillsSettingsTab.tsx` |
| 上传技能 .md | 有(复用) | 已支持单文件/URL | `settings/skill-import.ts:17-55` |
| 上传技能 文件夹(SKILL.md+references/) | 无 | 无多文件模型/端点 | spec 扁平 JSONB;无 references |
| 发现新版本/更新 | 无 | spec 无 version;仅重启 silent diff | `creator_suite_seed.go` |
| 语音输入(mic) | 无 | 无录音/STT | composer 纯文本 `:824-866` |
| 新会话(+) | 有(复用) | 已有 `newChat()`,不显眼 | `:749`,`createAgentConversation skills.ts:251` |
| 会话重命名 | 部分 | 首轮自动取标题后冻结,无重命名 | `agent_run_handler.go:224-232`(无端点) |

---

## 3. 升级设计

### (a) UI / 交互（建议拆分 `AgentRunPanel.tsx`,避免单文件继续膨胀）
```
┌ Header: agent 选择 │ 模式 toggle │ 会话(+) │ 管理技能 │ 关闭 ┐
├ 左:历史会话(可折叠)  │ 右:聊天区                              │
│   空态"暂无历史会话"  │   问候+快捷 chips(仅空会话) / 气泡+RunStep │
├ Composer: [+菜单][textarea][mic][模型徽标][发送]              │
```
1. **问候+快捷 chips** → `AgentGreeting.tsx`。⚠️ chips 来源用 `getAllInvokableSlashSkills`(全局技能 `:228`)**而非绑定技能**——种子 agent 的 `skill_ids` 多为空,用绑定会是空 chips。点击填 `/command`。仅 `!hasAnyContent` 渲染(替换 `:769-775`)。
2. **历史会话常驻面板** → 把 `ConversationMenu` 重构为 `ConversationSidebar.tsx` + 空态 + grid 切换。复用 `listAgentConversations`/`createAgentConversation`/`deleteAgentConversation`。
3. **执行模式 toggle** → `ExecutionModeToggle.tsx`。⚠️ **仅改前端 `:329` 判断**:manual=全部走 `PendingRunCard`,auto=全部直跑。后端字段只作持久化默认值(P1),**P0 不碰 `tools.go`、不碰后端 use-mode**(语义不同)。
4. **Composer "+" 菜单** → `ComposerAttachMenu.tsx`:从画布添加(`useStore(nodes)`→注入 `attached_node_ids`)/技能(复用 slash 数据)/模型(`backendModels`,需按 agent service_type **过滤**避免选到无 endpoint 的模型)。
5. **技能管理+上传弹窗** → `SkillManagerModal.tsx`,复用 `SkillsSettingsTab` 逻辑(抽共享)。单文件 `.md` 复用 `parseSkillMarkdown`;文件夹用 `<input webkitdirectory>` 读 `SKILL.md`+`references/`。
6. **语音输入** → mic 按钮,先浏览器 `webkitSpeechRecognition`(P2)。
7. **新会话/重命名** → `newChat()` 提到侧栏顶部显眼;卡片 inline 重命名。

### (b) 后端
1. **执行模式持久化(P1)**:`agents` 加 `execution_mode TEXT DEFAULT 'auto'`(auto|manual);run body 加 `execution_mode` per-turn 覆盖。⚠️ **确认门仍在前端**(见 §1 修正),后端字段只决定 toggle 初值,**勿改 `run_node` 工具**。
2. **per-message 模型覆盖(P1)**:`agentRunRequest`(`agent_run_handler.go:51-67`,当前无 Model)加 `Model`;在 `:113-115` `resolveAgentRoute` 后覆盖 `catalogModel` 再 `ResolveModelEndpoints`。⚠️ 覆盖会绕过 route 承载的 provider/temperature,需回退/报错。
3. **会话重命名(P1)**:新增 huma `PUT /api/app/agents/{id}/conversations/{cid}`(`handler.go:125-148` 风格),新增独立 rename query(非复用 `TouchAgentConversation`)。
4. **技能文件夹上传(P2)**:`POST /api/app/skills/import`(multipart)。⚠️ references **不要全塞 `spec` JSONB**(体积/二进制问题)——文本进 spec,图片走已有 **COS 签名代理**(复用本仓 proxy);run 时谨慎拼接,控 token。上传产物受后端约束**只能 `scope=personal`+本人可见**(`handler.go:320`,`guardMutation:843`),分享/global 需 admin 通道。
5. **模板版本(P2)**:`spec` 加 `version`+`source_hash`;`EnsureCreatorSuiteSeeds` diff 时 bump;`GET /api/app/skills/{id}/updates` 驱动"发现新版本"。仅补字段、复用 seed diff(无历史版本表,回滚另议)。
6. **用户名(P1)**:新增 `/api/app/me` 或前端 auth store(问候依赖,**P0 阻塞项**)。

### (c) 串联点（agent 配置 + prompt 管理 → UI）
- `agent.system_prompt` + 绑定技能 → composer slash 列表/计数(已有) + header tooltip 展示"这个 agent 会什么"。
- `kind='prompt'` 技能 → **快捷 chips / 技能 picker**,把模板库变成引导式入口。
- `agent.model` + `backendModels` → composer 模型徽标 + per-message 覆盖(P1)。
- `execution_mode` → toggle 初值 + 前端确认门(`:329`)。
- 技能上传 → 管理弹窗 → `listSkills()` 刷新 → 立即进 slash 发现(`:228` 跨全部技能)→ 绑定后进 chips;version → "更新"徽标。

---

## 4. 分阶段实施路线（已并入审查修正）

**P0（100% 前端、零端点、零 schema）**
- [ ] **前置技术项**:把面板 `open=false` 的 `return null`(`AgentRunPanel.tsx:641`,整树卸载)改为切显隐——否则常驻侧栏/录音/流式进度一关即丢。
- [ ] 历史会话常驻侧栏 + 空态(重构 `ConversationMenu`,复用会话 CRUD)。
- [ ] 新会话"+"显眼化 + 卡片删除(复用 `newChat`/`deleteAgentConversation`)。
- [ ] 执行模式 toggle —— **仅前端改 `:329`**(状态存 localStorage/zustand,不落库)。
- [ ] 快捷 chips —— 来源 `getAllInvokableSlashSkills`(全局技能,规避空 chips),仅空会话渲染。

**P1（需后端字段/端点）**
- [ ] 用户名 `/api/app/me`(或 auth store)+ 问候 header。
- [ ] 执行模式落库(`agents.execution_mode` + run body),toggle 初值来源。
- [ ] per-message 模型 picker(run body `model` + 后端覆盖路由 + service_type 过滤)。
- [ ] Composer "+" 菜单(从画布添加 / 技能 picker)。
- [ ] 技能管理弹窗 + 单文件 `.md` 上传(复用 `SkillsSettingsTab`/`parseSkillMarkdown`)。
- [ ] 会话重命名端点 + inline 编辑。

**P2（净新增）**
- [ ] 技能文件夹上传(`POST /skills/import` + references,图片走 COS 代理)。
- [ ] 模板版本 + "发现新版本/更新"(`GET /skills/{id}/updates`)。
- [ ] 语音输入。
- [ ] sessions/grid 视图、`GET /api/app/agents/{id}/resolved`(prompt 预览)。

**复用清单**:会话 CRUD、`getBoundSlashSkills`/`getAllInvokableSlashSkills`、`parseSkillMarkdown`、`PendingRunCard`、`SlashMenu`、`SkillsSettingsTab` 逻辑、`TouchAgentConversation`、run body 已带 nodes/edges、COS 签名代理。
**净新清单**:面板保持挂载、execution_mode 字段、per-message model 入参、技能文件夹/references、技能版本、语音、用户名 context、会话 rename。

---

## 5. 风险与开放问题（含审查修正）
1. **【最高风险·已修正】执行模式确认门在前端不在后端**。原始设计误指后端 `run_node`(`tools.go:257` 无门);正确做法是改前端 `AgentRunPanel.tsx:329`。后端 `AgentUseMode` 是子 agent 路由继承(`creator_suite_agents.go:265`),与确认门**正交**,勿复用其字段。
2. **问候用户名无数据源**——P0 之前必须先建 `/api/app/me` 或 auth store(故问候归 P1)。
3. **面板整树卸载**(`:641`)——引入常驻侧栏前必须改为切显隐,否则 in-flight SSE/状态丢失(列为 P0 前置)。
4. **per-message 模型**覆盖与多供应商路由耦合,需回退;picker 须按 agent service_type 过滤(`backendModels` 是 provider 维度)。
5. **技能上传 scope**:用户上传强制 `personal`+本人可见;分享/global 需 admin。
6. **文件夹技能存储**:references 文本进 spec、图片走 COS;定大小/数量上限;run 时控 token。
7. **版本机制无回滚/灰度**:加 version≠历史版本表,回滚/AB 需 `skill_versions`(超本轮范围)。
8. **语音 STT 合规**:浏览器 API 兼容差且数据外发;自管需后端 STT + 隐私评估。

---

## 6. 关键文件
前端:`src/app/components/AgentRunPanel.tsx`(`:282-288` serviceTypeMap、`:329` 确认门、`:641` 卸载、`:769-775` 空态、`:1164-1244` PendingRunCard、`:1341-1428` SlashMenu、`:1430-1547` ConversationMenu)、`src/app/components/Canvas.tsx:303,1593-1602`、`src/app/components/settings/SkillsSettingsTab.tsx`、`src/app/components/settings/skill-import.ts`、`src/app/api/skills.ts`、`src/app/api/agent-run.ts`、`src/app/components/agent-skill-commands.ts`、`src/app/store.ts:227`。
后端:`backend/internal/skills/interfaces/agent_run_handler.go`(`:51-67` 请求体、`:113-115` 模型解析)、`backend/internal/skills/interfaces/handler.go`(会话 CRUD `:125-148`、`:320` personal scope、`:843` guard)、`backend/internal/skills/interfaces/admin_handler.go:101-114`、`backend/internal/skills/application/{slash_skill_commands.go:66-72, creator_suite_agents.go:14-18/118-120/264-281, creator_suite_seed.go, tools.go:243-257, agent_runner.go}`、`backend/db/migrations/{007,008,009,017}_*.sql`。
