import { CircleCheck, CircleX, ShieldAlert } from "lucide-react";

import type { ProviderConfig } from "../../api/providerConfigs";

export function ChannelHealthBadge({ config }: { config: ProviderConfig }) {
  if (config.failure_count > 0) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300 ring-1 ring-amber-500/30"
        title={config.last_error_msg || `${config.failure_count} 次失败，只报警不自动锁定`}
      >
        <ShieldAlert className="h-3 w-3" />
        退化 ({config.failure_count})
      </span>
    );
  }

  if (config.last_success_at) {
    const ago = relativeTimeShort(Date.parse(config.last_success_at));
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-300 ring-1 ring-emerald-500/30"
        title={`最近成功：${config.last_success_at}`}
      >
        <CircleCheck className="h-3 w-3" />
        健康 · {ago}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-500/10 px-2 py-0.5 text-[11px] text-neutral-400 ring-1 ring-neutral-500/20">
      <CircleX className="h-3 w-3" />
      未使用
    </span>
  );
}

function relativeTimeShort(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return "刚刚";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  return `${days} 天前`;
}
