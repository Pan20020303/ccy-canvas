---
name: ai-film-workbench
description: 智能体创作工作台入口。用于打开创作工作台、选择编剧或剧本医生、分镜、资产导演、图像提示词、打斗设计，以及明确要求的完整创作流程；按当前阶段读取对应技能，不一次加载所有资料。
---

# 智能体创作工作台 · 按需入口

先读 [CCY 接入边界](references/ccy-integration.md)。本入口适用于对话与 CCY 画布制作，不修改用户已确定的流程。

已有明确任务直接路由；没有目标才问需要哪项。不要仅因用户上传剧本就启动全部流程。

| 当前任务 | 读取入口 |
| --- | --- |
| 构思、编剧、剧本诊断、情绪动作细写 | [剧本医生](../screenwriter/SKILL.md) |
| 原文整理成场次级 AI 剧本 | [豪哥分镜](../haoge-storyboard/SKILL.md) |
| 分镜、镜头表、视频提示词、连续性 | [咸鱼分镜](../seedance-agent/SKILL.md) |
| 提取人物、场景、道具，规划对应参考图 | [豪哥导演](../haoge-film-director-flex/SKILL.md) |
| 写或修改图片提示词 | [GPT 制图](../gpt-image/SKILL.md) |
| 编排已有打戏或独立对决 | [打斗导演](../sd05-fight-director/SKILL.md) |

只读取命中的入口及该入口指定的相关章节。完整流程需要用户明确提出，才读取 [完整流程参考](references/automatic-script-workflow.md)；在 CCY 中依项目既定阶段安排，不改变用户锁定的顺序。

跨阶段记录原稿、版本、已选素材、镜头范围、未决项与下一步，不假装后台持续制作。详细历史规则和来源说明在 [原始入口](SOURCE_SKILL.md)，只有当前问题需要时再读取。
