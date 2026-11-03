# 后端成本闭环 · 任务清单

Date: 2026-05-29
Status: 可勾选任务清单

配套：[决策备忘](../specs/2026-05-29-backend-cost-loop-decisions.md) · [实施指引](2026-05-29-backend-cost-loop-implementation-guide.md)

图例：`[P0]` 关键路径，必须先做；`[P1]` 重要；`[P2]` 可延后。`(依赖: X)` 表示前置任务。

---

## 规划交付（2026-05-29 顾问对话）

- [x] 现状调研：梳理前端/后端/设计三层进度差距
- [x] 主线决策：敲定「后端成本闭环优先」、huma、密钥仅 admin 可配 + 后端托管、切片推进法
- [x] 落地文档：决策备忘 `docs/superpowers/specs/2026-05-29-backend-cost-loop-decisions.md`
- [x] 落地文档：实施指引 `docs/superpowers/plans/2026-05-29-backend-cost-loop-implementation-guide.md`
- [x] 落地文档：任务清单 `docs/superpowers/plans/2026-05-29-backend-cost-loop-task-checklist.md`

---

## M0 · 地基

### S0 清理

- [x] `[P0]` `git rm --cached` 取消跟踪 `dist/`、`backend-dev.log`、`frontend-dev.log`（2026-05-29，未提交）
- [x] `[P0]` `.gitignore` 追加 `dist/`、`*.exe`、`*-dev.log`（2026-05-29，未提交）

### S1 huma 契约 + 共享鉴权

- [x] `[P0]` 引入 `huma/v2`（v2.38.0）+ `adapters/humachi` 依赖（2026-05-29，未提交；连带升级 chi→5.2.5、x/crypto→0.50）
- [x] `[P0]` 新建 `internal/platform/httpapi`：创建并配置 huma API（`OpenAPIPath=/api/openapi`、注册 cookie 安全方案）（2026-05-29，未提交）
- [x] `[P0]` 新建 `internal/platform/authn`：按操作粒度的鉴权中间件（401/403）+ `ClaimsFromContext`（依赖: httpapi）（2026-05-29，未提交）
- [x] `[P0]` `cmd/api/main.go` 接线：humachi API + `UseMiddleware(authn)`（依赖: httpapi, authn）（2026-05-29，未提交）
- [x] `[P1]` 加一个受保护示例操作，验证未登录 401 / 非 admin 403 / admin 200（2026-05-29，`authn` 集成测试覆盖）
- [ ] `[P2]` （可选）把 `POST /api/admin/invitations` 迁成 huma 操作做示范
- [x] `[P0]` 验收：`go build ./...` 绿、`GET /api/openapi.json` 可用（2026-05-29，后端 build/test 绿；OpenAPI 由 huma 挂载）

---

## M1 · Model Catalog

### S2 目录只读链路

- [x] `[P0]` 迁移 `002_model_catalog.sql`：`relay_providers / model_definitions / model_permission_rules`（2026-05-29，未提交）
- [x] `[P0]` `db/queries/model_catalog.sql` + 重新 `sqlc generate`（依赖: 002）（2026-05-29，未提交）
- [x] `[P0]` 新建 `internal/modelcatalog`（domain/application/infrastructure/interfaces），只读用例（依赖: sqlc）（2026-05-29，未提交）
- [x] `[P0]` `GET /api/admin/models`（admin）、`GET /api/app/models`（登录，仅 enabled+有权，无密钥/内部定价）（依赖: modelcatalog, S1）（2026-05-29，未提交；应用层测试覆盖定价过滤，sqlc 查询接 user/role 权限）
- [x] `[P1]` 前端 `admin/ModelConfigTable` 切到 `GET /api/admin/models`（只读）（2026-05-29，未提交；由 `AdminModelCatalogPage` 承接）
- [ ] `[P0]` 验收：后台见 DB 模型；用户只见 enabled+有权模型

### S3 Provider 配置 + 密钥加密

- [x] `[P0]` 新建 `internal/platform/crypto`：AES-256-GCM（标准库）（2026-05-29，未提交）
- [x] `[P0]` `config` 加载 `CCY_ENCRYPTION_KEY` + 校验；`.env.example` 同步（2026-05-29，未提交；base64 32 bytes 测试覆盖）
- [x] `[P0]` `PUT /api/admin/relay-provider`（加密存储；留空不改、有值覆盖）（依赖: crypto, S2）（2026-05-29，未提交）
- [x] `[P0]` `GET /api/admin/relay-provider`（脱敏：`api_key_set`/`api_key_hint`，永不回明文）（2026-05-29，未提交）
- [x] `[P1]` `POST /api/admin/relay-provider/test`（用已存密钥测连通）（2026-05-29，未提交）
- [x] `[P1]` 前端 Provider 配置表单接上述端点（2026-05-29，未提交）
- [ ] `[P0]` 验收：DB 为密文、GET 无明文、留空更新不清空

### S4 模型 sync + 编辑 + 拆前端直连

- [x] `[P0]` `POST /api/admin/models/sync`（调 Provider `/v1/models`，新模型落 draft）（依赖: S3 adapter）（2026-05-29，未提交；新增计数测试覆盖）
- [x] `[P0]` `PATCH /api/admin/models/{id}`（schema/pricing/default/capability，后端权威校验）（2026-05-29，未提交；JSON 由请求/DB 约束，启用前要求 pricing）
- [x] `[P0]` `POST /api/admin/models/{id}/enable`、`/disable`（2026-05-29，未提交；enable 定价校验测试覆盖）
- [x] `[P1]` 前端 `admin/ModelConfigDrawer` 创建/编辑切后端（2026-05-29，未提交；当前为编辑抽屉）
- [x] `[P0]` **拆直连**：移除 `/app` 的 `model-config.ts` baseUrl/apiKey 直连与 `SettingsModal` 密钥项；`/app` 模型列表改用 `GET /api/app/models`（2026-05-29，未提交；store 测试覆盖不直连 provider）
- [x] `[P1]` `/app` 生成入口临时禁用/占位（M3 前），PR 注明（2026-05-29，未提交）
- [ ] `[P0]` 验收：管理员可 sync/编辑/启停；`/app` 无任何密钥输入与直连

---

## M2 · Pricing & Credits

- [ ] `[P0]` 迁移补 `credit_reservations`
- [ ] `[P0]` 引入 River + 每日配额重置 job（重置 `current_balance`，不跨日累积）+ River 迁移
- [ ] `[P0]` `POST /api/app/pricing/estimate`（鉴权 + 模型/权限/schema/定价校验）
- [ ] `[P0]` reserve 事务：锁账户 → 校验 → 扣减 → reservation → `reserve` ledger → job
- [ ] `[P0]` 结算：charge / refund / undercharge / admin 调整，全部入 ledger
- [ ] `[P1]` `GET /api/app/credits/summary`、admin `credit-adjustments` / `daily-quota` / `GET /api/admin/credit-ledger`
- [ ] `[P1]` 前端：顶栏剩余积分接真实、生成前显示预估
- [ ] `[P0]` 测试：domain 覆盖预留/结算/每日重置/定价计算

---

## M3 · Generation

- [ ] `[P0]` 迁移 `generation_jobs`、`model_invocations`
- [ ] `[P0]` NewAPI/OpenAI 兼容 adapter（封装在 catalog 起的边界内）
- [ ] `[P0]` River generation worker：`estimate → reserve → invoke → settle/release` + 失败/取消
- [ ] `[P0]` 成功生成 `asset`；Provider 响应/用量落 `model_invocations`
- [ ] `[P0]` `POST /api/app/generations`、`GET /api/app/generations/{id}`、列表（先轮询）
- [ ] `[P1]` 前端：节点运行动画、elapsed 基于 `started_at`（刷新不归零）、TaskQueue 接真实 job
- [ ] `[P0]` 验收：端到端一次图像生成（扣预留→出图→结算→落资产→进历史）
- [ ] `[P1]` 测试：worker 成功/失败、application 生成创建/结算

---

## M4 · Asset Library & 项目持久化

- [ ] `[P0]` 迁移 `projects / project_members / canvas_snapshots / assets`
- [ ] `[P1]` `/api/app/projects*`（含切项目存快照）
- [ ] `[P1]` `/api/app/assets*`（canvas-to-library、personal/team 可见性）
- [ ] `[P1]` 前端：Project/Space/History 从 localStorage 切后端；History masonry 接真实资产
- [ ] `[P1]` 验收：项目切换持久、历史来自真实生成、团队可见性正确

---

## M5 · Admin 控制台补全（中文）

- [ ] `[P1]` 邀请码：`POST/GET /api/admin/invitations`、`revoke`；前端管理页
- [ ] `[P1]` 成员：`GET/PATCH /api/admin/members*`、配额/禁用；前端管理页
- [ ] `[P2]` 概览：`dashboard/*` KPI + Recharts 图表
- [ ] `[P2]` 生成日志：`GET /api/admin/generation-jobs` + 筛选/详情
- [ ] `[P2]` 审计日志：`GET /api/admin/audit-logs`（只读、UI 不可删）
- [ ] `[P1]` admin 全量中文文案

---

## M6 · 收尾硬化

- [ ] `[P2]` 邮箱验证流程
- [ ] `[P2]` SSE 实时（`job.updated / asset.created / credit.updated`）
- [ ] `[P2]` 协作角色细化（owner/editor/viewer）
- [ ] `[P2]` 中文编码遗留清理
- [ ] `[P2]` 把 identity 等早期 chi handler 迁到 huma，OpenAPI 覆盖全量
- [ ] `[P2]` 端到端验收 + 可观测性

---

## 横切（贯穿各里程碑）

- [x] `[P0]` 新端点一律先以 huma 操作定义，前端据 `/api/openapi.json` 对齐（2026-05-29，M1 新端点已用 huma）
- [ ] `[P0]` 审计写入点：邀请、配额、积分调整、Provider/模型变更、启停用户/模型
- [x] `[P1]` 测试金字塔随功能同步补齐（2026-05-29，补 authn、modelcatalog application/interfaces、store 测试）
- [x] `[P1]` `/api/app/*` 响应不泄露密钥与内部定价（2026-05-29，`UserModelItem` 仅返回渲染字段）

---

## 关键路径（建议排期顺序）

```
S0 → S1 → S2 → S3 → S4   （M0+M1，端到端模型目录闭环）
      └→ M2（定价/积分，含 River 与 credit_reservations）
           └→ M3（生成，真正跑通成本闭环）
                └→ M4（资产/项目持久化）
                     └→ M5（admin 补全）→ M6（收尾）
```

`[P0]` 链路即最小可用成本闭环：S0→S1→S2→S3→S4→M2→M3 跑通后，"配置模型 → 用户生成 → 预留扣费 → 出图结算 → 落资产" 全程经后端，产品核心价值即兑现。
