# Visionular 视频超分接入

## 入口和档位

选中有结果的视频节点 → 工具栏“超分” → “Visionular · 云端”。原视频不变，输出到新的视频节点并连接原节点。

| 档位 | 项目模型 ID | Visionular 模板 |
| --- | --- | --- |
| 1080p 高清 | visionular-genopt-1080p | genopt_1080p |
| 1440p 超清 / QHD | visionular-genopt-1440p | genopt_1440p |
| 2160p / 4K 极清 | visionular-genopt-2160p | genopt_2160p |

只处理完整原视频，不发送裁切、时长或帧率覆盖参数；具体输出遵循上游已配置模板。原有 SeedVR2 本地视频/图片超分保持可用。此 MPS 接口不用于图片超分。

## 后端配置

后端进程环境支持以下变量，示例见仓库 `.env.example`（实际凭据只能写入 Git 忽略的 `.env` 或部署密钥管理器）：

- `VISIONULAR_ACCESS_KEY`、`VISIONULAR_SECRET_KEY`
- `VISIONULAR_PIPELINE`、`VISIONULAR_STORAGE_ID`
- 可选 `VISIONULAR_OUTPUT_BASE_URL`：OSS 桶根域名 / CDN 域名，不包含对象路径。空值根据任务返回的 bucket 与 region 还原 HTTPS 地址。

本机启动脚本会读取 `.env`；直接启动二进制时需自行注入环境变量。**不要使用 `VITE_` 前缀，不要把密钥放进参数 schema 或提示词。** Docker 生产部署同样需要向 API 容器注入这些变量。

首次启动自动创建 Visionular 渠道，AK:SK 组合使用现有 AES-GCM 渠道加密机制保存。后续启动不会覆盖管理员编辑的价格、开关或密钥。需要轮换密钥时，在管理端修改该渠道 API Key（格式 `AccessKey:SecretKey`）；修改管道 / 存储时编辑其参数 schema 中 `visionular.pipeline` / `visionular.storage_id`。三个工具模型隐藏于普通文生视频选择器，但可在超分弹窗按启用情况选择。

**档位是分辨率档位，不是会员等级，也未虚构官方人民币价格或预设阶梯积分差价。** 费用沿用现有渠道计费逻辑，可在后台分别配置 `models.<模型ID>.credit_cost`，未配置时沿用项目默认计费。正式开放前请按采购价格设置各档积分和会员使用权限。

## 接口与任务

官方文档：<https://docs.visionular.cn/mps/api#create_enhance_task>

- HTTPS 服务根路径：`https://api.visionular.cn/vodencoding/v1`
- V2 请求头：HTTP BasicAuth（AK/SK）及 `auth-type: use-basic`。
- POST `/create_enhance_task`：`input`、唯一 `output`、`template_name`、`storage_id`、`pipeline`，以及 `extra_options.session_id`。
- GET `/query_task?task_id=...`：识别 pending / downloading / running / uploading / succeeded / failed。
- 使用现有 `/api/app/generate`、generation_logs、任务队列 / SSE / 恢复轮询、积分预扣与终态失败退款、结果持久化；后台可以查询原始 provider task id。
- `session_id` 使用项目日志 ID；排队重试命中上游 24 小时去重（1006）时复用原任务，不创建第二次收费任务。GET 查询遇到瞬时错误允许重试；提交 POST 不作透明自动重试。

输入必须是可由云端读取的 HTTP(S) URL，不能是 blob/Base64/本地上传路径。项目自有私有 OSS/COS 对象会使用已有签名机制。输出 `oss://bucket/path` 根据任务地域转换为 HTTPS，再走现有媒体暂存与对象存储持久化；如果输出是不同的私有桶，需要配置可访问的输出 CDN/签名地址或相应存储权限，不能只改成 HTTPS 就假设有下载权限。上游错误正文和凭据不会回传浏览器。

## 验证

单元测试覆盖三个模板映射、V2 两个鉴权头、创建与查询契约、六个任务阶段、1006 去重、查询重试、错误脱敏、无效 URL、输出地址解析、加密初始化以及非覆盖式启动。界面测试覆盖三档选择、未配置 / 部分档位未启用、忙碌禁用与本地引擎回归。

只读调用可验证账户与存储配置；开发测试使用本地模拟服务器，不会提交收费超分。上线验收需选一段用户授权的短视频完成实际云端输出、音轨 / 时长及播放下载验证。
