// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTaskProgress } from "./AgentTaskProgress";
import { completedTaskLabel, finishAgentTaskProgress, hasVisibleTaskProgress, updateAgentTaskProgress, type AgentTaskProgressState } from "./task-progress";

const plan: AgentTaskProgressState = {
  steps: [
    { id: "assets", title: "确认参考素材", status: "completed" },
    { id: "video", title: "准备视频生成参数", status: "in_progress" },
    { id: "check", title: "核对生成结果", status: "pending" },
  ],
  status: "running",
  activities: [{ id: "read-1", label: "已读取第三集角色素材", status: "completed" }],
};

describe("public task progress state", () => {
  it('does not present metadata lookup as completed media analysis', () => {
    const metadata: AgentTaskProgressState = { steps: [], status: 'completed', activities: [{id:'read',label:'节点信息已读取',tool_name:'read_node',status:'completed'}] };
    expect(completedTaskLabel(metadata)).toBe('节点信息已读取');
    expect(completedTaskLabel({...metadata, activities:[{id:'analyze',label:'已分析视频画面',tool_name:'analyze_video',status:'completed'}]})).toBe('素材分析完成');
    expect(completedTaskLabel({...metadata, activities:[{id:'analyze',label:'视频读取失败',tool_name:'analyze_video',status:'failed'}]})).toBe('本轮已结束');
    expect(completedTaskLabel({...metadata, activities:[{id:'generate',label:'已提交生成',tool_name:'run_node',status:'completed'}]})).toBe('本轮已结束');
  });
  it('does not hide failed or unfinished media analysis behind a later successful metadata lookup', () => {
    for(const status of ['failed','running','waiting'] as const){
      const progress:AgentTaskProgressState={steps:[],status:'completed',activities:[
        {id:'image',tool_name:'analyze_image',label:'图片分析完成',status:'completed'},
        {id:'video',tool_name:'analyze_video',label:'视频分析未完成',status},
        {id:'read',tool_name:'read_node',label:'节点信息已读取',status:'completed'},
      ]};
      expect(completedTaskLabel(progress)).toBe('本轮已结束');
      const recovered=updateAgentTaskProgress(progress,{type:'progress',data:{id:'video',tool_name:'analyze_video',label:'视频画面分析完成',status:'completed'}});
      expect(completedTaskLabel(recovered)).toBe('素材分析完成');
    }
  });
  it("updates the same action instead of adding a new row for every event", () => {
    const first = updateAgentTaskProgress(undefined, { type: "progress", data: { id: "read", label: "正在读取节点", status: "running" } });
    const next = updateAgentTaskProgress(first, { type: "progress", data: { id: "read", label: "已读取节点", status: "completed" } });
    expect(next.activities).toHaveLength(1);
    expect(first.activities[0].status).toBe("running");
    expect(next.activities[0].status).toBe("completed");
  });

  it("never completes planned work just because a chat response finished", () => {
    const finished = finishAgentTaskProgress(plan, "completed")!;
    expect(finished.steps).toEqual(plan.steps);
    const waiting = updateAgentTaskProgress(plan, { type: "progress", data: { id: "generate", label: "等待你确认生成参数", status: "waiting" } });
    expect(finishAgentTaskProgress(waiting, "completed")?.status).toBe("waiting");
    expect(finishAgentTaskProgress(waiting, "cancelled")?.status).toBe("cancelled");
  });

  it("does not show an execution card for a simple response", () => {
    const simple = updateAgentTaskProgress(undefined, { type: "progress", data: { id: "reply", phase: "response", label: "正在准备回复", status: "running" } });
    expect(hasVisibleTaskProgress(simple)).toBe(false);
    expect(hasVisibleTaskProgress(plan)).toBe(true);
  });

  it("does not let a polite final reply turn failure or an outstanding approval green", () => {
    const failed = updateAgentTaskProgress(undefined, { type: "progress", data: { id: "read", label: "素材读取失败", status: "failed" } });
    const apology = updateAgentTaskProgress(failed, { type: "progress", data: { id: "reply", phase: "response", label: "正在回复", status: "completed" } });
    expect(finishAgentTaskProgress(apology, "completed")?.status).toBe("failed");
    const recovered = updateAgentTaskProgress(apology, { type: "progress", data: { id: "read", label: "素材已读取", status: "completed" } });
    expect(finishAgentTaskProgress(recovered, "completed")?.status).toBe("completed");
    const waiting = updateAgentTaskProgress(undefined, { type: "progress", data: { id: "generate", label: "等待确认生成参数", status: "waiting" } });
    const replied = updateAgentTaskProgress(waiting, { type: "progress", data: { id: "reply", phase: "response", label: "已回复", status: "completed" } });
    expect(finishAgentTaskProgress(replied, "completed")?.status).toBe("waiting");
  });
});

describe("compact task progress card", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    host.style.width = "260px";
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  it("shows real completed/current/pending steps with a single current action", async () => {
    await act(async () => root.render(<AgentTaskProgress progress={plan} />));
    expect(host.textContent).toContain("1/3 步");
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain("准备视频生成参数");
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  });

  it("collapses success and does not mark unexecuted work completed", async () => {
    await act(async () => root.render(<AgentTaskProgress progress={{ ...plan, status: "completed" }} />));
    expect(host.textContent).toContain("本轮已结束");
    expect(host.querySelector('ol')).toBeNull();
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('[data-step-status="pending"]')?.textContent).toContain("待执行");
    expect(host.textContent).toContain("未完成");
    expect(host.querySelector('.agent-task-progress__spinner')).toBeNull();
  });

  it("distinguishes a failure, waiting for approval and user cancellation", async () => {
    await act(async () => root.render(<AgentTaskProgress progress={{ ...plan, status: "failed", activities: [{ id: "read", status: "failed", label: "参考视频暂时无法读取，请检查素材" }] }} />));
    expect(host.textContent).toContain("需要处理");
    expect(host.textContent).toContain("参考视频暂时无法读取");
    await act(async () => root.render(<AgentTaskProgress progress={{ ...plan, status: "waiting", activities: [{ id: "generate", status: "waiting", label: "等待你确认生成参数" }] }} />));
    expect(host.textContent).toContain("等待你确认生成参数");
    expect(host.querySelector('.agent-task-progress__spinner')).toBeNull();
    await act(async () => root.render(<AgentTaskProgress progress={{ ...plan, status: "cancelled" }} />));
    expect(host.textContent).toContain("已停止");
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain("已完成的操作保留");
    expect(host.querySelector('.agent-task-progress__spinner')).toBeNull();
  });
});
