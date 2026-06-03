# CCY Canvas 局域网部署指南

适用场景：**单台服务器，20 人内网并发**。

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
