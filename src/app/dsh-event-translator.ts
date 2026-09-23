/**
 * DSH session 事件 → ccy AgentSSEEvent 翻译器。
 *
 * 为什么放在 src/ 下用 TS 写：它是纯函数、无副作用，是"DSH 会话事件"与"ccy 前端契约"
 * 之间唯一的翻译层。放在这里可以类型检查 + 单测，Node 侧 bridge 只是在运行时引用同一份
 * 实现（不复制逻辑，避免两边漂移）。
 *
 * 前端契约见 `src/app/api/agent-run.ts`。目标事件类型就是那里的 13 种。
 *
 * 关键设计：DSH 的 `assistant/message` 带**完整时序流**（stream 字段，含
 * text-chunks / reasoning-chunks，每片都有耗时 dt）。因此 bridge 不是"最后一次性吐文本"，
 * 而是能按原始节奏逐片重放 message_delta / thought_delta —— 打字机效果与思考块的流式增长
 * 都能还原。`paced: false` 时一次性给出全文（历史回放/测试用）。
 *
 * 已对照真实载荷核验（本机会话日志，见 scripts/canvas-cli/dump-event.mjs）：
 *   assistant/message: { turn, step, message:{ role, content:[{type:'text',text}],
 *                        source:{provider,model}, id },
 *                        usage:{ inputTokens, outputTokens, totalTokens, cacheReadTokens, reasoningTokens },
 *                        stream:[ {type:'chunk',chunk:{type:'block-start',...}},
 *                                 {type:'text-chunks',index,dt:number[],texts:string[]},
 *                                 {type:'reasoning-chunks',index,dt,texts},
 *                                 {type:'tool-call-chunks',index,dt,id,name,args} ] }
 *   tool/call:   { turn, step, callId, name, arguments }
 *   tool/result: { turn, step, message:{ content:[{ type:'tool-result', toolCallId,
 *                        content:[{type:'text',text}], isError }] } }
 */

import type { AgentSSEEvent, AgentSSEEventType } from "./api/agent-run";

/** 翻译产物：一条前端事件 + 重放它之前的建议等待时长（仅 paced 模式）。 */
export type TranslatedAgentEvent = {
  kind: AgentSSEEventType;
  data: AgentSSEEvent["data"];
  delayMs?: number;
};

export type StreamChunk = {
  kind: "text" | "reasoning";
  index: number;
  text: string;
  delayMs: number;
};

export type SessionEventEnvelope = {
  type?: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
};

export type SessionEventNotification = {
  sessionId?: string | number;
  event?: SessionEventEnvelope;
};

export type TranslateOptions = {
  /** true: 增量按原始 dt 节奏逐片输出；false: 一次性输出全文。 */
  paced?: boolean;
};

/**
 * 去掉 MCP 工具的命名空间前缀：`mcp__ccy__create_node` → `create_node`。
 *
 * 前端与工具卡片都按裸名展示（与 ccy 自研 runner 的工具名一致），
 * 所以这一层归一化必须在翻译器里做，而不是留给 UI。
 */
export function normalizeToolName(name: unknown): string {
  const raw = String(name ?? "");
  if (raw.startsWith("mcp__")) {
    const parts = raw.split("__");
    if (parts.length >= 3) return parts.slice(2).join("__");
  }
  return raw;
}

/** 从 content 块数组里取出可读文本（递归处理 tool-result 的嵌套 content）。 */
export function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      if (record.type === "text") return String(record.text ?? "");
      if (record.type === "tool-result") return textFromBlocks(record.content);
      if (typeof record.text === "string") return record.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 把时序流拍平成按到达顺序排列的增量片。 */
export function flattenStreamChunks(stream: unknown): StreamChunk[] {
  if (!Array.isArray(stream)) return [];
  const chunks: StreamChunk[] = [];
  for (const record of stream) {
    if (!record || typeof record !== "object") continue;
    const entry = record as Record<string, unknown>;
    if (entry.type !== "text-chunks" && entry.type !== "reasoning-chunks") continue;
    const kind: StreamChunk["kind"] = entry.type === "text-chunks" ? "text" : "reasoning";
    const texts = Array.isArray(entry.texts) ? entry.texts : [];
    const deltas = Array.isArray(entry.dt) ? entry.dt : [];
    const index = typeof entry.index === "number" ? entry.index : 0;
    for (let position = 0; position < texts.length; position++) {
      const text = String(texts[position] ?? "");
      if (!text) continue;
      const delay = Number(deltas[position]);
      chunks.push({ kind, index, text, delayMs: Number.isFinite(delay) ? Math.max(0, delay) : 0 });
    }
  }
  return chunks;
}

function toUsage(usage: unknown): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const prompt = Number(record.inputTokens ?? 0);
  const completion = Number(record.outputTokens ?? 0);
  const total = Number(record.totalTokens ?? prompt + completion);
  if (!prompt && !completion) return null;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

/**
 * 把一条 session 事件翻译成前端事件列表。
 *
 * 未进入 UI 时间线的事件（turn/start、step/*、system/message、request/* 等）返回空数组。
 */
export function translateSessionEvent(
  event: SessionEventEnvelope | undefined,
  options: TranslateOptions = {},
): TranslatedAgentEvent[] {
  const paced = options.paced === true;
  const type = event?.type;
  const data = (event?.data ?? {}) as Record<string, any>;
  const out: TranslatedAgentEvent[] = [];

  switch (type) {
    case "assistant/message": {
      const message = (data.message ?? {}) as Record<string, any>;
      const chunks = flattenStreamChunks(data.stream);
      const textChunks = chunks.filter((chunk) => chunk.kind === "text");
      const reasoningChunks = chunks.filter((chunk) => chunk.kind === "reasoning");

      if (paced && chunks.length) {
        for (const chunk of chunks) {
          out.push({
            kind: chunk.kind === "reasoning" ? "thought_delta" : "message_delta",
            data: { delta: chunk.text },
            delayMs: chunk.delayMs,
          });
        }
      } else {
        const reasoning = reasoningChunks.map((chunk) => chunk.text).join("");
        const streamedText = textChunks.map((chunk) => chunk.text).join("");
        const text = streamedText || textFromBlocks(message.content);
        if (reasoning) out.push({ kind: "thought_delta", data: { delta: reasoning } });
        if (text) out.push({ kind: "message_delta", data: { delta: text } });
      }

      const usage = toUsage(data.usage);
      if (usage) out.push({ kind: "usage", data: usage });

      // 最终回复只取**正文**。
      //
      // 为什么不用 message.content：实测 DSH 的 assistant/message 会把**推理文本**
      // 也放进 message.content（同一条消息里既有推理段又有正文段），
      // 直接取它会把思考内容当成回复 —— 面板随后把它记进会话历史，
      // 表现就是"思考跑到正文里、而且刷新后还在"（实测踩过）。
      //
      // 判定规则：
      //   有 stream → 正文只认 text-chunks。哪怕一个 text-chunk 都没有（整条消息
      //               只有推理），也不能退回 message.content，否则思考又会被当成回复。
      //   无 stream → 才退回 message.content（历史回放等场景没有 stream）。
      const hasStream = Array.isArray(data.stream) && data.stream.length > 0;
      const finalText = hasStream ? textChunks.map((chunk) => chunk.text).join("") : textFromBlocks(message.content);
      if (finalText) out.push({ kind: "message", data: { content: finalText } });
      if (data.interrupted === true) {
        out.push({
          kind: "thought",
          data: { content: "本轮被中断，已交付内容为中断前的前缀。" },
        });
      }
      return out;
    }

    case "tool/call": {
      out.push({
        kind: "tool_call",
        data: {
          id: String(data.callId ?? ""),
          name: normalizeToolName(data.name),
          arguments: String(data.arguments ?? ""),
        },
      });
      return out;
    }

    case "tool/result": {
      const block = (data.message?.content?.[0] ?? {}) as Record<string, any>;
      const text = textFromBlocks(block.content);
      const isError = block.isError === true;
      out.push({
        kind: "tool_result",
        data: {
          id: String(block.toolCallId ?? ""),
          // DSH 的 result 里只有 callId，工具名由 createSessionEventTranslator 用
          // 之前的 tool/call 记录补齐（前端的时间线需要名字）。
          name: "",
          ok: !isError,
          ...(isError
            ? { error: text || String(data.error?.name ?? "") || "工具执行失败" }
            : { result: text }),
        },
      });
      return out;
    }

    case "turn/end": {
      out.push({ kind: "done", data: { steps: Number(data.turn ?? 0) } });
      return out;
    }

    default:
      return out;
  }
}

export type SessionEventTranslator = {
  translate: (notification: SessionEventNotification) => TranslatedAgentEvent[];
  knownToolNames: () => Record<string, string>;
};

/**
 * 会话事件过滤器 + 工具名对账。
 *
 * `session.event` 是全 runtime 广播（包含非本会话的事件），所以按 sessionId 过滤是硬性要求；
 * 顺带记住 callId → 工具名，给只有 callId 的 tool/result 补名。
 */
export function createSessionEventTranslator(
  sessionId: string,
  options: TranslateOptions = {},
): SessionEventTranslator {
  const callNames = new Map<string, string>();
  return {
    translate(notification) {
      if (!notification || String(notification.sessionId) !== String(sessionId)) return [];
      const translated = translateSessionEvent(notification.event, options);
      for (const item of translated) {
        if (item.kind === "tool_call") {
          const payload = item.data as { id: string; name: string };
          callNames.set(payload.id, payload.name);
        } else if (item.kind === "tool_result") {
          const payload = item.data as { id: string; name: string };
          if (!payload.name) payload.name = callNames.get(payload.id) ?? "tool";
        }
      }
      return translated;
    },
    knownToolNames: () => Object.fromEntries(callNames),
  };
}
