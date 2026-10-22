# CCY Canvas — 项目健康审计

> 日期：2026-06-11
> 范围：后端 Go (modelcatalog / workspace / skills) + 前端 React/Zustand
> 方法：静态代码走查，按严重度分级。未做渗透测试 / 压测。

---

## 摘要

按"会不会出事 × 多容易触发"排序，最该先处理的三件：

1. **SSRF 漏洞**（proxy-media 任意 URL 服务端拉取）— 安全 P0
2. **画布保存无并发控制**（多端同时编辑后写覆盖）— 数据丢失 P0
3. **生成资产无清理策略**（uploads/generated 无限增长）— 运维 P1

下面分级详述。

---

## 🔴 P0 — 安全 / 数据完整性

### S1. proxy-media SSRF（任意服务端请求伪造）

**位置**：[backend/internal/workspace/interfaces/upload_handler.go:109](../../backend/internal/workspace/interfaces/upload_handler.go)

```go
target := r.URL.Query().Get("url")
// 仅校验 http/https 前缀，无 host 白名单
client.Get(target)
```

任何**登录用户**可让后端 GET 任意 URL。攻击面：

- 云元数据：`?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/`（拿 AWS 临时凭证）
- 内网探测：`?url=http://localhost:5432` / 内网管理后台
- 虽然有 `Content-Type` 必须是 image/video 的校验，但**错误响应的 body 仍可能通过 timing / 状态码侧信道泄露**，且元数据端点常返回可被伪装的内容类型

**修复**：
- 解析 target → 拒绝私有/保留 IP 段（10/8、172.16/12、192.168/16、127/8、169.254/16、::1、fc00::/7）
- 跟随重定向时**逐跳重新校验**（防 DNS rebinding / 重定向绕过）
- 理想：维护一个上游 provider host 白名单（反正 result_url 只来自我们配置的渠道）

> 注意：现在有了 Stage-1 的服务端 asset cache（`PersistRemoteAsset`），前端**几乎不再需要** proxy-media。可以评估直接**下线这个端点**，是最干净的修法。

### S2. 画布保存无乐观锁 / 版本冲突检测

**位置**：[backend/internal/workspace/interfaces/handler.go:43](../../backend/internal/workspace/interfaces/handler.go) `Version int32` 字段存在但**保存路径未校验**。

`saveCanvas` 是 last-write-wins。场景：用户开两个 tab（我们的 SSE 多端是支持的），A、B 都编辑，B 后保存 → A 的改动**静默丢失**，无任何提示。

**修复**：保存时带 `expectedVersion`，DB 层 `UPDATE ... WHERE version = $expected`，0 行更新 → 返回 409，前端提示"画布已被其他会话修改"。

### S3. 500 错误曾吞掉底层原因（已部分修复）

`toHTTPError` 之前把所有 500 包成泛化文案，导致 "Failed to create provider config" 看不到真因（缺 migration 列）。**已在 1cca805a 之前修复**——但提醒：这类"best-effort 吞错"模式在 `persistGenerationOutcome` / asset cache 里还有多处 `_ = err`，生产环境**完全无可观测性**。建议至少接一个结构化 logger 记录这些静默失败。

---

## 🟠 P1 — 运维 / 资源

### O1. 生成资产无生命周期管理

**位置**：[backend/internal/modelcatalog/application/asset_cache.go](../../backend/internal/modelcatalog/application/asset_cache.go)

`uploads/generated/{yyyy-mm}/` **只增不减**。每张图/视频永久落盘，无配额、无 TTL、无清理。视频几十 MB 一个，跑量起来磁盘几周就满。

**修复选项**：
- 定时任务：`find uploads/generated -mtime +30 -delete`（简单，但删了正在用的节点资产会 404）
- 引用计数：清理前查 `generation_logs` / canvas snapshot 是否仍引用（正确但重）
- 对象存储 + 生命周期策略（治本，但要接 S3/OSS）

最小可行：先加 cron + 监控磁盘水位告警。

### O2. 全局并发限流过粗

**位置**：[handler.go:36](../../backend/internal/modelcatalog/interfaces/handler.go) `generateLimiter: make(chan struct{}, 8)`

**全局** 8 个并发槽，**无 per-user 限制**。Stage-1 改成 detached goroutine 后，超时的任务仍在后台跑，但占用的是 goroutine 不占 limiter 槽 → 单个恶意/手快用户可堆积大量后台任务，耗尽内存/上游配额。

**修复**：加 per-user 在跑任务上限（如 10），并发槽与后台任务分别计数。

### O3. localStorage 持久化有 5MB 天花板

**位置**：[store.ts:712](../../src/app/store.ts) `stripHeavyFromNodes`

画布快照存 localStorage，靠 `stripHeavyFromNodes` 剥离大字段硬塞进 5MB。节点数量大（你截图里有 370 节点的画布）时，**接近上限会静默截断**，刷新后丢数据。后端有 canvas snapshot 持久化是好的，但前端这层 5MB 是隐患。

**修复**：超限时降级——只存 UI 偏好，节点数据完全依赖后端拉取。

---

## 🟡 P2 — 架构 / 可维护性

### A1. 厂商适配靠字符串嗅探（正在改善）

`isVolcengine` / `isArkVideoContract` 等散落的 vendor 检测，靠 host 字符串和 endpoint 子串猜行为。**已在 profile 化方案中收编**（`adapter_profiles.go`），继续推进即可。

### A2. sqlc 生成与手写绑定混用，regen 会炸

`sqlc generate` 与 `agent_runs.sql.go` 等手写文件冲突（本次工作已踩坑两次，最后靠手写补 query 绕过）。这是个**定时炸弹**：下个改 schema 的人跑 sqlc 会遇到一堆 redeclared 错误。

**修复**：要么全量迁到 sqlc（删手写绑定，统一 query file），要么把手写部分挪出 sqlc 输出目录（独立 package），让两者物理隔离。

### A3. `api_spec` 字段曾是死代码

存了 "openai"/"custom" 但后端从不读。**profile 方案正在复活它**，OK。

### A4. 参考模式 tab 是纯装饰

详见 [reference-mode-capability-plan.md](2026-06-reference-mode-capability-plan.md)。**已立项**。

---

## 🟢 P3 — 测试 / 观测

### T1. 测试覆盖偏薄

后端 14 个测试文件、前端 15 个。核心生成链路（detached goroutine、SSE、poller、asset cache）**缺集成测试**——本次几个 stage 全靠单元测试 + 手动验证。建议补：
- 端到端"超时但完成"的恢复测试
- SSE publish/subscribe 的并发测试
- canvas 多端冲突测试（配合 S2 修复）

### T2. 无结构化日志 / 指标

`log.Printf` 散用，无 request-scoped 日志、无生成成功率/延迟/渠道健康的 metrics。生产排障只能靠 `api.log` grep。建议接 slog + 基础 Prometheus 指标。

### T3. 运行时日志被 git 跟踪

`backend/api.log` / `api.err.log` 一直在 working tree 里被改动（每次 commit 都要手动排除）。应加进 `.gitignore`。

---

## 优先级建议

| 优先 | 项 | 工作量 | 理由 |
|---|---|---|---|
| 立即 | S1 SSRF | 小（或直接下线 proxy-media） | 安全漏洞，登录即可利用 |
| 立即 | T3 gitignore 日志 | 极小 | 每次提交都被它干扰 |
| 本周 | S2 画布版本冲突 | 中 | 多端编辑会丢数据 |
| 本周 | O1 资产清理 | 中 | 磁盘会满 |
| 规划 | O2 per-user 限流 | 中 | 配合 detached 任务 |
| 规划 | A2 sqlc 隔离 | 中 | 下个改 schema 的人会踩 |
| 持续 | T1/T2 测试与观测 | 大 | 长期健康 |

---

## 已经做对的地方（不全是问题）

- API key AES-256-GCM 加密存储（[config.go:15](../../backend/internal/platform/config/config.go)）✓
- 渠道健康 + 指数退避冷却 ✓
- 生成任务后台化 + SSE 推送 + 恢复轮询（本轮工作）✓
- 服务端 asset 缓存（签名 URL 过期不再丢图）✓
- 多厂商 fallback 路由 ✓
