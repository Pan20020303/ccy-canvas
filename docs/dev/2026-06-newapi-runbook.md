# NewAPI 网关接入 Runbook

NewAPI 实例:`http://47.79.1.202:3001/`(已部署)
配套计划:`~/.claude/plans/11-1-1-2-2-staged-kitten.md`

本文档是 **P-1 / P0 阶段** 用户在 NewAPI 服务器上要做的所有事 —— 我没法登 47.79.1.202,
所以这些步骤只能由你执行,我等你打钩后才能进 P1 backend 串联代码。

---

## P-1 安全加固(P0 前置,必须做)

### 1. 改默认 root 密码

NewAPI 首次部署默认账号通常是 `root / 123456`。被扫到就完了。

```
浏览器打开 http://47.79.1.202:3001/
登录后:右上角头像 → 个人设置 → 修改密码
密码长度 16+,带数字 + 大写字母 + 符号
```

### 2. 上 HTTPS(三选一)

**方案 A — Caddy 一行配置(最快)**

SSH 上 47.79.1.202:

```bash
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile <<EOF
newapi.yourdomain.com {
    reverse_proxy localhost:3001
}
EOF
sudo systemctl restart caddy
```

DNS 把 `newapi.yourdomain.com` 解析到 47.79.1.202,Caddy 会自动申请 LE 证书。
之后 backend 调 **`https://newapi.yourdomain.com/v1`**,不再用 IP。

**方案 B — Nginx + certbot(已有 Nginx 用)**

```bash
sudo certbot --nginx -d newapi.yourdomain.com
# certbot 自动生成配置,把 proxy_pass 改成 http://localhost:3001
```

**方案 C — 内网走 Tailscale(开发期临时方案)**

backend 那台机器和 47.79.1.202 都装 Tailscale,backend 调 `http://<tailscale-ip>:3001/v1`,不出公网。

### 3. 防火墙白名单 3001

让 NewAPI 的 3001 端口只允许你 + backend 的出口 IP 进:

```bash
# 你办公 IP(查 whatismyip.com)
sudo ufw allow from <your-office-ip> to any port 3001 proto tcp
# backend 服务器出口 IP
sudo ufw allow from <backend-egress-ip> to any port 3001 proto tcp
sudo ufw deny 3001
sudo ufw enable
```

**上完 HTTPS 后 3001 应该不再公网开放**(只剩 443/Caddy 对外)。本步骤是双保险。

---

## P0 在 NewAPI admin UI 里配 channel

### 1. 新建 backend 用的 Token

```
左侧导航 → 令牌 → 添加新令牌
名称:  ccy-canvas-prod
额度:  无限(选"额度无限")
过期:  永不过期 / 1 年(自己定)
模型:  全部(默认)
保存,复制出现的 sk-xxxxxxxxxxxxxxxx
```

**这个 `sk-` 给 backend,后面 P1 代码里要 env 注入**:`NEWAPI_TOKEN=sk-xxx`

### 2. 把现有 provider 在 NewAPI 里建 channel

```
左侧导航 → 渠道 → 添加新渠道
```

对照你 ccy-canvas 现有的 `provider_configs` 表里每一条,重建到 NewAPI:

| ccy-canvas 字段 | NewAPI channel 对应字段 |
|---|---|
| `name` | 名称 |
| `api_spec` (openai/ark/custom) | 类型(下拉,选最接近的 —— Volcengine/火山 选"火山方舟",Doubao 也选"火山方舟") |
| `base_url` | 代理 (Proxy) —— 直接粘贴,NewAPI 会把请求转发到这里 |
| `api_key` (解密后) | 密钥 |
| 涉及的 model 名 | 模型 —— 多行,每行一个 model id,比如:`doubao-seedance-1-0-pro`, `doubao-pro-256k` |

**关键**:**模型名要跟前端 / `ProviderConfig.ChannelName` 里用的完全一致**。NewAPI 通过 `request.model` 字段路由到 channel。比如前端发 `model: "doubao-seedance-1-0-pro"`,这个字符串要在某个 channel 的"模型"列表里。

### 3. 逐个 channel 点"测试"

每条 channel 编辑页右上有"测试",绿勾才能用。
**视频 channel 特别要测**(Sora / Seedance / Vidu 这种 NewAPI 可能覆盖不全)。

如果某个视频模型测试报"不支持",有 3 个备选:
- 看 NewAPI GitHub Issues 是不是已知,等社区适配
- fork NewAPI,加一个 channel 适配(几百行 Go,改 `relay/channel/<vendor>/`)
- P3 阶段在我们 backend 里给这单一模型走旁路(不走 NewAPI,直连)—— 后路保留

### 4. 测试一次完整调用

从你电脑 curl:

```bash
curl https://newapi.yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer sk-xxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

返回 OpenAI 标准 schema 就 ✅。

```bash
curl https://newapi.yourdomain.com/v1/images/generations \
  -H "Authorization: Bearer sk-xxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "dall-e-3",
    "prompt": "a cat",
    "n": 1,
    "size": "1024x1024"
  }'
```

返回 `data[].url` 就 ✅。

---

## 完成检查表

- [ ] P-1.1 root 密码改成 16+ 字符强密码
- [ ] P-1.2 配置 HTTPS,backend 调用地址改成 `https://...`
- [ ] P-1.3 3001 端口防火墙白名单只允许你 + backend 的 IP
- [ ] P0.1 创建 `ccy-canvas-prod` Token,记下 sk-
- [ ] P0.2 把现有 ProviderConfig 全部在 NewAPI 建 channel
- [ ] P0.3 每个 channel 点"测试"过绿勾(尤其视频)
- [ ] P0.4 curl 测试 chat + image 都返回 200

打完 4 个 ✅ 告诉我,我直接进 P1 backend 代码。

---

## 给 backend 用的环境变量

把这两个加到 backend `.env`(或部署的环境配置):

```bash
NEWAPI_BASE_URL=https://newapi.yourdomain.com/v1
NEWAPI_TOKEN=sk-xxxxxxxxxxxxxxxx
# 可选:
NEWAPI_TIMEOUT_SECONDS=60
```

**没设 `NEWAPI_BASE_URL` → backend 走 legacy(老 ProviderConfig)路径**,P1 代码默认这样设计,可以平滑上线。
