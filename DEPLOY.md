# CCY Canvas 局域网部署指南

适用场景：**单台服务器，20 人内网并发**。

支持两种平台：
- **Linux / macOS** — 用 `scripts/*.sh`（bash）
- **Windows** — 用 `scripts/windows/*.ps1`（PowerShell），见 [§W. Windows 部署](#w-windows-部署)

---

## 0. 前置准备

服务器上需要：

| 工具       | 最低版本 | 安装提示                                              |
| ---------- | -------- | ----------------------------------------------------- |
| Go         | 1.22+    | https://go.dev/dl/                                    |
| Node.js    | 20+      | https://nodejs.org/  （只用于一次性 build，无需常驻） |
| Docker     | 24+      | 用来跑 PostgreSQL（最省事）                           |
| Nginx      | 1.20+    | 反代前端 + 静态文件（推荐，不强制）                   |

服务器最低配置建议：**4 核 / 8 GB RAM / 50 GB 磁盘**。

---

## 1. 拉取代码

```bash
git clone <repo-url> /opt/ccy-canvas
cd /opt/ccy-canvas
```

---

## 2. 一键安装

```bash
bash scripts/install.sh
```

这个脚本会：
1. 启动 PostgreSQL（Docker）
2. 自动跑 db migrations
3. 编译后端二进制 `bin/ccy-canvas-api`
4. build 前端到 `dist/`
5. 生成 `.env` 配置文件（如果不存在）

完成后看到 `✅ Install done`。

---

## 3. 配置环境变量

第一次安装会生成 `.env`，编辑它：

```bash
cd /opt/ccy-canvas
vim .env
```

需要确认/修改的字段：

```bash
# 数据库
DATABASE_URL=postgres://postgres:postgres@localhost:5432/ccy_canvas?sslmode=disable

# 会话密钥（必须改！至少 32 字符）
SESSION_SECRET=请改成随机 32 字符以上字符串

# 加密上游 API key 用的 32 字节 base64 密钥（生产环境必须重新生成）
CCY_ENCRYPTION_KEY=MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=

# 后端监听地址（0.0.0.0 = 接受局域网连接）
HTTP_ADDR=0.0.0.0:8080

# Cookie 安全设置：纯 HTTP 内网填 false，HTTPS 填 true
COOKIE_SECURE=false

# 前端 build 时使用的 API 地址（脚本会自动注入到 dist/）
PUBLIC_API_BASE=http://192.168.X.X:8080   # ← 改成你的服务器 LAN IP
```

**生成强随机密钥**：

```bash
# SESSION_SECRET
openssl rand -hex 32

# CCY_ENCRYPTION_KEY（必须 base64 32 字节）
openssl rand -base64 32
```

修改 `.env` 后重新构建前端：

```bash
bash scripts/build-web.sh
```

---

## 4. 启动 / 停止 / 重启

```bash
bash scripts/start.sh    # 启动后端服务（后台运行）
bash scripts/stop.sh     # 停止
bash scripts/restart.sh  # 重启
bash scripts/status.sh   # 查看状态
bash scripts/logs.sh     # 查看实时日志
```

服务以 `nohup` 后台运行，PID 写入 `run/api.pid`，日志写入 `run/api.log`。

---

## 5. 前端服务（任选一种）

### A. 用 Nginx 反代（推荐）

复制 `scripts/nginx.example.conf` 到 `/etc/nginx/conf.d/ccy-canvas.conf`：

```nginx
server {
    listen 80;
    server_name _;

    # 前端静态文件
    root /opt/ccy-canvas/dist;
    index index.html;

    # API 反代
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 600s;   # 视频生成可能跑较久
        proxy_send_timeout 600s;
        client_max_body_size 60M;  # 配合上传 50MB 限制
    }

    # 上传文件反代
    location /uploads/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        # 给上传文件加缓存
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # 前端 SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

启用：

```bash
sudo nginx -t           # 校验配置
sudo nginx -s reload
```

然后局域网用户直接访问 `http://<服务器IP>` 即可（80 端口）。

### B. 不用 Nginx，直接 serve 静态文件

`scripts/serve-web.sh` 用 Python 起一个静态服务器（开发可用）：

```bash
bash scripts/serve-web.sh   # 监听 :5173
```

⚠️ 这种方式 API 调用要直连后端 8080 端口，确保 `.env` 里 `PUBLIC_API_BASE` 写对。

---

## 6. 防火墙

```bash
# Ubuntu / Debian (ufw)
sudo ufw allow 80/tcp      # 如果用了 Nginx
sudo ufw allow 8080/tcp    # 如果直连后端

# CentOS / RHEL (firewalld)
sudo firewall-cmd --add-port=80/tcp --permanent
sudo firewall-cmd --add-port=8080/tcp --permanent
sudo firewall-cmd --reload

# Windows Server
# 控制面板 → Windows 防火墙 → 高级安全 → 入站规则
# 新建规则 → 端口 → TCP → 80 / 8080 → 允许
```

---

## 7. 数据库备份（定时任务）

```bash
crontab -e
```

加一行（每天凌晨 3 点备份到 `/var/backups/`）：

```cron
0 3 * * * docker exec ccy-canvas-postgres pg_dump -U postgres ccy_canvas | gzip > /var/backups/ccy-canvas-$(date +\%Y\%m\%d).sql.gz
```

恢复：

```bash
gunzip -c backup.sql.gz | docker exec -i ccy-canvas-postgres psql -U postgres -d ccy_canvas
```

---

## 8. 日志轮转

后端日志写到 `run/api.log`。配置 logrotate（`/etc/logrotate.d/ccy-canvas`）：

```
/opt/ccy-canvas/run/api.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

---

## 9. 升级流程

```bash
cd /opt/ccy-canvas
bash scripts/stop.sh
git pull
bash scripts/install.sh   # 重跑 migrate + rebuild
bash scripts/start.sh
```

---

## 10. 故障排查

| 现象                              | 排查                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------- |
| 前端 CORS 报错                    | 检查 `.env` 的 `PUBLIC_API_BASE` 是否等于浏览器实际访问的域名                   |
| 上游 provider Invalid token       | 进 admin 后台 `/admin/provider-configs` 重新填 API key                          |
| `429 too many requests` / 卡顿    | 后端 generate 并发上限是 8，正常等待即可；过多并发是设计行为                    |
| 数据库 `too many connections`     | PG 默认 `max_connections=100`；后端池子 50；admin 控制台再开 5。仍报错就提 PG 配置 |
| `413 Request Entity Too Large`    | 上传 > 50 MB；要么前端压缩，要么改 `upload_handler.go` 的 `maxUploadSize`        |
| 前端 localStorage 报 quota        | 已有兜底；只是日志 warn，不影响功能                                              |

后端日志关键位置：
- 应用日志：`run/api.log`
- 数据库容器日志：`docker logs ccy-canvas-postgres`

---

## 配置参数速查

| 位置                                                                | 默认值 | 含义                            |
| ------------------------------------------------------------------- | ------ | ------------------------------- |
| `database.go` → `MaxConns`                                          | 50     | PG 连接池上限                   |
| `handler.go` → `generateLimiter`                                    | 8      | 上游 provider 并发上限          |
| `httpx.MaxBodyMiddleware`                                           | 10 MB  | 非上传请求体大小上限            |
| `upload_handler.go` → `maxUploadSize`                               | 50 MB  | 上传文件大小上限                |
| `cors.go` → `isLANOrigin`                                           | —      | 自动放行私有 IP / localhost     |

修改后需要 `bash scripts/install.sh` 重新构建后端。

---

## W. Windows 部署 {#w-windows-部署}

### W.1 前置依赖

| 工具             | 安装方式                                                                |
| ---------------- | ----------------------------------------------------------------------- |
| Go 1.22+         | https://go.dev/dl/  下载 .msi，安装时自动加入 PATH                      |
| Node.js 20+      | https://nodejs.org/  下载 LTS .msi                                      |
| Docker Desktop   | https://www.docker.com/products/docker-desktop/  （需开 WSL2 后端）     |
| Git for Windows  | https://git-scm.com/  附带 `gzip`、`ssh`，备份脚本会用                  |
| **可选** NSSM    | `choco install nssm` 或 https://nssm.cc/download — 用于注册 Windows 服务 |
| **可选** Nginx   | http://nginx.org/en/download.html  Windows 版稳定包                     |

建议同时安装 **chocolatey**（https://chocolatey.org/install）方便后续 `choco install nginx nssm` 一键搞定。

### W.2 一键安装

以 **管理员身份** 打开 PowerShell，cd 到项目根目录：

```powershell
cd D:\opt\ccy-canvas
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
```

脚本会：
1. 检查 go / npm / docker 依赖
2. 自动从 `.env.example` 生成 `.env`，注入随机 `SESSION_SECRET` + `CCY_ENCRYPTION_KEY`
3. 启动 PostgreSQL Docker 容器
4. 编译 `bin\ccy-canvas-api.exe`
5. `npm install` + build 前端到 `dist\`

### W.3 配置 `.env`

```powershell
notepad .env
```

需要确认/修改：
- `PUBLIC_API_BASE=http://<服务器局域网IP>:8080` 或留空（用 nginx 反代时）
- `HTTP_ADDR=0.0.0.0:8080`（默认就是 `:8080`，等同所有网卡）
- `COOKIE_SECURE=false`（纯 HTTP 内网保持 false）

修改 `PUBLIC_API_BASE` 后必须重新 build 前端：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\build-web.ps1
```

### W.4 启动 / 停止 / 状态

```powershell
# 启动（后台运行，PID 写到 run\api.pid，日志写到 run\api.log）
powershell -ExecutionPolicy Bypass -File scripts\windows\start.ps1

# 停止
powershell -ExecutionPolicy Bypass -File scripts\windows\stop.ps1

# 重启
powershell -ExecutionPolicy Bypass -File scripts\windows\restart.ps1

# 状态（含 PG 容器状态、内存占用、最近日志）
powershell -ExecutionPolicy Bypass -File scripts\windows\status.ps1

# 实时日志（-Pg 切到 PG 容器日志）
powershell -ExecutionPolicy Bypass -File scripts\windows\logs.ps1
powershell -ExecutionPolicy Bypass -File scripts\windows\logs.ps1 -Pg
```

> 💡 嫌每次输 `powershell -ExecutionPolicy Bypass -File` 麻烦？开 PowerShell 管理员权限里跑一次：
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```
> 之后就能直接 `.\scripts\windows\start.ps1`。

### W.5 注册为 Windows 服务（推荐生产用）

简单 `start.ps1` 的进程在用户登出后会被 Windows 杀掉。如果你希望服务**开机自启 + 崩溃自动重启 + 日志轮转**，用 NSSM：

```powershell
# 1. 装 NSSM
choco install nssm

# 2. 注册服务（管理员 PowerShell）
powershell -ExecutionPolicy Bypass -File scripts\windows\install-service-nssm.ps1
```

服务名为 **`CCYCanvasAPI`**，管理命令：

```powershell
nssm status CCYCanvasAPI
nssm restart CCYCanvasAPI
nssm stop CCYCanvasAPI
nssm remove CCYCanvasAPI confirm    # 卸载
```

也可以在 `services.msc`（服务管理器）里找到并启停。NSSM 已设：
- 开机自启
- stdout/stderr 写入 `run\api.log`
- 日志自动轮转（50 MB 一份）
- `.env` 注入到服务环境变量

### W.6 前端 — Nginx for Windows

**A. 用 Nginx for Windows（推荐）**

```powershell
choco install nginx   # 或自行解压官方包到 C:\nginx
```

编辑 `C:\nginx\conf\nginx.conf`，把 `http {}` 段里的 `server {}` 替换为 `scripts\nginx.example.conf`（路径改为绝对 Windows 路径，例如 `root D:/opt/ccy-canvas/dist;`，注意正斜杠）。

启动：

```powershell
cd C:\nginx
.\nginx.exe                # 启动
.\nginx.exe -s reload      # 热重载
.\nginx.exe -s stop        # 停止
```

也可以用 NSSM 把 nginx 也注册成服务，开机自启。

**B. 不用 Nginx — Python 静态服务（测试用）**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\serve-web.ps1
```

默认端口 5173。用户访问 `http://<服务器IP>:5173`。**注意**：这种模式下需要 `.env` 里 `PUBLIC_API_BASE=http://<IP>:8080` 显式指向后端。

### W.7 防火墙

打开「**Windows Defender 防火墙** → **高级安全** → **入站规则** → **新建规则**」，按顺序：

1. 规则类型 → **端口**
2. 协议和端口 → **TCP**，特定端口 → `80,8080,5173`（按实际用到的）
3. 操作 → **允许连接**
4. 配置文件 → **域 + 专用**（不要勾选 公用 网络），更安全
5. 名称 → `CCY Canvas Inbound`

或 PowerShell 一行搞定（管理员）：

```powershell
New-NetFirewallRule -DisplayName "CCY Canvas API"  -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Domain,Private
New-NetFirewallRule -DisplayName "CCY Canvas Web"  -Direction Inbound -Protocol TCP -LocalPort 80   -Action Allow -Profile Domain,Private
```

### W.8 数据库备份（计划任务）

手动备份：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\backup-db.ps1
# 默认输出到 C:\Backups\ccy-canvas\ccy-canvas-YYYYMMDD-HHMMSS.sql[.gz]
```

注册每天凌晨 3 点自动跑（管理员 PowerShell）：

```powershell
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
            -Argument "-ExecutionPolicy Bypass -File D:\opt\ccy-canvas\scripts\windows\backup-db.ps1"
$trigger = New-ScheduledTaskTrigger -Daily -At 3:00am
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
Register-ScheduledTask -TaskName 'CCYCanvasBackup' -Action $action -Trigger $trigger -Principal $principal
```

在「任务计划程序」里能看到 `CCYCanvasBackup` 这一项。

### W.9 升级

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\stop.ps1
git pull
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
powershell -ExecutionPolicy Bypass -File scripts\windows\start.ps1
```

如果走 NSSM 服务方式，stop/start 用 `nssm` 命令替换；重新 build 后服务会指向新 EXE。

### W.10 Windows 专属故障排查

| 现象                                    | 处理                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `cannot run script .ps1: execution policy` | 临时：脚本前加 `powershell -ExecutionPolicy Bypass`<br>永久：`Set-ExecutionPolicy RemoteSigned` |
| Docker Desktop 启动慢 / 卡 WSL          | 任务栏 Docker 图标 → Quit → 重新启动；确认 WSL2 内核已更新 (`wsl --update`)                         |
| 8080 端口被占用                         | `netstat -ano \| findstr 8080`，找出 PID 后 `taskkill /PID <pid> /F`                                |
| 服务装好但端口拒绝连接                  | 检查防火墙是否同时允许了 域 / 专用 配置（公用网络默认拦截）                                         |
| `start.ps1` 后立刻 stopped              | 看 `run\api.log` 最后 30 行；多数是 `.env` 没生效，去 `scripts\windows\status.ps1` 看进程是否真起来 |
| 中文乱码（日志 / 控制台）               | PowerShell 里跑 `chcp 65001` 切换到 UTF-8；或加到 PS profile                                        |
| `gzip` 命令不存在导致备份失败           | 装 Git for Windows，会自动带 gzip 到 PATH；或脚本会自动 fallback 到未压缩 .sql                      |
| `.env` 打开是乱码 / Go 报无法连接数据库 | 旧脚本写入了 BOM 头。跑 `powershell -ExecutionPolicy Bypass -File scripts\windows\fix-env-encoding.ps1` 一键修复（重写为 UTF-8 无 BOM + LF）|

---
