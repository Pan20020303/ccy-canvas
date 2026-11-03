import type { AgentPlanEventData, AgentProgressEventData } from "../../api/agent-run";

export type AgentTaskProgressState = {
  steps: AgentPlanEventData["steps"];
  summary?: string;
  activities: AgentProgressEventData[];
  status: "running" | "completed" | "failed" | "cancelled" | "waiting";
};

/** A greeting should get a lightweight waiting hint, not an execution dashboard. */
export function hasVisibleTaskProgress(progress: AgentTaskProgressState | undefined): boolean {
  return !!progress && (progress.steps.length > 0 || progress.activities.some(activity =>
    !!activity.tool_name || !["response", "thinking"].includes(activity.phase ?? "")));
}

/** Public task state only. Never copy model reasoning, tool arguments or results here. */
export function updateAgentTaskProgress(
  current: AgentTaskProgressState | undefined,
  event: { type: "plan"; data: AgentPlanEventData } | { type: "progress"; data: AgentProgressEventData },
): AgentTaskProgressState {
  const state: AgentTaskProgressState = current ?? { steps: [], activities: [], status: "running" };
  if (event.type === "plan") return { ...state, steps: event.data.steps.slice(0, 6), summary: event.data.summary, status: "running" };
  const activity = event.data;
  const activities = [...state.activities];
  const index = activities.findIndex(item => item.id === activity.id);
  if (index < 0) activities.push(activity);
  else activities[index] = activity;
  return { ...state, activities: activities.slice(-40), status: activity.status === "waiting" ? "waiting" : "running" };
}

export function finishAgentTaskProgress(
  current: AgentTaskProgressState | undefined,
  status: "completed" | "failed" | "cancelled" | "waiting",
): AgentTaskProgressState | undefined {
  if (!current) return undefined;
  // Finishing a turn is not proof that its planned work or media generation finished.
  const meaningful = current.activities.filter(activity => activity.tool_name || !["response", "thinking"].includes(activity.phase ?? ""));
  const last = meaningful.at(-1)?.status;
  return { ...current, status: status === "completed" && last === "failed" ? "failed"
    : status === "completed" && meaningful.some(activity => activity.status === "waiting") ? "waiting" : status };
}

const TOOL_LABELS: Record<string, string> = {
  list_nodes: "查看画布节点列表", read_canvas: "查看画布概况", search_nodes: "查找相关节点",
  find_nodes: "查找相关节点", read_node: "读取节点信息", read_nodes: "读取相关节点",
  read_group: "读取分组信息", list_groups: "查看画布分组", inspect_image: "查看参考图片",
  analyze_image: "分析参考图片", view_image: "查看参考图片", analyze_video: "分析参考视频",
  add_node: "创建画布节点", add_nodes: "创建画布节点", create_node: "创建画布节点", update_node: "更新节点内容",
  patch_node_data: "更新节点内容", add_edge: "连接参考素材", connect_nodes: "连接参考素材",
  delete_node: "删除指定节点", move_node: "调整节点位置", move_nodes: "整理画布布局",
  create_group: "整理画布分组", run_node: "准备生成参数", run_nodes: "准备批量生成参数",
  run_nodes_batch: "准备批量生成参数", ask_user: "确认你的选择", list_models: "查看可用模型",
  update_plan: "更新执行步骤", plan_task: "规划执行步骤", delegate_agent: "处理任务",
};

export function publicToolLabel(name: string): string {
  return TOOL_LABELS[name.split(/[./]/).at(-1) ?? name] ?? "处理任务步骤";
}

/** Node metadata is not visual analysis or successful media generation. */
export function completedTaskLabel(progress: AgentTaskProgressState): string {
  if (progress.steps.some(step => step.status !== 'completed')) return '本轮已结束';
  const analysisActivities = progress.activities.filter(activity => ['analyze_image', 'analyze_video'].includes(activity.tool_name?.split(/[./]/).at(-1) ?? ''));
  if (analysisActivities.some(activity => activity.status !== 'completed')) return '本轮已结束';
  const completedTools = progress.activities.filter(activity => activity.status === 'completed' && activity.tool_name);
  const names = completedTools.map(activity => activity.tool_name!.split(/[./]/).at(-1));
  if (names.some(name => name === 'analyze_image' || name === 'analyze_video')) return '素材分析完成';
  const metadataTools = new Set(['read_node', 'read_nodes', 'read_canvas', 'list_nodes', 'search_nodes', 'find_nodes', 'read_group', 'list_groups']);
  if (names.length && names.every(name => !!name && metadataTools.has(name))) return '节点信息已读取';
  return '本轮已结束';
}

export function legacyToolProgress(
  tools: Array<{ name: string; status: "running" | "success" | "error" }>,
  running: boolean,
): AgentTaskProgressState | undefined {
  if (!tools.length) return undefined;
  return {
    steps: [],
    activities: tools.map((tool, index) => ({
      id: `legacy-${index}`, label: publicToolLabel(tool.name), tool_name: tool.name,
      status: tool.status === "success" ? "completed" : tool.status === "error" ? "failed" : "running",
    })),
    status: running ? "running" : tools.some(tool => tool.status === "error") ? "failed"
      : tools.some(tool => tool.status === "running") ? "cancelled" : "completed",
  };
}
