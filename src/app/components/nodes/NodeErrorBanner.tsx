import { useEffect, useState } from "react";
import { ImageOff, X } from "lucide-react";
import { useStore } from "../../store";
import { getNodeErrorPresentation, nodeFailureReason } from "./node-errors";

export function NodeErrorBanner({ error, nodeId }: { error: string; nodeId?: string }) {
  const language = useStore(state => state.language);
  const updateNodeData = useStore(state => state.updateNodeData);
  const taskId = useStore(state => nodeId ? state.nodes.find(node => node.id === nodeId)?.data?.taskId : undefined);
  const [dismissed, setDismissed] = useState(false);
  const presentation = getNodeErrorPresentation(error);
  const reason = nodeFailureReason(error);
  useEffect(() => { setDismissed(false); }, [error, nodeId]);
  if (dismissed) return null;
  const title = language === "zh" ? presentation.zh : presentation.en;
  return (
    <div role="alert" className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] border border-rose-300/15 bg-[#211419]/94 px-5 py-4 text-rose-50 backdrop-blur-md">
      <button type="button" aria-label={language === "zh" ? "关闭错误提示" : "Dismiss error"}
        onClick={event => { event.stopPropagation(); setDismissed(true); if (nodeId) updateNodeData(nodeId, { error: undefined }); }}
        className="nodrag nopan pointer-events-auto absolute right-2.5 top-2.5 rounded-md p-1 text-rose-100/45 hover:bg-white/[0.08] hover:text-rose-50 focus-visible:ring-1 focus-visible:ring-rose-200">
        <X className="h-3.5 w-3.5" />
      </button>
      <div className="flex max-h-full max-w-full items-start gap-2.5 py-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rose-300/10"><ImageOff className="h-3.5 w-3.5 text-rose-300" /></div>
        <div className="nodrag nopan pointer-events-auto min-w-0 select-text">
          <div className="text-xs font-medium leading-5">{title}</div>
          {reason && reason !== title && <div className="nowheel mt-1 max-h-36 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-rose-100/80">{reason}</div>}
          <div className="mt-2 break-all text-[10px] leading-4 text-rose-100/45">
            {language === "zh" ? "分类编号" : "Category"} {presentation.code}
            {typeof taskId === "string" && taskId && <div>{language === "zh" ? "任务编号" : "Task"} {taskId}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
