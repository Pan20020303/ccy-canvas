/**
 * 技能导出的回归测试：node --test "scripts/agent-bridge/test/*.test.mjs"
 *
 * 重点覆盖容易静默出错的点：frontmatter 里的特殊字符、目录名冲突、
 * 陈旧技能清理、以及 `user-invocable: false` 这个关键取舍（防止与 ccy
 * 自己的斜杠解析抢同一个 /技能名）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skillFilePlan, skillIdentifier, skillSlug, writeSkills } from "../lib/skills-export.mjs";

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "ccy-skills-"));
  return {
    dir,
    cleanup: () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          // Windows 句柄延迟，重试
        }
      }
    },
  };
}

test("skillSlug 处理非法字符、空白与前导点", () => {
  assert.equal(skillSlug("事件提取"), "事件提取");
  assert.equal(skillSlug("art scene/derivative"), "art-scene-derivative");
  assert.equal(skillSlug("  a  b  "), "a-b");
  assert.equal(skillSlug("...leading"), "leading");
  assert.equal(skillSlug(""), "skill");
  assert.equal(skillSlug("a".repeat(100)).length, 64);
});

test("skillIdentifier：DSH 技能名必须是 ASCII（中文名会被 catalog 拒绝）", () => {
  // 实测：中文名「镜头设计」在磁盘上 frontmatter 合法，但进不了会话 catalog，
  // skill 工具报 invalid skill name；ASCII 名 shot-design 可以正常加载。
  assert.equal(skillIdentifier("shot-design"), "shot-design");
  assert.equal(skillIdentifier("art_scene_derivative"), "art-scene-derivative");
  assert.equal(skillIdentifier("事件提取").startsWith("ccy-skill-"), true);
  assert.equal(skillIdentifier("镜头设计").startsWith("ccy-skill-"), true);
  // 纯非 ASCII 也不能撞名：不同中文名要得到不同标识符
  assert.notEqual(skillIdentifier("镜头设计"), skillIdentifier("事件提取"));
  // 稳定：同名两次结果一致
  assert.equal(skillIdentifier("镜头设计"), skillIdentifier("镜头设计"));
  // 混合名保留 ASCII 部分
  assert.equal(skillIdentifier("分镜 storyboard"), "storyboard");
});

test("frontmatter 含必需字段，name 为 ASCII，原名保留在描述里", () => {
  const [file] = skillFilePlan([
    { name: "事件提取", description: "从剧本里提取事件", content: "# 步骤\n1. 读剧本" },
  ]);
  assert.ok(file, "应生成一个技能文件");
  assert.equal(file.originalName, "事件提取");
  assert.match(file.content, /^---\n/);
  // name 必须是 ASCII 标识符，否则 DSH 不会把它放进 catalog
  assert.match(file.content, /name: "ccy-skill-[0-9a-f]{8}"/);
  // 中文原名不能丢 —— 放在描述里，人和模型都能对上
  assert.match(file.content, /description: "从剧本里提取事件（ccy 技能：事件提取）"/);
  assert.match(file.content, /^---\n/);
  // 实测：不该写这两个 flag（写了会造成"技能不可用"的误判）
  assert.ok(!file.content.includes("user-invocable"), "不应写 user-invocable");
  assert.ok(!file.content.includes("disable-model-invocation"), "不应隐藏技能");
  // 正文必须在 frontmatter 之后原样保留
  assert.ok(file.content.includes("# 步骤\n1. 读剧本"));
});

test("ASCII 技能名不加冗余描述后缀", () => {
  const [file] = skillFilePlan([{ name: "shot-design", description: "Shot design", content: "x" }]);
  assert.match(file.content, /name: "shot-design"/);
  assert.match(file.content, /description: "Shot design"\n/);
  assert.ok(!file.content.includes("ccy 技能："));
});

test("description 里的引号/冒号不会破坏 YAML（总是加引号并转义）", () => {
  const [file] = skillFilePlan([
    { name: 'quote"inside', description: "含冒号: 和 #井号", content: "body" },
  ]);
  // name 走 ASCII 标识符，特殊字符被归一
  assert.match(file.content, /name: "quote-inside"/);
  // 描述里保留了带引号的原名，必须被正确转义
  assert.match(file.content, /description: "含冒号: 和 #井号（ccy 技能：quote\\"inside）"/);
});

test("跳过未启用与没有正文的技能（不占目录预算）", () => {
  const plan = skillFilePlan([
    { name: "enabled", content: "body" },
    { name: "disabled", content: "body", enabled: false },
    { name: "empty", content: "   " },
    { name: "", content: "body" },
    { content: "body" },
  ]);
  assert.deepEqual(plan.map((file) => file.name), ["enabled"]);
});

test("纯空白技能名被跳过（trim 后为空即视为无效）", () => {
  const plan = skillFilePlan([{ name: "   ", content: "body" }]);
  assert.equal(plan.length, 0, "空白名字不应产生技能文件");
});

test("同名冲突时生成不同目录，避免互相覆盖", () => {
  const plan = skillFilePlan([
    { name: "art scene", content: "a" },
    { name: "art/scene", content: "b" },
  ]);
  assert.equal(plan.length, 2);
  assert.notEqual(plan[0].slug, plan[1].slug);
  assert.equal(plan[0].slug, "art-scene");
  assert.equal(plan[1].slug, "art-scene-2");
});

test("whenToUse 可选，存在时才写", () => {
  const [withWhen] = skillFilePlan([{ name: "a", content: "x", whenToUse: "当用户要分镜时" }]);
  assert.match(withWhen.content, /whenToUse: "当用户要分镜时"/);
  const [without] = skillFilePlan([{ name: "a", content: "x" }]);
  assert.ok(!without.content.includes("whenToUse"));
});

test("writeSkills 落盘到 <workspace>/.dsh/skills/<slug>/SKILL.md", () => {
  const workspace = tempWorkspace();
  try {
    const result = writeSkills(workspace.dir, [
      { name: "事件提取", description: "d", content: "正文内容" },
    ]);
    assert.equal(result.written, 1);
    // 目录名用 ASCII 标识符（DSH 的技能名校验只接受 ASCII）
    const identifier = skillIdentifier("事件提取");
    const file = join(workspace.dir, ".dsh", "skills", identifier, "SKILL.md");
    assert.ok(existsSync(file), `SKILL.md 应存在于 ${file}`);
    const written = readFileSync(file, "utf8");
    assert.ok(written.includes("正文内容"));
    // 中文原名保留在描述里
    assert.ok(written.includes("事件提取"));
  } finally {
    workspace.cleanup();
  }
});

test("writeSkills 清理陈旧技能（解绑后必须从目录消失）", () => {
  const workspace = tempWorkspace();
  try {
    writeSkills(workspace.dir, [
      { name: "keep", content: "a" },
      { name: "drop", content: "b" },
    ]);
    const root = join(workspace.dir, ".dsh", "skills");
    assert.deepEqual(readdirSync(root).sort(), ["drop", "keep"]);

    const result = writeSkills(workspace.dir, [{ name: "keep", content: "a" }]);
    assert.equal(result.removed, 1, "应清理 1 个陈旧技能");
    assert.deepEqual(readdirSync(root), ["keep"]);
  } finally {
    workspace.cleanup();
  }
});

test("writeSkills 幂等：重复写不产生重复目录", () => {
  const workspace = tempWorkspace();
  try {
    const skills = [{ name: "same", content: "x" }];
    writeSkills(workspace.dir, skills);
    const second = writeSkills(workspace.dir, skills);
    assert.equal(second.written, 1);
    assert.equal(second.removed, 0);
    assert.deepEqual(readdirSync(join(workspace.dir, ".dsh", "skills")), ["same"]);
  } finally {
    workspace.cleanup();
  }
});

test("没有可导出技能时不创建空目录（不污染会话工作区）", () => {
  const workspace = tempWorkspace();
  try {
    const result = writeSkills(workspace.dir, []);
    assert.equal(result.written, 0);
    assert.ok(!existsSync(join(workspace.dir, ".dsh", "skills")), "不应创建空的 skills 根");
  } finally {
    workspace.cleanup();
  }
});

test("容忍畸形输入（null / 非对象 / 缺字段）", () => {
  const plan = skillFilePlan([null, undefined, "string", 42, { name: "ok", content: "x" }]);
  assert.deepEqual(plan.map((file) => file.name), ["ok"]);
});
