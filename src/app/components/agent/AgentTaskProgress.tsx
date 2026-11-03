import { useState } from "react";
import { Check, ChevronDown, Circle, LoaderCircle, Pause, Sparkles, TriangleAlert } from "lucide-react";
import { completedTaskLabel, type AgentTaskProgressState } from "./task-progress";
import "./agent-task-progress.css";

export function AgentTaskProgress({ progress }: { progress: AgentTaskProgressState }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const active = progress.status === "running";
  const open = expanded ?? (active || progress.status === "failed" || progress.status === "waiting");
  const activity = progress.activities.at(-1);
  const complete = progress.steps.filter(step => step.status === "completed").length;
  const hasPlan = progress.steps.length > 0;
  const title = progress.status === "cancelled" ? "已停止"
    : progress.status === "failed" ? "需要处理"
    : progress.status === "waiting" ? "等待确认或结果"
    : active ? (hasPlan ? "正在执行" : "正在处理")
    : completedTaskLabel(progress);
  const HeaderIcon = active ? LoaderCircle : progress.status === "failed" ? TriangleAlert
    : progress.status === "cancelled" || progress.status === "waiting" ? Pause : Check;
  const visibleActivity = activity?.label || (active ? "正在准备回复" : "执行过程已结束");

  return <section className="agent-task-progress" data-task-progress data-status={progress.status} aria-label="任务进度">
    <button type="button" className="agent-task-progress__header" aria-expanded={open} onClick={() => setExpanded(!open)}>
      <HeaderIcon size={14} className={active ? "agent-task-progress__spinner" : ""} aria-hidden="true" />
      <span className="agent-task-progress__heading">{title}</span>
      {hasPlan ? <span className="agent-task-progress__count">{complete}/{progress.steps.length} 步</span> : null}
      <ChevronDown size={13} className={`agent-task-progress__chevron${open ? " is-open" : ""}`} aria-hidden="true" />
    </button>
    {open ? <div className="agent-task-progress__body">
      {progress.summary ? <p className="agent-task-progress__summary">{progress.summary}</p> : null}
      {hasPlan ? <ol className="agent-task-progress__steps" aria-label="执行步骤">
        {progress.steps.map((step, index) => {
          const StepIcon = step.status === "completed" ? Check : step.status === "blocked" ? TriangleAlert
            : step.status === "in_progress" && active ? LoaderCircle : Circle;
          const label = step.status === "completed" ? "已完成" : step.status === "blocked" ? "待处理"
            : step.status === "in_progress" ? (active ? "进行中" : "未完成") : "待执行";
          return <li key={step.id || index} data-step-status={step.status} aria-current={step.status === "in_progress" && active ? "step" : undefined}>
            <StepIcon size={13} className={step.status === "in_progress" && active ? "agent-task-progress__spinner" : ""} aria-hidden="true" />
            <span>{step.title}</span><small>{label}</small>
          </li>;
        })}
      </ol> : null}
      <div className="agent-task-progress__current" role="status" aria-live="polite" aria-atomic="true">
        <Sparkles size={12} aria-hidden="true" />
        <span>{progress.status === "cancelled" ? "已停止本轮处理，已完成的操作保留。" : visibleActivity}</span>
      </div>
    </div> : null}
  </section>;
}
