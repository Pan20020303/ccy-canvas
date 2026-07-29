import type { CreditLedgerEntry } from "./api/credits";

export type CreditReasonDisplay = {
  summary: string;
  /** Raw provider/runtime context, hidden until the user asks for details. */
  technicalDetail?: string;
};

const SERVICE_LABELS = {
  text: { zh: "文本生成", en: "Text generation" },
  image: { zh: "图片生成", en: "Image generation" },
  video: { zh: "视频生成", en: "Video generation" },
  audio: { zh: "音频生成", en: "Audio generation" },
} as const;

function shortFallback(value: string, max = 24) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/**
 * Turns the legacy free-form reason into a compact product label.
 *
 * The ledger still stores the untouched reason for audit/debugging. The UI
 * deliberately keeps that machine context one level deeper instead of mixing
 * node ids, task ids and provider model ids into the primary table.
 */
export function presentCreditReason(
  entry: Pick<CreditLedgerEntry, "type" | "reason">,
  language: "zh" | "en",
): CreditReasonDisplay {
  const zh = language === "zh";
  const reason = entry.reason.trim();
  if (!reason) return { summary: "—" };

  if (entry.type === "daily_reset" || /每日(?:额度)?重置|daily\s+(?:quota\s+)?reset/i.test(reason)) {
    return { summary: zh ? "每日额度已恢复" : "Daily quota restored" };
  }

  if (entry.type === "refund" || /^refund\s*:/i.test(reason)) {
    let summary = zh ? "生成未完成，积分已退回" : "Generation not completed · refunded";
    if (/generation failed|failed to (?:encode|persist)|panic/i.test(reason)) {
      summary = zh ? "生成失败，积分已退回" : "Generation failed · refunded";
    } else if (/cancel|client gone|disconnect/i.test(reason)) {
      summary = zh ? "任务已取消，积分已退回" : "Task cancelled · refunded";
    } else if (/no provider/i.test(reason)) {
      summary = zh ? "模型服务不可用，积分已退回" : "Model unavailable · refunded";
    } else if (/reaped|timeout/i.test(reason)) {
      summary = zh ? "任务超时，积分已退回" : "Task timed out · refunded";
    }
    return { summary, technicalDetail: reason };
  }

  if (entry.type === "reserve" || entry.type === "charge" || /^reserve\s*:|^charge\s*:/i.test(reason)) {
    const service = reason.match(/(?:reserve|charge)\s*:\s*(text|image|video|audio)\b/i)?.[1]?.toLowerCase() as
      | keyof typeof SERVICE_LABELS
      | undefined;
    const label = service ? SERVICE_LABELS[service] : null;
    return {
      summary: label ? (zh ? label.zh : label.en) : (zh ? "内容生成" : "Content generation"),
      technicalDetail: reason,
    };
  }

  // Human-written admin notes stay readable. Very long notes are shortened in
  // the table and remain available in the expandable technical detail.
  const summary = shortFallback(reason);
  return summary === reason ? { summary } : { summary, technicalDetail: reason };
}
