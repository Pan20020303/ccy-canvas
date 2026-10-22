import { resolveBackendAssetUrl } from "./reference-media";
import type { HistoryItem, HistoryMediaType } from "./store";

export type HistoryAssetsTab = Extract<HistoryMediaType, "image" | "video" | "audio">;

export type HistoryDayGroup = {
  dateKey: string;
  dateLabel: string;
  items: HistoryItem[];
};

export type HistoryZoomLayout = {
  percentage: 75 | 100 | 125;
  columns: number;
  tileWidth: number;
  previewClassName: string;
};

export function filterHistoryByMediaType(history: HistoryItem[], mediaType: HistoryAssetsTab) {
  return history.filter((item) => item.mediaType === mediaType);
}

export function countHistoryByMediaType(history: HistoryItem[]) {
  return {
    image: history.filter((item) => item.mediaType === "image").length,
    video: history.filter((item) => item.mediaType === "video").length,
    audio: history.filter((item) => item.mediaType === "audio").length,
  };
}

export function groupHistoryByDate(history: HistoryItem[]): HistoryDayGroup[] {
  const groups = new Map<string, HistoryItem[]>();

  const sorted = [...history].sort((a, b) => b.timestamp - a.timestamp);
  for (const item of sorted) {
    const dateKey = new Date(item.timestamp).toISOString().slice(0, 10);
    groups.set(dateKey, [...(groups.get(dateKey) ?? []), item]);
  }

  return Array.from(groups.entries())
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([dateKey, items]) => ({
      dateKey,
      dateLabel: dateKey,
      items,
    }));
}

export function getZoomLayout(percentage: number): HistoryZoomLayout {
  if (percentage <= 75) {
    return { percentage: 75, columns: 7, tileWidth: 112, previewClassName: "aspect-square" };
  }

  if (percentage >= 125) {
    return { percentage: 125, columns: 5, tileWidth: 168, previewClassName: "aspect-[4/5]" };
  }

  return { percentage: 100, columns: 6, tileWidth: 136, previewClassName: "aspect-[3/4]" };
}

export function computeBatchActionAvailability(selectedItems: HistoryItem[]) {
  const canDelete = selectedItems.length > 0;
  const canDownload = selectedItems.some((item) => Boolean(item.thumbnail || item.content));
  const canUse = selectedItems.some((item) => item.mediaType === "image" || item.mediaType === "video" || item.mediaType === "audio");

  return {
    canDelete,
    canDownload,
    canUse,
  };
}

export function getHistoryItemAssetUrl(item: HistoryItem, apiBaseUrl?: string | null): string {
  return resolveBackendAssetUrl(item.thumbnail || item.content || "", apiBaseUrl);
}

export function canPreviewHistoryItem(item: HistoryItem, apiBaseUrl?: string | null): boolean {
  return Boolean(getHistoryItemAssetUrl(item, apiBaseUrl));
}

export function getHistoryPreviewSequence(history: HistoryItem[]): HistoryItem[] {
  return [...history].sort((a, b) => b.timestamp - a.timestamp);
}

export function getPreviewCursor(history: HistoryItem[], currentId: string) {
  const currentIndex = history.findIndex((item) => item.id === currentId);
  const previousItem = currentIndex > 0 ? history[currentIndex - 1] : null;
  const nextItem = currentIndex >= 0 && currentIndex < history.length - 1 ? history[currentIndex + 1] : null;

  return {
    currentIndex,
    total: history.length,
    hasPrevious: Boolean(previousItem),
    hasNext: Boolean(nextItem),
    previousItem,
    nextItem,
  };
}
