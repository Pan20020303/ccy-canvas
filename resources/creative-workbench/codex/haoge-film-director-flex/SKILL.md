---
name: haoge-film-director-flex
description: 豪哥导演。用于 CCY 短剧的人物场景道具提取、参考图描述、资产依赖、空间走位与镜头连续性规划；按资产类型或镜头任务读取小型参考模块。
---

# 豪哥导演 · 按需入口

先读 [CCY 接入边界](references/ccy-integration.md)。核对真实剧本、镜头、已采用资产与待处理范围，然后只读对应模块：

| 任务 | 参考 |
| --- | --- |
| 人物外貌、服装、同人不同状态 | [角色资产](references/character_assets.md) |
| 场景结构、时间、光线与地标 | [场景资产](references/scene_assets.md) |
| 关键道具形态、材质、持握及状态 | [道具资产](references/prop_assets.md) |
| 镜头设计与表演 | [导演规则](references/director_rules.md) |
| 位移、遮挡、轴线与站位 | [空间预检](references/spatial_preflight.md) |
| 风格一致性 | [风格锁定](references/style_lock.md) |
| 续作或中断恢复 | [项目账本](references/project_ledger.md) |

多种资产同时提取才读多个资产模块。不得为了形式齐全制造多余状态图、固定参考数量或无关资产；最终生成比例、模型和模板遵守用户设置。

写资产提示词需要专项优化时，再读同包 [GPT 制图入口](../gpt-image/SKILL.md)。不要默认加载内嵌的重复大文档 `gpt-image-embedded.md`。

360 补角、一镜到底、声音、循环等仅在用户当前任务涉及它们时读取同名参考文件。完整原版入口在 [SOURCE_SKILL.md](SOURCE_SKILL.md)，按需查证，不自动运行其中脚本或整套状态机。
