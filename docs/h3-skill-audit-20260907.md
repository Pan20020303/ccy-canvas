# H3 分镜、打戏、视效与音画审核技能审计

日期：2026-09-07。技能更新已同步画布数据库；本报告不表示正在运行的旧任务已经重新加载新提示词，也没有重跑、修复或删除历史成片。

## 已生效的调整

| 范围 | 处理 | 关键变化 |
| --- | --- | --- |
| H3 Prompt · 分镜与提示词 | 新建，安装本机并同步画布 | 按实际接口区分文生、首尾帧、多参考；素材真实接线，不能仅在提示词虚构引用；角色身份、对白、动作与声音分开 |
| Action Storyboard · 打戏分镜 | 新建，安装本机并同步画布 | 明确交手双方、轴线、受力、持物手与镜头衔接；不强制快切、闪白、逆光、轰鸣或慢动作 |
| VFX Supervisor · 视效总监 | 新建，安装本机并同步画布 | 区分底片编辑与重新生成；约束符咒/法术的附着点、遮挡、起落时序和交互光；不承诺提示词能实现逐像素保留 |
| H3 Review · 音画旁路审核 | 替换旧画布审核正文 | 只标记杂音、对白、错人、分身、突变等疑点；不阻断正常生产，不自动重试，用户确认后才修复 |
| Seedance 元模板 | 修订并改为纯方法论文档 | 不再跨模型套用固定规则；不强制音效、背光或删除必要约束；调用技能本身不额外发起模板模型请求 |
| 固定门禁的旧分镜模板、Hot_blooded_action 的两项导演模板 | 停用，共三项 | 原文和 ID 保留，有备份；没有永久删除 |

四个 H3/打戏/视效/审核入口已绑定原有「生产 Agent」「生产 Agent: 监督层」「生产 Agent: 生成资产」。实际调用四项方法论接口均成功，工具名分别为 H3_Review、H3_Prompt、Action_Storyboard、VFX_Supervisor，避免纯中文名称归一化后重名。后续调用可以读取新版；已经生成或进行中的任务不自动改写。

## 为什么改

- 旧审核技能仍要求自动重试/门禁，与用户“只标记、正常往下生产、我审核后再修复”冲突。环境音必须保留，不能以全轨静音冒充修音成功。
- 部分旧分镜规则将强烈背光、无补光、闪白、密集音效或删除全部否定约束设为通用要求。这些只能是特定项目的风格选择，不能成为 H3 默认值，也不是修复杂音/人物漂移的技术依据。
- 三视图对应同一个角色身份，不是三个人；多图参考也不等同首帧。镜头间手里持有的扳手、朝向、站位等状态必须明确交接，seed 相同不能保证连续性。
- 动作描述不能进入对白标签；配乐与环境声不能混为一谈。提示词分栏是语义约束，不等于底层独立音轨或采样器。
- 原生 H3、画布适配器、Director 插件的功能边界不同。Director 的上下文接续不是无条件跨集记忆；未接入的参考视频也不能靠文字声明就实现原片编辑。

## 资料依据与本地核验

主要按 [H3 官方文生提示词指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md) 与 [H3 官方参考生成指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md) 校正字段、主体映射与对白标签。自然语言描述以英文结构为主，实际中文台词保留原文；有切镜时按实际时长设置递增时间边界，不能把字段当作执行保证。

交叉核验 [MiniMax 官方提示词技能](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/SKILL.md)、[Diffusers H3 实现文档](https://huggingface.co/docs/diffusers/main/en/api/pipelines/minimax_h3)、[ComfyUI 原生文本编码实现](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/text_encoders/minimax.py) 与 [Director 插件源码](https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director)。本机原生 tokenizer 禁用传统提示词权重解析，不能把 Stable Diffusion 的括号权重写法宣称为可靠的 H3 人物锁定方案。

动作数量、固定光源、轴线与持物检查是本项目的稳健制作建议，不冒充官方模型硬限制。质量问题需要真实音画检查，不能仅凭 ASR、响度数值或返回码判断“绝无杂音”。

## 本地文件范围

新增三个技能以代码目录 `skills/ccy-h3-prompts`、`skills/ccy-action-storyboard`、`skills/ccy-vfx-supervisor` 为维护源，同步安装到 `C:/Users/Administrator/.codex/skills/`。

已重写 `D:/学习/skills/cinematic-storyboard/SKILL.md` 及其 `references/seedance-meta-template-v2.md`、`character-sheet.md`、`style-lock.md`。已修正本机 `ccy-media-review/references/local-integration.md`：其中旧 21 镜、5 秒、768p 项目只作为历史示例，不能用于新项目默认路由。代码目录的旧 `h3-audio-quality-gate` 已标明历史命名和旁路语义。

数据库共导出 193 项技能清单；本次深入审查聚焦与 H3、分镜、打戏、视效和审核直接相关的内容，并非逐项实测全部技能。多数内置条目为当前执行器不支持的 code 类型，不因此批量删除。与当前任务无关的技能、个人提示词和生产素材保持不变。没有发现本机原先独立安装且可用的同名 H3/打戏/视效技能，故建立三个明确入口。

`D:/ljh-film-director-flex/` 当前未找到，仅发现同名 RAR。没有把压缩包中的 Seedance 项目规则视作已安装 H3 技能，也没有修改该压缩包。

## 验证与恢复

- 三个新技能及修订的本地分镜、审核技能通过 skill-creator 结构校验；独立角色场景推演已用于校正持物冲突及视效素材缺失处理。
- 同步工具 11 项离线测试通过；8 项数据库变更写后回读验证。四个纯文档技能真实调用成功，无生成任务或付费模板调用。
- 修改前完整内容、数据库 ID、绑定与本地目录备份位于 `run/h3-skill-audit-20260907/`，其中 `file-backups/` 是本地文件原件，`sync-state-before.json` 是数据库修改前对象，`sync-state.json` 是同步日志。
- 如需人工回退，先检查并执行同目录 `rollback-agent-bindings.sql`，仅移除本次新增的三个绑定，保留其他绑定；再运行 `scripts/sync_h3_reviewed_skills.py --manifest run/h3-skill-audit-20260907/change-manifest.json --rollback`。这会恢复旧技能正文与启用状态，新技能只停用、不删除；若技能后来又被修改，工具拒绝覆盖。
- 本地文件恢复需按 `file-backups/` 逐项核对后恢复，不覆盖后续人工修改。本次没有执行回退。

## 音画分采工作流的独立发布状态

音画分采 20 步音频 + 8 步画面已实现并通过独立后端实际生成测试，详见 `docs/minimax-h3-audio-first.md`。正式 API 仍有用户任务运行，因此未重启正式后端、未发布参数迁移 051。技能更新不依赖该重启，已生效；工作流代码、构建产物与导出的 ComfyUI API JSON 已准备好，正式画布档位仍待维护窗口切换。不能把技能发布与采样器发布混称为全部上线。
