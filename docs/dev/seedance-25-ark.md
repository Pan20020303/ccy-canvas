# 即梦官方 Seedance 2.5 适配

在后台「模型服务 → 火山引擎 · 即梦 Seedance → 从模板导入」选择
`doubao-seedance-2-5-260628`。保持官方 Ark 地址
`https://ark.cn-beijing.volces.com/api/v3` 和 `ark` 协议。
已有渠道不会被自动修改，密钥、启停状态与积分定价仍由管理员配置。

## 画布与上游参数

| 画布 / 应用字段 | 官方请求字段 |
| --- | --- |
| 提示词 | `content[].type=text` / `text` |
| 全能参考图片 | `image_url`，`role=reference_image` |
| 全能参考视频 | `video_url`，`role=reference_video`，保留连线顺序 |
| 全能参考音频 | `audio_url`，`role=reference_audio` |
| 首尾帧 | `first_frame` / `last_frame`，不混用全能参考 |
| 全能 / 多图 / 动作参考 | `omni_reference_task_type=reference` |
| `audio_setting=on/off` | `generate_audio=true/false`，默认开启 |
| 时长、比例、分辨率 | `duration`、`ratio`、`resolution` |
| 输出格式 | `output_format=mp4/mov`，默认 MP4 |

界面开放 4～30 秒、480p / 720p；后台也接受 `duration=-1` 自动时长。
全能参考最多 30 张图片、10 段视频、10 段音频。超出这些数量、无效时长、
不支持的分辨率/格式、混用首尾帧与多模态参考，会在请求上游前报错。
参考视频和音频仍须具有上游可访问的 URL；媒体时长、大小、内容审核及
账号权限由 Ark 最终校验，原有真实上游错误处理保持不变。

当前不开放 2.5 视频编辑/延长的 UI：本次接入的是参考生成，不将参考视频
误当作编辑或延长任务。HopBase/DMXAPI 和旧版 Seedance 的协议不变。

## 验证与资料

- 以用户提供的官方请求作为合同测试：1 张图 + 6 段视频，15 秒，16:9，
  `generate_audio=true`、`omni_reference_task_type=reference`、`output_format=mov`。
- 前端测试验证真实 `runNode` 提交的参考数组和设置；本地 HTTP 模拟服务
  验证 Ark POST 请求体、授权头、任务 ID 轮询和 MOV 结果。
- 增加音频关闭、音频参考去重、首尾帧、数量与参数越界、旧版兼容测试。
- 不调用真实付费生成。更新后端进程/worker 后，新的请求适配才会生效；
  重启前应等待现有任务完成，或使用现有部署流程平滑更新。
- [ByteDance Seedance 2.5 模型说明](https://seed.bytedance.com/en/seedance2_5)
- [BytePlus 官方同系列输入及能力表](https://docs.byteplus.com/en/docs/Byteplus_LAS/video_gen_enhanced)
  用于核对 2.5 的分辨率、时长和多模态能力；国内 Ark 的字段以用户提供的
  官方请求为准（BytePlus LAS 是不同入口，不能替换本渠道地址）。
