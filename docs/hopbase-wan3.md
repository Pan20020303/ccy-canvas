# HopBase 万相 3.0

后台「视频模型」新增渠道时选择 **HopBase · 万相 3.0（官方直连）**，配置该分组的密钥并启用。准确模型 ID 为 `wan3.0-video`，不使用 `-prime` 等别名。不要覆盖已有 Seedance / Grok 渠道的密钥。

密钥必须开通 **万相 3.0 官方直连** 分组。可以先用该密钥查询 HopBase 的 `GET /v1/models` 确认可用性，再发起计费生成。本次代码验证使用本地模拟服务，未发起真实付费生成。更新代码后需重新构建并重启后端，前端重新构建或使用开发服务。

## 已适配

- 提交：`POST /api/v1/services/aigc/video-generation/video-synthesis`；查询：`GET /api/v1/tasks/{task_id}`。不使用 Seedance 的 `/v1/video/*`，不发送 `X-DashScope-Async`。
- 画布和一键成片：480P / 720P / 1080P；2–30 秒整数或自动时长；声音开关；16:9、4:3、1:1、3:4、9:16。画布支持自适应画幅和随机种子。
- 首帧、首尾帧、全能参考。全能参考最多 10 张图片、5 段视频、5 段音频；首尾帧不能混用全能参考素材。
- 后端约每 15 秒查询一次，保存上游任务编号。仅 SUCCEEDED / FAILED 终止查询；网络抖动、429、5xx、未知进行中状态不重新提交计费请求。前端任务走项目现有异步队列和轮询机制。
- 成功结果交给现有媒体转存流程。HopBase 签名视频地址仅有效 6 小时，再查询不续期；请确保项目对象存储正常。

## 高级接口参数

项目生成接口使用已有统一字段：`duration`、`resolution`、`aspect_ratio`、`audio_setting`（on/off）、`seed`、`reference_images`、`reference_videos`、`reference_audios`、`reference_mode`。`duration: -1` 表示自动。

`parameters` 可传 `prompt_extend`、`watermark`（布尔值）；也支持原生 `audio`、`duration`、`ratio`、`resolution`、`seed`，统一字段显式值优先。未填写的字段保留上游默认值。

通过 `parameters.media` 可额外传入原生 `{ "type": "file", "url": "https://…" }` 或 `{ "type": "link", "url": "https://…" }` 等素材数组。文档与网页各最多一个，且彼此互斥，也不能和首尾帧混用。它们是高级接口能力，当前画布没有专用文档/网页上传入口。项目生成入口仍要求填写提示词。

参考素材支持公网 http(s) 和 base64 data URL；不支持 oss://、asset://；网页必须为 http(s)。本地上传沿用项目对象存储处理，不进行 Seedance 专用素材注册。

上游校验的限制：视频总时长 ≤15 秒，音频总时长 ≤15 秒，输入视频时长 + 输出时长 ≤30 秒；文档 ≤100 MB、≤50 页。万相的视频输入秒数也计费，因此带参考视频时不能无条件选择 30 秒输出。暂未在本地探测所有远端媒体的时长、文档页数，相关错误按上游真实原因显示。

本次仅接入万相 3.0，没有将快乐马 1.1 接入 HopBase。

依据：用户提供的最新 HopBase 文档及 [官方接口说明](https://hop-base.com/zh-cn/docs/media/bailian)。
