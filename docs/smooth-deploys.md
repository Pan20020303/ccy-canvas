# 平滑发布:优雅关闭 + 前端更新提示

目标:更新代码时**不打断在线用户、不丢在途工作**,并且前端更新对用户是「**有提示、点了才刷新**」而非强制打断。

## 背景

- 后端原来直接 `http.ListenAndServe`,重启(kill/SIGTERM)会**当场掐断在飞请求**——正在保存的画布、正在上传的文件、刚提交的生成,都被腰斩。
- 生成任务本身已由 Redis + Asynq **持久化**(`REDIS_ADDR` 已配),重启不丢任务;但 HTTP 请求被腰斩仍会丢"这一下"的操作。

本次两项改动分别解决「重启腰斩」和「前端强制刷新」。

## 一、后端优雅关闭

`backend/cmd/api/main.go`:改为监听 `SIGINT/SIGTERM`,收到信号后

1. 停止接收新连接,`http.Server.Shutdown` **排空在飞请求**(上限 25s)——保存/上传能跑完再退出;
2. 停掉后台 reaper 与 Asynq worker(worker 优雅停:当前任务跑完,未 ack 的任务留在 Redis,重启后重投,**生成不丢**);
3. 再次 Ctrl-C 可强制退出(恢复默认信号处理)。

效果:**重启不再腰斩用户操作**。配合 Redis 持久化 + 前端重连,一次快速重启对用户几乎无感、零丢失。

> 部署脚本请用「发送 SIGTERM 后等进程自然退出」的方式停服务(而非 -9 强杀),优雅关闭才生效。

## 二、版本号 + 「有新版本 → 看更新内容 → 点击刷新」

不强制刷新,用户空闲时自己点;并且**用大白话告诉用户这次更新了什么**。

**版本与发布说明的来源:`src/app/releases.json`**(最新的放最前面):
```json
[
  { "version": "1.1.0", "date": "2026-07-10",
    "notes": ["用大白话写:这次改了啥", "修了哪个问题", "加了什么新功能"] },
  { "version": "1.0.0", "date": "2026-07-07", "notes": ["..."] }
]
```

- **构建时**(`vite.config.ts`):读 `releases.json` 的第一条,写进 `dist/version.json`(含 `version` + `date` + `notes`)。
- **运行时**(`src/app/components/UpdatePrompt.tsx`,挂在 `App.tsx`):每 3 分钟 + 窗口重新聚焦时拉 `/version.json`;若 `version` ≠ 自己编译进来的 `CURRENT_VERSION`,右下角弹一张**非阻塞、可关闭**的卡片:标题「发现新版本 vX.Y.Z」+ 逐条列出 `notes`(大白话更新内容)+ 「刷新更新」/「稍后」按钮。点「刷新更新」才 `location.reload()`。
- **只在生产构建生效**(`import.meta.env.PROD`);dev 用 HMR、无 `version.json`,自动跳过。
- 点「稍后」会记住这个版本、不再打扰,直到出现更新的版本。

用户点「刷新更新」才会加载新的 `index.html` + 新哈希资源;不点就继续用,当前操作不受影响。

### 如何发布一个新版本(你的操作)
1. 在 `src/app/releases.json` **最前面**加一条:新的 `version`、`date`、以及几句**大白话** `notes`;
2. `npm run build`(会把这条写进 `dist/version.json`);
3. 部署新 `dist/` + `nginx -s reload`。

在线的旧标签页几分钟内(或用户切回窗口时)就会弹出「发现新版本 vX.Y.Z」并列出你写的更新内容。

## 三、nginx 缓存(关键,否则刷新还拿旧的)

| 路径 | 缓存策略 | 原因 |
|---|---|---|
| `/index.html` | `no-cache`(或很短) | 刷新要拿到引用新哈希资源的新 index |
| `/version.json` | `no-cache` | 版本检测必须实时 |
| `/assets/*`(带哈希) | `immutable, max-age=31536000` | 内容哈希,永不变 |

nginx 片段:
```nginx
location = /index.html   { add_header Cache-Control "no-cache"; }
location = /version.json { add_header Cache-Control "no-cache"; }
location /assets/        { add_header Cache-Control "public, max-age=31536000, immutable"; }
```

## 四、推荐发布流程

- **只改前端**(大多数情况):`npm run build` → 用新 `dist/` 替换旧的 → `nginx -s reload`(热重载,**零停机**,不碰后端)。在线用户过一会看到更新提示,空闲时自己点刷新。
- **改后端**:`go build` 新二进制 → 用 **SIGTERM 优雅停旧进程**(排空)→ 起新进程。有了优雅关闭 + Redis + 前端重连,快速重启不丢数据。要做到用户完全无感,可再上蓝绿(两实例 + nginx 上游切换)或把 worker 拆成独立进程(更新 API 不动 worker)。

## 五、验证

```bash
# 后端优雅关闭:向进程发 SIGTERM,日志应出现 draining… → shutdown complete,
# 且此刻在飞的请求能正常返回,不是连接被重置。

# 前端版本机制:
npm run build
cat dist/version.json          # {"version":"1.0.0","date":"...","notes":[...]}
# 在 releases.json 顶部加一条新版本再 build+部署,旧标签页几分钟内(或切回窗口时)
# 应弹「发现新版本 vX.Y.Z」并列出你写的更新内容。
```

## 涉及文件

- 后端:`backend/cmd/api/main.go`(信号监听 + `Server.Shutdown` 排空 + 停 worker/reaper)
- 前端:`src/app/releases.json`(版本 + 大白话更新说明,发布时改这里)、`vite.config.ts`(产出 version.json)、
  `src/app/version.ts`、`src/app/components/UpdatePrompt.tsx`(更新卡片)、`src/app/App.tsx`(挂载)
- 运维:nginx 缓存策略(见上,按需并入你的 nginx 配置/脚本)

## 后续 / 可选

- 蓝绿部署或独立 worker 进程,做到后端更新用户完全无感。
- 画布**防抖自动保存**(改动即存),把「未保存编辑」窗口降到最小(与优雅关闭互补)。
