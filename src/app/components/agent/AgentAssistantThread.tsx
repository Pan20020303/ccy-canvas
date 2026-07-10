/**
 * 智能体消息线程 —— assistant-ui 驱动。
 *
 * 用 @assistant-ui/react 的 ExternalStoreRuntime 把面板既有状态
 * (历史轮次 + 当前运行的 思考/工具调用/流式文本)映射成结构化消息 parts:
 *   - thought      → reasoning part(可折叠的「思考」块)
 *   - tool_call    → tool-call part(工具卡片;连续多个自动折叠成工具组)
 *   - 流式回复      → text part(GFM markdown 渲染)
 *   - 附图          → image part(点击放大)
 * 另提供:线程列表(ThreadListPrimitive,历史会话切换)、选中文本引用
 * (SelectionToolbarPrimitive)、DotMatrix 状态点阵、消息悬浮复制。
 *
 * 结构:面板层用 useAgentThreadRuntime 建 runtime,再用 AssistantRuntimeProvider
 * 包住 <AgentThreadList>(侧栏)与 <AgentThread>(视口)—— 两者共享同一 runtime。
 * 交互型卡片(ask_user / pending_run / canvas / error)不进消息流,经 footer 插槽
 * 渲染在消息之后。
 */
import { createContext, useContext, useEffect, useMemo, useState, type FC, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ActionBarPrimitive,
  MessagePrimitive,
  SelectionToolbarPrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  ThreadPrimitive,
  groupPartByType,
  useExternalStoreRuntime,
  useMessage,
  useThreadListItemRuntime,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, Check, ChevronRight, Copy, MessageSquareQuote, Plus, TriangleAlert, Trash2, Wrench, X } from "lucide-react";

import { DotMatrix } from "./ui/dot-matrix";
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
    content: [
      // 附图(引用的画布节点等)在文本之前显示。
      ...(turn.images ?? []).map((url) => ({ type: "image" as const, image: url })),
      { type: "text" as const, text: turn.content },
    ],
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

/** 渲染前归一化模型输出:
 *  - `<br>`(模型在表格单元格里常用)→ 表格行内换成空格(GFM 表格必须单行,
 *    换行会拆断表格);普通行换成真换行。react-markdown 默认不渲染 raw HTML,
 *    不处理的话 `<br>` 会以字面文本吐出来。 */
function normalizeAgentMarkdown(text: string): string {
  if (!text.includes("<br")) return text;
  return text
    .split("\n")
    .map((line) => line.replace(/<br\s*\/?>/gi, line.includes("|") ? " " : "\n"))
    .join("\n");
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
  img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
    // eslint-disable-next-line jsx-a11y/alt-text
    <img className="my-1 max-w-full rounded-lg border border-white/10" loading="lazy" {...props} />
  ),
  // 宽表格(分镜表 7+ 列)在窄面板里横向滚动,不撑破消息区。
  table: (props: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="prompt-editor-scroll mb-2 overflow-x-auto">
      <table className="w-max min-w-full border-collapse text-[11px]" {...props} />
    </div>
  ),
  th: (props: React.ThHTMLAttributes<HTMLTableCellElement>) => <th className="border border-white/10 bg-white/[0.04] px-2 py-1 text-left" {...props} />,
  td: (props: React.TdHTMLAttributes<HTMLTableCellElement>) => <td className="border border-white/10 px-2 py-1" {...props} />,
};

/** 消息里的图片 part:圆角缩略图,点击放大(portal 全屏灯箱)。 */
const ImagePartView: FC<{ image: string; alt?: string }> = ({ image, alt }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group/img relative mb-1.5 block max-w-[220px] overflow-hidden rounded-xl border border-white/10 transition hover:border-white/25"
        title={alt || ""}
      >
        <img src={image} alt={alt || ""} loading="lazy" className="block max-h-[180px] w-full object-cover transition group-hover/img:scale-[1.02]" />
      </button>
      {open
        ? createPortal(
            <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/85 p-8 backdrop-blur-sm" onClick={() => setOpen(false)}>
              <img src={image} alt={alt || ""} className="max-h-full max-w-full rounded-xl shadow-2xl" />
              <button type="button" className="absolute right-4 top-4 rounded-full border border-white/15 bg-black/50 p-2 text-neutral-300 hover:text-white" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
};

/** 健壮复制:clipboard API 需要 secure context(https/localhost),局域网 http
 *  访问时静默失败 —— 退回隐藏 textarea + execCommand,两条路都保证有反馈。 */
async function copyTextRobust(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** 悬浮复制条(DeepSeek 式):hover 消息时浮现,点击复制整条消息文本,
 *  1.5s 内图标切成 ✓。运行中隐藏(避免复制半截流式内容)。
 *  不用 ActionBarPrimitive.Copy —— 它依赖 clipboard API,http 环境点了没反应。 */
const MessageActionBar: FC<{ align: "start" | "end"; zh: boolean }> = ({ align, zh }) => {
  const [copied, setCopied] = useState(false);
  const getText = useMessage((m) =>
    m.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n\n"),
  );
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      className={`mt-1 flex items-center opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100 ${align === "end" ? "justify-end" : ""}`}
    >
      <button
        type="button"
        title={zh ? "复制" : "Copy"}
        onClick={() => {
          void copyTextRobust(getText).then((ok) => {
            if (ok) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }
          });
        }}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-neutral-500 transition hover:bg-white/10 hover:text-neutral-200"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        {copied ? <span className="text-emerald-400">{zh ? "已复制" : "Copied"}</span> : <span>{zh ? "复制" : "Copy"}</span>}
      </button>
    </ActionBarPrimitive.Root>
  );
};

function makeUserMessage(zh: boolean): FC {
  return function UserMessage() {
    return (
      <MessagePrimitive.Root className="group/msg flex flex-col items-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-white/10 px-3.5 py-2 text-[13px] leading-relaxed text-neutral-100">
          <MessagePrimitive.Parts
            components={{
              Image: ({ image }) => <ImagePartView image={image} />,
            }}
          />
        </div>
        <MessageActionBar align="end" zh={zh} />
      </MessagePrimitive.Root>
    );
  };
}

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
          <DotMatrix state="loading" className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
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

/** 工具组(assistant-ui ToolGroup 式):连续 ≥2 个工具调用折叠成一组,
 *  运行中自动展开并显示点阵动画,结束后可收起。 */
const ToolGroupBlock: FC<{ count: number; running: boolean; zh: boolean; children: ReactNode }> = ({ count, running, zh, children }) => {
  const [open, setOpen] = useState(running);
  // 流式期间自动展开(官方 ToolGroup 的 auto-expand 行为)。
  useEffect(() => { if (running) setOpen(true); }, [running]);
  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-neutral-400 transition hover:text-neutral-200"
      >
        {running ? (
          <DotMatrix state="loading" className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
        ) : (
          <Wrench className="h-3 w-3 shrink-0 text-neutral-500" />
        )}
        <span>{zh ? `${count} 个工具调用` : `${count} tool calls`}</span>
        <ChevronRight className={`ml-auto h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open ? <div className="space-y-1.5 px-1.5 pb-1.5">{children}</div> : null}
    </div>
  );
};

// 连续 tool-call 归入 "group-tool" 组(assistant-ui 官方 ToolGroup 模式)。
const groupToolCalls = groupPartByType({ "tool-call": ["group-tool"] });

function makeAssistantMessage(zh: boolean): FC {
  return function AssistantMessage() {
    return (
      <MessagePrimitive.Root className="group/msg flex flex-col items-start">
        <div className="w-full max-w-full space-y-2 text-[13px] leading-relaxed text-neutral-200">
          <MessagePrimitive.GroupedParts groupBy={groupToolCalls}>
            {({ part, children }) => {
              switch (part.type) {
                case "group-tool":
                  // 单个工具直接平铺;≥2 个折叠成工具组。
                  if (part.indices.length < 2) return <>{children}</>;
                  return (
                    <ToolGroupBlock count={part.indices.length} running={part.status.type === "running"} zh={zh}>
                      {children}
                    </ToolGroupBlock>
                  );
                case "text":
                  return (
                    <MarkdownTextPrimitive
                      // GFM:管道表格/删除线/任务列表(分镜表就是管道表格,不开就渲染成原文)。
                      remarkPlugins={[remarkGfm]}
                      preprocess={normalizeAgentMarkdown}
                      // 长流式内容降优先级解析,打字/滚动不被逐 token 重排卡住。
                      defer
                      components={MD_COMPONENTS}
                    />
                  );
                case "reasoning":
                  return <ReasoningBlock text={(part as { text: string }).text} zh={zh} />;
                case "image":
                  return <ImagePartView image={(part as { image: string }).image} />;
                case "tool-call": {
                  const tc = part as { toolName: string; argsText?: string; result?: unknown; isError?: boolean };
                  return <ToolCallCard toolName={tc.toolName} argsText={tc.argsText} result={tc.result} isError={tc.isError} zh={zh} />;
                }
                default:
                  return null;
              }
            }}
          </MessagePrimitive.GroupedParts>
        </div>
        <MessageActionBar align="start" zh={zh} />
      </MessagePrimitive.Root>
    );
  };
}

/** 选中文本引用按钮(SelectionToolbar 内):把选中内容交给面板 composer。
 *  Root 已保证选区在单条消息内且 mousedown 不清除选区 —— 点击时直接读选区即可。 */
const QuoteSelectionButton: FC<{ zh: boolean; onQuote: (text: string) => void }> = ({ zh, onQuote }) => (
  <button
    type="button"
    onClick={() => {
      const text = window.getSelection()?.toString() ?? "";
      if (text.trim()) {
        onQuote(text);
        window.getSelection()?.removeAllRanges();
      }
    }}
    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] text-neutral-200 transition hover:bg-white/10"
  >
    <MessageSquareQuote className="h-3.5 w-3.5 text-cyan-300" />
    {zh ? "引用" : "Quote"}
  </button>
);

// ─── runtime + 视口 + 线程列表(供面板组装)────────────────────────────────────

export function useAgentThreadRuntime({
  history,
  runSteps,
  streamingReply,
  running,
  onSend,
  threadList,
}: {
  history: AgentConversationTurn[];
  runSteps: ThreadRunStep[];
  streamingReply: string;
  running: boolean;
  onSend: (text: string) => void;
  /** 会话列表适配器:threads/threadId/onSwitchToThread/onSwitchToNewThread/onDelete。 */
  threadList?: ExternalStoreThreadListAdapter;
}) {
  const messages = useMemo(
    () => buildMessages(history, runSteps, streamingReply, running),
    [history, runSteps, streamingReply, running],
  );

  return useExternalStoreRuntime({
    messages,
    isRunning: running,
    convertMessage: (m: ThreadMessageLike) => m,
    onNew: async (message) => {
      const part = message.content[0];
      if (part?.type === "text") onSend(part.text);
    },
    adapters: threadList ? { threadList } : undefined,
  });
}

/** 历史会话列表(assistant-ui ThreadList):新建/切换/删除,当前会话高亮。
 *  必须渲染在 AssistantRuntimeProvider 内。 */
export function AgentThreadList({ zh }: { zh: boolean }) {
  return (
    <ThreadListPrimitive.Root className="flex w-[172px] shrink-0 flex-col gap-1.5 border-r border-[var(--agent-border)] bg-white/[0.015] p-2">
      <ThreadListPrimitive.New asChild>
        <button
          type="button"
          className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/15 px-2 py-1.5 text-[11px] text-neutral-400 transition hover:border-white/30 hover:bg-white/[0.04] hover:text-white"
        >
          <Plus className="h-3 w-3" />
          {zh ? "新对话" : "New chat"}
        </button>
      </ThreadListPrimitive.New>
      <div className="prompt-editor-scroll min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        <ThreadListPrimitive.Items components={{ ThreadListItem: AgentThreadListItem }} />
      </div>
    </ThreadListPrimitive.Root>
  );
}

const AgentThreadListItem: FC = () => {
  // 直接调 runtime 的 delete —— ThreadListItemPrimitive.Delete 受 capability
  // gate 影响,ExternalStore 下可能整个不渲染/无响应。
  const itemRuntime = useThreadListItemRuntime();
  return (
    <ThreadListItemPrimitive.Root className="group/thread flex items-center gap-1 rounded-lg px-1 transition hover:bg-white/[0.05] data-[active]:bg-white/[0.08]">
      <ThreadListItemPrimitive.Trigger asChild>
        <button type="button" className="min-w-0 flex-1 truncate px-1 py-1.5 text-left text-[11px] text-neutral-300">
          <ThreadListItemPrimitive.Title fallback="新对话" />
        </button>
      </ThreadListItemPrimitive.Trigger>
      <button
        type="button"
        title="删除会话"
        onClick={() => { void itemRuntime.delete(); }}
        className="shrink-0 rounded p-1 text-neutral-600 opacity-0 transition hover:bg-rose-500/15 hover:text-rose-300 group-hover/thread:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </ThreadListItemPrimitive.Root>
  );
};

// 面板层可用的 activeConversation 上下文(备用;aui data-active 不生效时可切换)。
export const ActiveThreadContext = createContext<string | null>(null);
export const useActiveThread = () => useContext(ActiveThreadContext);

export function AgentThread({
  zh,
  runSteps,
  streamingReply,
  running,
  onQuote,
  footer,
}: {
  zh: boolean;
  runSteps: ThreadRunStep[];
  streamingReply: string;
  running: boolean;
  /** 选中消息文本 → 引用到 composer。 */
  onQuote?: (text: string) => void;
  /** 渲染在消息之后的交互卡片区(ask_user / 待确认生成 / 画布操作 / 错误)。 */
  footer?: ReactNode;
}) {
  const AssistantMessage = useMemo(() => makeAssistantMessage(zh), [zh]);
  const UserMessage = useMemo(() => makeUserMessage(zh), [zh]);

  return (
    <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col" onWheel={(e) => e.stopPropagation()}>
      <ThreadPrimitive.Viewport className="prompt-editor-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div data-aui-messages className="space-y-3">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </div>
        {running && runSteps.length === 0 && !streamingReply ? (
          <div className="flex items-center gap-2 text-xs text-cyan-300">
            <DotMatrix state="thinking" className="h-4 w-4" />
            {zh ? "思考中…" : "Thinking…"}
          </div>
        ) : null}
        {footer}
      </ThreadPrimitive.Viewport>
      {/* 选中消息文本 → 浮出「引用」工具条。 */}
      {onQuote ? (
        <SelectionToolbarPrimitive.Root className="z-[80] rounded-xl border border-white/15 bg-[#1a1d23]/95 p-0.5 shadow-2xl backdrop-blur">
          <QuoteSelectionButton zh={zh} onQuote={onQuote} />
        </SelectionToolbarPrimitive.Root>
      ) : null}
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
  );
}
