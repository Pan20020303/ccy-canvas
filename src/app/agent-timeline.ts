/**
 * 事件流 → 时间线：DSH 会话事件的可读呈现模型。
 *
 * 为什么单独一层：原始事件流不适合直接渲染 —— 一次 run 可能有几百条
 * `thought_delta`（实测 354 条），逐条显示会把工具调用淹掉。这里把它压成
 * "步骤"列表：连续增量合成一个块、tool_call 与 tool_result 按 callId 配对、
 * 画布变更单列。React 面板与内置检视页共用这一份逻辑，避免两边呈现漂移。
 *
 * 与翻译器的关系：翻译器负责 DSH → ccy 契约（事件级），这一层负责
 * 事件序列 → 可读步骤（呈现级）。两者都在 src/ 下，可类型检查 + 单测。
 */

import type { AgentSSEEventType, CanvasPatch } from "./api/agent-run";
import { normalizeToolName } from "./dsh-event-translator";

/** 落库/桥返回的一条事件。 */
export type TimelineEvent = {
  id: number;
  type: AgentSSEEventType | string;
  data: Record<string, unknown>;
  at?: number;
};

export type TimelineStep =
  | {
      kind: "reasoning";
      id: string;
      /** 合并后的完整思考文本（原始是逐片增量）。 */
      text: string;
      /** 原始增量片数，用于展示"逐字流"的规模。 */
      chunkCount: number;
      at: number;
    }
  | {
      kind: "message";
      id: string;
      text: string;
      chunkCount: number;
      at: number;
    }
  | {
      kind: "tool";
      id: string;
      callId: string;
      name: string;
      /** 原始（未去 namespace 的）工具名，排障时有用。 */
      rawName?: string;
      arguments: string;
      ok: boolean | null;
      result?: string;
      error?: string;
      at: number;
    }
  | {
      kind: "canvas";
      id: string;
      op: string;
      revision?: number;
      baseRevision?: number;
      /** 一句话摘要：add_node → n1 [image] 标题 */
      summary: string;
      at: number;
    }
  | {
      kind: "notice";
      id: string;
      level: "info" | "error";
      text: string;
      at: number;
    }
  | {
      kind: "usage";
      id: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      at: number;
    };

export type TimelineSummary = {
  status: string;
  toolCalls: number;
  canvasOps: number;
  reasoningChunks: number;
  messageChunks: number;
  totalTokens: number;
  steps: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 从首个事件到最后一个事件的墙钟时长（毫秒）。 */
  durationMs: number | null;
};

export type Timeline = {
  steps: TimelineStep[];
  summary: TimelineSummary;
};

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      if (record.type === "text") return String(record.text ?? "");
      if (record.type === "tool-result") return textFromBlocks(record.content);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 画布变更的一句话摘要：让人一眼看出"改了什么"。 */
export function summarizeCanvasPatch(data: Record<string, unknown>): string {
  const op = asString(data.op);
  switch (op) {
    case "add_node": {
      const node = (data.node ?? {}) as Record<string, unknown>;
      const nodeData = (node.data ?? {}) as Record<string, unknown>;
      const title = asString(nodeData.title);
      return `${asString(node.id)} [${asString(node.type)}]${title ? ` ${title}` : ""}`;
    }
    case "add_edge":
      return `${asString((data.edge as Record<string, unknown>)?.source)} → ${asString((data.edge as Record<string, unknown>)?.target)}`;
    case "patch_node_data": {
      const keys = Object.keys((data.patch ?? {}) as Record<string, unknown>);
      return `${asString(data.node_id)} 字段: ${keys.join(", ") || "(空)"}`;
    }
    case "move_node":
      return `${asString(data.node_id)} → (${asNumber((data.position as Record<string, unknown>)?.x) ?? "?"}, ${asNumber((data.position as Record<string, unknown>)?.y) ?? "?"})`;
    case "delete_node":
      return asString(data.node_id);
    case "create_group":
      return `${asString(data.name) || "分组"}: ${Array.isArray(data.node_ids) ? data.node_ids.join(", ") : ""}`;
    case "run_node":
      return `${asString(data.node_id)}${asString(data.model) ? ` model=${asString(data.model)}` : ""}`;
    default:
      return op;
  }
}

/**
 * 把事件序列压成时间线步骤。
 *
 * 合并规则：连续的同类增量（thought_delta / message_delta）合成一个块；
 * tool_call 先落位，等同一 callId 的 tool_result 到达时回填结果（保持步骤顺序稳定）。
 */
export function buildTimeline(events: readonly TimelineEvent[]): Timeline {
  const steps: TimelineStep[] = [];
  const toolIndexByCallId = new Map<string, number>();

  // 增量合并状态
  let pendingKind: "reasoning" | "message" | null = null;
  let pendingText = "";
  let pendingChunks = 0;
  let pendingAt = 0;

  const flushPending = () => {
    if (!pendingKind || !pendingText) {
      pendingKind = null;
      pendingText = "";
      pendingChunks = 0;
      return;
    }
    steps.push(
      pendingKind === "reasoning"
        ? { kind: "reasoning", id: `reasoning-${steps.length}`, text: pendingText, chunkCount: pendingChunks, at: pendingAt }
        : { kind: "message", id: `message-${steps.length}`, text: pendingText, chunkCount: pendingChunks, at: pendingAt },
    );
    pendingKind = null;
    pendingText = "";
    pendingChunks = 0;
  };

  const summary: TimelineSummary = {
    status: "unknown",
    toolCalls: 0,
    canvasOps: 0,
    reasoningChunks: 0,
    messageChunks: 0,
    totalTokens: 0,
    steps: 0,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  };

  for (const event of events) {
    const data = event.data ?? {};
    const at = event.at ?? 0;
    if (at && summary.startedAt === null) summary.startedAt = at;

    switch (event.type) {
      case "thought_delta":
      case "message_delta": {
        const delta = asString(data.delta);
        const kind = event.type === "thought_delta" ? "reasoning" : "message";
        if (pendingKind !== kind) flushPending();
        pendingKind = kind;
        if (!pendingChunks) pendingAt = at;
        pendingText += delta;
        pendingChunks += 1;
        if (kind === "reasoning") summary.reasoningChunks += 1;
        else summary.messageChunks += 1;
        break;
      }

      case "thought": {
        // 过程性说明（技能加载、防幻觉校验等）：单独一条，不并入正文
        flushPending();
        const content = asString(data.content);
        if (content) steps.push({ kind: "notice", id: `notice-${steps.length}`, level: "info", text: content, at });
        break;
      }

      case "tool_call": {
        flushPending();
        const callId = asString(data.id);
        const rawName = asString(data.name);
        const name = normalizeToolName(rawName);
        summary.toolCalls += 1;
        toolIndexByCallId.set(callId, steps.length);
        steps.push({
          kind: "tool",
          id: `tool-${steps.length}`,
          callId,
          name,
          rawName: rawName !== name ? rawName : undefined,
          arguments: asString(data.arguments),
          ok: null,
          at,
        });
        break;
      }

      case "tool_result": {
        const callId = asString(data.id);
        const index = toolIndexByCallId.get(callId);
        if (index === undefined) {
          // 没有对应调用的结果（例如历史被截断）：单独显示，不要静默丢弃
          steps.push({
            kind: "notice",
            id: `notice-${steps.length}`,
            level: "info",
            text: `未配对的工具结果（callId=${callId}）：${asString(data.result ?? data.error).slice(0, 200)}`,
            at,
          });
          break;
        }
        const step = steps[index];
        if (step.kind === "tool") {
          step.ok = data.ok === true;
          if (data.ok === true) step.result = asString(data.result);
          else step.error = asString(data.error) || "工具执行失败";
        }
        break;
      }

      case "canvas_patch": {
        flushPending();
        summary.canvasOps += 1;
        steps.push({
          kind: "canvas",
          id: `canvas-${steps.length}`,
          op: asString(data.op),
          revision: asNumber(data.revision),
          baseRevision: asNumber(data.base_revision),
          summary: summarizeCanvasPatch(data),
          at,
        });
        break;
      }

      case "message": {
        flushPending();
        const content = asString(data.content);
        if (content) steps.push({ kind: "message", id: `message-${steps.length}`, text: content, chunkCount: 0, at });
        break;
      }

      case "usage": {
        flushPending();
        summary.totalTokens = asNumber(data.total_tokens) ?? summary.totalTokens;
        steps.push({
          kind: "usage",
          id: `usage-${steps.length}`,
          promptTokens: asNumber(data.prompt_tokens) ?? 0,
          completionTokens: asNumber(data.completion_tokens) ?? 0,
          totalTokens: asNumber(data.total_tokens) ?? 0,
          at,
        });
        break;
      }

      case "error": {
        flushPending();
        steps.push({
          kind: "notice",
          id: `notice-${steps.length}`,
          level: "error",
          text: asString(data.message) || "未知错误",
          at,
        });
        break;
      }

      case "done": {
        flushPending();
        summary.steps = asNumber(data.steps) ?? 0;
        summary.status = "success";
        break;
      }

      case "conversation":
      case "connection_status":
        // 不进时间线：属于连接层信息
        break;

      default:
        break;
    }

    if (at) summary.finishedAt = at;
  }

  flushPending();

  if (summary.startedAt && summary.finishedAt && summary.finishedAt >= summary.startedAt) {
    summary.durationMs = summary.finishedAt - summary.startedAt;
  }

  // 时间戳缺失时（老数据/内存态），用序号仍能稳定排序，不影响展示
  summary.steps = summary.steps || steps.filter((step) => step.kind === "tool").length || 1;
  return { steps, summary };
}

/**
 * 给 React 用的降级转换：把时间线步骤映射成"思考块/工具卡片"两种可渲染单元。
 * 保持与检视页一致的取舍（合并增量、工具配对）。
 */
export function toRenderableUnits(timeline: Timeline) {  return timeline.steps.map((step) => {
    switch (step.kind) {
      case "reasoning":
        return { type: "thinking" as const, id: step.id, text: step.text, chunkCount: step.chunkCount };
      case "message":
        return { type: "answer" as const, id: step.id, text: step.text, chunkCount: step.chunkCount };
      case "tool":
        return {
          type: "tool" as const,
          id: step.id,
          name: step.name,
          rawName: step.rawName,
          arguments: step.arguments,
          ok: step.ok,
          result: step.result,
          error: step.error,
        };
      case "canvas":
        return { type: "canvas" as const, id: step.id, op: step.op, revision: step.revision, summary: step.summary };
      case "notice":
        return { type: "notice" as const, id: step.id, level: step.level, text: step.text };
      case "usage":
        return {
          type: "usage" as const,
          id: step.id,
          promptTokens: step.promptTokens,
          completionTokens: step.completionTokens,
          totalTokens: step.totalTokens,
        };
    }
  });
}

/** 从事件里取最终助手回复（时间线里最后一条 message）。 */
export function finalReplyOf(events: readonly TimelineEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === "message") {
      const content = asString(event.data?.content);
      if (content) return content;
    }
  }
  return "";
}

/** 供检视页复用：把 tool_result 的文本压成单行预览。 */
export function previewText(text: string | undefined, limit = 160): string {
  if (!text) return "";
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

/**
 * 画布操作步骤 → assistant-ui 的消息 part。
 *
 * 为什么需要它：面板的 `AgentAssistantThread` 原本只把 thought/tool 映射成
 * assistant-ui 的 reasoning / tool-call parts，**画布变更只进 footer 的汇总卡，
 * 不进线程时间线** —— 于是"agent 在画布上做了什么"在对话流里是缺失的
 * （DSH 的事件流里 canvas_patch 明明是按时间顺序插在工具调用之间的）。
 *
 * 用 `data-<name>` 而不是自定义类型：assistant-ui 的 part 类型是严格联合
 * （`DataMessagePart | TextMessagePart | ReasoningMessagePart | ToolCallMessagePart | …`），
 * 塞一个 `canvas-op` 进去会被类型系统拒绝。
 *
 * 而且**运行时只认 `data-` 前缀**这一种写法：
 * `thread-message-like.js` 转换 part 时，switch 里没有 `data` 分支，兜底是
 * `convertDataPrefixedPart(type, part.data)`，非 `data-` 前缀会
 * `throw new Error("Unsupported assistant message part type: …")`。
 * （我第一版写的就是 `{ type: "data", name }`，类型检查过了但运行时会炸。）
 *
 * 渲染侧由 `useAssistantDataUI({ name: "canvas-op", render })` 注册命名渲染器
 * （见 AgentAssistantThread）。
 */
export type CanvasOperationPart = {
  type: "data-canvas-op";
  data: {
    id: string;
    op: string;
    action: string;
    entity: string;
    title: string;
    detail: string;
    nodeId?: string;
    position?: string;
    revision?: number;
  };
};

/** 面板里 canvas 步骤的最小形状（patch 就是 AgentSSEEvent 里的 CanvasPatch）。 */
export type CanvasStepLike = {
  kind: "canvas";
  id: string;
  patch: CanvasPatch;
};

/**
 * 把面板的 runSteps 转成 assistant-ui 的 part 数组。
 *
 * 做两件事：
 *   1. **合并相邻的思考块**：面板每个 thought 步骤各渲染一个 ReasoningBlock，
 *      一次 run 里可能出现好几个（模型多次思考），折叠态下是一堆碎块。
 *      这里把相邻的合并成一个，视觉上就是"一段完整的思考"。
 *      （只合并相邻的：中间隔着工具调用就不并 —— 那代表两段不同的推理，
 *       顺序也必须保持，否则工具卡的位置会乱。）
 *   2. **把画布变更插进时间线**：原先它只进面板底部的汇总卡，对话流里看不到
 *      "agent 在画布上做了什么"，而 DSH 的 canvas_patch 本来就按时间序插在
 *      工具调用之间。
 *
 * @param steps 面板的 runSteps
 * @param present 画布操作的本地化呈现函数（复用 canvas-operation-presenter）
 * @param zh 中文
 */
export function runStepsToThreadParts(
  steps: readonly { kind: string; id: string; [key: string]: unknown }[],
  present: (patch: CanvasPatch, zh: boolean) => {
    action: string;
    entity: string;
    title: string;
    detail: string;
    nodeId?: string;
    position?: string;
  },
  zh: boolean,
): (
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; argsText: string; result?: unknown; isError?: boolean }
  | CanvasOperationPart
)[] {
  const parts: ReturnType<typeof runStepsToThreadParts> = [];

  for (const step of steps) {
    if (step.kind === "thought") {
      const text = String((step as { content?: string }).content ?? "");
      if (!text.trim()) continue;
      const last = parts[parts.length - 1];
      // 相邻思考合并（中间有工具/画布就不并）
      if (last && last.type === "reasoning") {
        last.text = `${last.text}\n${text}`;
      } else {
        parts.push({ type: "reasoning", text });
      }
      continue;
    }

    if (step.kind === "tool") {
      const inv = (step as { invocation?: Record<string, unknown> }).invocation ?? {};
      parts.push({
        type: "tool-call",
        toolCallId: String(inv.id ?? step.id),
        toolName: String(inv.name ?? "tool"),
        argsText: String(inv.args ?? "") || "{}",
        // running → 不填结果（卡片显示进行中）；结束后填结果/错误。
        ...(inv.status === "running"
          ? {}
          : { result: inv.output ?? "", isError: inv.status === "error" }),
      });
      continue;
    }

    if (step.kind === "canvas") {
      parts.push(...canvasStepsToParts([step], present, zh));
    }
  }

  return parts;
}

/**
 * 把画布步骤转成 part 数组（供 runStepsToThreadParts 与单测复用）。
 */
export function canvasStepsToParts(
  steps: readonly { kind: string; id: string; [key: string]: unknown }[],
  present: (patch: CanvasPatch, zh: boolean) => {
    action: string;
    entity: string;
    title: string;
    detail: string;
    nodeId?: string;
    position?: string;
  },
  zh: boolean,
): CanvasOperationPart[] {
  const parts: CanvasOperationPart[] = [];
  for (const step of steps) {
    if (step.kind !== "canvas") continue;
    const patch = (step as unknown as CanvasStepLike).patch;
    if (!patch) continue;
    let shown: ReturnType<typeof present>;
    try {
      shown = present(patch, zh);
    } catch {
      // 呈现函数对未知 op 不该抛错；真抛了也不能让整条消息渲染失败。
      continue;
    }
    parts.push({
      // 必须是 data- 前缀：运行时的 convertDataPrefixedPart 靠它把
      // `data-canvas-op` 翻成内部表示 { type:"data", name:"canvas-op", data }。
      type: "data-canvas-op",
      data: {
        id: step.id,
        op: patch.op,
        action: shown.action,
        entity: shown.entity,
        title: shown.title,
        detail: shown.detail,
        nodeId: shown.nodeId,
        position: shown.position,
        revision: patch.revision,
      },
    });
  }
  return parts;
}

export { textFromBlocks };
