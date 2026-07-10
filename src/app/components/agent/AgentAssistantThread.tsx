/**
 * 智能体消息线程 —— assistant-ui 驱动。
 *
 * 用 @assistant-ui/react 的 ExternalStoreRuntime 把面板既有状态
 * (历史轮次 + 当前运行的 思考/工具调用/流式文本)映射成结构化消息 parts:
 *   - thought      → reasoning part(可折叠的「思考」块)
 *   - tool_call    → tool-call part(带参数/结果展开的工具卡片)
 *   - 流式回复      → text part(markdown 渲染)
 * 视口/自动滚动/回到底部按钮由 ThreadPrimitive 提供。
 *
 * 交互型卡片(ask_user / pending_run / canvas / error)不进消息流 ——
 * 它们由面板经 `footer` 插槽渲染在消息之后(运行尾声出现,顺序不失真)。
 */
import { useMemo, useState, type FC, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowDown, Check, ChevronRight, Copy, Loader2, TriangleAlert, Wrench } from "lucide-react";

import type { AgentConversationTurn } from "../agent-conversation";

// 与 AgentRunPanel 共享的运行步骤形状(仅取本组件需要的字段,避免循环依赖)。
export type ThreadToolStep = {
  kind: "tool";
  id: string;
  invocation: {
    id: string;
    name: string;
    args: string;
    status: "running" | "success" | "error";
    output?: string;
  };
};
export type ThreadThoughtStep = { kind: "thought"; id: string; content: string };
export type ThreadRunStep =
  | ThreadToolStep
  | ThreadThoughtStep
  | { kind: string; id: string; [key: string]: unknown };

/** 把面板状态映射成 assistant-ui 的 ThreadMessageLike 列表。 */
function buildMessages(
  history: AgentConversationTurn[],
  runSteps: ThreadRunStep[],
  streamingReply: string,
  running: boolean,
): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = history.map((turn, index) => ({
    id: `h-${index}`,
    role: turn.role,
    content: [{ type: "text" as const, text: turn.content }],
  }));

  // 当前运行 → 一条带结构化 parts 的 assistant 消息(思考/工具/流式文本)。
  const parts: Exclude<ThreadMessageLike["content"], string>[number][] = [];
  for (const step of runSteps) {
    if (step.kind === "thought") {
      const s = step as ThreadThoughtStep;
      if (s.content.trim()) parts.push({ type: "reasoning", text: s.content });
    } else if (step.kind === "tool") {
      const inv = (step as ThreadToolStep).invocation;
      parts.push({
        type: "tool-call",
        toolCallId: inv.id,
        toolName: inv.name,
        argsText: inv.args || "{}",
        // running → result 留空(卡片显示进行中);结束后填结果/错误。
        ...(inv.status === "running" ? {} : { result: inv.output ?? "", isError: inv.status === "error" }),
      });
    }
  }
  if (streamingReply) parts.push({ type: "text", text: streamingReply });

  if (parts.length > 0) {
    const runMessage: ThreadMessageLike = { id: "current-run", role: "assistant", content: parts };
    // 时序修正:运行结束后最终回复已作为最后一条 assistant 历史存在,
    // 工具/思考时间线应插在它「之前」;运行中则排在最后。
    const last = messages[messages.length - 1];
    if (!running && !streamingReply && last?.role === "assistant") {
      messages.splice(messages.length - 1, 0, runMessage);
    } else {
      messages.push(runMessage);
    }
  }
  return messages;
}

const MD_COMPONENTS = {
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => <p className="mb-2 last:mb-0" {...props} />,
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => <ul className="mb-2 list-disc pl-5 last:mb-0" {...props} />,
  ol: (props: React.OlHTMLAttributes<HTMLOListElement>) => <ol className="mb-2 list-decimal pl-5 last:mb-0" {...props} />,
  li: (props: React.LiHTMLAttributes<HTMLLIElement>) => <li className="mb-0.5" {...props} />,
  h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h1 className="mb-2 mt-3 text-[15px] font-semibold first:mt-0" {...props} />,
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h2 className="mb-1.5 mt-2.5 text-[14px] font-semibold first:mt-0" {...props} />,
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h3 className="mb-1 mt-2 text-[13px] font-semibold first:mt-0" {...props} />,
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a className="text-cyan-300 underline decoration-cyan-300/40 underline-offset-2 hover:text-cyan-200" target="_blank" rel="noreferrer" {...props} />,
  blockquote: (props: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => <blockquote className="mb-2 border-l-2 border-white/15 pl-3 text-neutral-400" {...props} />,
  code: (props: React.HTMLAttributes<HTMLElement>) => <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[11px]" {...props} />,
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <pre className="prompt-editor-scroll mb-2 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed [&>code]:bg-transparent [&>code]:p-0" {...props} />
  ),
  hr: () => <hr className="my-2 border-white/10" />,
  table: (props: React.TableHTMLAttributes<HTMLTableElement>) => <table className="mb-2 w-full border-collapse text-[11px]" {...props} />,
  th: (props: React.ThHTMLAttributes<HTMLTableCellElement>) => <th className="border border-white/10 bg-white/[0.04] px-2 py-1 text-left" {...props} />,
  td: (props: React.TdHTMLAttributes<HTMLTableCellElement>) => <td className="border border-white/10 px-2 py-1" {...props} />,
};

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="flex justify-end">
    <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-white/10 px-3.5 py-2 text-[13px] leading-relaxed text-neutral-100">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);

/** 可折叠「思考」块。 */
const ReasoningBlock: FC<{ text: string; zh: boolean }> = ({ text, zh }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-neutral-500 transition hover:text-neutral-300"
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        {zh ? "思考" : "Reasoning"}
        <span className="min-w-0 flex-1 truncate text-neutral-600">{open ? "" : text}</span>
      </button>
      {open ? <div className="whitespace-pre-wrap break-words px-3 pb-2.5 text-[11px] leading-relaxed text-neutral-400">{text}</div> : null}
    </div>
  );
};

/** 工具调用卡片:进行中转圈;完成后可展开参数/结果。 */
const ToolCallCard: FC<{
  toolName: string;
  argsText?: string;
  result?: unknown;
  isError?: boolean;
  zh: boolean;
}> = ({ toolName, argsText, result, isError, zh }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const running = result === undefined && !isError;
  const resultText = typeof result === "string" ? result : result == null ? "" : JSON.stringify(result, null, 2);
  return (
    <div className={`rounded-lg border ${isError ? "border-rose-400/25 bg-rose-500/[0.06]" : "border-white/[0.08] bg-white/[0.03]"}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px]"
      >
        {running ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-cyan-300" />
        ) : isError ? (
          <TriangleAlert className="h-3 w-3 shrink-0 text-rose-300" />
        ) : (
          <Check className="h-3 w-3 shrink-0 text-emerald-300" />
        )}
        <Wrench className="h-3 w-3 shrink-0 text-neutral-500" />
        <span className="font-mono text-neutral-300">{toolName}</span>
        <span className="ml-auto flex items-center gap-1 text-neutral-600">
          {running ? (zh ? "运行中" : "running") : null}
          <ChevronRight className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
        </span>
      </button>
      {open ? (
        <div className="space-y-1.5 px-2.5 pb-2">
          {argsText && argsText !== "{}" ? (
            <pre className="prompt-editor-scroll max-h-[140px] overflow-auto whitespace-pre-wrap break-all rounded-md bg-black/30 p-2 font-mono text-[10px] leading-relaxed text-neutral-400">{argsText}</pre>
          ) : null}
          {!running && resultText ? (
            <div className="relative">
              <pre className={`prompt-editor-scroll max-h-[180px] overflow-auto whitespace-pre-wrap break-all rounded-md p-2 font-mono text-[10px] leading-relaxed ${isError ? "bg-rose-950/30 text-rose-200" : "bg-black/30 text-neutral-300"}`}>{resultText}</pre>
              <button
                type="button"
                title={zh ? "复制结果" : "Copy result"}
                onClick={() => {
                  void navigator.clipboard?.writeText(resultText).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1200);
                  });
                }}
                className="absolute right-1.5 top-1.5 rounded p-1 text-neutral-500 transition hover:bg-white/10 hover:text-white"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-300" /> : <Copy className="h-3 w-3" />}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

function makeAssistantMessage(zh: boolean): FC {
  return function AssistantMessage() {
    return (
      <MessagePrimitive.Root className="flex justify-start">
        <div className="w-full max-w-full space-y-2 text-[13px] leading-relaxed text-neutral-200">
          <MessagePrimitive.Parts
            components={{
              Text: () => <MarkdownTextPrimitive components={MD_COMPONENTS} />,
              Reasoning: ({ text }) => <ReasoningBlock text={text} zh={zh} />,
              tools: {
                Fallback: (part) => (
                  <ToolCallCard
                    toolName={part.toolName}
                    argsText={part.argsText}
                    result={part.result}
                    isError={part.isError}
                    zh={zh}
                  />
                ),
              },
            }}
          />
        </div>
      </MessagePrimitive.Root>
    );
  };
}

export function AgentAssistantThread({
  zh,
  history,
  runSteps,
  streamingReply,
  running,
  onSend,
  footer,
}: {
  zh: boolean;
  history: AgentConversationTurn[];
  runSteps: ThreadRunStep[];
  streamingReply: string;
  running: boolean;
  /** aui composer 未启用,但 runtime 需要 onNew;转发到面板的 start()。 */
  onSend: (text: string) => void;
  /** 渲染在消息之后的交互卡片区(ask_user / 待确认生成 / 画布操作 / 错误)。 */
  footer?: ReactNode;
}) {
  const messages = useMemo(
    () => buildMessages(history, runSteps, streamingReply, running),
    [history, runSteps, streamingReply, running],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async (message) => {
      const part = message.content[0];
      if (part?.type === "text") onSend(part.text);
    },
  });

  const AssistantMessage = useMemo(() => makeAssistantMessage(zh), [zh]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col" onWheel={(e) => e.stopPropagation()}>
        {/* min-h-0:flex 子项默认 min-height:auto,长内容会把线程区撑高、把
            composer 顶出面板 —— 必须显式允许收缩,让滚动发生在视口内。 */}
        <ThreadPrimitive.Viewport className="prompt-editor-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div data-aui-messages className="space-y-3">
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </div>
          {running && runSteps.length === 0 && !streamingReply ? (
            <div className="flex items-center gap-2 text-xs text-cyan-300">
              <Loader2 className="h-3 w-3 animate-spin" />
              {zh ? "思考中…" : "Thinking…"}
            </div>
          ) : null}
          {footer}
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ScrollToBottom asChild>
          <button
            type="button"
            title={zh ? "回到底部" : "Scroll to bottom"}
            className="absolute bottom-3 left-1/2 z-10 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-white/15 bg-[#1a1d23] text-neutral-300 shadow-lg transition hover:bg-[#23272e] hover:text-white disabled:hidden"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        </ThreadPrimitive.ScrollToBottom>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
