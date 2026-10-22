# 本地 FFmpeg 视频剪辑

画布中选中已上传或已生成的视频 → 剪辑。拖动起止点或输入秒数，可播放选中片段、保留或静音原声。导出后立即关闭面板，在新视频节点显示处理中、成功或失败，原素材不变。

- 接口：POST /api/app/video/trim，需要正常登录。参数 media_url、start、end、mute、node_id。
- 真实 FFmpeg 截取，不调用生成模型，不扣生成积分。任务日志模型标识为 ffmpeg-local-trim。
- 导出 MP4 / H.264 / yuv420p / AAC，CRF 18，veryfast，faststart。精确寻址重编码，不是按关键帧无损拷贝。
- 输入 MP4/MOV/MKV/WebM/AVI、512 MB 以内、最高 4K；片段 0.1–600 秒、结束位置不超过 3600 秒；输出 190 MB 以内，5 分钟超时。每个 API 实例最多 1 个剪辑任务。
- 只读取 uploads 下的素材或经 SSRF 检查的公网地址；FFmpeg 无网络权限，不接受播放列表、不执行 shell 命令。
- 断开页面会取消当前请求，失败日志可供节点状态恢复查询。不是持久化后台剪辑队列；服务重启前请等待任务完成。
- 当前是单视频片段剪辑，不包含多轨拼接、转场、字幕或调色。

## 运行工具
将 ffmpeg.exe、ffprobe.exe 放在 backend/tools/ffmpeg/。也可配置 FFMPEG_PATH、FFPROBE_PATH（完整可执行文件路径），或使用 PATH。
本机工具复用了已有 Pixelle-Video 安装中的 FFmpeg 可执行文件，未下载新软件。若向他人分发安装包，应保留所用构建的许可证、源代码及对应开源义务；该目录不是第三方二进制公开发布包。

官方项目与命令说明：https://ffmpeg.org/ 和 https://ffmpeg.org/ffmpeg.html

## 验证
设置 CCY_TEST_FFMPEG=1、FFMPEG_PATH、FFPROBE_PATH 后，运行：
go test ./internal/modelcatalog/application -run 'TestTrim|TestLocalTrim' -v
前端组件测试：npx vitest run src/app/components/VideoTrimDialog.test.tsx
