/**
 * 把 ccy 的技能导出成 DSH 能发现的技能文件。
 *
 * 背景：本地 runner 会把绑定技能注册成工具（模型按需读方法论）；DSH 路径下原本
 * 只有斜杠命中的那份模板文本，没有"目录 + 按需加载"。DSH 自带
 * `dsh-skill-filesystem`：扫描 `<projectRoot>/.dsh/skills`（projectRoot 就是会话
 * 工作区），解析 YAML frontmatter 成目录条目，正文按需读取，并且 watch 目录 ——
 * 所以写入即可生效，不需要重启 runtime。
 *
 * 两个关键设计选择：
 *
 * 1) 不写 `user-invocable: false`
 *    一开始我给它设了 false，想让 DSH 只提供"目录"，斜杠入口留给 ccy 自己 ——
 *    结果实测发现该字段不只挡 `/name` 手势，**也把模型侧的 `skill` 加载工具一起挡掉了**
 *    （模型报 `invalid skill name`，只能退回 glob+read 读文件来绕过）。
 *    按需加载才是这个导出的主要价值，所以不能挡。
 *
 *    与 ccy 自己的斜杠解析是否冲突？不会：ccy 的 `/技能名` 在 Go 侧就被解析成了
 *    模板正文（见 ResolveSlashSkillMessage），那个 `/技能名` token 到不了 DSH；
 *    而 DSH 的 `/name` 手势要求名字能对上它自己目录里的技能名，属于另一套命名。
 *
 * 2) 每次 run 重写并清理陈旧文件
 *    skills 表在运行时会被改（运营/用户上传），所以不能只在首次建会话时写。
 *    目录被 watch，改写会被下一轮目录刷新看到。
 *
 * 纯函数与文件 I/O 分开：`skillFilePlan` 可单测，`writeSkills` 只做落盘。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** DSH 扫描的技能根（相对会话工作区）。 */
export const SKILLS_SUBDIR = join(".dsh", "skills");

/** 技能名 → 目录名：DSH 发现的是目录，名字里不能有路径分隔符等。 */
export function skillSlug(name) {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 64);
  return cleaned || "skill";
}

/**
 * 技能名 → DSH 可接受的标识符。
 *
 * 实测：DSH 的技能名校验**只接受 ASCII 标识符** —— 中文名（如「镜头设计」）在磁盘上
 * frontmatter 合法、文件也在，但进不了会话 catalog，`skill` 工具会报
 * `invalid skill name`；同时导出 `shot-design`（ASCII）就能正常加载。
 * 而 ccy 的技能大量是中文名，所以必须在这里做映射。
 *
 * 规则：拉丁字母/数字/下划线/连字符保留；下划线归一成连字符；
 * 一个 ASCII 字符都提不出来时，用名字的哈希兜底（保证稳定、不与其他技能撞名），
 * 并在描述里带上原名让人/模型仍能对上。
 */
export function skillIdentifier(name) {
  const raw = String(name ?? "").trim();
  const kept = raw
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/_+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (kept) return kept;

  // 纯非 ASCII：稳定哈希兜底
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index++) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `ccy-skill-${hash.toString(16).padStart(8, "0")}`;
}

/** frontmatter 里的标量：总用双引号包起来，避免 YAML 特殊字符（如 `:`、`#`）破坏解析。 */
function yamlString(value) {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`;
}

/**
 * @typedef {object} SkillInput 来自 ccy skills 表的技能
 * @property {unknown} [name]
 * @property {unknown} [description]
 * @property {unknown} [content]   技能正文（spec.content_md）
 * @property {unknown} [whenToUse] 可选：给模型看的"什么时候用"
 * @property {unknown} [enabled]
 *
 * @typedef {object} SkillFile
 * @property {string} slug    目录名（相对 skills 根）
 * @property {string} content 落盘的 SKILL.md 全文
 * @property {string} name    frontmatter 里的技能名（模型看到的就是它）
 *
 * @typedef {object} WriteSkillsResult
 * @property {number} written
 * @property {number} removed
 * @property {string} dir
 * @property {string[]} names
 */

/**
 * 计算要写入的技能文件清单。
 *
 * 跳过没有正文或未启用的技能：目录里放一个空技能只会浪费模型的目录预算。
 * 同 slug 冲突时后者覆盖前者（并加后缀区分），避免互相覆盖。
 *
 * @param {readonly SkillInput[]} skills
 * @returns {SkillFile[]}
 */
export function skillFilePlan(skills) {
  const files = [];
  const used = new Map();

  for (const skill of skills ?? []) {
    if (!skill || typeof skill !== "object") continue;
    if (skill.enabled === false) continue;
    const name = String(skill.name ?? "").trim();
    const content = String(skill.content ?? "").trim();
    if (!name || !content) continue;

    // 模型与人都按 name 找技能，所以它必须是 ASCII 标识符（见 skillIdentifier）；
    // 撞名后缀只加在**目录名**上，出现在 name 里会让模型看到的技能名很怪。
    const identifier = skillIdentifier(name);
    let slug = skillSlug(identifier);
    const seen = used.get(slug) ?? 0;
    used.set(slug, seen + 1);
    if (seen > 0) slug = `${slug}-${seen + 1}`;

    const description = String(skill.description ?? "").trim() || `ccy 技能：${name}`;
    const displayDescription = identifier === name ? description : `${description}（ccy 技能：${name}）`;
    const whenToUse = String(skill.whenToUse ?? "").trim();
    const frontmatter = [
      "---",
      `name: ${yamlString(identifier)}`,
      `description: ${yamlString(displayDescription)}`,
      ...(whenToUse ? [`whenToUse: ${yamlString(whenToUse)}`] : []),
      // 刻意不写 user-invocable / disable-model-invocation：
      // 实测 decision：能加载靠的是 name 为 ASCII，而不是这两个 flag；
      // 写 user-invocable: false 还会造成"技能不可用"的误判（模型实测时就这么推断的）。
      "---",
      "",
    ].join("\n");

    files.push({
      slug,
      name: identifier,
      originalName: name,
      content: `${frontmatter}${content}\n`,
    });
  }

  return files;
}

/**
 * 把技能写进会话工作区，并清理不再存在的旧技能目录。
 *
 * 幂等：内容相同也会重写（文件很小，换来"永远与数据库一致"的确定性）。
 *
 * @param {string} workspace
 * @param {readonly SkillInput[]} skills
 * @returns {WriteSkillsResult}
 */
export function writeSkills(workspace, skills) {
  const root = join(workspace, SKILLS_SUBDIR);
  const plan = skillFilePlan(skills);

  // 没有技能可导出时，不创建空目录（避免 DSH 的 skill 插件扫到空根）。
  if (!plan.length) {
    return { written: 0, removed: 0, dir: root, names: [] };
  }

  mkdirSync(root, { recursive: true });
  const wanted = new Set(plan.map((file) => file.slug));

  let written = 0;
  for (const file of plan) {
    const dir = join(root, file.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), file.content, "utf8");
    written += 1;
  }

  // 清理陈旧技能：解绑/删除后必须从目录里消失，否则模型会看到一个已失效的技能。
  let removed = 0;
  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      if (wanted.has(entry)) continue;
      const target = join(root, entry);
      try {
        if (statSync(target).isDirectory()) {
          rmSync(target, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // 忽略：清理失败不应影响这一轮
      }
    }
  }

  return { written, removed, dir: root, names: plan.map((file) => file.name) };
}
