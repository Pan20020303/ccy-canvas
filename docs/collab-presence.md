# 实时协作在场(彩色光标 / 选中 / 操作)

多人协作时实时看到其他协作者的**光标、选中的节点、正在拖动的节点**,按用户稳定分配颜色区分。
纯前端体验层 + 一条轻量后端通道,**无新依赖**。

## 是什么 / 不是什么

- **是**:只读的「在场展示」——你看得到别人在哪、选了什么、在拖什么;每人一个稳定颜色。
- **不是**:多人同时写同一画布的「协同编辑 / 冲突解决」。画布保存仍是全量快照 + 防抖 +
  last-write-wins,和在场层**完全解耦**。真·协同编辑是另一个量级的重构,不在本功能内。
- **纯易失**:在场态不进撤销、不进快照、不落库、不触发自动保存。**零数据风险**。

## 架构

- **下行(服务端→客户端)**:SSE。新增 `GET /api/app/projects/{id}/presence/stream`,照抄任务流
  的 SSE 骨架(chi 裸路由、`text/event-stream`、`X-Accel-Buffering: no`、25s `: ping` 保活)。
- **上行(客户端→服务端)**:节流 REST。`POST /api/app/projects/{id}/presence`,body 带
  `{cursor, selection, activity, name, color}`,前端节流到 ~16Hz(最新覆盖),兼作心跳。
  **没有 WebSocket**——现有栈零 ws 依赖,SSE + 节流 POST 贴合架构且够用。
- **房间**:按 `projectId` 分频道的易失 pub/sub 总线(`backend/internal/presence/bus.go`),维护
  在线名单;新连接进来先补发一份「当前在场快照」。
- **跨副本**:复用任务总线的 Redis transport 范式,频道 `ccy:presence-events`。
- **鉴权**:复用 `ccy_session` cookie;每次(订阅 + 上报)都校验 `AccessRole(project, user)`,
  非成员 403。**访客(visitor)只读**:能订阅看别人,但 POST 被服务端拒绝、不广播自己。
- **颜色**:`colorForUid(user.id)` 稳定哈希到固定调色板,跨会话/设备一致(不用名字,避免撞色)。

## 部署要求

1. **多副本必须配 Redis**(`REDIS_ADDR`)。
   - 单实例:进程内总线即可,不配 Redis 也能用。
   - 多副本:在场**必须**走 Redis 跨副本广播,否则连在不同副本上的人**互相看不到**。
     本项目 `REDIS_ADDR` 已配 → 自动生效(和任务事件总线同一套装配)。
2. **nginx / 反向代理对 SSE 的处理**(和已有的任务流 `/api/app/tasks/stream` 要求一致):
   - `/api/` 代理需**关闭缓冲**、**放长读超时**,否则 SSE 帧会被攒着不实时下发:
     ```nginx
     location /api/ {
         proxy_pass http://backend;
         proxy_http_version 1.1;
         proxy_set_header Connection "";
         proxy_buffering off;          # SSE 关键:不要缓冲
         proxy_read_timeout 1h;        # 长连接不被中途掐断
         # (handler 已发 X-Accel-Buffering: no 作双保险)
     }
     ```
   - 如果任务流(tasks/stream)在你的部署里已经能实时推,那 presence 流用同一套 `/api/` 配置即可。
3. **优雅关闭**:后端优雅关闭时 SSE 断开,对方在 TTL(~12s)内看到你离场;无需额外配置。

## 行为与调参

- 上报频率:`SEND_INTERVAL = 60ms`(~16Hz),在 `src/app/collab/presence-store.ts`。
- 心跳:每 5s 重发一次当前状态,保住在线名单不过期。
- 幽灵淘汰:名单项 `staleAfter = 12s`(后端 `presence/bus.go`)+ 前端 4s 一次本地淘汰,兜住漏发的 leave。
- 自己不画:前端按 `uid === 自己` 过滤;后端广播含发送者。
- 上限:单次 selection/activity 节点数后端截断 500,body ≤ 64KB。

## 涉及文件

- 后端:`backend/internal/presence/bus.go`(总线+名单+TTL+跨副本)、
  `backend/internal/workspace/interfaces/presence_handler.go`(SSE + POST + 鉴权/准入/访客只读)、
  `backend/cmd/api/main.go`(装配 + 路由)。
- 前端:`src/app/collab/color.ts`、`src/app/collab/presence-store.ts`(独立 store + 连接 + 上报)、
  `src/app/collab/usePresenceReporting.ts`、`src/app/components/RemotePresenceLayer.tsx`(覆盖层)、
  `src/app/components/Canvas.tsx`(挂载 + 拖拽上报)、`src/app/components/CollaborationControls.tsx`(在线头像堆叠)。

## 验证

部署最新构建后,**两个不同账号同时打开同一个协作项目**:
- 移动鼠标 → 对方看到彩色光标 + 名字;
- 选中节点 → 对方看到你颜色的描边;
- 拖动节点 → 对方看到「你 正在编辑」角标;
- 协作栏绿点变成在线成员彩色头像堆叠;
- 访客账号:能看别人、自己不被看。

单实例快速验证也可以:同一浏览器开两个不同账号的窗口(不同登录会话)进同一项目。

## 风险 / 注意

- **多副本无 Redis = 在场分裂**(不同副本的人互不可见)。务必配 Redis。
- **SSE 被代理缓冲**是最常见的「看不到实时」原因——检查 `proxy_buffering off`。
- **上行 QPS**:16Hz × 在线人数 × 项目数会给后端加 QPS;人多时可考虑降频或后续升级 WebSocket。
- **隐私**:光标/选中/操作会暴露给同房间所有成员。访客已设为只读;若要「隐藏我的光标」开关,可后续加。

## 后续 / 可选

- 「隐藏我的在场」隐私开关。
- 逐帧拖动位置(需升级 WebSocket 才丝滑,当前只显示「正在编辑」而非逐帧坐标)。
- 真·协同编辑(增量 op 流 + 冲突解决 / CRDT + WebSocket)——独立重构级项目。
