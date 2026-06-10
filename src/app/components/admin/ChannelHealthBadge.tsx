import { useEffect, useState } from "react";
import { CircleCheck, CircleX, Clock, ShieldAlert } from "lucide-react";

import type { ProviderConfig } from "../../api/providerConfigs";

/**
 * Compact status pill for a single provider's channel health.
 *
 *   GREEN  — never failed OR last_success_at fresher than last_failure_at
 *   AMBER  — has failures but not yet in cooldown
 *   RED    — actively in cooldown_until > now
 *   GREY   — fresh row with no health data yet
 *
 * Re-renders once a second when the row is in cooldown so the countdown
 * stays accurate; idles otherwise (no timer).
 */
export function ChannelHealthBadge({ config }: { config: ProviderConfig }) {
  const cooldownUntilMs = config.cooldown_until ? Date.parse(config.cooldown_until) : 0;
  const inCooldown = cooldownUntilMs > 0 && cooldownUntilMs > Date.now();

  // Only tick when there's a live countdown. No timer when the channel is
  // healthy — avoids pinning a CPU core just to refresh idle rows.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (!inCooldown) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [inCooldown]);

  if (inCooldown) {
    const remainingSec = Math.max(0, Math.floor((cooldownUntilMs - Date.now()) / 1000));
    const mins = Math.floor(remainingSec / 60);
    const secs = remainingSec % 60;
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] text-rose-300 ring-1 ring-rose-500/30"
        title={config.last_error_msg || `Cooldown until ${config.cooldown_until}`}
      >
        <Clock className="h-3 w-3" />
        冷却中 {mins}:{secs.toString().padStart(2, "0")}
      </span>
    );
  }

  if (config.failure_count > 0) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300 ring-1 ring-amber-500/30"
        title={config.last_error_msg || `${config.failure_count} 次连续失败`}
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
        title={`最近成功 ${config.last_success_at}`}
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

// Tiny relative-time formatter — sufficient for the "last success xx ago"
// display without dragging in date-fns just for one badge.
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
