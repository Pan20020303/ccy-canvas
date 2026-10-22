# ComfyUI 局域网算力池

CCY Canvas 继续作为唯一的任务入口、队列和结果存储端；局域网里的其他电脑只运行 ComfyUI API，不需要部署 CCY 或复制数据库。

## 节点配置

在“管理后台 → 模型服务”中，每台 ComfyUI 电脑对应一条 Provider 配置：

- 厂商：`ComfyUI`
- 协议：`Native`
- Base URL：该电脑的局域网地址，例如 `http://192.168.1.126:8188`
- 模型列表：各节点必须真实安装并支持的模型 ID
- 算力池 ID：同一组机器使用相同值，例如 `minimax-h3-lan`
- 节点名称：便于日志识别，例如 `本机-4070TiS`、`工作站-4090`
- 并发槽位：普通单 GPU ComfyUI 填 `1`

只有显式填写相同 `compute_pool` 的 ComfyUI 配置才会互相分流。其他供应商和旧配置仍保持精确路由，不受影响。

## 调度语义

1. 中央 Redis/Asynq 队列保证画布任务可恢复及请求 ID 去重。
2. 真正提交前，后端并行读取池内各节点的 `GET /queue`。
3. 按 `(运行中 + 待处理) / 并发槽位` 选择负载最低的健康节点；优先级仅用于同负载时决胜。
4. 进程内预留计数覆盖“刚选中但 `/queue` 尚未出现任务”的竞态窗口。
5. 选中后，参考素材上传、`POST /prompt`、`GET /history/{prompt_id}`、`GET /view` 全部固定使用同一 Base URL。
6. 已提交任务失败或超时不会自动改投另一节点，以免非幂等生成被重复提交。

## 网络与安全

ComfyUI 以 `--listen 0.0.0.0 --port 8188` 启动。Windows 防火墙只应允许“专用网络 + LocalSubnet”，不要在路由器上做公网端口映射。ComfyUI 原生 API 默认没有 CCY 账号鉴权；如需跨网段或异地接入，应先通过 WireGuard/Tailscale 等受控隧道，而不是直接暴露 8188。

## SSH 临时算力节点

云主机或临时租用 GPU 可以只让 ComfyUI 监听远端回环地址，再通过 SSH 本地端口转发加入同一个算力池：

1. 在远端安装 CCY 所需的 ComfyUI 节点和模型，并让 ComfyUI 监听 `127.0.0.1`。
2. 使用独立 SSH 密钥登录；密码仅用于首次安装公钥，不写入 Provider、脚本或数据库。
3. 在 CCY 主机创建一个不含密码的节点配置，使用 `scripts/windows/manage-ssh-compute.ps1 Start` 建立隧道。
4. Provider 的 Base URL 填隧道地址（例如 `http://127.0.0.1:28188`），不要填写远端公网 ComfyUI 地址。
5. Provider 启用时参与 `compute_pool` 调度；停用 Provider 即停止分配新任务。要彻底断开连接，再运行脚本的 `Stop` 操作。

节点配置示例：

```json
{
  "name": "临时 H3 算力",
  "host": "gpu.example.com",
  "ssh_port": 22,
  "ssh_user": "root",
  "identity_file": "C:\\ccy迁移\\secrets\\ssh\\h3-ed25519",
  "local_port": 28188,
  "remote_port": 6006,
  "pid_file": "C:\\ccy迁移\\run\\ssh-compute\\h3.pid",
  "log_file": "C:\\ccy迁移\\run\\ssh-compute\\h3.log"
}
```

隧道只绑定 `127.0.0.1`，不会把远端无鉴权的 ComfyUI API 暴露给局域网或公网。SSH 连接中断后，`ServerAliveInterval` 会清理失效进程；算力池健康检查会自动跳过不可用节点。
