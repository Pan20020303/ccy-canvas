// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { AgentThread, AgentThreadList, useAgentThreadRuntime, type ThreadRunStep } from "./AgentAssistantThread";
import type { AgentConversationTurn } from "../agent-conversation";
import { conversationTurnsFromHistoryItems } from "../agent-conversation";
import type { AgentTaskProgressState } from "./task-progress";

const emptyHistory: AgentConversationTurn[] = [];
function Harness({ history = emptyHistory, reply = "", threadId, running = false, runSteps = [], draft = "", onEdit, showList = false, progress }: {
  history?: AgentConversationTurn[];
  reply?: string;
  threadId?: string;
  running?: boolean;
  runSteps?: ThreadRunStep[];
  draft?: string;
  onEdit?: (index: number, text: string) => void;
  showList?: boolean;
  progress?: AgentTaskProgressState;
}) {
  const runtime = useAgentThreadRuntime({
    history, runSteps, streamingReply: reply, running, onSend: () => {}, progress,
    threadList: { threadId, threads: threadId ? [{ id: threadId, status: "regular", title: threadId }] : [] },
  });
  return <AssistantRuntimeProvider runtime={runtime}>
    {showList ? <AgentThreadList zh /> : null}
    <AgentThread zh runSteps={runSteps} streamingReply={reply} running={running} onEditUserMessage={onEdit} progress={progress} />
    <input aria-label="draft" value={draft} readOnly />
  </AssistantRuntimeProvider>;
}

describe("agent messages with the real assistant runtime", () => {
  let host: HTMLDivElement;
  let root: Root;
  let previousScrollTo: PropertyDescriptor | undefined;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    previousScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: vi.fn(), configurable: true });
    vi.spyOn(console, "error");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (previousScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", previousScrollTo);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    const errors = vi.mocked(console.error).mock.calls;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    expect(errors).toEqual([]);
  });
  it("renders a new conversation, streamed reply and final history without losing messages", async () => {
    await act(async () => root.render(<Harness />));
    const history: AgentConversationTurn[] = [{ role: "user", content: "你好", images: [] }];
    await act(async () => root.render(<Harness threadId="chat-1" history={history} running />));
    expect(host.querySelector("[data-aui-messages]")?.textContent).toContain("你好");
    await act(async () => root.render(<Harness threadId="chat-1" history={history} reply="你好！有什么可以帮你？" running />));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(host.textContent).toContain("你好！有什么可以帮你？");
    await act(async () => root.render(<Harness threadId="chat-1" history={[...history, { role: "assistant", content: "你好！有什么可以帮你？" }]} />));
    expect(host.textContent).toContain("你好！有什么可以帮你？");
    expect(host.querySelector("[data-aui-messages]")?.children.length).toBe(2);
    expect(Array.from(host.querySelectorAll('[data-message-id]')).map(el => el.getAttribute('data-message-id'))).toEqual(['h-0', 'h-1']);
    expect(host.querySelector('[data-message-id="h-0"]')!.compareDocumentPosition(host.querySelector('[data-message-id="h-1"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('restores an old referenced video as a playable attachment and keeps it while editing', async () => {
    const history=conversationTurnsFromHistoryItems([{user_input:'（参考画布节点：15.mp4#video-1）\n（参考图片：https://example.com/15.mp4）\n分析一下这个视频', final_reply:'收到'}]);
    const onEdit=vi.fn();
    await act(async()=>root.render(<StrictMode><Harness threadId="video" history={history} onEdit={onEdit}/></StrictMode>));
    const user=host.querySelector('[data-message-id="h-0"]')!;
    expect(user.querySelector('img')).toBeNull();
    const video=user.querySelector('video')!;
    expect(video).not.toBeNull();
    expect(video.controls).toBe(true);
    expect(video.autoplay).toBe(false);
    expect(video.src).toContain(encodeURIComponent('https://example.com/15.mp4'));
    expect(user.textContent).toContain('15.mp4');
    await act(async()=> (user.querySelector('button[title="编辑并重发"]') as HTMLButtonElement).click());
    expect(user.querySelector('video')).toBe(video);
    expect(user.querySelector('textarea')?.value).toBe('分析一下这个视频');
    await act(async()=> (Array.from(user.querySelectorAll('button')).find(button=>button.textContent==='放入输入框重发') as HTMLButtonElement).click());
    expect(onEdit).toHaveBeenCalledWith(0,'分析一下这个视频');
    await act(async()=> video.dispatchEvent(new Event('error')));
    expect(user.textContent).toContain('暂时无法预览');
    expect(user.querySelector('a')?.textContent).toBe('打开视频');
  });

  it("keeps saved images, copying and editing usable during composer rerenders", async () => {
    const history: AgentConversationTurn[] = [
      { role: "user", content: "用这张参考图", images: ["/uploads/test-reference.png"] },
      { role: "assistant", content: "**收到图片**，请确认参数。" },
    ];
    const onEdit = vi.fn();
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: copy }, configurable: true });
    await act(async () => root.render(<StrictMode><Harness threadId="saved" history={history} onEdit={onEdit} /></StrictMode>));
    for (const draft of ["你", "你好", "你好继续"]) {
      await act(async () => root.render(<StrictMode><Harness threadId="saved" history={history} onEdit={onEdit} draft={draft} /></StrictMode>));
    }
    const user = host.querySelector('[data-message-id="h-0"]')!;
    expect(user.textContent).toContain("用这张参考图");
    expect(user.querySelector("img")?.getAttribute("src")).toContain("test-reference.png");
    expect(host.querySelector("strong")?.textContent).toBe("收到图片");
    await act(async () => (user.querySelector('button[title="复制"]') as HTMLButtonElement).click());
    expect(copy).toHaveBeenCalledWith("用这张参考图");
    await act(async () => (user.querySelector('button[title="编辑并重发"]') as HTMLButtonElement).click());
    expect(user.querySelector("textarea")?.value).toBe("用这张参考图");
    const applyEdit = Array.from(user.querySelectorAll("button")).find((button) => button.textContent === "放入输入框重发")!;
    await act(async () => applyEdit.click());
    expect(onEdit).toHaveBeenCalledWith(0, "用这张参考图");
    expect(history[0].images).toEqual(["/uploads/test-reference.png"]);
  });

  it("switches to an empty conversation and restores the correct saved history", async () => {
    const first: AgentConversationTurn[] = [{ role: "user", content: "第一个画布的问题" }, { role: "assistant", content: "第一个画布的回复" }];
    const second: AgentConversationTurn[] = [{ role: "user", content: "第二个画布的问题" }];
    await act(async () => root.render(<Harness threadId="canvas-one" history={first} showList />));
    expect(host.textContent).toContain("第一个画布的回复");
    await act(async () => root.render(<Harness showList />));
    expect(host.querySelector("[data-aui-messages]")?.textContent).toBe("");
    await act(async () => root.render(<Harness threadId="canvas-two" history={second} showList />));
    expect(host.textContent).toContain("第二个画布的问题");
    expect(host.textContent).not.toContain("第一个画布的问题");
    await act(async () => root.render(<Harness threadId="canvas-one" history={first} showList />));
    expect(host.textContent).toContain("第一个画布的回复");
    expect(host.textContent).not.toContain("第二个画布的问题");
  });

  it("keeps the streamed answer visible when a late tool step is inserted", async () => {
    const history: AgentConversationTurn[] = [{ role: "user", content: "读取画布" }];
    await act(async () => root.render(<Harness threadId="tools" history={history} reply="正在读取画布" running />));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(host.textContent).toContain("正在读取画布");
    const steps: ThreadRunStep[] = [{ kind: "tool", id: "step-1", invocation: { id: "call-1", name: "read_canvas", args: "{}", status: "success", output: "完成" } }];
    await act(async () => root.render(<Harness threadId="tools" history={history} reply="正在读取画布" running runSteps={steps} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(host.textContent).toContain("正在读取画布");
    expect(host.textContent).toContain("查看画布概况");
    expect(host.textContent).not.toContain("read_canvas");
  });

  it("shows one public progress card while keeping private reasoning and tool payloads out of the DOM", async () => {
    const history: AgentConversationTurn[] = [{ role: "user", content: "整理第三集分镜" }];
    const progress: AgentTaskProgressState = {
      status: "running", summary: "先确认素材，再整理分镜。",
      steps: [{ id: "a", title: "确认角色素材", status: "completed" }, { id: "b", title: "整理分镜节点", status: "in_progress" }],
      activities: [{ id: "read", status: "completed", label: "已读取第三集角色素材" }],
    };
    const runSteps: ThreadRunStep[] = [
      { kind: "thought", id: "private", content: "Let me think through the hidden private strategy." },
      { kind: "tool", id: "raw", invocation: { id: "call", name: "read_node", args: '{"token":"private-secret"}', output: "private-output", status: "success" } },
    ];
    await act(async () => root.render(<StrictMode><Harness history={history} running progress={progress} runSteps={runSteps} /></StrictMode>));
    expect(host.querySelectorAll('[data-task-progress]')).toHaveLength(1);
    expect(host.textContent).toContain("整理分镜节点");
    expect(host.textContent).not.toMatch(/hidden private|private-secret|private-output|read_node|思维链|正在理解你的请求/);
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain("整理分镜节点");
    const finished = { ...progress, status: "completed" as const };
    await act(async () => root.render(<Harness history={[...history, {role:"assistant",content:"分镜已整理",progress:finished}]} running runSteps={runSteps}/>));
    expect(host.querySelectorAll('[data-task-progress]')).toHaveLength(1);
    expect(host.textContent).toContain("本轮已结束");
  });
});
