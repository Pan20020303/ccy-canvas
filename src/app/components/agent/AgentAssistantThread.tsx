/**
 * 智能体消息线程 —— assistant-ui 驱动。
 *
 * 用 @assistant-ui/react 的 ExternalStoreRuntime 把面板既有状态
 * (历史轮次 + 公开任务进度 + 流式文本)映射成结构化消息：
 *   - plan/progress → 单一中文进度卡，原始推理与工具参数不进入消息内容
 *   - 旧工具日志    → 白名单中文活动摘要，不展示原始入参/结果
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
import { createContext, useContext, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ActionBarPrimitive,
  MessagePrimitive,
  SelectionToolbarPrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  ThreadPrimitive,
  groupPartByType,
  useAssistantDataUI,
  useExternalStoreRuntime,
  useMessage,
  useThreadListItem,
  useThreadListItemRuntime,
  type ExternalStoreAdapter,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, Check, Copy, Film, MessageSquareQuote, Pencil, Plus, Trash2, X } from "lucide-react";

import { DotMatrix } from "./ui/dot-matrix";
import type { AgentConversationTurn, AgentVideoReference } from "../agent-conversation";
import { runStepsToThreadParts, type CanvasOperationPart } from "../../agent-timeline";
import { CanvasOperationIcon, presentCanvasOperation } from "./canvas-operation-presenter";
import { toRenderableMediaUrl } from "../../reference-media";
import { withStableThreadListSnapshot } from "./stable-assistant-runtime";
import { AgentTaskProgress } from "./AgentTaskProgress";
import { hasVisibleTaskProgress, legacyToolProgress, type AgentTaskProgressState } from "./task-progress";

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
export type ThreadThoughtStep = { kind: "thought"; id: string; content: string; streaming?: boolean };
export type ThreadRunStep =
  | ThreadToolStep
  | ThreadThoughtStep
  | { kind: string; id: string; [key: string]: unknown };

const EMPTY_RUN_STEPS: ThreadRunStep[] = [];
const convertThreadMessage = (message: ThreadMessageLike) => message;
const groupPublicParts = groupPartByType({});

/** 把面板状态映射成 assistant-ui 的 ThreadMessageLike 列表。 */
export function buildAgentThreadMessages(
  history: AgentConversationTurn[],
  runSteps: ThreadRunStep[],
  streamingReply: string,
  running: boolean,
  zh = true,
  progress?: AgentTaskProgressState,
): ThreadMessageLike[] {
  const messages: ThreadMessageLike[] = history.map((turn, index) => ({
    id: `h-${index}`,
    role: turn.role,
    metadata: { custom: { videos: turn.videos ?? [], progress: turn.progress ?? legacyToolProgress(turn.toolCalls ?? [], false) } },
    content: [
      // 附图(引用的画布节点等)在文本之前显示。
      ...(turn.images ?? []).map((url) => ({ type: "image" as const, image: url })),
      { type: "text" as const, text: turn.content },
    ],
  }));

  // 当前进度与回复保持独立、稳定的消息标识。
  // Keep the live execution timeline separate from the streamed reply.
  // assistant-ui keys leaf parts by their array index. A late tool call used to be
  // inserted before an already-mounted text part, which made the text renderer
  // observe a tool-call context and throw `MessagePartText can only be used...`.
  //
  // 仅为旧后端保留画布操作卡；新公开进度把操作集中到一张卡。
  const alreadySaved = !progress && !streamingReply && history.at(-1)?.role === "assistant" && !!history.at(-1)?.progress;
  const timelineParts = runStepsToThreadParts(progress || alreadySaved ? [] : runSteps.filter(step => step.kind === "canvas"), presentCanvasOperation, zh) as Exclude<
    ThreadMessageLike["content"],
    string
  >[number][];
  const visibleProgress = alreadySaved ? undefined : progress ?? legacyToolProgress(runSteps.filter((step): step is ThreadToolStep => step.kind === "tool" && "invocation" in step).map(step => step.invocation), running);
  if (timelineParts.length > 0 || hasVisibleTaskProgress(visibleProgress)) {
    const runMessage: ThreadMessageLike = {
      id: "current-run-steps",
      role: "assistant",
      content: timelineParts.length ? timelineParts : [{ type: "text", text: "" }],
      metadata: { custom: { progress: visibleProgress } },
    };
    // 时序修正:运行结束后最终回复已作为最后一条 assistant 历史存在,
    // 任务进度应插在它「之前」；运行中则排在最后。
    const last = messages[messages.length - 1];
    if (!running && !streamingReply && last?.role === "assistant") {
      messages.splice(messages.length - 1, 0, runMessage);
    } else {
      messages.push(runMessage);
    }
  }
  // The reply has its own stable message/part identity. Tool events can now arrive
  // at any time without changing the type of the mounted Markdown text part.
  if (streamingReply) {
    messages.push({
      id: "current-run-reply",
      role: "assistant",
      content: [{ type: "text", text: streamingReply }],
    });
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
  // break-words:超长连续字符(URL/无空格提示词)强制换行,决不把消息区
  // 往右平铺;真正的宽内容(表格/代码块)各自带横向滚动容器。
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => <p className="mb-2 break-words last:mb-0" {...props} />,
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => <ul className="mb-2 list-disc pl-5 last:mb-0" {...props} />,
  ol: (props: React.OlHTMLAttributes<HTMLOListElement>) => <ol className="mb-2 list-decimal pl-5 last:mb-0" {...props} />,
  li: (props: React.LiHTMLAttributes<HTMLLIElement>) => <li className="mb-0.5 break-words" {...props} />,
  h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h1 className="mb-2 mt-3 text-[15px] font-semibold first:mt-0" {...props} />,
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h2 className="mb-1.5 mt-2.5 text-[14px] font-semibold first:mt-0" {...props} />,
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h3 className="mb-1 mt-2 text-[13px] font-semibold first:mt-0" {...props} />,
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a className="text-cyan-300 underline decoration-cyan-300/40 underline-offset-2 hover:text-cyan-200" target="_blank" rel="noreferrer" {...props} />,
  blockquote: (props: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => <blockquote className="mb-2 border-l-2 border-white/15 pl-3 text-neutral-400" {...props} />,
  // overflow-wrap:anywhere:正常单词仍在空格处折行(不从单词中间断),
  // 只有超过整行宽的无空格长串才在必要处断 —— 决不向右溢出。
  // className 必须「合并」而不是被展开的 props 覆盖:aui 的代码块管线
  // (CodeOverride → withDefaultProps)总会传入 className(可能为空串),
  // 放在 {...props} 前面会被整个抹掉 —— 样式失效、代码块回到不折行。
  // 字体用微软雅黑:代码块里装的多是中文提示词/描述,等宽字体渲染中文
  // 既难看又费宽;雅黑在前、苹方/思源黑体兜底(非 Windows 环境)。
  code: ({ className, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <code className={`rounded bg-white/10 px-1 py-0.5 text-[12px] [font-family:'Microsoft_YaHei','微软雅黑','PingFang_SC','Noto_Sans_SC',sans-serif] [overflow-wrap:anywhere] ${className ?? ""}`} {...props} />
  ),
  // pre-wrap:模型常把提示词/描述写成缩进行,markdown 会当代码块(white-space:pre
  // 不折行,中文行直接被面板右缘截断)。保留缩进与换行、允许折行;单词不拆。
  pre: ({ className, ...props }: React.HTMLAttributes<HTMLPreElement>) => (
    <pre className={`mb-2 whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-black/40 p-2.5 text-[12px] leading-relaxed [font-family:'Microsoft_YaHei','微软雅黑','PingFang_SC','Noto_Sans_SC',sans-serif] [overflow-wrap:anywhere] [&>code]:bg-transparent [&>code]:p-0 ${className ?? ""}`} {...props} />
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
  const displayUrl = toRenderableMediaUrl(image, { thumbWidth: 720 });
  const fullUrl = toRenderableMediaUrl(image);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group/img relative mb-1.5 block max-w-[220px] overflow-hidden rounded-xl border border-white/10 transition hover:border-white/25"
        title={alt || ""}
      >
        <img src={displayUrl} alt={alt || ""} loading="lazy" className="block max-h-[180px] w-full object-cover transition group-hover/img:scale-[1.02]" />
      </button>
      {open
        ? createPortal(
            <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/85 p-8 backdrop-blur-sm" onClick={() => setOpen(false)}>
              <img src={fullUrl} alt={alt || ""} className="max-h-full max-w-full rounded-xl shadow-2xl" />
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

const VideoReferenceView: FC<{ video: AgentVideoReference; zh: boolean }> = ({video, zh}) => {
  const [failed, setFailed] = useState(false);
  const url = toRenderableMediaUrl(video.url);
  const name = video.name || (zh ? '参考视频' : 'Reference video');
  return <div className="mb-2 w-[260px] max-w-full overflow-hidden rounded-xl border border-white/15 bg-black/30" data-video-reference>
    {failed ? <div role="status" className="px-3 py-5 text-[11px] text-neutral-400">{zh ? '此视频暂时无法预览，可打开原视频查看。' : 'Preview unavailable. Open the original video below.'}</div>
      : <video src={url} controls playsInline preload="metadata" aria-label={name}
          poster={video.poster ? toRenderableMediaUrl(video.poster) : undefined}
          onError={() => setFailed(true)} className="block max-h-[180px] w-full bg-black object-contain" />}
    <div className="flex items-center gap-1.5 px-2.5 py-2 text-[11px] text-neutral-300">
      <Film size={13} className="shrink-0" /><span className="min-w-0 flex-1 truncate" title={name}>{name}</span>
      <a href={url} target="_blank" rel="noreferrer" className="shrink-0 text-cyan-300 hover:underline">{zh ? '打开视频' : 'Open video'}</a>
    </div>
  </div>;
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
const MessageActionBar: FC<{ align: "start" | "end"; zh: boolean; onEdit?: () => void }> = ({ align, zh, onEdit }) => {
  const [copied, setCopied] = useState(false);
  const getText = useMessage((m) =>
    m.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n\n"),
  );
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning={align === "start"}
      className={`mt-1 flex items-center transition-opacity duration-150 focus-within:opacity-100 ${align === "end" ? "justify-end opacity-100" : "opacity-0 group-hover/msg:opacity-100"}`}
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
      {onEdit ? (
        <button
          type="button"
          title={zh ? "编辑并重发" : "Edit and resend"}
          onClick={onEdit}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-neutral-500 transition hover:bg-white/10 hover:text-neutral-200"
        >
          <Pencil className="h-3 w-3" />
          <span>{zh ? "编辑" : "Edit"}</span>
        </button>
      ) : null}
    </ActionBarPrimitive.Root>
  );
};

function makeUserMessage(zh: boolean, onEditMessage?: (index: number, text: string) => void, getUserEditText?: (index: number) => string): FC {
  return function UserMessage() {
    const id = useMessage((m) => m.id);
    // useMessage subscribes through useSyncExternalStore: selectors must return
    // primitives here. An array (including m.content itself) can be a fresh
    // snapshot on each read and trigger React #185.
    const originalText = useMessage((m) => m.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("\n\n"));
    const imagesJson = useMessage((m) => JSON.stringify(m.content.filter((p): p is { type: "image"; image: string } => p.type === "image").map((p) => p.image)));
    const images = JSON.parse(imagesJson) as string[];
    const videosJson = useMessage(m => JSON.stringify(m.metadata.custom.videos ?? []));
    const videos = JSON.parse(videosJson) as AgentVideoReference[];
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(originalText);
    const historyIndex = /^h-(\d+)$/.exec(id ?? "")?.[1];
    return (
      <MessagePrimitive.Root className="group/msg flex flex-col items-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-white/10 px-3.5 py-2 text-[13px] leading-relaxed text-neutral-100">
          {videos.map((video,index) => <VideoReferenceView key={`${video.url}-${index}`} video={video} zh={zh} />)}
          {editing ? (
            <div className="min-w-[220px] space-y-2">
              {images.length ? <div className="flex flex-wrap gap-1.5">{images.map((image, index) => <ImagePartView key={`${image}-${index}`} image={image} />)}</div> : null}
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={4}
                autoFocus
                className="prompt-editor-scroll min-h-20 w-full resize-y rounded-lg border border-white/15 bg-black/25 p-2 text-[12px] text-neutral-100 outline-none focus:border-cyan-400/40"
              />
              <p className="text-[10px] text-neutral-500">{zh ? "原对话保留；修改后的内容会放入新对话输入框。" : "The original chat stays intact; the edit opens in a new chat."}</p>
              <div className="flex justify-end gap-2 text-[11px]">
                <button type="button" onClick={() => setEditing(false)} className="text-neutral-400 hover:text-white">{zh ? "取消" : "Cancel"}</button>
                <button
                  type="button"
                  disabled={!draft.trim() || historyIndex == null}
                  onClick={() => { if (historyIndex != null) { onEditMessage?.(Number(historyIndex), draft.trim()); setEditing(false); } }}
                  className="rounded-md bg-cyan-500/20 px-2 py-1 text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
                >{zh ? "放入输入框重发" : "Use in composer"}</button>
              </div>
            </div>
          ) : (
            <MessagePrimitive.Parts components={{ Image: ({ image }) => <ImagePartView image={image} /> }} />
          )}
        </div>
        <MessageActionBar align="end" zh={zh} onEdit={onEditMessage && historyIndex != null ? () => { setDraft(getUserEditText?.(Number(historyIndex)) ?? originalText); setEditing(true); } : undefined} />
      </MessagePrimitive.Root>
    );
  };
}

/**
 * 时间线里的画布变更卡。
 *
 * 呈现细节复用 canvas-operation-presenter（与面板底部的汇总卡同一套文案/图标），
 * 所以这里只负责排版，不重复实现"add_node 该显示成什么"。
 */
export function CanvasOpCard({ data }: { data: CanvasOperationPart["data"] }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-emerald-400/15 bg-emerald-500/[0.05] px-2.5 py-1.5">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/[0.05] text-emerald-300/80">
        <CanvasOperationIcon entity={data.entity as never} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1 text-[9px]">
          <span className="font-medium text-emerald-300/85">{data.action}</span>
          <span className="text-neutral-600">·</span>
          <span className="text-neutral-500">{data.detail}</span>
          {data.revision != null ? (
            <span className="rounded border border-white/10 px-1 text-neutral-500">rev {data.revision}</span>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-neutral-300" title={data.title}>
          {data.title}
        </span>
      </span>
    </div>
  );
}

function makeAssistantMessage(zh: boolean): FC {
  return function AssistantMessage() {
    const progressJson = useMessage(m => JSON.stringify(m.metadata.custom?.progress ?? null));
    const progress = useMemo(() => JSON.parse(progressJson) as AgentTaskProgressState | null, [progressJson]);
    const hasText = useMessage(m => m.content.some(part => part.type === "text" && part.text.trim().length > 0));
    // 注册画布变更卡的命名渲染器（assistant-ui 的官方 data-part 扩展点）。
    // 必须在消息组件内部注册：useAssistantDataUI 依赖 useAui() 上下文。
    useAssistantDataUI({
      name: "canvas-op",
      render: (props: { data?: CanvasOperationPart["data"] }) =>
        props?.data ? <CanvasOpCard data={props.data} /> : null,
    });
    return (
      // 气泡只在用户侧(DeepSeek 式):assistant 回复保持全宽平铺,阅读面积最大。
      <MessagePrimitive.Root className="group/msg flex flex-col items-start">
        <div className="w-full max-w-full space-y-2 text-[13px] leading-relaxed text-neutral-200">
            {progress && hasVisibleTaskProgress(progress) ? <AgentTaskProgress progress={progress} /> : null}
            <MessagePrimitive.GroupedParts groupBy={groupPublicParts}>
              {({ part }) => {
                switch (part.type) {
                  case "data":
                    // data part（含 canvas-op）由 useAssistantDataUI 注册的命名渲染器
                    // 负责渲染，见 makeAssistantMessage 里的 canvas-op 注册。
                    // 这里返回 null，避免与注册渲染器重复渲染出两张卡。
                    return null;
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
                  case "image":
                    return <ImagePartView image={(part as { image: string }).image} />;
                  // Internal reasoning and raw tool payloads are never user-facing.
                  case "reasoning":
                  case "tool-call":
                    return null;
                  default:
                    return null;
                }
              }}
            </MessagePrimitive.GroupedParts>
        </div>
        {hasText ? <MessageActionBar align="start" zh={zh} /> : null}
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
  progress,
}: {
  history: AgentConversationTurn[];
  runSteps: ThreadRunStep[];
  streamingReply: string;
  running: boolean;
  onSend: (text: string) => void;
  progress?: AgentTaskProgressState;
  /** 会话列表适配器:threads/threadId/onSwitchToThread/onSwitchToNewThread/onDelete。 */
  threadList?: ExternalStoreThreadListAdapter;
}) {
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const threadListRef = useRef(threadList);
  threadListRef.current = threadList;
  const threadListKey = JSON.stringify(threadList?.threads ?? null);
  const stableThreads = useMemo(() => threadList?.threads ? [...threadList.threads] : undefined, [threadListKey]);
  const stableThreadList = useMemo<ExternalStoreThreadListAdapter | undefined>(() => threadList ? ({
    threadId: threadList.threadId,
    isLoading: threadList.isLoading,
    threads: stableThreads,
    onSwitchToThread: (id) => threadListRef.current?.onSwitchToThread?.(id),
    onSwitchToNewThread: () => threadListRef.current?.onSwitchToNewThread?.(),
    onDelete: (id) => threadListRef.current?.onDelete?.(id),
  }) : undefined, [Boolean(threadList), threadList?.threadId, threadList?.isLoading, stableThreads]);
  const stableRunSteps = runSteps.length ? runSteps : EMPTY_RUN_STEPS;
  const messages = useMemo(
    () => buildAgentThreadMessages(history, stableRunSteps, streamingReply, running, true, progress),
    [history, stableRunSteps, streamingReply, running, progress],
  );
  // Keep the external-store adapter stable while the composer text changes.
  // Re-registering it on each keystroke can recursively notify assistant-ui's
  // thread list subscribers and crash React with error #185.
  const store = useMemo<ExternalStoreAdapter<ThreadMessageLike>>(() => ({
    messages,
    isRunning: running,
    convertMessage: convertThreadMessage,
    onNew: async (message) => {
      const part = message.content[0];
      if (part?.type === "text") onSendRef.current(part.text);
    },
    adapters: stableThreadList ? { threadList: stableThreadList } : undefined,
  }), [messages, running, stableThreadList]);
  const runtime = useExternalStoreRuntime(store);
  return useMemo(() => withStableThreadListSnapshot(runtime), [runtime]);
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
  const title = useThreadListItem((item) => item.title);
  // 删除前二次确认(portal 小弹窗):防误触,删了不可恢复。
  const [confirming, setConfirming] = useState(false);
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
        onClick={() => setConfirming(true)}
        className="shrink-0 rounded p-1 text-neutral-600 opacity-0 transition hover:bg-rose-500/15 hover:text-rose-300 group-hover/thread:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </button>
      {confirming
        ? createPortal(
            <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setConfirming(false)}>
              <div className="w-[300px] rounded-xl border border-white/12 bg-[#17191e] p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center gap-2 text-[13px] font-medium text-neutral-100">
                  <Trash2 className="h-3.5 w-3.5 text-rose-300" />
                  删除会话？
                </div>
                <div className="mt-1.5 truncate text-[11px] text-neutral-400">
                  「{title?.trim() || "新对话"}」的全部消息将被删除,不可恢复。
                </div>
                <div className="mt-3.5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    className="rounded-md border border-white/10 px-3 py-1.5 text-[11.5px] text-neutral-300 transition hover:bg-white/5 hover:text-white"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => { setConfirming(false); void itemRuntime.delete(); }}
                    className="rounded-md border border-rose-400/40 bg-rose-500/20 px-3 py-1.5 text-[11.5px] text-rose-100 transition hover:bg-rose-500/35"
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
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
  elapsedMs,
  onQuote,
  onEditUserMessage,
  getUserEditText,
  footer,
  progress,
}: {
  zh: boolean;
  runSteps: ThreadRunStep[];
  streamingReply: string;
  running: boolean;
  /** 当前运行的已耗时(ms)。运行中显示为读秒,置于「思考中…」上方。 */
  elapsedMs?: number | null;
  /** 选中消息文本 → 引用到 composer。 */
  onQuote?: (text: string) => void;
  onEditUserMessage?: (index: number, text: string) => void;
  getUserEditText?: (index: number) => string;
  /** 渲染在消息之后的交互卡片区(ask_user / 待确认生成 / 画布操作 / 错误)。 */
  footer?: ReactNode;
  progress?: AgentTaskProgressState;
}) {
  const AssistantMessage = useMemo(() => makeAssistantMessage(zh), [zh]);
  const UserMessage = useMemo(() => makeUserMessage(zh, onEditUserMessage, getUserEditText), [zh, onEditUserMessage, getUserEditText]);

  return (
    <ThreadPrimitive.Root className="relative flex min-h-0 min-w-0 flex-1 flex-col" onWheel={(e) => e.stopPropagation()}>
      {/* overflow-x-hidden:视口永不横滚 —— 超宽内容(表格/代码块)必须在
          自己的 overflow-x-auto 容器里滚,长文本一律换行。 */}
      <ThreadPrimitive.Viewport className="prompt-editor-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4">
        <div data-aui-messages className="space-y-3">
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </div>
        {running ? (
          <div className="mt-1 space-y-1">
            {elapsedMs != null ? (
              <div className="text-[10px] tabular-nums text-neutral-500">{(elapsedMs / 1000).toFixed(1)}s</div>
            ) : null}
            {!hasVisibleTaskProgress(progress) && runSteps.every(step => step.kind === "thought") && !streamingReply ? (
              <div className="flex items-center gap-2 text-xs text-cyan-300">
                <DotMatrix state="thinking" className="h-4 w-4" />
                {zh ? "正在理解你的请求…" : "Preparing your response…"}
              </div>
            ) : null}
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
