# 后端成本闭环 · 决策备忘

Date: 2026-05-29
Status: 已敲定（可随实施迭代）

本文件记录 2026-05-29 顾问对话中敲定的方向性决策，作为后续不再反复纠结的依据。

关联文档：

- 总设计：[2026-05-22-cost-controlled-ai-canvas-design.md](2026-05-22-cost-controlled-ai-canvas-design.md)
- 进度基线：[spec-progress-2026-05-22-cost-controlled-ai-canvas.md](../../dev/spec-progress-2026-05-22-cost-controlled-ai-canvas.md)
- 实施指引：[2026-05-29-backend-cost-loop-implementation-guide.md](../plans/2026-05-29-backend-cost-loop-implementation-guide.md)
- 任务清单：[2026-05-29-backend-cost-loop-task-checklist.md](../plans/2026-05-29-backend-cost-loop-task-checklist.md)

## 现状快照（为什么需要这条主线）

| 层 | 状态 |
|---|---|
| 设计 / 愿景 | ✅ 完整（5-22 总设计 + 5-28 多份细化 spec） |
| 前端 | 🟡 跑得快但建立在 mock 之上：登录 / 画布 / 自定义节点 / 工具栏 / 任务队列 / admin 壳 / 模型配置 / 个人&团队空间 / 项目 / 历史，数据多靠 `zustand + localStorage`，生成调用仍是浏览器直连模型平台 |
| 后端 | 🔴 只有地基 + 两个上下文：Identity 完整、Credit 仅"初始账户创建"；只有一个迁移 `001_identity_credit.sql`；Model Catalog / Generation / Asset / Analytics / Audit / River / OpenAPI 全部未开始 |

**核心矛盾**：产品灵魂是「成本管控」（预估 → 预留 → 调用 → 结算/释放 + 每日配额 + 审计 + 模型密钥后端托管），而这恰恰是当前最大的空洞。前端 mock 堆得越高，后期切真实 API 的返工越大；前端持有模型 baseUrl/密钥直连，既违背"后端唯一真相源"，也让成本管控形同虚设。

## 已敲定决策

### D1 · 主线优先级：后端成本闭环优先

- **决定**：下一阶段自底向上打通后端闭环（Model Catalog → Pricing/Credits → Generation），前端逐模块从 mock 切到真实 API。
- **理由**：成本管控是产品核心价值，也是当前最大空洞；契约先行能减少前后端返工。
- **被否方案**：继续前端产品化（mock 上加 workspace/admin 页面）——可视进展快，但成本闭环与安全隐患仍在，返工风险大。

### D2 · OpenAPI 产出方式：huma

- **决定**：后端 API 契约用 [huma](https://huma.rocks) v2（code-first，原生 OpenAPI 3.1，`humachi` 适配现有 chi）。
- **理由**：契约与代码强绑定、文档不易脱节、开发省事；可把鉴权要求声明进 OpenAPI。
- **被否方案**：纯 chi 手写 + 另维护 openapi 文件（易脱节）；ogen spec-first（流程偏重）。

### D3 · 模型密钥：仅 admin 可配 + 后端托管

- **决定**：
  - 配置入口只在 `/admin`，**仅管理员**可见可用。
  - **写入方向**（前端 → 后端）支持：管理员在表单填密钥，提交后后端用 AES-GCM 加密存 `encrypted_api_key`。
  - **读取方向**（后端 → 前端）屏蔽：GET 只返回脱敏状态（如 `api_key_set`、`api_key_hint`），永不回传明文。
  - **更新语义**：密钥框留空 = 不改；填新值 = 覆盖。连通性测试用已存密钥，不要求前端重传。
- **理由**：既满足"前端能配"，又满足"后端托管 + 成本管控"，用户绕不过后端。

### D4 · 前后端能力边界

- **决定**：
  - `/admin`（仅管理员）：录入/更换/测试 Provider 密钥、配置模型。
  - `/app`（普通用户）：不再有 apiKey/baseUrl 输入，不直连模型平台，生成一律走后端 job。
- **理由**：对齐总设计「前端永不直连、后端唯一真相源」。

### D5 · 推进方式：垂直切片

- **决定**：不铺满地基再做功能，而是先打通一条最薄的真实链路（迁移 → sqlc → domain → handler → 前端联调），再逐切片加宽。切片序列 S0 → S4 见实施指引。
- **理由**：尽早暴露集成问题，每个切片都可独立演示、保持构建绿。

### D6 · 文档形式

- **决定**：暂不依赖正式 superpowers 工作流，先以顾问对话迭代，并把结论落成本批 md 文档（决策备忘 / 实施指引 / 任务清单）。

## 贯穿所有实施的不变量

1. 前端永不直连模型平台；后端是身份、模型、参数、定价、积分、生成、资产、分析的唯一真相源。
2. 模型密钥后端加密存储、永不回传明文。
3. `/admin` 与 `/app` 权限边界清晰；审计日志不可经 UI 删除。
4. 每一笔积分变动都写入 `credit_ledger_entries`。
5. 生成只能经后端生成应用服务进入；job 先落库再调 Provider。

## 暂缓 / 待定项

- **仓库清理**（`dist/`、`*-dev.log` 取消跟踪 + `.gitignore`）：已确认**保留**（2026-05-29，未提交）；连同 `go get huma` 引入的依赖一并保留——相当于 S0 已完成、S1 依赖已就位。
- **单 Provider**：首版只支持一个 NewAPI 类平台，保留 adapter 边界，多实例暂不做。
- **SSE 实时**：先用轮询，`job.updated / asset.created / credit.updated` 的 SSE 推送放到 M3 之后。
- **River 引入时机**：M2 做每日配额重置时正式引入并补 River 迁移。
- **`credit_reservations` 表缺失**：`001` 迁移未建该表（总设计数据模型中有），M2 reserve 流程前必须补迁移。
