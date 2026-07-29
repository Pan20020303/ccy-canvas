import type { Skill } from "./api/skills";

export type SkillSourceFilter = "official" | "personal" | "all";

export type SkillLibraryFilter = {
  source?: SkillSourceFilter;
  keyword?: string;
  category?: string;
};

export type SkillCategoryOption = {
  key: string;
  label: string;
  count: number;
};

export function getRotatingSkillBatch<T>(
  items: T[],
  batchIndex: number,
  batchSize = 5,
): T[] {
  if (items.length === 0 || batchSize <= 0) return [];
  const batchCount = Math.max(1, Math.ceil(items.length / batchSize));
  const normalizedBatch = ((batchIndex % batchCount) + batchCount) % batchCount;
  const visibleCount = Math.min(batchSize, items.length);
  return Array.from({ length: visibleCount }, (_, offset) => (
    items[(normalizedBatch * batchSize + offset) % items.length]
  ));
}

const SKILL_NAME_ZH: Record<string, string> = {
  art_character: "人物形象",
  art_character_derivative: "人物衍生形态",
  art_prop: "道具设计",
  art_prop_derivative: "道具衍生设计",
  art_scene: "场景设计",
  art_scene_derivative: "场景衍生设计",
  art_storyboard_video: "分镜视频设计",
  character_expression_director: "角色表情导演",
  director_planning_narrative: "导演叙事规划",
  director_planning_style: "导演风格规划",
  director_storyboard: "分镜导演",
  director_storyboard_table_narrative: "分镜表叙事技法",
  director_storyboard_table_style: "分镜表风格技法",
  event_extraction: "事件提取",
  production_agent_decision: "制作决策",
  production_agent_supervision: "制作智能体监督",
  production_execution_derive_assets: "素材衍生执行",
  production_execution_director_plan: "导演方案执行",
  production_execution_generate_assets: "素材生成执行",
  production_execution_storyboard_gen: "分镜生成执行",
  production_execution_storyboard_panel: "分镜面板执行",
  production_execution_storyboard_table: "分镜表执行",
  prefix: "全局美学",
  readme: "风格说明",
  script_agent_decision: "剧本决策",
  script_agent_supervision: "剧本智能体监督",
  script_asset_extraction: "剧本资产提取",
  script_execution_adaptation: "剧本改编执行",
  script_execution_script: "剧本创作执行",
  script_execution_skeleton: "剧本骨架执行",
  script_to_storyboard: "剧本转分镜",
  seedance_shot_prompt_structure: "Seedance 镜头提示词结构",
  seedance_video_prompt_template: "Seedance 视频提示词模板",
  storyboard_prompt_techniques: "分镜提示词技法",
  storyboard_table_techniques: "分镜表技法",
  video_prompt_generation: "视频提示词生成",
  audio_bind_prompt: "音色绑定",
};

const CONTEXT_ZH: Record<string, string> = {
  "2d_90s_japanese_anime": "90年代日式动画",
  "2d_chinese_guofeng": "国风二次元",
  "2d_flat_design": "扁平插画",
  "2d_mature_urban_romance": "都市情感漫画",
  "3d_anime_render": "3D 动画",
  "3d_chinese_traditional": "3D 中式传统",
  "3d_clay_stopmotion": "3D 黏土定格",
  "3d_guofeng_cyber": "3D 国风赛博",
  comedy_humor: "喜剧幽默",
  coming_of_age: "青春成长",
  family_warmth: "家庭温情",
  historical_epic: "历史史诗",
  horror_supernatural: "恐怖灵异",
  hot_blooded_action: "热血动作",
  mystery_thriller: "悬疑惊悚",
  psychological_drama: "心理剧情",
  realpeople_ancient_chinese: "真人古风",
  realpeople_modern_city: "真人现代都市",
  realpeople_urban_modern: "真人都市时尚",
  scifi_post_apocalypse: "科幻末世",
  sweet_romance_novel: "甜宠言情",
  urban_workplace_drama: "都市职场",
  xianxia_fantasy: "古风仙侠",
};

const CATEGORY_ZH: Record<string, string> = {
  agent_skills: "智能体技能",
  art_prompt: "美术提示词",
  art_skills: "视觉设计",
  audio: "音频创作",
  commercial: "商业创作",
  director_skills: "导演技能",
  driector_skills: "导演技能",
  image: "图像创作",
  other: "其他技能",
  production_skills: "制作流程",
  prompt: "提示词",
  prompt_skills: "提示词",
  prompts: "系统提示词",
  story_skills: "故事分镜",
  video: "视频创作",
  workflow: "工作流",
  writing: "文案写作",
};

const CONTEXTUAL_SKILL_NAMES = new Set([
  "art_character",
  "art_character_derivative",
  "art_prop",
  "art_prop_derivative",
  "art_scene",
  "art_scene_derivative",
  "art_storyboard_video",
  "director_planning_narrative",
  "director_planning_style",
  "director_storyboard",
  "director_storyboard_table_narrative",
  "director_storyboard_table_style",
  "prefix",
  "readme",
]);

function normalizedKey(value: string) {
  return value
    .trim()
    .replace(/\.(md|markdown|txt)$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s./\\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function stringSpecValue(skill: Skill, ...keys: string[]) {
  const spec = (skill.spec ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    const value = spec[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function hasChinese(value: string) {
  return /[\u3400-\u9fff]/.test(value);
}

function skillContext(skill: Skill) {
  const sourcePath = stringSpecValue(skill, "source_path", "sourcePath");
  const parts = `${sourcePath}/${skill.category || ""}`
    .split(/[\\/]/)
    .map(normalizedKey)
    .filter(Boolean);
  for (const part of parts) {
    if (CONTEXT_ZH[part]) return CONTEXT_ZH[part];
  }
  return "";
}

/**
 * Returns a Chinese-facing name without mutating the stored skill name or its
 * slash command. Official seed files may opt into an exact label through
 * `spec.display_name_zh`.
 */
export function getSkillDisplayName(skill: Skill): string {
  const explicit = stringSpecValue(
    skill,
    "display_name_zh",
    "displayNameZh",
    "title_zh",
    "titleZh",
  );
  if (explicit) return explicit;

  const original = skill.name.trim() || "未命名技能";
  if (hasChinese(original)) return original;

  const key = normalizedKey(original);
  const translated = SKILL_NAME_ZH[key];
  if (!translated) return original;

  const context = CONTEXTUAL_SKILL_NAMES.has(key) ? skillContext(skill) : "";
  return context ? `${context} · ${translated}` : translated;
}

/**
 * Maps the stored category/path into a compact Chinese category chip.
 */
export function getSkillCategoryLabel(categoryOrSkill: string | Skill): string {
  const skill = typeof categoryOrSkill === "string" ? null : categoryOrSkill;
  const category = typeof categoryOrSkill === "string"
    ? categoryOrSkill
    : categoryOrSkill.category;
  const sourcePath = skill ? stringSpecValue(skill, "source_path", "sourcePath") : "";
  const parts = `${sourcePath}/${category || ""}`
    .split(/[\\/]/)
    .map(normalizedKey)
    .filter(Boolean);

  for (const part of parts) {
    if (CONTEXT_ZH[part]) return CONTEXT_ZH[part];
  }
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (CATEGORY_ZH[parts[index]]) return CATEGORY_ZH[parts[index]];
  }

  const clean = (category || "").trim();
  if (!clean) return "其他技能";
  if (hasChinese(clean)) return clean;
  return CATEGORY_ZH[normalizedKey(clean)] || clean;
}

export function getSkillSource(skill: Skill): Exclude<SkillSourceFilter, "all"> {
  return skill.scope === "global" ? "official" : "personal";
}

export function filterSkillLibrary(
  skills: Skill[],
  filter: SkillLibraryFilter = {},
): Skill[] {
  const source = filter.source ?? "all";
  const keyword = (filter.keyword ?? "").trim().toLocaleLowerCase("zh-CN");
  const category = (filter.category ?? "").trim();

  return skills.filter((skill) => {
    if (source !== "all" && getSkillSource(skill) !== source) return false;
    if (category && getSkillCategoryLabel(skill) !== category) return false;
    if (!keyword) return true;

    const command =
      typeof skill.spec?.slash_command === "string"
        ? skill.spec.slash_command
        : "";
    const haystack = [
      getSkillDisplayName(skill),
      skill.name,
      skill.description,
      getSkillCategoryLabel(skill),
      skill.category,
      command,
    ]
      .join("\n")
      .toLocaleLowerCase("zh-CN");
    return haystack.includes(keyword);
  });
}

export function getSkillCategoryOptions(skills: Skill[]): SkillCategoryOption[] {
  const countByLabel = new Map<string, number>();
  for (const skill of skills) {
    const label = getSkillCategoryLabel(skill);
    countByLabel.set(label, (countByLabel.get(label) ?? 0) + 1);
  }
  return Array.from(countByLabel, ([label, count]) => ({
    key: label,
    label,
    count,
  })).sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}
