import { describe, expect, it } from "vitest";

import type { Skill } from "./api/skills";
import {
  filterSkillLibrary,
  getRotatingSkillBatch,
  getSkillCategoryLabel,
  getSkillCategoryOptions,
  getSkillDisplayName,
  getSkillSource,
} from "./skill-display";

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    scope: "global",
    name: "script-to-storyboard",
    description: "把剧本拆成可执行分镜。",
    category: "workflow",
    icon: "",
    kind: "prompt",
    spec: { slash_command: "script-to-storyboard" },
    input_schema: {},
    output_schema: {},
    enabled: true,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("skill display helpers", () => {
  it("prefers an explicit Chinese display name without changing the stored name", () => {
    const row = skill({
      name: "director_storyboard",
      spec: {
        display_name_zh: "我的中文分镜导演",
        slash_command: "director-storyboard",
      },
    });

    expect(getSkillDisplayName(row)).toBe("我的中文分镜导演");
    expect(row.name).toBe("director_storyboard");
  });

  it("preserves existing Chinese names and translates known English skill names", () => {
    expect(getSkillDisplayName(skill({ name: "剧本资产提取" }))).toBe("剧本资产提取");
    expect(getSkillDisplayName(skill({ name: "script-to-storyboard" }))).toBe("剧本转分镜");
  });

  it("adds the Chinese genre context to official creator-suite skills", () => {
    expect(getSkillDisplayName(skill({
      name: "director_storyboard_table_narrative",
      category: "creator-suite/story_skills/Xianxia_fantasy/driector_skills",
      spec: {
        source_path: "story_skills/Xianxia_fantasy/driector_skills/director_storyboard_table_narrative.md",
      },
    }))).toBe("古风仙侠 · 分镜表叙事技法");
  });

  it("gives generic creator-suite files a contextual Chinese label", () => {
    expect(getSkillDisplayName(skill({
      name: "README",
      category: "creator-suite/art_skills/2D_chinese_guofeng",
    }))).toBe("国风二次元 · 风格说明");
    expect(getSkillDisplayName(skill({
      name: "prefix",
      category: "creator-suite/art_skills/3D_anime_render",
    }))).toBe("3D 动画 · 全局美学");
  });

  it("maps nested categories to compact Chinese labels", () => {
    const row = skill({
      category: "creator-suite/art_skills/3D_guofeng_cyber/art_prompt",
    });
    expect(getSkillCategoryLabel(row)).toBe("3D 国风赛博");
    expect(getSkillCategoryLabel("production_skills")).toBe("制作流程");
    expect(getSkillCategoryLabel("自定义分类")).toBe("自定义分类");
  });

  it("distinguishes official and personal uploads", () => {
    expect(getSkillSource(skill({ scope: "global" }))).toBe("official");
    expect(getSkillSource(skill({ scope: "personal", owner_id: "user-1" }))).toBe("personal");
  });

  it("filters by source, Chinese display text and category", () => {
    const rows = [
      skill({ id: "official", name: "script-to-storyboard", scope: "global" }),
      skill({
        id: "mine",
        scope: "personal",
        owner_id: "user-1",
        name: "character-expression-director",
        category: "director_skills",
      }),
    ];

    expect(filterSkillLibrary(rows, { source: "personal" }).map((row) => row.id)).toEqual(["mine"]);
    expect(filterSkillLibrary(rows, { keyword: "角色表情" }).map((row) => row.id)).toEqual(["mine"]);
    expect(filterSkillLibrary(rows, { category: "导演技能" }).map((row) => row.id)).toEqual(["mine"]);
  });

  it("builds de-duplicated category chips with counts", () => {
    const options = getSkillCategoryOptions([
      skill({ id: "one", category: "workflow" }),
      skill({ id: "two", category: "workflow" }),
      skill({ id: "three", category: "production_skills" }),
    ]);

    expect(options).toEqual([
      { key: "工作流", label: "工作流", count: 2 },
      { key: "制作流程", label: "制作流程", count: 1 },
    ]);
  });

  it("keeps the compact picker at five items and rotates the next batch", () => {
    const rows = Array.from({ length: 7 }, (_, index) => `skill-${index + 1}`);

    expect(getRotatingSkillBatch(rows, 0)).toEqual([
      "skill-1",
      "skill-2",
      "skill-3",
      "skill-4",
      "skill-5",
    ]);
    expect(getRotatingSkillBatch(rows, 1)).toEqual([
      "skill-6",
      "skill-7",
      "skill-1",
      "skill-2",
      "skill-3",
    ]);
    expect(getRotatingSkillBatch([], 4)).toEqual([]);
  });
});
