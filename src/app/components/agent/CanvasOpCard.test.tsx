// @vitest-environment jsdom
/**
 * 画布变更卡的真渲染测试。
 *
 * 为什么值得单独测：这条链路穿过三个"类型检查过了但运行时可能不对"的环节
 * （part 类型前缀 → 运行时转换 → 命名渲染器注册）。类型检查只覆盖第一环，
 * 所以这里把能离线验证的部分**真的渲染出来断言**，而不是靠读源码推断。
 *
 * 覆盖边界：真正的 assistant-ui data-renderer 分发需要完整的 aui 上下文（在
 * AgentThread 里由 useAssistantDataUI 注册），这里不 mock 那套内部状态机 ——
 * 而是断言我们自己负责的两段：
 *   1. buildAgentThreadMessages 产出的 part 形状（含 data-canvas-op 前缀）
 *   2. 卡片组件对这些数据的渲染结果
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgentThreadMessages, CanvasOpCard } from "./AgentAssistantThread";
import type { CanvasOperationPart } from "../../agent-timeline";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function render(node: React.ReactNode) {
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
  return host!;
}

const sampleData: CanvasOperationPart["data"] = {
  id: "canvas-1",
  op: "add_node",
  action: "已新增",
  entity: "image",
  title: "开场图",
  detail: "图片节点",
  nodeId: "n1",
  position: "0, 0",
  revision: 3,
};

describe("CanvasOpCard 渲染", () => {
  it("渲染动作、标题与 revision", () => {
    const dom = render(<CanvasOpCard data={sampleData} />);
    const text = dom.textContent ?? "";
    expect(text).toContain("已新增");
    expect(text).toContain("图片节点");
    expect(text).toContain("开场图");
    expect(text).toContain("rev 3");
  });

  it("缺 revision 时不渲染 rev 徽标（不能显示 rev undefined）", () => {
    const dom = render(<CanvasOpCard data={{ ...sampleData, revision: undefined }} />);
    expect(dom.textContent ?? "").not.toContain("rev");
  });

  it("标题过长时放进 title 属性（便于悬停查看，不撑破布局）", () => {
    const dom = render(<CanvasOpCard data={sampleData} />);
    const titled = dom.querySelector("[title='开场图']");
    expect(titled).not.toBeNull();
  });

  it("未知 entity 不抛错（图标回退）", () => {
    expect(() => render(<CanvasOpCard data={{ ...sampleData, entity: "unknown-entity" }} />)).not.toThrow();
  });
});

describe("buildAgentThreadMessages 注入画布 part", () => {
  it("canvas 步骤变成 data-canvas-op part，并保持与工具调用的相对顺序", () => {
    const messages = buildAgentThreadMessages(
      [],
      [
        { kind: "thought", id: "t1", content: "先看看画布" },
        { kind: "tool", id: "tool1", invocation: { id: "c1", name: "canvas_overview", args: "{}", status: "success", output: "{}" } },
        {
          kind: "canvas",
          id: "canvas-1",
          patch: {
            op: "add_node",
            node: { id: "n1", type: "imageNode", position: { x: 0, y: 0 }, data: { title: "开场图" } },
            revision: 1,
          },
        },
        { kind: "tool", id: "tool2", invocation: { id: "c2", name: "create_image_node", args: "{}", status: "success", output: "{}" } },
      ],
      "",
      false,
      true,
    );

    // 运行中 → 时间线作为最后一条 assistant 消息
    const runMessage = messages[messages.length - 1];
    expect(runMessage.role).toBe("assistant");
    const parts = runMessage.content as unknown as { type: string }[];
    const types = parts.map((part) => part.type);
    // 顺序：思考 → 工具 → 画布卡 → 工具（画布变更插在两次工具调用之间）
    expect(types).toEqual(["reasoning", "tool-call", "data-canvas-op", "tool-call"]);

    const canvasPart = parts.find((part) => part.type === "data-canvas-op") as unknown as CanvasOperationPart;
    expect(canvasPart.data).toMatchObject({ op: "add_node", revision: 1 });
    // 动作文案来自共享 presenter（中文环境）
    expect(canvasPart.data.action.length).toBeGreaterThan(0);
  });

  it("多个画布步骤各成一个 part，顺序与发生顺序一致", () => {
    const messages = buildAgentThreadMessages(
      [],
      [
        { kind: "canvas", id: "c1", patch: { op: "add_node", node: { id: "n1", type: "imageNode", data: {} }, revision: 1 } },
        { kind: "canvas", id: "c2", patch: { op: "add_node", node: { id: "n2", type: "textNode", data: {} }, revision: 2 } },
        { kind: "canvas", id: "c3", patch: { op: "add_edge", edge: { source: "n2", target: "n1" }, revision: 3 } },
      ],
      "",
      true,
      true,
    );
    const parts = messages[messages.length - 1].content as unknown as { type: string; data?: { revision?: number } }[];
    const canvasParts = parts.filter((part) => part.type === "data-canvas-op");
    expect(canvasParts).toHaveLength(3);
    expect(canvasParts.map((part) => part.data?.revision)).toEqual([1, 2, 3]);
  });

  it("没有 canvas 步骤时不注入任何 data part（不产生空卡）", () => {
    const messages = buildAgentThreadMessages(
      [],
      [{ kind: "thought", id: "t1", content: "只想了个问题" }],
      "",
      true,
      true,
    );
    const parts = messages[messages.length - 1].content as unknown as { type: string }[];
    expect(parts.some((part) => part.type === "data-canvas-op")).toBe(false);
  });
});
