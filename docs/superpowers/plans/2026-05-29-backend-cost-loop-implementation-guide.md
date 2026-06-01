# 后端成本闭环 · 实施指引

Date: 2026-05-29
Status: 指引（供开发照做，不含已落库代码）

本文件把「后端成本闭环」主线拆成可执行的垂直切片，给出每步要建/改的文件、接口契约、设计要点与验收标准。决策依据见 [决策备忘](../specs/2026-05-29-backend-cost-loop-decisions.md)；可勾选的任务条目见 [任务清单](2026-05-29-backend-cost-loop-task-checklist.md)。

> 代码片段均为**设计示意**，用于明确签名与结构，不是最终实现。

## 总览

主线顺序：**Model Catalog → Pricing/Credits → Generation**，前端逐模块从 mock 切真实 API。

近期切片（M0 地基 + M1 模型目录）：

```
S0 清理        → S1 契约+鉴权骨架 → S2 目录只读链路
→ S3 Provider+密钥 → S4 模型 sync+编辑+拆前端直连
```

推进原则：每个切片结束都要 `go build ./...` + `go test ./...` + 前端 `build` 绿，且能单独演示。

## 当前代码事实（开发基线）

后端 `backend/`：

- `cmd/api/main.go`：纯 chi 手写路由；已挂 RealIP / RequestID / CORS / Logger 中间件、`/api/health`、`identityHandler.Routes(router)`。
- `internal/identity/`：domain/application/infrastructure/interfaces 四层齐全；HTTP 层已有 `RequireAdmin`（私有方法，绑在 identity `Handler` 上，包装 `http.HandlerFunc`）与 `sessionClaims` helper。
- `internal/credits/`：仅"初始账户创建 + 初始 ledger"。
- `internal/platform/session`：`Claims{UserID, Role, ExpiresAt}`，HMAC 签名 cookie，`Manager.Parse(value)` 已可用；cookie 名 `ccy_session`。
- `internal/platform/database/sqlc`：sqlc 生成层；查询源在 `db/queries/identity.sql`。
- `db/migrations/001_identity_credit.sql`：已建 `users / invitations / invitation_redemptions / credit_accounts / credit_ledger_entries`；**未建 `credit_reservations`**。
- 尚未集成 huma / OpenAPI / River。

前端 `src/app/`：

- `api/client.ts`、`auth/`、`components/`（Canvas、CustomNodes、Toolbar、TaskQueue、Navbar、admin/*）。
- `store.ts`（zustand + localStorage）、`model-config.ts`、`model-templates.ts`：含 baseUrl/apiKey 直连逻辑——S4 要拆除 `/app` 侧直连。
- admin 已有 `ModelConfigPage / ModelConfigTable / ModelConfigDrawer`，目前消费本地 mock。

---

## S0 · 清理

**目标**：仓库不再跟踪构建产物与运行日志。

**动作**：

- `git rm -r --cached dist`、`git rm --cached backend-dev.log frontend-dev.log`（只动索引，保留磁盘文件）。
- `.gitignore` 追加 `dist/`、`*.exe`、`*-dev.log`。

**验收**：`git status` 中不再出现 dist 与 dev.log；磁盘文件仍在。

---

## S1 · huma 契约 + 共享鉴权骨架

**目标**：引入 huma（OpenAPI 3.1），建立**可被所有上下文复用**的鉴权中间件，spec 暴露在 `/api/openapi.json`。

### 依赖

- `github.com/danielgtaylor/huma/v2`（v2.38.0）+ `adapters/humachi`。

### 要建/改的文件

- `internal/platform/httpapi/api.go`（新）：封装 huma API 的创建与配置。
- `internal/platform/authn/middleware.go`（新）：共享鉴权中间件 + claims 读取。
- `cmd/api/main.go`（改）：创建 humachi API、注册 security scheme、`UseMiddleware`、接线。

### huma 配置要点（基于 v2.38.0 实测）

```go
cfg := huma.DefaultConfig("CCY Canvas API", "0.1.0") // 默认即 OpenAPI 3.1
cfg.OpenAPIPath = "/api/openapi"                       // → /api/openapi.json 与 /api/openapi.yaml
cfg.DocsPath = "/api/docs"                             // 可选；留空则禁用内置文档页
// 注册 cookie 安全方案，供操作声明引用
cfg.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
    authn.SecuritySchemeName: {Type: "apiKey", In: "cookie", Name: session.CookieName},
}
api := humachi.New(router, cfg)
api.UseMiddleware(authn.Middleware(api, sessionManager))
```

> 注意：huma 的 spec 路径靠扩展名区分（`.json`/`.yaml`），**不要**在 chi 上挂 `URLFormat` 中间件，否则会 strip 扩展名导致路径失效。当前 `main.go` 未使用 URLFormat，保持即可。

### 鉴权中间件设计（`internal/platform/authn`）

放在 platform 层，**只依赖 `session`，不依赖任何业务 domain**（避免分层倒置）。按操作粒度生效——读 `ctx.Operation().Security`：

```go
const SecuritySchemeName = "sessionCookie"
const ScopeAdmin = "admin"   // 与 session.Claims.Role 的 "admin" 取值对齐

// Middleware：操作未声明 sessionCookie 方案 → 直接放行（如 /api/auth/login）；
// 声明了 → 必须有有效 cookie，否则 401；若 scope 含 admin 而 role 非 admin → 403；
// 通过后用 huma.WithValue 注入 claims，供 handler 读取。
func Middleware(api huma.API, sessions session.Manager) func(huma.Context, func(huma.Context))

// 操作 handler 内读取当前登录者：
func ClaimsFromContext(ctx context.Context) (session.Claims, bool)
```

关键 API：`huma.ReadCookie(ctx, session.CookieName)`、`huma.WriteErr(api, ctx, status, msg)`、`huma.WithValue(ctx, key, claims)` 后 `next(ctx)`、handler 内 `ctx.Value(key)`。

操作声明鉴权要求的写法：

```go
// 需登录：
Security: []map[string][]string{{authn.SecuritySchemeName: {}}}
// 需 admin：
Security: []map[string][]string{{authn.SecuritySchemeName: {authn.ScopeAdmin}}}
```

### 与现有 identity 的关系

- identity 的纯 chi handler **暂不迁移**（避免回归），继续用其私有 `RequireAdmin`。
- 新增的所有 huma 操作统一走 `authn.Middleware`。
- 两套逻辑共享同一个 `session.Manager`，行为一致；M6 收尾时再把 identity 操作迁到 huma 统一契约。
- 可选：S1 末尾把 `POST /api/admin/invitations` 迁成 huma 操作做一个示范（非必须）。

### 验收

- `go build ./...` 通过。
- 启动后 `GET /api/openapi.json` 返回 3.1 spec。
- 一个加了 `Security: admin` 的示例操作：未登录 → 401，普通成员 → 403，管理员 → 200。

---

## S2 · Model Catalog 只读链路（最薄端到端）

**目标**：打通"迁移 → sqlc → domain → handler → 前端只读"的第一条真实链路。

### 迁移 `db/migrations/002_model_catalog.sql`（新）

依据总设计数据模型，建三张表（关键列）：

- `relay_providers`：`id, name, provider_type, base_url, encrypted_api_key, status, last_sync_at, created_at, updated_at`
- `model_definitions`：`id, provider_id, external_model_name, display_name, capability(text/image/video/audio), status(draft/enabled/disabled), parameter_schema jsonb, default_parameters jsonb, pricing_rule jsonb, cost_snapshot jsonb, sort_order, created_at, updated_at`
- `model_permission_rules`：`id, model_id, user_id?, role?, allowed, created_at`

### 后端模块 `internal/modelcatalog/`（新，DDD 四层）

- `domain`：`ModelDefinition`、`Capability`、`Status`、`ParameterSchema`、`PricingRule` 值对象。
- `application`：`Service`，先提供只读用例 `ListAdminModels`、`ListEnabledModelsForUser(userID, role)`。
- `infrastructure`：基于 sqlc 的仓储实现。
- `interfaces`：huma 操作。
- 查询源 `db/queries/model_catalog.sql` + 重新 `sqlc generate`。

### 端点（只读）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/admin/models` | admin | 后台模型列表（含 draft/disabled） |
| GET | `/api/app/models` | 登录 | 仅 enabled + 当前用户有权 + 定价有效的模型 |

- 响应遵循现有信封 `{ "data": ..., "request_id": ... }`。
- `/api/app/models` **不得**返回任何 Provider 密钥或内部定价细节，只给前端渲染所需字段 + `parameter_schema`。

### 前端

- `admin/ModelConfigTable`：数据源从本地 mock 切到 `GET /api/admin/models`（先只读展示，编辑留 S4）。
- 在 `api/client.ts` 增加对应请求方法；保留"数据源开关"思路，便于灰度。

### 验收

- 管理员在后台看到来自 DB 的模型列表。
- 普通用户 `GET /api/app/models` 只看到 enabled 且有权的模型。
- 端到端链路（迁移/sqlc/handler/前端）跑通，构建与测试绿。

---

## S3 · Provider 配置 + 密钥加密

**目标**：管理员可在 `/admin` 配置 Provider 密钥；后端加密托管、读取脱敏。

### 加密

- `internal/platform/crypto/aesgcm.go`（新）：AES-256-GCM，标准库 `crypto/aes` + `crypto/cipher`，无需新依赖。
- 密钥来源：环境变量（如 `CCY_ENCRYPTION_KEY`，32 字节，base64）；在 `internal/platform/config` 增加加载与校验。`.env.example` 同步补充。
- 存储：`relay_providers.encrypted_api_key` 存 `nonce || ciphertext`（base64）。

### 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/admin/relay-provider` | admin | 返回脱敏：`{ base_url, api_key_set, api_key_hint, status, last_sync_at }` |
| PUT | `/api/admin/relay-provider` | admin | 写入/更新；`api_key` 留空表示不改、有值则加密覆盖 |
| POST | `/api/admin/relay-provider/test` | admin | 用已存密钥测连通（调 Provider `GET /v1/models` 或健康端点） |

### 前端

- admin Provider 配置表单接上述端点：展示"已配置/未配置"，密钥框 placeholder 表达"留空不改"。
- 测试连通按钮调 `/test`，展示结果。

### 验收

- DB 中 `encrypted_api_key` 为密文；任何 GET 响应都不含明文。
- 留空更新不会清空已存密钥；填值更新可覆盖。
- 测试连通能反映真实可达性。

---

## S4 · 模型 sync + 编辑 + 拆前端直连

**目标**：完成 M1 闭环，并消除 `/app` 浏览器直连。

### 后端端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/admin/models/sync` | admin | 调 Provider `/v1/models`，新模型落库为 `draft` |
| PATCH | `/api/admin/models/{id}` | admin | 编辑 display_name / capability / parameter_schema / default_parameters / pricing_rule |
| POST | `/api/admin/models/{id}/enable` | admin | 启用（需定价与 schema 有效） |
| POST | `/api/admin/models/{id}/disable` | admin | 停用 |

- sync 用 S1 起的 adapter 边界封装"OpenAI 兼容 `/v1/models`"调用，便于后续接非兼容 Provider。
- `parameter_schema` / `pricing_rule` 后端为权威校验方；前端表单 + 高级 JSON 模式只是录入。

### 前端

- `admin/ModelConfigDrawer`：创建/编辑切到上述端点（替换 mock 写入）。
- **拆直连**（仅 `/app`）：移除 `model-config.ts` 的 baseUrl/apiKey 直连与 `model-templates.ts` 中浏览器构造请求体的路径；`SettingsModal` 去掉密钥/URL 项。`/app` 的模型列表改为消费 `GET /api/app/models`。
- 生成调用此时还没有后端 job（M3 才有），可临时禁用"运行"或指向占位，直至 M3 落地——在 PR 描述里标注。

### 验收

- 管理员可 sync、编辑、启停模型，状态持久化于 DB。
- `/app` 不再有任何密钥/URL 输入，也不直连模型平台。
- M1 视为完成。

---

## 后续里程碑指引（M2–M6，方向性）

> 越靠后越可能调整，这里只给落地方向，细化时再补切片。

### M2 · Pricing & Credits（成本管控核心）

- 迁移补 `credit_reservations`（总设计已有定义）。
- 端点：`POST /api/app/pricing/estimate`、`GET /api/app/credits/summary`；admin 侧 `credit-adjustments`、`daily-quota`、`GET /api/admin/credit-ledger`。
- reserve 事务：锁 `credit_accounts` 行 → 校验余额 → 扣减 → 建 `credit_reservation` → 写 `reserve` ledger → 建 `generation_job`。
- 正式引入 **River**：每日配额重置 job（`current_balance` 重置为 `daily_quota`，不跨日累积），补 River 迁移。
- 结算：charge / refund / 超额(undercharge)处理 / admin 调整，全部入 ledger。
- 前端：顶栏剩余积分接真实、生成前显示预估明细。

### M3 · Generation（跑通闭环）

- 迁移 `generation_jobs`、`model_invocations`。
- NewAPI/OpenAI 兼容 adapter；River generation worker。
- 流程 `estimate → reserve → invoke → settle/release` + 失败/取消处理；成功生成 `asset`。
- 端点 `POST /api/app/generations`、`GET /api/app/generations/{id}`、列表（先轮询，后 SSE）。
- 前端：画布节点生成走后端 job；运行动画（水流/高亮/淡入淡出）；elapsed 基于 `generation_job.started_at`（刷新不归零）；TaskQueue 接真实 job。

### M4 · Asset Library & 项目持久化

- 迁移 `projects / project_members / canvas_snapshots / assets`。
- 切项目存快照；canvas-to-library；personal/team 可见性。
- 端点 `/api/app/projects*`、`/api/app/assets*`。
- 前端：把已做好的 Project/Space/History 从 localStorage 切后端；History masonry 接真实资产。

### M5 · Admin 控制台补全（中文界面）

- 优先级：模型配置（M1 已做）→ 邀请码 → 成员 → 概览（Recharts dashboard）→ 日志/审计。
- 端点：`/api/admin/members*`、`invitations*`、`dashboard/*`、`generation-jobs`、`audit-logs`。
- 概览 KPI 与图表、成员配额/禁用、邀请管理、生成日志、审计（只读、不可删）。

### M6 · 收尾硬化

- 邮箱验证流程；SSE 实时（`job.updated / asset.created / credit.updated`）；协作角色细化；中文编码清理；端到端验收；可观测性。
- 把 identity 等早期 chi handler 统一迁到 huma，使 OpenAPI 覆盖全量 API。

## 横切关注点

- **OpenAPI 契约先行**：新端点一律先以 huma 操作定义，前端据 `/api/openapi.json` 对齐。
- **测试金字塔**：domain（积分预留/结算/每日重置、定价计算）→ application（生成创建/结算）→ API（鉴权、admin 边界、模型可见性）→ worker（成功/失败）→ 前端（受保护路由、动态参数渲染）。
- **安全**：密钥加密、`/admin` 边界、审计不可删、`/api/app/*` 不泄露内部配置。
- **i18n/编码**：admin 中文文案；清理历史中文编码问题。
