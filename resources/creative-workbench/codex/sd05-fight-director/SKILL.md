---
name: sd05-fight-director
description: SD-05 打斗导演，用于独立打戏设计或改进已有分镜中的攻防、速度重量、受力反馈、武器身份、相机与音效节奏；不为普通剧情自动添加战斗。
---

# SD-05 打斗导演 · 按需入口

先读 [CCY 接入边界](references/ccy-integration.md)，再读 [六层动作核心](references/ccy-fight-core.md)。沿用用户已给角色、场景、胜负、风格和时长。

- 将“快、狠、有重量、压迫”等感觉落成编排：读 [感觉路由](references/feel-routing.md)。
- 处理撞击、受力和重音：读 [冲击语言](references/impact-language.md)。
- 需要具体写法时，在 [分段案例库](references/segment-library.md) 中定位对应段落，不一次载入全部案例，不把案例人物与技能复制成当前设定。

每段写清威胁→选择→攻防接触→物理反馈→新局面；让对手反应改变下一招。写实打戏不自动加入法阵、血腥特写或毁天灭地的效果。

输出符合当前宿主字段、时长和文字预算的提示词。只修改指定打戏，不改其他场次和结局，不自动调用生图／视频。完整原版规则与来源在 [SOURCE_SKILL.md](SOURCE_SKILL.md)，仅在需要时查阅。
