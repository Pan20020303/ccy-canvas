import {
  generate,
  generateStream,
  listAppProviderConfigs,
  modelServiceType,
  type AppProviderConfig,
  type GenerateResult,
} from "./providerConfigs";
import { listSkills } from "./skills";
import { getTask } from "./tasks";
import { extractScriptCharacterCandidates } from "../automation-workflow";

export type AutomationTextModelOption = {
  id: string;
  providerId: string;
  providerName: string;
  vendor: string;
  model: string;
};

export type AutomationImageModelOption = AutomationTextModelOption;

function textModelsForProvider(provider: AppProviderConfig) {
  const configured = Array.from(new Set([
    provider.default_model,
    ...(provider.model_list ?? []),
  ].filter(Boolean)));
  return configured.filter((model) => modelServiceType(provider, model) === "text");
}

export async function listAutomationTextModels(): Promise<AutomationTextModelOption[]> {
  const providers = await listAppProviderConfigs();
  return providers.flatMap((provider) =>
    textModelsForProvider(provider).map((model) => ({
      id: `${provider.id}:${model}`,
      providerId: provider.id,
      providerName: provider.name,
      vendor: provider.vendor,
      model,
    })),
  );
}

export async function listAutomationImageModels(): Promise<AutomationImageModelOption[]> {
  const providers = await listAppProviderConfigs();
  return providers.flatMap((provider) =>
    Array.from(new Set([
      provider.default_model,
      ...(provider.model_list ?? []),
    ].filter(Boolean)))
      .filter((model) => modelServiceType(provider, model) === "image")
      .map((model) => ({
        id: `${provider.id}:${model}`,
        providerId: provider.id,
        providerName: provider.name,
        vendor: provider.vendor,
        model,
      })),
  );
}

async function loadSystemAssetExtractionPrompt() {
  const skills = await listSkills();
  const skill = skills.find((item) => {
    const spec = item.spec ?? {};
    return spec.prompt_type === "scriptAssetExtraction"
      || spec.source_path === "prompts/scriptAssetExtraction.md";
  });
  const prompt = skill?.spec?.content_md ?? skill?.spec?.user_template;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("系统中未找到“剧本资产提取”提示词，请先在技能管理中初始化创作套件。");
  }
  return prompt.trim();
}

function adaptAssetExtractionPromptForPlainTextModel(prompt: string) {
  return prompt
    .replaceAll("必须通过调用 `resultTool` 工具返回结果", "必须直接返回一个 JSON 对象")
    .replaceAll("禁止以纯文本、Markdown 表格或 JSON 代码块等形式直接输出资产列表。", "禁止输出 Markdown、解释、代码围栏或表格。")
    .replaceAll("`resultTool` 的 schema 会对字段类型和枚举值做强校验，调用时请严格按照下方字段定义填写", "JSON 对象会被系统严格解析，请按照下方字段定义填写")
    .replaceAll("必须通过调用 `resultTool` 工具输出完整资产列表", "必须直接输出完整资产 JSON");
}

const queuedTaskPollIntervalMs = 1500;
// Backend text tasks have a 15-minute hard ceiling. Give the browser a small
// observation margin so a task is not reported as timed out while the worker
// is persisting its terminal result.
const queuedTaskTimeoutMs = 20 * 60 * 1000;
const streamTextTimeoutMs = 20 * 60 * 1000;

export function automationTaskNodeId(
  kind: "extract" | "storyboard-split",
  projectId?: string,
  source?: string,
) {
  const scope = projectId?.trim() || "local";
  if (!source) return `automation-${kind}-${scope}`;

  // A four-lane 128-bit content fingerprint avoids treating the old 32-bit
  // cache key as a durable identity. Version the key so rows created by older
  // clients can remain visible in history without ever being auto-applied to
  // a different script.
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  const fingerprint = [h1, h2, h3, h4]
    .map((value) => (value >>> 0).toString(16).padStart(8, "0"))
    .join("");
  return `automation-${kind}-${scope}-v2-${fingerprint}`;
}

export function storyboardTaskFingerprintSource(input: {
  script: string;
  assets: Array<{
    id: string;
    name: string;
    type: string;
    description: string;
    url?: string;
    locked?: boolean;
    variants?: Array<{ id: string; name: string; description: string; url?: string }>;
  }>;
  storyboardSkillName?: string;
}) {
  return JSON.stringify({
    script: input.script.trim(),
    skill: input.storyboardSkillName ?? "",
    assets: input.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      type: asset.type,
      description: asset.description,
      url: asset.url ?? "",
      locked: Boolean(asset.locked),
      variants: (asset.variants ?? []).map((variant) => ({
        id: variant.id,
        name: variant.name,
        description: variant.description,
        url: variant.url ?? "",
      })),
    })),
  });
}

type StreamTextProgress = {
  content: string;
  receivedChars: number;
};

function observationAbortError() {
  const error = new Error("后台任务观察已切换到更新任务。");
  error.name = "AbortError";
  return error;
}

function throwIfObservationAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw observationAbortError();
}

function wait(ms: number, signal?: AbortSignal) {
  throwIfObservationAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(observationAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readStreamedTextResponse(
  response: Response,
  onProgress?: (progress: StreamTextProgress) => void,
): Promise<string> {
  if (!response.ok) {
    let message = "文字模型流式调用失败。";
    try {
      const body = await response.json();
      if (body?.error) message = String(body.error);
    } catch {
      // Keep the generic message for non-JSON responses.
    }
    throw new Error(message);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("文字模型没有返回可读取的流式内容。");

  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";
  let finalContent = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf("\n\n");
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const data = dataLine.slice(5).trim();
      if (!data) continue;
      let event: { type?: string; content?: string; message?: string };
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.type === "token") {
        accumulated += event.content ?? "";
        onProgress?.({ content: accumulated, receivedChars: accumulated.length });
      } else if (event.type === "done") {
        finalContent = event.content || accumulated;
        onProgress?.({ content: finalContent, receivedChars: finalContent.length });
        return finalContent;
      } else if (event.type === "error") {
        throw new Error(event.message || "文字模型流式生成失败。");
      }
    }
  }

  if (accumulated.trim()) {
    throw new Error(`文字模型流式连接在完成前中断，已保留 ${accumulated.length} 字草稿。`);
  }
  throw new Error("文字模型流式生成结果为空。");
}

async function streamTextGeneration(input: {
  prompt: string;
  model: string;
  providerId: string;
  projectId?: string;
  nodeId: string;
  onProgress?: (progress: StreamTextProgress) => void;
}) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), streamTextTimeoutMs);
  try {
    const response = await generateStream({
      model: input.model,
      provider_config_id: input.providerId,
      prompt: input.prompt,
      project_id: input.projectId,
      node_id: input.nodeId,
    }, controller.signal);
    return await readStreamedTextResponse(response, input.onProgress);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function buildAssetExtractionPrompt(script: string) {
  const systemPrompt = adaptAssetExtractionPromptForPlainTextModel(
    await loadSystemAssetExtractionPrompt(),
  );
  const characterCandidates = extractScriptCharacterCandidates(script);
  const characterAudit = characterCandidates.length > 0
    ? characterCandidates.map((candidate) => ({
      name: candidate.name,
      evidence: candidate.evidence,
    }))
    : [];
  const executionContract = `

## 本次自动化执行约束
你正在执行 CCY Canvas 的剧本资产提取步骤。当前通道不提供 resultTool，因此必须把原本提交给 resultTool 的参数作为最终响应直接返回。
只允许输出一个 JSON 对象，不要输出 Markdown、解释或代码围栏：
{"assetsList":[{"name":"名称","desc":"中文基础人设/视觉描述","prompt":"English visual prompt","type":"role|scene|tool","variants":[{"name":"形态/状态名称","desc":"该形态中文视觉描述","prompt":"English visual prompt for this form"}]}]}

人物类资产必须拆出基础人设和形态：desc 写基础人设；如果剧本里出现变身、法相、战斗状态、妖狐状态、鸾凤状态、黑化状态、幼年状态、受伤状态等，请放入 variants 字段。比如“李清颜的鸾凤状态”“洛小璃的九尾妖狐状态”都应该作为对应人物 variants 返回，不要另建成独立人物。

## 人物覆盖审计（必须执行）
先逐段核对所有有名字、代号或可独立识别的生命角色，再输出 JSON。短暂出场、已经死亡、敌对角色、妖兽/神兽、单字姓名也都属于人物资产，不能因为戏份少或名字只有一个字而省略；例如“魁”必须作为 role，而“魁梧”只是形容词。
系统从剧本语法中找出的高置信人物候选如下。每个候选都必须在 assetsList 中有且仅有一个 type="role" 的同名条目；若描述不足，也要根据现有上下文生成基础人设，不能静默跳过：
${JSON.stringify(characterAudit, null, 2)}

输出前请在内部逐项复核：人物候选是否全覆盖、人物形态是否归入 variants、场景和道具是否误当人物。不要把复核过程输出到最终响应。

## 待分析剧本
${script.trim()}
`;
  return `${systemPrompt}\n${executionContract}`;
}

function buildStoryboardSplitPrompt(input: {
  script: string;
  assets: Array<{
    id: string;
    name: string;
    type: string;
    description: string;
    url?: string;
    variants?: Array<{ id: string; name: string; description: string; url?: string }>;
  }>;
  storyboardSkillName?: string;
  storyboardSkillPrompt?: string;
}) {
  const assetSummary = input.assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    type: asset.type,
    description: asset.description.slice(0, 120),
    hasReference: Boolean(asset.url),
    variants: asset.variants?.map((variant) => ({
      id: variant.id,
      name: variant.name,
      description: variant.description.slice(0, 120),
      hasReference: Boolean(variant.url),
    })),
  }));
  const selectedSkillPrompt = input.storyboardSkillPrompt?.trim();
  return `
${selectedSkillPrompt || "你是 CCY Canvas 的分镜导演。请把剧本拆成连续的镜头卡。"}

## 本次执行技能
${input.storyboardSkillName ?? "默认分镜技能"}

## CCY Canvas 执行合同
无论上面的技能如何描述，最终响应必须满足下面合同：
1. 只允许输出 JSON，不要 Markdown、解释或代码围栏。
2. 顶层必须包含 shots 数组。
3. 每个镜头必须包含 title、description、shot、duration、camera、action、continuity、imagePrompt、negativePrompt、assetIds。
4. assetIds 只能使用“已锁定资产”中真实存在的 id；人物特殊形态通过描述引用该人物资产与 variants，不要编造 variant id。
5. imagePrompt 必须能直接用于图片模型生成分镜图/线稿。
6. 镜头数量必须按技能中的最低数量规则执行，不要因为输出合同而缩短。

输出格式：
{"shots":[{"title":"分镜 01","description":"中文镜头描述","shot":"全景/中景/近景/特写等","duration":"3s","camera":"机位、角度、运镜","action":"动作链","continuity":"与前后镜头连续性","imagePrompt":"可直接给图片模型的中文提示词","negativePrompt":"负面约束","assetIds":["资产ID"]}]}

已锁定资产：
${JSON.stringify(assetSummary, null, 2)}

剧本：
${input.script.trim()}
`;
}

async function waitForQueuedGeneration(
  taskId: string,
  submitted: GenerateResult,
  emptyResultMessage: string,
  failedMessage: string,
  timeoutMessage: string,
  expectedNodeId?: string,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  const deadline = Date.now() + queuedTaskTimeoutMs;

  while (Date.now() < deadline) {
    throwIfObservationAborted(signal);
    let task;
    try {
      task = await getTask(taskId);
    } catch {
      throwIfObservationAborted(signal);
      // A temporary network/proxy interruption must not turn a durable backend
      // task into a terminal frontend error. Keep observing until the normal
      // deadline; the persisted task id can also be resumed after refresh.
      await wait(queuedTaskPollIntervalMs, signal);
      continue;
    }
    throwIfObservationAborted(signal);
    if (expectedNodeId && task.node_id !== expectedNodeId) {
      throw new Error("找回的后台任务与当前剧本不一致，已停止应用旧结果。");
    }
    if (task.status === "success") {
      if (!task.result_url) {
        throw new Error(emptyResultMessage);
      }
      return {
        ...submitted,
        type: "text",
        content: task.result_url,
        task_id: taskId,
      };
    }
    if (["error", "failed", "dead", "cancelled", "canceled"].includes(task.status)) {
      throw new Error(task.error_msg || failedMessage);
    }
    await wait(queuedTaskPollIntervalMs, signal);
  }

  throw new Error(timeoutMessage);
}

export async function resumeQueuedTextGeneration(input: {
  taskId: string;
  expectedNodeId: string;
  signal?: AbortSignal;
  emptyResultMessage: string;
  failedMessage: string;
  timeoutMessage: string;
}): Promise<GenerateResult> {
  return waitForQueuedGeneration(
    input.taskId,
    {
      type: "queued",
      task_id: input.taskId,
    } as GenerateResult,
    input.emptyResultMessage,
    input.failedMessage,
    input.timeoutMessage,
    input.expectedNodeId,
    input.signal,
  );
}

export async function extractAssetsWithSystemPrompt(input: {
  script: string;
  model: string;
  providerId: string;
  /** Stable workspace scope used only for durable task identity. */
  taskScope?: string;
  /** Real backend project id, when one exists, used as a history display hint. */
  projectId?: string;
  onQueued?: (taskId: string) => void;
}) {
  const prompt = await buildAssetExtractionPrompt(input.script);
  const nodeId = automationTaskNodeId(
    "extract",
    input.taskScope ?? input.projectId,
    input.script.trim(),
  );
  const submitted = await generate({
    service_type: "text",
    provider_config_id: input.providerId,
    model: input.model,
    prompt,
    project_id: input.projectId,
    node_id: nodeId,
    request_id: crypto.randomUUID(),
  });

  if (submitted.type !== "queued") return submitted;
  if (!submitted.task_id) {
    throw new Error("真实文字模型提取任务已提交，但缺少任务编号。");
  }
  input.onQueued?.(submitted.task_id);
  return waitForQueuedGeneration(
    submitted.task_id,
    submitted,
    "真实文字模型已完成，但没有返回可解析的提取结果。",
    "真实文字模型提取失败，请更换模型或稍后重试。",
    "真实文字模型仍在提取中，请稍后重试。",
    nodeId,
  );
}

export async function streamExtractAssetsWithSystemPrompt(input: {
  script: string;
  model: string;
  providerId: string;
  /** Stable workspace scope used only for durable task identity. */
  taskScope?: string;
  projectId?: string;
  onProgress?: (progress: StreamTextProgress) => void;
}) {
  const prompt = await buildAssetExtractionPrompt(input.script);
  return streamTextGeneration({
    prompt,
    model: input.model,
    providerId: input.providerId,
    projectId: input.projectId,
    nodeId: `${automationTaskNodeId(
      "extract",
      input.taskScope ?? input.projectId,
      input.script.trim(),
    )}-stream`,
    onProgress: input.onProgress,
  });
}

export async function splitScriptToStoryboardsWithSystemPrompt(input: {
  script: string;
  assets: Array<{
    id: string;
    name: string;
    type: string;
    description: string;
    url?: string;
    variants?: Array<{ id: string; name: string; description: string; url?: string }>;
  }>;
  model: string;
  providerId: string;
  /** Stable workspace scope used only for durable task identity. */
  taskScope?: string;
  projectId?: string;
  storyboardSkillName?: string;
  storyboardSkillPrompt?: string;
  onQueued?: (taskId: string) => void;
}) {
  const prompt = buildStoryboardSplitPrompt(input);
  const nodeId = automationTaskNodeId(
    "storyboard-split",
    input.taskScope ?? input.projectId,
    storyboardTaskFingerprintSource(input),
  );

  const submitted = await generate({
    service_type: "text",
    provider_config_id: input.providerId,
    model: input.model,
    prompt,
    project_id: input.projectId,
    node_id: nodeId,
    request_id: crypto.randomUUID(),
  });

  if (submitted.type !== "queued") return submitted;
  if (!submitted.task_id) throw new Error("真实文字模型分镜任务已提交，但缺少任务编号。");
  input.onQueued?.(submitted.task_id);
  return waitForQueuedGeneration(
    submitted.task_id,
    submitted,
    "真实文字模型已完成，但没有返回可解析的分镜结果。",
    "真实文字模型拆分分镜失败，请更换模型或稍后重试。",
    "真实文字模型仍在拆分分镜中，请稍后重试。",
    nodeId,
  );
}

export async function streamSplitScriptToStoryboardsWithSystemPrompt(input: {
  script: string;
  assets: Array<{
    id: string;
    name: string;
    type: string;
    description: string;
    url?: string;
    variants?: Array<{ id: string; name: string; description: string; url?: string }>;
  }>;
  model: string;
  providerId: string;
  projectId?: string;
  storyboardSkillName?: string;
  storyboardSkillPrompt?: string;
  onProgress?: (progress: StreamTextProgress) => void;
}) {
  const prompt = buildStoryboardSplitPrompt(input);
  return streamTextGeneration({
    prompt,
    model: input.model,
    providerId: input.providerId,
    projectId: input.projectId,
    nodeId: `${automationTaskNodeId(
      "storyboard-split",
      input.projectId,
      storyboardTaskFingerprintSource(input),
    )}-stream`,
    onProgress: input.onProgress,
  });
}

export async function generateStoryboardImage(input: {
  prompt: string;
  model: string;
  providerId: string;
  projectId?: string;
  referenceImages?: string[];
}) {
  const submitted = await generate({
    service_type: "image",
    provider_config_id: input.providerId,
    model: input.model,
    prompt: input.prompt,
    size: "16:9",
    reference_images: input.referenceImages,
    project_id: input.projectId,
    node_id: `automation-storyboard-image-${Date.now()}`,
    request_id: crypto.randomUUID(),
  });

  if (submitted.type !== "queued") return submitted;
  if (!submitted.task_id) throw new Error("图片生成任务已提交，但缺少任务编号。");
  return waitForQueuedGeneration(
    submitted.task_id,
    submitted,
    "图片模型已完成，但没有返回图片结果。",
    "图片生成失败，请更换模型或稍后重试。",
    "图片模型仍在生成中，请稍后重试。",
  );
}
