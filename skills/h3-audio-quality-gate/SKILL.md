---
name: h3-audio-quality-gate
description: Legacy H3 audio metrics helper. For automated media review use ccy-media-review; mark findings without blocking production or regenerating until explicit user approval.
---

# H3 音频指标辅助（旧门禁停用）

2026-09-04 用户策略更新：旧自动重试门禁停用，改用 `C:/Users/Administrator/.codex/skills/ccy-media-review/SKILL.md` 旁路审核；只标记，不阻塞下一段、尾帧衔接或合成。用户确认后才修复。以下脚本只提供技术证据，不能据退出码自动重生。

## 验收规则

- 从提示词的 `<d>[Chinese]...</d>` 标签提取唯一允许出现的对白；标签外文字永远不是台词。
- 无对白段：允许环境声和动作声。单个极短孤立音节（例如“哦”）记为轻微瑕疵并放行；连续可辨识话语、乱码人声、旁白、呢喃或歌声才判失败。
- 有对白段：必须检测到人声，识别文本与目标台词的规范化字符相似度必须达到阈值；缺词、串词、重复、说出画面说明均失败。
- 音轨缺失、解码失败、明显爆音/削波、持续异常杂音，或本应有环境声却异常静音，均失败。
- 检测失败只记录，不自动换 seed、不重跑、不停队列。ASR/单峰值可能误判，需复核；检查器故障记审核异常，不假装通过。
- 已生成 URL 正常写入画布、连续性引用和合成清单；质量状态独立记录。只有用户明确授权且满足修复时机后才修复指定镜头，原版保留。

## 本地执行器

调用 `scripts/check_video_audio.py`，传入视频路径及期望对白。该脚本使用 FFmpeg 解码音频，并用本机缓存的 Whisper 模型做语音检测与中文文本比对，输出单行 JSON 报告和进程退出码。

```powershell
python scripts/check_video_audio.py --video input.mp4 --expected-dialogue "今晚十二点前不挪" --json
```

退出码 `0` 仅表示本次自动指标未触发阈值，不证明没有杂音或已完成听审；`2` 是待复核指标异常，其他退出码是检查器故障。任何退出码都不能单独触发重生、阻塞生产或拒绝保存结果。
