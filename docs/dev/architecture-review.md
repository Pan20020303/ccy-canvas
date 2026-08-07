# CCY Canvas 架构复盘与稳定性审计（已事实核查修正版）

> 生成于 2026-07-01。由多智能体逐层测绘 + 审计产出，随后对全部 P0 与关键 P1 论断做了
> 逐条代码反查（14 条：10 属实 / 3 夸大 / 1 错误），本文为**修正后**版本。
> 行号为审计时点参考，后续代码演进会漂移——以符号名定位为准。

---

## PART A — 架构与数据流转总览

### A.1 分层总览

```
┌──────────────────────────────────────────────────────────────────────┐
│ FRONTEND  React19 + Zustand + React Flow (@xyflow) · Vite :5173        │
│   store.ts（单一 Zustand store，persist→localStorage，partialize）      │
│   runNode / pollTrackedTasks(8s) / SSE EventSource / rehostToStableUrl │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │  /api（dev: Vite proxy → :9090；prod: nginx 同源）      │
┌───────────────▼───────────────────────────────▼──────────────────────┐
│ API 层  chi mux（main.go）                                             │
│   middleware: RealIP→RequestID→CORS→MaxBody(50MB)→Logger               │
│   两套世界并存：                                                        │
│   (1) 裸 chi handler：identity/OAuth、upload、history/asset、SSE 流     │
│   (2) Huma OpenAPI3.1 + authn.Middleware（per-op ccy_session）          │
└───┬────────────┬─────────────┬──────────────┬────────────┬───────────┘
    │identity    │modelcatalog │credits       │workspace    │skills/agent
┌───▼────────────▼─────────────▼──────────────▼────────────▼───────────┐
│ 生成管线  Service.Generate → buildCandidates（取第一个，无 failover）    │
│   → dispatchToVendor → ResolveProfile(api_spec) → vendor_image/video   │
│   → 异步 poll / 同步 → persistGeneratedAssetForResult → COS re-host     │
│   → generation_logs → TaskEventBus → SSE                               │
│   异步：Asynq(REDIS) 或 detached goroutine（no-redis）· 1min reaper 兜底 │
└───┬──────────────────────────────────────────────────────────────────┘
┌───▼──────────────────────────────────────────────────────────────────┐
│ DATA + INFRA                                                           │
│   Postgres（pgxpool Max50/Min5）· sqlc（新表为手写绑定）· 编号 SQL 迁移   │
│   Redis（JSONCache best-effort + Asynq 队列 + SSE transport）           │
│   Tencent COS（assetstore，signed proxy-media 回源）                    │
│   config: env-only · dev: run-latest-backend.ps1 / start.ps1           │
└──────────────────────────────────────────────────────────────────────┘
```

### A.2 三条核心数据流

**流① 生成**：`runNode` → 生成 request_id + 预扣积分 → 有 Redis 则入 Asynq 队列
（TaskID=request_id 幂等）否则 detached goroutine → `buildCandidates[0]` →
`ResolveProfile(api_spec)` → vendor → 异步轮询 / 同步 → re-host 到 COS →
写 generation_logs → TaskEvent → SSE 推回节点。兜底：前端 8s poller + 后端 1min reaper。

**流② 持久化**：变更 → Zustand `set` → persist → localStorage；`partialize` 里
`stripHeavy` 把 data:/blob: 媒体抹成 `''`（防膨胀，产生 dangling ref）。
history/asset 走后端 Postgres；生成产物 `generation_logs.result_url`（单值）。

**流③ 认证**：密码 / Google OAuth（callback 信任 userinfo，未验 id_token 签名）→
不透明 HMAC cookie（ccy_session，7 天、无服务端 store、不可撤销）。

### A.3 关键决策与取舍

| 决策 | 收益 | 代价/风险 |
|---|---|---|
| DDD 分层 | 领域清晰、可测 | 生成链路跨多域，耦合在 service.go 巨文件 |
| 新表手写 sqlc 绑定 | 绕生成器冲突 | generation_history/saved_assets 等绕过 generate 校验（注：db/queries 存在且大部分表有正规 sqlc 流） |
| 不透明 HMAC cookie | 无状态易扩展 | 泄露后 7 天有效、不可撤销/轮换 |
| adapter profiles by api_spec | 一列切厂商 | 拼错/custom → 静默 fallback openai（wan2.7 曾踩此坑；现 wan2.7 已按模型名路由） |
| Asynq + SSE | 重启存活 + 实时 | Redis 缺失静默降级 in-process；transport 广播 + StartBridge 回环是**刻意设计**（main.go 同块接线，无双发） |
| local-first persist | 秒开/乐观 | stripHeavy 抹媒体 → 坏节点无恢复路径 |
| COS re-hosting | 资产不随 provider URL 过期 | 只 re-host Content[0]；staging 失败静默保留过期 URL |

---

## PART B — 稳定性问题清单（修正版，按严重度）

### 🔴 P0（数据丢失 / 资损 / 静默失败）——全部经代码反查属实

**P0-2 · 多图端到端丢弃**（付 12 图交付 1 图）
- `vendor_image.go` 返回 `ContentList`（组图最多 12 URL），但 `persistGeneratedAssetForResult`
  只 re-host `Content[0]`；`generation_logs.result_url`、`TaskEvent.ResultURL`、前端节点全是单值。
- 反查补充：re-host 后 `Content` 被替换但 `ContentList[0]` 不同步更新，同步响应里残存未落盘的临时 URL。
- OpenAI 风格 `data[]` 多图同样只取 `Data[0]`（image_response.go）。
- 修：re-host 全部 ContentList → `result_urls` 贯穿 log/事件/响应 → 前端多图 fan-out 成节点。

**P0-4 · 付费 submit POST 在 mid-flight EOF 上重试 → 重复出图 + 双扣费**
- `doProviderRequestWithRetry` 对 io.EOF / connection-reset / "server closed" 重试（3 次尝试），
  且包住 4 个付费图片 submit POST（Volcengine/chat-image/text-only/edit）；上游无幂等键。
- 反查补充：作者已用 `IsRequestDeadlineTimeout` 刻意排除超时重试（注释明言 re-charge 风险），
  但漏了 post-accept EOF/reset 分支——已知风险类别的遗漏。
- 修：submit POST 只重试**发送前**失败（dial/TLS/connection-refused），EOF/reset 不重试。

**P0-5 · 扣费/幂等竞态 + 退款尽力而为**
- `generate()` 先 ReserveCredits，后靠 INSERT ON CONFLICT 查重；并发重复请求都过 reserve，
  loser 退款仅 best-effort（失败只打日志）。
- 反查补充（更糟）：`GetGenerationLogByRequestID` 查询自身出错时返回 500 且**完全不退款**；
  inline（无 Redis）路径**没有任何 request_id 去重**。
- 修：reserve 前先按 request_id 快速查重；INSERT 冲突/出错路径都保证退款；inline 加去重。

**P0-6 · COS 落盘失败仍报成功 + 保留过期 provider URL**
- `persistGeneratedAssetForResult` staging/promotion 失败时保留短命 URL 并按成功返回（仅 WARNING）；
  durable 重试队列只覆盖 promotion 失败，**staging 下载失败不入队**。
- 修：staging 失败也入 durable 重试；重试预算耗尽标 `asset_lost` + 退款 + 告警指标。

**P0-3 · 资产 staging 下载绕过 EOF 硬化**
- `StageRemoteAsset` 用默认 transport（keep-alive 开）+ 单次尝试，绕开了 provider 客户端的
  `DisableKeepAlives` 硬化（#16/#17/#18 同类 EOF 直接导致资产腐烂）。
- 修：staging client 同 provider 客户端硬化 + GET 幂等重试。

**P0-8 · 前端过期 URL 无恢复路径**
- 反查修正（比原复盘更糟）：**SSE/轮询完成路径把 `task.result_url` 直写节点、完全没有 rehost**
  ——队列路径上后端落盘一失败就直接出过期 URL（这是第一优先修复点）。
- 同步路径 `rehostToStableUrl` 一次重试后静默保留原 URL；persist 把 data:/blob: 抹 `''`。
- 已有部分缓解：MediaThumb/dead-media 自动清理覆盖历史/素材库，但对画布节点无效。
- 修：SSE/poller 应用 result_url 后异步 rehost 升级；失败标 `assetSyncing` 交 poller 重试。

### 🟠 P1（韧性）

- **P1-0（原 P0-1 降级）** 游离 goroutine（inline Generate、reaper、SSE bridge）无 recover
  + 无优雅退出（`worker.Shutdown()` 从未被调用、无 signal 处理、裸 ListenAndServe）。
  注：HTTP handler panic **不会**杀进程（net/http 自带 per-conn recover），原复盘机制有误。
- **P1-1（改写）** **Linux 部署路径**（install.sh/start.sh）无自动迁移且文档谎称有；
  Windows `start.ps1`/`desktop-launch.ps1` 每次启动幂等重放全部迁移、已覆盖。
  修：引入版本化 migrator（goose/dbmate）+ schema_migrations + 启动 fail-fast。
- **P1-3** provider 无健康路由/failover——channel-health 记录了却不用于选择。
- **P1-4** api_spec→profile 静默 mis-route（未知一律 openai，config 写时无校验）。
- **P1-5** `/api/health` 静态 200，不探 PG/Redis/COS；无 readiness。
- **P1-6** config load 用 `context.Background()` 无超时；provider 调用无 per-attempt timeout。
- **P1-7** 轮询无 jitter/backoff、静默吞传输错误。
- **P1-9** 错误分类靠子串匹配 → 未识别的 moderation 拒绝被重试 5 次（每次付费）。
- **P1-10** 无可观测性（无 metrics/tracing；队列深度、COS EOF 率、pool 饱和不可见）。
- **P1-11** generateText 裸 60s 无重试；NewAPI 越界索引 `Choices[0]`（空数组 panic）。
- （撤下）~~P1-2 sqlc 配置坏~~：db/queries 存在且正常；仅新表手写绑定绕过校验 → 降 P2。
- （撤下）~~P1-8 SSE StartBridge 未接线/无去重~~：main.go 同块接线，去重是注释明言的设计。

### 🟡 P2（scale / 安全边角）

- CORS 硬编码 localhost + LAN 凭证放行（DNS rebinding 面）。
- 错误塌缩 500 且向终端用户回显 raw upstream body。
- 无 prod fail-fast（Redis 缺失静默降级 in-process）。
- 单节点/单区；备份本地 cron 无异地无恢复演练。
- proxy-media presign 无 per-user 归属校验（key 为 UUID 不可枚举，暴露面=泄露的 URL 永久有效）。
- reaper 假设单副本；request_payload 内联 base64 膨胀；日志无轮转且可能含 presigned token。
- 手写 sqlc 绑定（generation_history/saved_assets）无编译期校验。
- 前端持久化 history 上限 100（内存 200）、savedAssets 80——注意数字勿混。

---

## 🎯 Top 5 最高杠杆硬化（修正版）

1. **媒体持久化硬化组（P0-3/P0-4/P0-6）**——止住双扣费与静默坏资产两类付费用户可见故障。
2. **多图结果贯穿（P0-2）**——止住"付 12 交 1"，先 re-host 全部 ContentList 防过期。
3. **扣费竞态收口（P0-5）**——reserve 前查重 + 全路径退款保证 + inline 去重。
4. **前端 SSE 路径 rehost（P0-8）**——补上队列路径的资产二次保险。
5. **`/api/ready` 深度探针 + 最小 Prometheus 指标（P1-5/P1-10）**——让一切静默降级可见。

（原第 1 条 "Recoverer" 降级：改为三处游离 goroutine recover + 优雅退出，成本极低仍值得做。）

## 架构演进建议（中期）

1. **迁移 runner + schema 契约**：in-repo versioned migrator（schema_migrations）+ CI 校验手写绑定。
2. **多值结果模型**：`result_urls` 贯穿 GenerateResult.ContentList → generation_logs → TaskEvent → 前端。
3. **媒体持久化一等保证**："付费资产必须落 COS 或退款" 不变量 + durable retry + `asset_lost` 告警。
4. **provider 路由按显式 capability + 健康**：api_spec 枚举校验 + 多候选按健康排序 failover。
