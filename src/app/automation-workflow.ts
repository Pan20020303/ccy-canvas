export type AutomationAssetType = "character" | "scene" | "prop" | "audio";

export type AutomationAssetVariant = {
  id: string;
  name: string;
  description: string;
  generationPrompt?: string;
  url?: string;
  fileName?: string;
};

export type AutomationAsset = {
  id: string;
  type: AutomationAssetType;
  name: string;
  description: string;
  generationPrompt?: string;
  source: "extracted" | "uploaded";
  url?: string;
  fileName?: string;
  locked: boolean;
  boundAudioId?: string;
  variants?: AutomationAssetVariant[];
};

export type StoryboardDraft = {
  id: string;
  title: string;
  description: string;
  shot: string;
  duration: string;
  assetIds: string[];
  camera?: string;
  action?: string;
  continuity?: string;
  prompt?: string;
  negativePrompt?: string;
  imageModel?: string;
  imageProviderId?: string;
  imageUrl?: string;
  status: "draft" | "queued" | "generated";
};

export type AutomationWorkflow = {
  version: 1;
  projectId: string;
  scriptName: string;
  scriptText: string;
  textModel?: string;
  textProviderId?: string;
  storyboardSkillId?: string;
  extractedScriptText?: string;
  extractionCompletedAt?: number;
  lastExtractionTaskId?: string;
  lastStoryboardTaskId?: string;
  assets: AutomationAsset[];
  storyboards: StoryboardDraft[];
  updatedAt: number;
};

type ExtractedModelAsset = {
  name: string;
  desc: string;
  prompt: string;
  type: "role" | "scene" | "tool" | "audio";
  variants?: ExtractedModelAssetVariant[];
  forms?: ExtractedModelAssetVariant[];
  states?: ExtractedModelAssetVariant[];
  status?: ExtractedModelAssetVariant[];
};

type ExtractedModelAssetVariant = {
  name?: string;
  desc?: string;
  description?: string;
  prompt?: string;
};

const TYPE_LABELS: Record<AutomationAssetType, string> = {
  character: "人物",
  scene: "场景",
  prop: "道具",
  audio: "音频",
};

const unique = (values: string[]) =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const cleanName = (value: string) =>
  value
    .replace(/^[\s【\[(（]+|[\s】\])）]+$/g, "")
    .replace(/[，。！？；、,.!?;].*$/, "")
    .trim();

const makeAsset = (
  type: AutomationAssetType,
  name: string,
  description: string,
  index: number,
): AutomationAsset => ({
  id: `auto-${type}-${Date.now()}-${index}`,
  type,
  name,
  description,
  source: "extracted",
  locked: false,
});

const FORM_NAME_PATTERN = /([\u4e00-\u9fa5A-Za-z0-9·路]{1,16}(?:状态|形态|状态下|形态下))/g;

function normalizeExtractedVariants(
  raw: Partial<ExtractedModelAsset>,
  fallbackDesc: string,
  fallbackPrompt: string,
  parentIndex: number,
): AutomationAssetVariant[] {
  const rawVariants = [
    ...(Array.isArray(raw.variants) ? raw.variants : []),
    ...(Array.isArray(raw.forms) ? raw.forms : []),
    ...(Array.isArray(raw.states) ? raw.states : []),
    ...(Array.isArray(raw.status) ? raw.status : []),
  ];
  const variants = rawVariants.flatMap((variant, index) => {
    if (!variant || typeof variant !== "object") return [];
    const name = variant.name?.trim();
    if (!name) return [];
    return [{
      id: `variant-model-${Date.now()}-${parentIndex}-${index}`,
      name,
      description: (variant.desc ?? variant.description ?? fallbackDesc).trim(),
      generationPrompt: (variant.prompt ?? fallbackPrompt).trim() || undefined,
    }];
  });

  if (variants.length > 0) return variants;

  const inferred = Array.from(fallbackDesc.matchAll(FORM_NAME_PATTERN), (match) => match[1])
    .filter((name) => name !== "基础状态" && name !== "普通状态");
  return unique(inferred).map((name, index) => ({
    id: `variant-inferred-${Date.now()}-${parentIndex}-${index}`,
    name,
    description: fallbackDesc,
    generationPrompt: fallbackPrompt || undefined,
  }));
}

function dialogueCharacters(lines: string[]) {
  const names: string[] = [];
  for (const line of lines) {
    const match = line.match(
      /^(?:【|\[)?([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·]{0,11})(?:】|\])?\s*[：:]/,
    );
    if (!match) continue;
    const candidate = cleanName(match[1]);
    if (isScriptFieldLabel(candidate)) continue;
    names.push(candidate);
  }
  return unique(names);
}

export type ScriptCharacterCandidate = {
  name: string;
  evidence: string[];
};

export type ScriptCharacterCoverageResult = {
  assets: AutomationAsset[];
  addedNames: string[];
  removedNames: string[];
  reclassifiedAudioNames: string[];
};

const NON_CHARACTER_NAMES = new Set([
  "他", "她", "它", "他们", "她们", "它们", "自己", "对方", "众人", "所有人",
  "有人", "男人", "女人", "男子", "女子", "少年", "少女", "老人", "孩子",
  "异能者", "敌人", "怪物", "人群", "利爪", "身体", "声音", "火焰", "光芒",
  "天空", "地面", "山林", "树林", "房间", "大门", "夜色", "镜头", "画面",
]);

function isScriptFieldLabel(value: string) {
  const label = cleanName(value);
  return /^(?:人物|角色|主要人物|出场人物|人物表|角色表|道具|关键道具|道具表|场景(?:[一二三四五六七八九十百\d]+)?|地点|时间|镜头(?:[一二三四五六七八九十百\d]+)?|动作|台词|对白|旁白|画外音|音频|音效|音乐|BGM|SFX|OS|VO|内景|外景|字幕|画面|转场|备注)$/i
    .test(label);
}

function isCharacterCandidateName(value: string) {
  const name = cleanName(value);
  if (!name || name.length > 12 || NON_CHARACTER_NAMES.has(name) || isScriptFieldLabel(name)) return false;
  if (/^(?:第.{0,8}[集场幕]|内景|外景|日|夜|早晨|黄昏|远处|近处)$/.test(name)) return false;
  if (/(?:山林|树林|天空|地面|房间|大门|火焰|光芒|声音|镜头|画面)$/.test(name)) return false;
  if (/(?:字幕|片名|标题|字样|屏幕|大屏|转场|空镜|特写|特效|闪白|黑屏|红屏|定格|淡入|淡出|音效|配乐|BGM|SFX|旁白|画外音|广播)/i.test(name)) return false;
  return true;
}

/**
 * Find high-confidence named characters directly evidenced by the script.
 * This is deliberately conservative: it complements the text model instead
 * of trying to do full Chinese NER in the browser. In particular it covers
 * single-character names such as “魁”, which the old speaker regex and some
 * language models tended to treat as ordinary prose.
 */
export function extractScriptCharacterCandidates(scriptText: string): ScriptCharacterCandidate[] {
  const text = scriptText.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const evidenceByName = new Map<string, Set<string>>();
  const add = (rawName: string, evidence: string) => {
    const name = cleanName(rawName);
    if (!isCharacterCandidateName(name)) return;
    const values = evidenceByName.get(name) ?? new Set<string>();
    values.add(evidence.trim().slice(0, 160));
    evidenceByName.set(name, values);
  };

  for (const name of explicitList(text, ["人物", "角色", "人物表", "角色表", "主要人物", "出场人物"])) {
    add(name, `人物表：${name}`);
  }
  for (const line of lines) {
    const speaker = line.match(
      /^(?:【|\[)?([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9·]{0,11})(?:】|\])?\s*[：:]/,
    );
    if (speaker && !isScriptFieldLabel(speaker[1])) add(speaker[1], line);
  }

  const clauses = text
    .split(/[\n，。！？；!?;]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    // This narrative fallback intentionally accepts only a single CJK name.
    // It covers names such as “魁” without turning phrases such as
    // “年轻男人的身体” or “魁梧的身体” into invented characters. Multi-word
    // names remain covered by explicit character lists and dialogue labels.
    const possessive = clause.match(
      /^([\u4e00-\u9fa5])的(?:身体|身躯|脸|面容|双眼|眼睛|手臂|双手|声音|伤口|头发|尾巴|翅膀|血液)/,
    );
    if (possessive) add(possessive[1], clause);
  }

  return Array.from(evidenceByName, ([name, evidence]) => ({
    name,
    evidence: Array.from(evidence),
  }));
}

const AUDIO_CUE_PATTERN = /(?:声音|音效|声响|音乐|配乐|BGM|SFX|旁白|画外音|广播|铃声|脚步声|轰鸣|回声|低语|喊声|哭声|笑声)/i;
const VISUAL_DIRECTIVE_PATTERN = /(?:字幕|片名|标题|字样|屏幕|大屏|画面|镜头|转场|空镜|特写|特效|闪白|黑屏|红屏|定格|淡入|淡出|LOGO|UI)/i;
const DIRECTIVE_ACTION_PATTERN = /(?:窜入|爆红|砸出|出现|浮现|闪现|切入|切出|淡入|淡出|亮起|熄灭|响起|传来|回荡|显示|弹出|定格|黑屏)$/;

function normalizeAssetName(value: string) {
  return cleanName(value).replace(/\s+/g, "");
}

function normalizeAudioCueName(value: string) {
  const normalized = cleanName(value)
    .replace(/(?:窜入|闯入|进入|响起|传来|回荡|出现|渐强|渐弱)$/, "")
    .trim();
  return normalized || cleanName(value);
}

function hasCharacterEvidence(name: string, candidates: ScriptCharacterCandidate[]) {
  const normalized = normalizeAssetName(name);
  return candidates.some((candidate) => normalizeAssetName(candidate.name) === normalized);
}

/**
 * Models occasionally label screenplay directions as roles. Strongly typed
 * screenplay cues are corrected before the assets reach the UI, while named
 * characters found in dialogue/character lists always win over the heuristic.
 */
function correctMisclassifiedCharacters(
  scriptText: string,
  assets: AutomationAsset[],
): Pick<ScriptCharacterCoverageResult, "assets" | "removedNames" | "reclassifiedAudioNames"> {
  const candidates = extractScriptCharacterCandidates(scriptText);
  const removedNames: string[] = [];
  const reclassifiedAudioNames: string[] = [];
  const corrected = assets.flatMap((asset) => {
    if (
      asset.source !== "extracted"
      || asset.type !== "character"
      || hasCharacterEvidence(asset.name, candidates)
    ) return [asset];
    const name = normalizeAssetName(asset.name);
    if (AUDIO_CUE_PATTERN.test(name)) {
      reclassifiedAudioNames.push(asset.name);
      return [{
        ...asset,
        type: "audio" as const,
        name: normalizeAudioCueName(asset.name),
        variants: undefined,
        boundAudioId: undefined,
      }];
    }
    if (VISUAL_DIRECTIVE_PATTERN.test(name) || DIRECTIVE_ACTION_PATTERN.test(name)) {
      removedNames.push(asset.name);
      return [];
    }
    return [asset];
  });

  const seen = new Set<string>();
  return {
    assets: corrected.filter((asset) => {
      const key = `${asset.type}:${normalizeAssetName(asset.name)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    removedNames: unique(removedNames),
    reclassifiedAudioNames: unique(reclassifiedAudioNames),
  };
}

export function ensureScriptCharacterCoverage(
  scriptText: string,
  assets: AutomationAsset[],
): ScriptCharacterCoverageResult {
  const corrected = correctMisclassifiedCharacters(scriptText, assets);
  const characterNames = new Set(
    corrected.assets
      .filter((asset) => asset.type === "character")
      .map((asset) => cleanName(asset.name)),
  );
  const missing = extractScriptCharacterCandidates(scriptText)
    .filter((candidate) => !characterNames.has(cleanName(candidate.name)));
  if (missing.length === 0) {
    return {
      ...corrected,
      addedNames: [],
    };
  }

  const now = Date.now();
  const additions = missing.map<AutomationAsset>((candidate, index) => {
    const evidence = candidate.evidence.join("；");
    return {
      id: `auto-covered-character-${now}-${index}`,
      type: "character",
      name: candidate.name,
      description: `剧本明确出现的人物。相关描写：${evidence}`,
      generationPrompt: `character design for ${candidate.name}, based on script evidence: ${evidence}, full body concept art, consistent identity`,
      source: "extracted",
      locked: false,
    };
  });
  return {
    assets: [...corrected.assets, ...additions],
    addedNames: additions.map((asset) => asset.name),
    removedNames: corrected.removedNames,
    reclassifiedAudioNames: corrected.reclassifiedAudioNames,
  };
}

function explicitList(text: string, keys: string[]) {
  const values: string[] = [];
  for (const key of keys) {
    const regex = new RegExp(`${key}\\s*[：:]\\s*([^\\n]+)`, "g");
    for (const match of text.matchAll(regex)) {
      values.push(
        ...match[1]
          .split(/[、,，/|]/)
          .map(cleanName)
          .filter((value) => value.length > 0 && value.length < 24),
      );
    }
  }
  return unique(values);
}

export function extractAssetsFromScript(scriptText: string): AutomationAsset[] {
  const text = scriptText.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);

  const characters = unique([
    ...explicitList(text, ["人物", "角色", "人物表", "角色表", "主要人物", "出场人物"]),
    ...dialogueCharacters(lines),
  ]).slice(0, 16);

  const scenes = unique([
    ...explicitList(text, ["场景", "地点"]),
    ...lines
      .filter((line) =>
        /^(第.{1,12}场|场景\s*[一二三四五六七八九十\d]*|内景|外景|INT\.?|EXT\.?)/i.test(line),
      )
      .map((line) => cleanName(line.replace(/^(场景\s*[一二三四五六七八九十\d]*|地点)\s*[：:]?\s*/i, ""))),
  ]).slice(0, 16);

  const props = unique([
    ...explicitList(text, ["道具", "关键道具"]),
    ...lines.flatMap((line) => {
      const matches = line.matchAll(
        /(?:拿起|握着|手持|掏出|递给|放下|桌上(?:放着|摆着)?|身旁(?:放着|摆着)?)([\u4e00-\u9fa5A-Za-z0-9·]{1,10})/g,
      );
      return Array.from(matches, (match) => cleanName(match[1]));
    }),
  ]).slice(0, 16);

  const audios = unique([
    ...explicitList(text, ["音频", "音效", "音乐", "BGM"]),
    ...lines
      .filter((line) => /^(音效|音乐|BGM|旁白|画外音|OS)\s*[：:]/i.test(line))
      .map((line) => cleanName(line.replace(/^(音效|音乐|BGM|旁白|画外音|OS)\s*[：:]\s*/i, ""))),
  ]).slice(0, 16);

  const collected: AutomationAsset[] = [];
  let index = 0;
  for (const [type, names] of [
    ["character", characters],
    ["scene", scenes],
    ["prop", props],
    ["audio", audios],
  ] as const) {
    for (const name of names) {
      collected.push(
        makeAsset(type, name, `从剧本自动识别的${TYPE_LABELS[type]}资产`, index++),
      );
    }
  }
  return collected;
}

function containsPreferredKey(value: unknown, preferredKeys: string[], depth = 0): boolean {
  if (depth > 8 || !value) return false;
  if (typeof value === "string") {
    return preferredKeys.some((key) => value.includes(`"${key}"`));
  }
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsPreferredKey(item, preferredKeys, depth + 1));
  }
  const object = value as Record<string, unknown>;
  return preferredKeys.some((key) => key in object)
    || Object.values(object).some((item) => containsPreferredKey(item, preferredKeys, depth + 1));
}

function findJSONObject(
  input: string,
  preferredKeys: string[] = [],
  errorMessage = "文字模型返回内容无法解析为 JSON 对象",
) {
  const text = input
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!preferredKeys.length || containsPreferredKey(parsed, preferredKeys)) return parsed;
    return parsed;
  } catch {
    // Continue with a balanced-object scan so surrounding prose from a model
    // does not make an otherwise valid structured result unusable.
  }
  const candidates: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, index + 1);
        try {
          const parsed = JSON.parse(candidate) as unknown;
          if (!preferredKeys.length || containsPreferredKey(parsed, preferredKeys)) return parsed;
          candidates.push(parsed);
        } catch {
          // Keep scanning in case a later balanced object contains valid JSON.
        }
        start = -1;
      }
    }
  }
  if (candidates.length > 0) return candidates[0];
  throw new Error(errorMessage);
}

function findAssetsList(value: unknown, depth = 0): unknown[] | null {
  if (depth > 4 || !value) return null;
  if (typeof value === "string") {
    if (!value.includes("assetsList")) return null;
    try {
      return findAssetsList(
        findJSONObject(value, ["assetsList"], "文字模型返回内容无法解析为剧本资产"),
        depth + 1,
      );
    } catch {
      return null;
    }
  }
  if (typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.assetsList)) return object.assetsList;
  for (const nested of Object.values(object)) {
    const list = findAssetsList(nested, depth + 1);
    if (list) return list;
  }
  return null;
}

function findShotsList(value: unknown, depth = 0): unknown[] | null {
  if (depth > 4 || !value) return null;
  if (typeof value === "string") {
    if (!value.includes("shots")) return null;
    try {
      return findShotsList(
        findJSONObject(value, ["shots"], "文字模型返回内容无法解析为分镜数据"),
        depth + 1,
      );
    } catch {
      return null;
    }
  }
  if (typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.shots)) return object.shots;
  for (const nested of Object.values(object)) {
    const list = findShotsList(nested, depth + 1);
    if (list) return list;
  }
  return null;
}

export function parseExtractedAssetsResponse(content: string): AutomationAsset[] {
  const parsed = findJSONObject(
    content,
    ["assetsList"],
    "文字模型返回内容无法解析为剧本资产",
  );
  if (!parsed || typeof parsed !== "object") {
    throw new Error("文字模型返回的资产格式不正确");
  }
  const list = findAssetsList(parsed);
  if (!list) {
    throw new Error("文字模型返回内容缺少剧本资产数据");
  }
  const typeMap: Record<ExtractedModelAsset["type"], AutomationAssetType> = {
    role: "character",
    scene: "scene",
    tool: "prop",
    audio: "audio",
  };
  return list.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const value = raw as Partial<ExtractedModelAsset>;
    if (
      !value.name?.trim()
      || !value.desc?.trim()
      || !value.prompt?.trim()
      || !value.type
      || !(value.type in typeMap)
    ) return [];
    return [{
      id: `auto-model-${Date.now()}-${index}`,
      type: typeMap[value.type],
      name: value.name.trim(),
      description: value.desc.trim(),
      generationPrompt: value.prompt.trim(),
      source: "extracted" as const,
      locked: false,
      variants: value.type === "role"
        ? normalizeExtractedVariants(value, value.desc.trim(), value.prompt.trim(), index)
        : undefined,
    }];
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMentionsAssetName(text: string, name: string) {
  const term = name.trim();
  if (!term) return false;
  if (term.length > 1) return text.includes(term);
  // A naked includes() is unsafe for one-character names: “魁” must not
  // match the adjective “魁梧”. Require a character-like grammatical edge.
  const escaped = escapeRegExp(term);
  return new RegExp(
    `(?:^|[\\s，。！？；、：:“”"'（(]|将|把|向|朝|对准|抓住|击中|与|和|跟|看向|望向|攻击|追赶|靠近|围住|挡住|扶起|推开|压住)${escaped}(?=$|[\\s，。！？；、：:“”"'）)]|的|被|在|正|已|又|也|仍|后|前|身旁|身边|胸口|并肩|死死|猛然|缓缓|突然|怒吼|冷笑|说道|说着|问道|喊道|倒下|起身|转身|冲向|扑向|站|坐|走|跑|冲|扑|看|望|说|问|喊|笑|哭|倒|起|转|退|进|抬|举|握|抓|击|挡|躲|挣)`,
    "u",
  ).test(text);
}

function assetMentionTerms(asset: AutomationAsset) {
  const terms = [asset.name];
  for (const variant of asset.variants ?? []) {
    terms.push(variant.name);
    const base = variant.name.replace(/(?:状态下?|形态下?)$/, "").trim();
    if (base.length >= 2) terms.push(base);
  }
  return unique(terms);
}

export function reconcileStoryboardAssetReferences(
  storyboards: StoryboardDraft[],
  assets: AutomationAsset[],
): StoryboardDraft[] {
  const validAssetIds = new Set(assets.map((asset) => asset.id));
  return storyboards.map((storyboard) => {
    const searchableText = [
      storyboard.title,
      storyboard.description,
      storyboard.camera,
      storyboard.action,
      storyboard.continuity,
      storyboard.prompt,
    ].filter(Boolean).join("\n");
    const mentionedIds = assets
      .filter((asset) =>
        assetMentionTerms(asset).some((term) => textMentionsAssetName(searchableText, term)),
      )
      .map((asset) => asset.id);
    return {
      ...storyboard,
      assetIds: unique([
        ...storyboard.assetIds.filter((id) => validAssetIds.has(id)),
        ...mentionedIds,
      ]),
    };
  });
}

export function parseStoryboardResponse(content: string, assets: AutomationAsset[]): StoryboardDraft[] {
  const parsed = findJSONObject(
    content,
    ["shots"],
    "文字模型返回内容无法解析为分镜数据",
  );
  const list = findShotsList(parsed);
  if (!list) throw new Error("文字模型返回内容缺少分镜镜头列表");
  const validAssetIds = new Set(assets.map((asset) => asset.id));
  const assetIdByName = new Map<string, string>();
  for (const asset of assets) {
    assetIdByName.set(cleanName(asset.name), asset.id);
    for (const variant of asset.variants ?? []) {
      assetIdByName.set(cleanName(variant.name), asset.id);
    }
  }
  const collectAssetIds = (value: unknown): string[] => {
    if (!value) return [];
    if (typeof value === "string") {
      if (validAssetIds.has(value)) return [value];
      const resolved = assetIdByName.get(cleanName(value));
      return resolved ? [resolved] : [];
    }
    if (Array.isArray(value)) return value.flatMap(collectAssetIds);
    if (typeof value !== "object") return [];
    const object = value as Record<string, unknown>;
    return [
      ...collectAssetIds(object.id),
      ...collectAssetIds(object.assetId),
      ...Object.values(object).flatMap(collectAssetIds),
    ];
  };
  const readPrompt = (value: unknown) => {
    if (typeof value === "string") return value.trim();
    if (!value || typeof value !== "object") return "";
    const object = value as Record<string, unknown>;
    return String(object.cn ?? object.zh ?? object.text ?? object.prompt ?? "").trim();
  };
  const structuredLabels: Record<string, string> = {
    shotSize: "景别",
    angle: "角度",
    height: "机位",
    lensMm: "焦段",
    shutterAngleDeg: "快门角",
    movement: "运镜",
    focusTarget: "对焦",
    fromPrev: "承接上镜",
    persistentAnchors: "持续锚点",
    forbiddenDrifts: "禁止漂移",
    identityLock: "身份锁定",
    propLock: "道具锁定",
    spaceLock: "空间锁定",
    lightLock: "光线锁定",
  };
  const readStructuredText = (
    value: unknown,
    joiner = "；",
    depth = 0,
  ): string => {
    if (depth > 6 || value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      return value
        .map((item) => readStructuredText(item, joiner, depth + 1))
        .filter(Boolean)
        .join(joiner);
    }
    if (typeof value !== "object") return "";
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => {
        const text = readStructuredText(nested, joiner, depth + 1);
        if (!text) return "";
        const suffix = key === "lensMm" ? "mm" : key === "shutterAngleDeg" ? "°" : "";
        return `${structuredLabels[key] ?? key}：${text}${suffix}`;
      })
      .filter(Boolean)
      .join("；");
  };
  const formatDuration = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) return `${value}s`;
    const text = String(value ?? "").trim();
    if (!text) return "3s";
    return /^\d+(?:\.\d+)?$/.test(text) ? `${text}s` : text;
  };
  const storyboards = list.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const value = raw as Record<string, unknown>;
    const description = String(value.description ?? value.visual ?? value.narrativeGoal ?? "").trim();
    const imagePrompt =
      readPrompt(value.imagePrompt)
      || readPrompt(value.promptCn)
      || readPrompt(value.prompt);
    if (!description && !imagePrompt) return [];
    const assetIds = unique([
      ...collectAssetIds(value.assetIds),
      ...collectAssetIds(value.assets),
      ...collectAssetIds(value.assetRefs),
    ]);
    const cameraObject = value.camera && typeof value.camera === "object"
      ? value.camera as Record<string, unknown>
      : undefined;
    const continuity = [
      readStructuredText(value.continuity),
      readStructuredText(value.continuityLocks),
    ].filter(Boolean).join("；");
    return [{
      id: `shot-model-${Date.now()}-${index}`,
      title: String(value.title ?? `分镜 ${String(index + 1).padStart(2, "0")}`).trim(),
      description: description || imagePrompt,
      shot: String(value.shot ?? value.shotSize ?? cameraObject?.shotSize ?? "中景").trim(),
      duration: formatDuration(value.duration ?? value.durationSec),
      camera: readStructuredText(value.camera) || undefined,
      action: readStructuredText(value.action ?? value.actionChain, " → ") || undefined,
      continuity: continuity || undefined,
      prompt: imagePrompt || description,
      negativePrompt: readStructuredText(value.negativePrompt ?? value.negativeConstraints, "；") || undefined,
      assetIds,
      status: "draft" as const,
    }];
  });
  return reconcileStoryboardAssetReferences(storyboards, assets);
}

export function buildStoryboardDrafts(
  scriptText: string,
  assets: AutomationAsset[],
): StoryboardDraft[] {
  const paragraphs = scriptText
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}|(?=第.{1,10}场)|(?=场景\s*[一二三四五六七八九十\d]+\s*[：:])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 8)
    .slice(0, 12);

  const source = paragraphs.length > 0
    ? paragraphs
    : scriptText.split("\n").map((line) => line.trim()).filter((line) => line.length > 8).slice(0, 8);

  return source.map((part, index) => {
    const relevantAssets = assets
      .filter((asset) => part.includes(asset.name) || asset.type === "scene")
      .slice(0, 6);
    const normalized = part.replace(/\s+/g, " ");
    const short = normalized.length > 110 ? `${normalized.slice(0, 110)}…` : normalized;
    const sceneAsset = relevantAssets.find((asset) => asset.type === "scene");
    return {
      id: `shot-${Date.now()}-${index}`,
      title: `分镜 ${String(index + 1).padStart(2, "0")}`,
      description: short,
      shot: index % 3 === 0 ? "全景" : index % 3 === 1 ? "中景" : "近景",
      duration: index % 2 === 0 ? "4s" : "3s",
      camera: index % 3 === 0 ? "低机位缓慢推进" : index % 3 === 1 ? "平视轻微横移" : "近距离定格",
      action: "按剧本文本推进动作链",
      continuity: "延续上一镜头的人物方位、光线和关键道具",
      prompt: `电影分镜黑白线稿，${short}，画面清晰，构图明确，16:9`,
      negativePrompt: "不要角色变形，不要多余肢体，不要文字水印",
      assetIds: relevantAssets.map((asset) => asset.id),
      status: "draft",
      ...(sceneAsset ? { title: `${String(index + 1).padStart(2, "0")} · ${sceneAsset.name}` } : {}),
    };
  });
}

export function automationStorageKey(projectId: string) {
  return `ccy-automation-workflow:${projectId}`;
}

export function hasCompletedScriptExtraction(workflow: AutomationWorkflow) {
  return Boolean(
    workflow.scriptText.trim()
    && workflow.extractedScriptText === workflow.scriptText.trim()
    && workflow.extractionCompletedAt
    && workflow.assets.some((asset) => asset.source === "extracted"),
  );
}

export function loadAutomationWorkflow(projectId: string): AutomationWorkflow | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(automationStorageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AutomationWorkflow;
    if (parsed.version !== 1 || parsed.projectId !== projectId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveAutomationWorkflow(workflow: AutomationWorkflow) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(automationStorageKey(workflow.projectId), JSON.stringify(workflow));
}
