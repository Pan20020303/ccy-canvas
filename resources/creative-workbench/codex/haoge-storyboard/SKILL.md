---
name: haoge-storyboard
description: 豪哥分镜，将小说或原剧本整理为场次级 AI 剧本，检查人物称呼、剧情节点、动作因果和连续性；用户明确要逐镜结构时输出执行分镜，按需读取对应格式。
---

# 豪哥分镜 · 按需入口

先读 [CCY 接入边界](references/ccy-integration.md) 和 [工作流](references/workflow.md)。默认不改定稿事件、人物关系、对白归属与结果。

- 场次级 AI 剧本：读 [交付结构](references/storyboard-schema.md) 中对应模式，保留情绪、动作起点、结果与场尾状态，不预先替用户锁死镜数和秒数。
- 逐镜分镜或 CCY 一键成片：同一结构文档中选执行分镜；以宿主要求的 JSON 字段与真实资产 ID 为准，不把示例名字和占位符当成真实素材。
- 完成当前批次前：读 [质量检查](references/quality-control.md)，检查有无漏情节、换说话人或破坏连续性。
- 用户需要文件交付时再读 [本地交付](references/local-delivery.md)，不覆盖原稿。长文本在完整场次处分批，明确完成范围。

详细原版说明保存在 [SOURCE_SKILL.md](SOURCE_SKILL.md)。只在需要查未覆盖规则时读取，不默认启动后续生成。
