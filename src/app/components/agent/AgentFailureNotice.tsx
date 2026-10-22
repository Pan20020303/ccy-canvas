import { safeFailureMessage } from "../../api/failure-message";

export function AgentFailureNotice({ message, jobId }: { message: string; jobId?: string }) {
  const reason = safeFailureMessage(message);
  const legacy = /^(?:模型)?服务暂时不可用[，,]?\s*请稍后重试[。.]?$/.test(reason);
  return <div role="alert" className="select-text rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs leading-5 text-rose-200">
    <p className="whitespace-pre-wrap break-words">{reason || "任务失败，未取得可安全展示的详细原因。"}</p>
    {legacy && <p className="mt-1 text-[11px] text-rose-200/60">此任务未记录具体原因，无法从通用错误还原。</p>}
    {jobId && <p className="mt-1 break-all text-[10px] text-rose-200/60">任务编号 {jobId}</p>}
  </div>;
}
