# ccy — CCY Canvas 无头命令行客户端

通过 HTTP 驱动运行中的 CCY Canvas 后端:登录、建项目、提交图/视频/文本生成、轮询、下载。
纯 HTTP 客户端,不引入后端 service/DB 层,`go build ./cmd/ccy` 产出一个独立跨平台二进制。

## 构建

```bash
# 当前平台
cd backend && go build -o ../bin/ccy ./cmd/ccy        # Windows: -o ../bin/ccy.exe

# 交叉编译
cd backend && GOOS=linux  GOARCH=amd64 go build -o dist/ccy-linux-amd64  ./cmd/ccy
cd backend && GOOS=darwin GOARCH=arm64 go build -o dist/ccy-darwin-arm64 ./cmd/ccy
```

## 配置与鉴权

- 后端地址优先级:`--base-url` > 环境变量 `CCY_BASE_URL` > `~/.ccy/config.json` > 默认 `http://localhost:8080`。
- 鉴权走 `ccy_session` Cookie(HMAC 签名,7 天过期,无 Bearer)。`ccy login` 成功后把 Cookie 原样存到
  `~/.ccy/session`(权限 0600),后续命令自动携带。**Cookie/密码从不打印到输出或日志。**
- Windows 上 0600 无法完全等效 POSIX,`~/.ccy/session` 的保护依赖 `%USERPROFILE%` 目录 ACL——勿在共享机使用。

## 常用命令

```bash
ccy login -e you@example.com          # 密码隐藏输入(也可 -p 或环境变量 CCY_PASSWORD)
ccy whoami                            # 当前用户 + 积分额度
ccy providers -s image                # 列出可用渠道(拿 provider_config_id + 模型)
ccy projects list

# 生成图片:提交 → 等待 → 下载(--out)
ccy generate image -p "一只橙色的猫" -m <model> --provider-config-id <id> --size 1:1 --out ./out

# 生成视频,带本地参考图(自动先上传)
ccy generate video -p "让它动起来" -m <model> --ref ./start.png --duration 5 --wait --out ./out

# 只提交不等待,拿 task_id 后再查/下载
ccy generate image -p ... -m ... --no-wait
ccy tasks get <task_id>
ccy download <result_url> -o ./out
```

## 要点

- **选模型/渠道**:`generate` 的 `--model` 填模型名字符串,`--provider-config-id` 只能取自 `ccy providers`
  的 `provider_config_id` 列(不是 `ccy models` 的 id)。同名模型可能出现在多条渠道,想精确走某条务必带
  `--provider-config-id`,否则后端按优先级/健康度自选。
- **node_id / project_id**:`--node-id` 默认自动生成 uuid(仅日志关联,无需对应真实画布节点);`--project-id`
  可选(带上时后端会拒绝只读访问者)。生成前无需先建项目/画布。
- **同步 vs 异步**:后端配了 `REDIS_ADDR` 就异步返回 `task_id`,否则同步内联返回结果。CLI 统一处理:默认
  `--wait`(SSE + 轮询并行,先到先得),`--no-wait` 只提交,`--poll-only` 只轮询不订阅 SSE,`--timeout` 秒。
- **下载**:自家后端对象直接带 Cookie 取;第三方/私有 COS 或即将过期的签名 URL 自动改走 `/api/app/proxy-media`。
- **多资产(组图 / n>1)**:全量 URL 仅经 SSE 下发;纯轮询只拿到第一张。
- **退出码**:0 成功;2 未登录/会话过期(401);3 积分不足(402);4 无权限/只读(403);5 请求无效(400/422);6 服务端错误(5xx);1 其他。

## 端到端自测

```bash
ccy --base-url http://127.0.0.1:9090 login -e <你的邮箱>
ccy --base-url http://127.0.0.1:9090 providers -s image        # 记下一条 (provider_config_id, 模型)
ccy --base-url http://127.0.0.1:9090 generate image -p "a cat" -m <模型> --provider-config-id <id> --out ./out
# 检查 ./out 落盘、~/.ccy/session 为 0600、输出里无 cookie/密码明文
```
