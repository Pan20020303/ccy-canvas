# Seedance Agent · 开发规则手册

> ## 🧊🧊🧊 冻结声明 + 转交 multi 版（2026-05-31）
>
> **本 skill（seedance-agent · 单体 Max 版）自 v3.2.6 起冻结为"保底基线"，暂停常规更新。**
>
> - **未来开发全部转入 `seedance-agent-multi`（多 Agent 协同版 · = 4.0 方向）**——多 Agent 协同是趋势，新版在那里随便试、可承担任何风险
> - 本 skill 保留、确保始终可用，作为 multi 版出问题时的回退基线
> - 桌面版（`C:\Users\ASUS\seedance-studio` · Electron 自研 Agent 形态）交由 Codex 继续开发
> - **三者关系**：本 skill（单体保底）= 真相源 → multi 版（拆分协同 · Cursor skill 4.0）+ 桌面版（Electron · Codex 维护）都从这里迁移知识库
>
> 本次（v3.2.6）是冻结前的最后一次校正：把下方过期统计数字修正到真实状态。

---

> **本文件**：`DEVELOPMENT.md` —— v3.2.3 新增 · v3.2.6 校正 · **给人类维护者看的工程纪律手册**
>
> **区别于 SKILL.md**：
> - `SKILL.md` = agent 运行时手册（给 LLM 看 · 描述如何生成分镜提示词）
> - `DEVELOPMENT.md` = 开发规则手册（给人类维护者看 · 描述如何维护 skill 本身）
> - `CHANGELOG.md` = 版本演化历史 + 大师作品库累积日志（双向参考）
>
> **核心理念**：**索引同步是工程纪律 · 不是可选项**——每次更新知识库都必须同步更新对应的索引文件 / 矩阵 / CHANGELOG · 否则会出现"INDEX 与实际文件分裂"导致 LLM 误判和孤儿 references 问题。
>
> **适用对象**：Seedance Agent + Storyboard Reviewer 双 skill 维护者
>
> ---
>
> ## 🎬 Agent 终极愿景（北极星指标）
>
> **用户输入任意剧本片段 → agent 输出大师级分镜提示词**。
>
> **实现路径**：通过持续累积 `references/masters/` 大师作品案例库 · 让 LLM 在 Phase 4.3 时能精准匹配并复用具体大师的具体场景技法 · 最终达到"**无论用户给什么剧本片段 · agent 都能找到 ≥1 部匹配大师作品参照**"的状态。
>
> **累积策略（v3.2.3 修订）**：
> - 大师作品库累积 = **永远不升版本号** · 是 agent 的**持续运营行为**
> - 每加 1 部仅同步 3 处（masters/README + masters/INDEX + CHANGELOG 累积日志 1 行）· ≤10 分钟
> - 不动 SKILL.md / 启动语 / description / 版本字段 / reviewer
> - 升版本号仅在**架构级新机制**时触发（新增信条 / 新增 Phase / 新增审查轴）
>
> **当前进度**（截至 v3.2.6 · 冻结）：**16 部**大师作品（王家卫《花样年华》/ Kubrick《2001》/ Villeneuve《降临》/ Bong《寄生虫》/ Coppola《教父》/ 黒澤《七武士》/ 是枝《小偷家族》/ Wes《布达佩斯大饭店》/ Hitchcock《迷魂记》/ Cuarón《人类之子》/ Spielberg《拯救大兵瑞恩》《辛德勒的名单》《大白鲨》《世界大战》/ Carpenter《怪形》/ Reeves《科洛弗档案》）· 详见 `CHANGELOG.md` 顶部"大师作品库累积日志"区块。后续累积转入 multi 版。

---

## 一、文档体系总览

```
seedance-agent/                        # 🧊 v3.2.6 冻结 · 保底基线
├── SKILL.md                          # 运行时手册（给 LLM 看 · ~4240 行 · 含 canonical 骨架+硬性装配协议+3 金标准样板）
├── CHANGELOG.md                      # 版本演化历史（含大师库累积日志）
├── DEVELOPMENT.md                    # 开发规则手册（本文件）
├── references/
│   ├── INDEX.md                      # 35 references 主索引（v3.2.6 · 含文戏 3 件套+反浮夸库）
│   └── masters/
│       ├── INDEX.md                  # 大师作品索引（16 部）
│       ├── README.md                 # 大师作品标准模板
│       └── [导演]/[作品].md          # 16 部作品（含顶部 §索引摘要 + §一至§九）

storyboard-reviewer/
├── SKILL.md                          # 审查员运行时手册（55 项验收维度）
├── CHANGELOG.md                      # 与 agent CHANGELOG 严格同步
└── references/                       # directory junction 指向 agent references/
```

> **统计校正（v3.2.6）**：references 从 30 → **35**（v3.2.4 加文戏编排/潜台词/静默 3 件套 + 反浮夸场景映射库）· reviewer 验收维度从 48 → **55**（v3.2.4 #49-#53 切片+文戏件套+反浮夸 · v3.2.5 #54 canonical 骨架/通用约束栏 · v3.2.6 #55 硬性装配协议）· 大师作品 3 → **16** · 信条仍 **46**（未动）· 17 Phase 未动。

### 文档同步关系

| 同步链 | 触发条件 | 必须同步项 | 是否升版本号 |
|--------|---------|----------|------------|
| **🆕 添加大师作品** | 新建 `masters/[导演]/[作品].md` | masters/README.md（标记 ✅）+ masters/INDEX.md（3 部分）+ CHANGELOG 累积日志追加 1 行 | ❌ **永远不升版本号** |
| **添加普通 reference** | 新建 `references/[新文件].md` | references/INDEX.md（3 部分）+ SKILL.md 矩阵 A + 矩阵 B | ✅ 升 Patch |
| **修改信条** | 修改信条 #N 内容 | SKILL.md 信条 #N + reviewer 对应审查项 + CHANGELOG |
| **修改 Phase** | 修改 Phase N 流程 | SKILL.md Phase N + reviewer 对应验收项 + CHANGELOG |
| **升小版本** | 任何架构变更（不破坏 46 信条 / 17 Phase / 48 验收项编号）| 4 处启动语 + description + 版本字段 + CHANGELOG 双同步 |
| **升中版本** | 信条编号重排 / Phase 重排（破坏向后兼容）| 全局 lint + 提供 vN ⇄ vN+1 映射表 |

---

## 二、添加大师作品的标准 Checklist（v3.2.3）

> **预计耗时**：1-2 小时（主要工作）+ 5-10 分钟（同步索引）= 总 **~2 小时/部**

### Step 1：创建作品文件

```
路径：references/masters/[导演英文名]/[作品中文名].md
```

按 `references/masters/README.md` 的"标准作品 9 大 section 模板"完整填写：

- ✅ **顶部元数据**（导演 / 摄影指导 / 年份 / 类型 / 代表性 / 获奖）
- ✅ **🆕 v3.2.3 必须含 `## 索引摘要` section**（≤300 字超浓缩 DNA）
  - 核心 DNA 一句话
  - 6 大风格指纹（每项含可量化参数）
  - 适用情境
  - 3 场标志性场景（场景名 + 时间码）
  - 反例清单
  - 首选引用场景
- ✅ **§一、整体风格指纹**（4-6 项可量化特征）
- ✅ **§二、标志性场景逐镜分析**（≥3 场 × 每场 ≥4 镜）
- ✅ **§三、镜头语法 DNA**（5-8 条）
- ✅ **§四、声音/音乐设计 DNA**
- ✅ **§五、表演分寸 DNA**（按信条 31 4 级）
- ✅ **§六、与信条体系的强关联**（信条 21/22/29/30/31/35/37/42/43/44 强触发表）
- ✅ **§七、AI 模型直接复用的句式模板**（≥5 句 Copy-Paste Ready）
- ✅ **§八、本作"禁忌"清单**
- ✅ **§九、扩展阅读 · 二级 references**

### Step 2：同步更新 masters/README.md

- 在目录结构中将该作品标记为 **✅ 完成**（替换 "# 待添加"）
- 持续扩张路线中加 1 计数（如 "v3.2.x 累积 10 部 → 11 部"）

### Step 3：🆕 同步更新 masters/INDEX.md（3 部分）

#### Step 3.1：第一部分总览表
- 按类型分类 · 在对应类型表格加一行：

```markdown
| 作品名 (年份) | 导演 | `[导演]/[作品].md` | 主要风格指纹 | 适用情境 | ✅ |
```

#### Step 3.2：第二部分风格关键词反查
- 按以下 7 维度逐项添加索引：
  - "情感核心"反查
  - "摄影机态度"（信条 30）反查
  - "运镜速度"（信条 35）反查
  - "色彩心理学"（信条 43）反查
  - "场景过渡"（信条 42）反查
  - "表演分寸"（信条 31）反查
  - "开头冲击力"（信条 21）反查

#### Step 3.3：第三部分快速匹配表
- 在"项目类型 × 优先匹配作品"表格中加一行（或更新已有行）

### Step 4：CHANGELOG 累积日志追加（轻量 · 不升版本号）

> **🆕 v3.2.3 修订核心策略：大师作品库累积 = 永远不升版本号**
>
> **背景**：升版本号意味着改 7 处（4 启动语 + description + 版本字段 + CHANGELOG 双同步）· 工作量大且无必要。大师作品库累积是 agent 的**持续运营行为** · 不应消耗版本号。

**每加 1 部作品的 CHANGELOG 同步**（极简）：

- ✅ **不升版本号**——SKILL.md / 启动语 / description / 版本字段 / reviewer 全部不动
- ✅ **只追加 1 行**到 `CHANGELOG.md` 顶部的"**大师作品库累积日志（Append-Only）**"区块
- ✅ 格式：

```markdown
| YYYY-MM-DD | [作品名] | [导演] | [类型] | [添加者] | [一句话引入背景] |
```

**长期愿景**：v3.2.x **持续累积 · 永远不升中版本号**——除非有架构级新机制（如新增第 8 轴审查 / 新增信条 47 等架构变更）· 否则一律不升版本号 · 只追加累积日志。

**累积阶段的 agent 终极目标**：当大师作品库累积到"任意剧本片段都能在 masters/INDEX 中匹配 ≥1 部大师作品"时 · agent 达成"**输入剧本片段 → 输出大师级分镜**"的终极愿景。

### Step 5：验证（自检）

- ✅ 作品文件按模板完整（9 大 section + 顶部 §索引摘要）
- ✅ masters/README.md 标记为 ✅ 完成
- ✅ masters/INDEX.md 3 部分全部同步
- ✅ 信条 22 强触发可命中（即未来 Agent 可通过路径 `references/masters/[导演]/[作品].md §___` 引用）

---

## 三、添加普通 References 的标准 Checklist（v3.2.3）

> **预计耗时**：30 分钟-1 小时（主要工作）+ 5-10 分钟（同步索引）= 总 **~1 小时**

### Step 1：创建 reference 文件

```
路径：references/[新文件名].md
```

内容按现有 references 风格写（如类似 `光影设计参考库.md` / `角色调度与走位参考库.md`）。

### Step 2：🆕 同步更新 references/INDEX.md（3 部分）

#### Step 2.1：第一部分 references 全清单
- 按分级（L0/L0+/L1/L2/L3/L4）插入新行：

```markdown
| # | `[新文件名].md` | 主要内容 | 触发条件 |
```

#### Step 2.2：第二部分 Phase × references 反查表
- 在对应 Phase 行加一行触发关系

#### Step 2.3：第三部分按情境/信条反查
- 在"按创作问题反查"或"按信条触发反查"加 1-2 条索引

### Step 3：同步更新 SKILL.md 矩阵 A（30 references 完整分级表）

- 在 SKILL.md 信条 46(b) 的矩阵 A 表格中加一行（保持编号连续）

### Step 4：同步更新 SKILL.md 矩阵 B（17 Phase × references 强触发表）

- 在对应 Phase 行加 references 触发关系

### Step 5：升小版本号（v3.2.3 → v3.2.4）

- ❗ **新增 references 文件比新增大师作品更"基础"**——属于架构层扩张 · 必须升小版本号
- 4 处启动语 + description + 版本字段同步
- CHANGELOG 双同步（agent + reviewer）

### Step 6：reviewer 同步（如需要）

- 若新 reference 对应新的审查维度 → reviewer SKILL.md 加审查项
- 若仅是已有审查维度的扩充 → reviewer 无需修改

---

## 四、修改现有信条的注意事项

### 修改 trigger

仅在以下情况修改现有信条：
- 🟢 用户实测反馈某信条的具体子项漏覆盖某场景
- 🟢 v3.2.x 累积作品库后发现某信条需要扩充新案例
- 🟢 reviewer 反馈某信条审查项可优化

### 修改原则

| 改动类型 | 影响范围 | 必须同步 |
|---------|---------|---------|
| **在信条内新增子项**（如信条 22 新增 (g) v3.2.3 子项）| 不破坏编号 | SKILL.md 信条 + reviewer 对应审查项 + CHANGELOG |
| **修改信条的子项内容** | 不破坏编号 | SKILL.md 信条 + CHANGELOG |
| **删除信条**（极少使用）| 🔴 破坏向后兼容 | 升中版本 v3.x → v4.x + 提供映射表 |
| **重排信条编号**（极少使用）| 🔴 破坏向后兼容 | 升中版本 + 提供 vN ⇄ vN+1 映射表 |

### 🚫 绝对不能做

- ❌ 修改信条编号（#1-#46 永久稳定）
- ❌ 修改信条主名称（如 "信条 22 导演意图必填铁律" 不能改名）
- ❌ 删除已存在的 (a)/(b)/(c) 子项（只能加 (g)/(h)）

---

## 五、修改 Phase 的注意事项

### 修改原则

| 改动类型 | 影响范围 | 必须同步 |
|---------|---------|---------|
| **在 Phase 内新增子步骤**（如 Phase 4.5 信条执行性自检表）| 不破坏编号 | SKILL.md Phase + reviewer 对应验收项 + CHANGELOG |
| **拆分 Phase**（如 Phase 4 → 4.1/4.2/4.3/4.4）| 不破坏主编号 | 同上 + 4 处启动语强调拆分 |
| **修改 Phase 触发条件** | 不破坏编号 | SKILL.md Phase + CHANGELOG |
| **重排 Phase 编号**（极少使用）| 🔴 破坏向后兼容 | 升中版本 |

### 🚫 绝对不能做

- ❌ 修改 17 Phase 主编号（0/0.5/0.7/1/2/2.3/2.3.5/2.4/2.5/3/3.5/4/5/6/7/7.5/8/8.5/8.7/9 永久稳定）
- ❌ 删除现有 Phase（只能拆分或加子步骤）

---

## 六、🆕 索引同步铁律（v3.2.3 核心工程纪律）

### 铁律 1：INDEX 必须与实际文件 100% 同步

- ✅ 每次新建 `references/[文件].md` → **必须同步** `references/INDEX.md`
- ✅ 每次新建 `references/masters/[导演]/[作品].md` → **必须同步** `references/masters/INDEX.md` + `references/masters/README.md`
- ✅ 每次新建大师作品 → **必须含顶部 `## 索引摘要` section**
- ❌ 不允许 "INDEX 中没有但实际文件存在"（孤儿文件）
- ❌ 不允许 "INDEX 中有但实际文件不存在"（虚假索引）

### 铁律 2：矩阵 A/B 必须与 INDEX 100% 同步

- SKILL.md 矩阵 A（30 references 完整分级表）= 与 `references/INDEX.md` 第一部分对应
- SKILL.md 矩阵 B（17 Phase × references 强触发表）= 与 `references/INDEX.md` 第二部分对应
- 两边必须同步——agent 通过矩阵 B 找 references · LLM 通过 INDEX 找 references · **两边必须一致**

### 铁律 3：索引摘要 ≤300 字 · 不替代实读

- 每部大师作品顶部 `## 索引摘要` ≤300 字
- 索引摘要只能含"风格指纹关键词 + 情境标签 + 反例 + 首选场景引用路径"
- 索引摘要**不能含**具体场景的逐镜机位/时长/微表情/物理参数等深度细节（这些必须在 §一至§九）
- 防止 LLM 用索引摘要替代实读（reviewer #46 反索引摘要校验保障）

### 铁律 4：CHANGELOG 必须双 skill 同步

- 每次升版本号 → agent CHANGELOG + reviewer CHANGELOG 必须同时更新
- 两边的版本号 / 描述 / 变更内容必须一致

### 铁律 5：4 处启动语必须同步

- 升版本号时 · agent 的 4 处启动语（自动 / 协同正向 / 协同反向 / 咨询）+ reviewer 启动语 = 共 5 处必须全部统一到新版本号
- 顶部 description + 版本字段 = 共 2 处必须同步

### 🆕 铁律 6：大师作品库累积 = 永远不升版本号（v3.2.3 新增 · 极简策略）

- ✅ 加 1 部大师作品 = 仅同步 masters/README + masters/INDEX + CHANGELOG 累积日志 1 行（共 3 处 · ≤10 分钟）
- ❌ **不动** SKILL.md / 启动语 / description / 版本字段 / reviewer
- ❌ **不再因为"累积 ≥N 部"自动升 Minor 版本号**
- 📍 服务于 agent 终极愿景：**输入剧本片段 → 输出大师级分镜**——累积作品库直到任意片段都能匹配 ≥1 部大师参照

---

## 七、版本号管理规则

### 版本号语义

```
v[Major].[Minor].[Patch][后缀]

Major：    破坏向后兼容（46 信条/17 Phase/48 验收项编号重排）
Minor：    新增功能模块（如 v3.2.0 大师作品库 / v3.2.1 项目记忆 / v3.2.2 空间快照）
Patch：    内部修复 + 索引层 + 冲突修复（如 v3.2.3 索引层 + 5 项冲突修复）
后缀：     +/++/+++ = 同 Patch 版本号的多次架构补丁（如 v3.1.7.8/++/+++）
```

### 何时升 Patch（v3.2.X）

- ✅ 新增**普通** references 文件（非 masters/）
- ✅ 修复冲突
- ✅ 加新工程机制（如索引层）
- ✅ reviewer 加新审查维度

### 🆕 何时**不**升版本号（保持 v3.2.X 内累积 · 永远不升）

- ✅ **新增大师作品**（`masters/[导演]/[作品].md`）—— **核心运营行为 · 永远不升版本号**
- ✅ 优化已有 references 文件内容
- ✅ 修正文档错别字
- ✅ 优化已有 masters/[导演]/[作品].md 文件内容
- ✅ 任何不影响 SKILL.md / 启动语 / 描述字段的内容修订

### 何时升 Minor（v3.X.0）

- ✅ 新增重大架构机制（如新增第 8 轴审查 / 新增信条 47 / 新增 Phase 9.5 等）
- ❌ **不再因为"累积 ≥10 部大师作品"自动升 Minor**（v3.2.3 修订）

### 何时升 Major（v4.0）

- 🔴 信条编号重排（如 46 → 35 合并精简）
- 🔴 Phase 编号重排
- 🔴 reviewer 验收项编号重排
- 🔴 输出格式破坏性变更

---

## 八、CHANGELOG 同步要求

### 完整 CHANGELOG 条目应含

```markdown
- **v[版本号] [版本名]：[一句话核心改动]**
  - **背景**：用户实测反馈 / 设计盲点 / 工程需求 ...
  - **🆕 新增 / 修改 / 修复**（按改动列表）
  - **不破坏向后兼容声明**：[具体保留了什么编号 / 历史版本是否可被新 reviewer 验收]
  - **设计哲学**：[这次升级的核心理念 + 解决的根本问题]
```

### 双 skill 同步

- agent CHANGELOG.md 更新 → reviewer CHANGELOG.md 必须同步更新（即使 reviewer 这次没改 · 也要写一条"与 agent v3.X.X 同步"的占位条目）

---

## 九、不破坏向后兼容铁律

### 永久稳定的编号

- 46 信条编号 #1-#46（永久稳定 · 不重排不复用 · 只能在信条内加 (g)/(h) 子项）
- 17 Phase 编号 0/0.5/0.7/1/2/2.3/2.3.5/2.4/2.5/3/3.5/4/5/6/7/7.5/8/8.5/8.7/9（含 Phase 4.1-4.4 拆分子 Phase）
- 48 项 reviewer 验收维度编号（永久稳定）
- 三元规则 #40/#45/#46 地位（永久不变）

### 兼容性测试

- 升版本后 · 历史 v3.X.X 之前生成的分镜应该可以被新版 reviewer 验收
- 历史 SEEDANCE_PROJECT.md 应可无痛升级到新版（仅追加新 section · 不破坏老 section）
- 历史 references/* 文件应可不修改继续使用

---

## 十、未来自动化方向（v3.3+ 规划）

当前 v3.2.3 的索引同步是**人工纪律**——未来可以演化为**自动化脚本**：

```
.dev/sync.py  (规划中 · v3.3+)
├── check_orphan_refs()       # 检查 references/ 目录文件是否都在 INDEX.md 中
├── check_orphan_masters()    # 检查 masters/ 目录作品是否都在 masters/INDEX.md 中
├── check_summary_section()   # 检查每个大师作品文件顶部是否含 §索引摘要 section
├── check_matrix_sync()       # 检查 SKILL.md 矩阵 A/B 是否与 INDEX 同步
├── check_changelog_sync()    # 检查 agent + reviewer CHANGELOG 版本号是否同步
└── check_startup_sync()      # 检查 4 处启动语 + description + 版本字段是否同步
```

**当前 v3.2.3**：以本 DEVELOPMENT.md 作为人工 checklist · 严格遵循即可保证不出错。

---

## 十一、紧急情况处理

### 发现 INDEX 与实际文件分裂

**症状**：
- agent 引用不存在的 references 路径
- agent 找不到已存在的 references 文件
- LLM 误用孤儿文件

**修复流程**：
1. 立即扫描 `references/` 目录 + `references/masters/` 目录所有实际文件
2. 比对 `references/INDEX.md` + `references/masters/INDEX.md` + `SKILL.md` 矩阵 A/B
3. 找出分裂项（实际有 INDEX 无 / 实际无 INDEX 有）
4. 修复并升小版本（视严重度）
5. CHANGELOG 加 "Patch 修复 INDEX 分裂" 条目

### 发现矩阵 A/B 与 INDEX 不一致

**症状**：
- SKILL.md 矩阵 B 触发关系与 INDEX 第二部分不一致

**修复流程**：
1. 以 SKILL.md 矩阵 A/B 为准（矩阵 A/B 是"权威"）
2. 同步修正 references/INDEX.md
3. CHANGELOG 加 "Patch 修复矩阵 vs INDEX 不一致" 条目

---

## 十二、维护频率建议

| 维护任务 | 推荐频率 |
|---------|---------|
| 添加大师作品 | 持续累积 · 不定期 |
| 全局自检（INDEX vs 实际文件）| 每月 1 次 |
| 矩阵 A/B 同步检查 | 每次新增 references 时 |
| CHANGELOG 双同步检查 | 每次升版本号时 |
| 4 处启动语 + 版本字段一致性 lint | 每次升版本号后 |
| reviewer 验收维度审查 | 每季度 1 次（确保与 agent 同步）|

---

---

## 十三、v3.2.4-v3.2.6 新增约束追溯（冻结前补记）

> 这几版的约束已落到 SKILL.md / reviewer，本节是 DEVELOPMENT.md 的补登记，保证开发规则单一权威。

### v3.2.4（文戏件套 + 反浮夸 + 切片串行 + 项目记忆强化）
- **文戏 3 件套**（references #31-#33）：文戏编排 / 潜台词与言外之意 / 静默时刻与留白——信条 11/12/31 工程化
- **反浮夸专项库**（reference #34）：表演分寸场景映射库（30 场景 × 档位 + 5 大反浮夸判别公式 + 大开大合 5 例外白名单）
- **Phase 切片串行模式**（Step 0-S.11）：5 个调用粒度 + SEEDANCE_PROJECT.md §三-§八 项目记忆 schema 强化
- reviewer 新增 #49-#53

### v3.2.5（Canonical 输出骨架 + 通用约束栏）
- **Canonical 输出骨架**：唯一权威填空骨架（强制段序）· 治"格式每次不一样"
- **【通用约束栏 · 本 segment 共享】固定命名槽位**（信条 39c 升级）· 通用 NOT 一次声明每镜 0 重复 · 治"NOT 重复" · 方案 A 不破坏信条 18c
- reviewer 新增 #54

### v3.2.6（硬性装配协议 + 完整金标准样板）
- **硬性装配协议**：表 A Layer 1 清单 + 表 B Layer 2 清单 + 表 C 条件字段触发矩阵 + 14 项装配自检（汇总信条 24/25/28/38/39/46 · 非新增）· 治"格式漏掉"
- **3 个完整金标准样板**（文戏 / 战场灾难 / 武戏 · L1+L2 全填满）· LLM 照抄锚点
- reviewer 新增 #55

---

## 十四、衍生版本开发约束（multi 版 + 桌面版）

### multi 版（`seedance-agent-multi` · = 4.0 · Cursor skill 多 Agent 协同）
- 知识库 + SKILL **从本 skill 迁移（只读复制）· 不动本 skill**
- 在迁移副本上做拆分（核心宪法层 + 6 角色模块 + 装配协议模块）· 原 skill 保底
- multi 版可承担任何风险随便试（本 skill 是回退基线）
- 未来常规更新转入 multi 版

### 桌面版（`seedance-studio` · Electron 自研 Agent · 交 Codex）
- 同样从本 skill `migrate-kb.mjs` 只读复制 + 模块化拆分
- 单一真相源 = 本 skill；本 skill 更新后重跑迁移即同步

### 三者单一真相源关系
```
seedance-agent（单体 · 冻结保底 · 真相源）
   ├── seedance-agent-multi （Cursor skill 4.0 · 多 Agent · 我维护）
   └── seedance-studio      （Electron 桌面版 · Codex 维护）
```

---

> **最后更新**：v3.2.6 · 2026-05-31（冻结校正版）
> **维护状态**：🧊 本 skill 冻结为保底基线 · 未来开发转入 seedance-agent-multi（4.0）+ seedance-studio（Codex）
