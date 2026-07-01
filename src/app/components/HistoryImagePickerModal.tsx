import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Square, X } from "lucide-react";

import {
  countHistoryByMediaType,
  filterHistoryByMediaType,
  getHistoryItemAssetUrl,
  groupHistoryByDate,
  type HistoryAssetsTab,
} from "../history-assets";
import type { HistoryItem } from "../store";
import { toRenderableMediaUrl } from "../reference-media";

const MEDIA_TABS: HistoryAssetsTab[] = ["image", "video", "audio"];

const TAB_LABELS: Record<HistoryAssetsTab, string> = {
  image: "图片历史",
  video: "视频历史",
  audio: "音频历史",
};

const MAX_SELECTION = 10;

export function HistoryImagePickerModal({
  isOpen,
  historyItems,
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  historyItems: HistoryItem[];
  onClose: () => void;
  onConfirm: (selectedItems: HistoryItem[]) => void;
}) {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
  const [activeTab, setActiveTab] = useState<HistoryAssetsTab>("image");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedIds([]);
      setActiveTab("image");
    }
  }, [isOpen]);

  const counts = useMemo(() => countHistoryByMediaType(historyItems), [historyItems]);
  const filteredItems = useMemo(
    () => filterHistoryByMediaType(historyItems, activeTab),
    [activeTab, historyItems],
  );
  const groups = useMemo(() => groupHistoryByDate(filteredItems), [filteredItems]);
  const selectedItems = useMemo(
    () => filteredItems.filter((item) => selectedIds.includes(item.id)),
    [filteredItems, selectedIds],
  );

  const toggleItem = (item: HistoryItem) => {
    setSelectedIds((current) => {
      if (current.includes(item.id)) {
        return current.filter((id) => id !== item.id);
      }
      if (current.length >= MAX_SELECTION) {
        return current;
      }
      return [...current, item.id];
    });
  };

  const toggleGroup = (groupIds: string[]) => {
    const allSelected = groupIds.every((id) => selectedIds.includes(id));
    setSelectedIds((current) => {
      if (allSelected) {
        return current.filter((id) => !groupIds.includes(id));
      }

      const next = [...current];
      for (const id of groupIds) {
        if (next.includes(id) || next.length >= MAX_SELECTION) continue;
        next.push(id);
      }
      return next;
    });
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/76 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 flex h-[78vh] w-[min(1600px,calc(100vw-40px))] flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#212121]/98 shadow-[0_24px_80px_rgba(0,0,0,0.48)]">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-5">
          <div className="text-[15px] font-medium text-neutral-100">选择图片</div>
          <button onClick={onClose} className="rounded-md p-1 text-neutral-500 transition hover:bg-white/5 hover:text-neutral-200">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-1 flex-col overflow-hidden px-6 pb-5 pt-4">
          <div className="mb-5 flex items-center justify-between">
            <div className="flex items-center gap-6 text-sm">
              {MEDIA_TABS.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`transition ${activeTab === tab ? "text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
                >
                  {TAB_LABELS[tab]}
                  <span className="text-neutral-500">({counts[tab]})</span>
                </button>
              ))}
            </div>

            <div className="text-sm text-neutral-400">
              已选 <span className="text-cyan-300">{selectedIds.length}</span>/10 张
            </div>
          </div>

          <div className="flex-1 overflow-y-auto rounded-2xl border border-white/5 bg-[#1f1f1f]/60 px-4 py-5">
            {groups.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-neutral-500">暂无可选择的历史素材</div>
            ) : (
              <div className="space-y-8">
                {groups.map((group) => {
                  const groupIds = group.items.map((item) => item.id);
                  const allSelected = groupIds.length > 0 && groupIds.every((id) => selectedIds.includes(id));

                  return (
                    <section key={group.dateKey}>
                      <div className="mb-4 flex items-center gap-3 text-lg font-semibold text-neutral-100">
                        <button
                          type="button"
                          onClick={() => toggleGroup(groupIds)}
                          className="rounded-md border border-white/15 p-0.5 text-neutral-300 transition hover:bg-white/5"
                        >
                          {allSelected ? <Check className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                        </button>
                        <span>{group.dateLabel}</span>
                      </div>

                      <div className="grid grid-cols-[repeat(auto-fill,minmax(216px,1fr))] gap-4">
                        {group.items.map((item) => {
                          const selected = selectedIds.includes(item.id);
                          const canSelectMore = selected || selectedIds.length < MAX_SELECTION;
                          const assetUrl = getHistoryItemAssetUrl(item, apiBaseUrl);

                          return (
                            <button
                              key={item.id}
                              type="button"
                              disabled={!canSelectMore}
                              onClick={() => toggleItem(item)}
                              className={`group overflow-hidden rounded-2xl border bg-[#262626] text-left transition ${
                                selected ? "border-cyan-400/40 shadow-[0_0_0_1px_rgba(34,211,238,0.2)]" : "border-white/8 hover:border-white/15"
                              } disabled:cursor-not-allowed disabled:opacity-50`}
                            >
                              <div className="relative aspect-[3/4] overflow-hidden bg-black/30">
                                {assetUrl ? (
                                  <img src={toRenderableMediaUrl(assetUrl)} alt={item.title} className="h-full w-full object-cover" />
                                ) : (
                                  <div className="flex h-full items-center justify-center text-sm text-neutral-600">No Preview</div>
                                )}
                                <div className="absolute left-3 top-3 rounded-md border border-white/15 bg-black/45 p-0.5 text-neutral-100 backdrop-blur">
                                  {selected ? <Check className="h-4 w-4" /> : <div className="h-4 w-4" />}
                                </div>
                              </div>
                              <div className="px-3 py-3">
                                <div className="line-clamp-2 text-sm text-neutral-100">{item.title || item.id}</div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-neutral-500">
              <button className="rounded-lg p-2 transition hover:bg-white/5 hover:text-neutral-300">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="rounded-lg bg-white/5 px-4 py-2 text-neutral-300">1</span>
              <button className="rounded-lg p-2 transition hover:bg-white/5 hover:text-neutral-300">
                <ChevronRight className="h-4 w-4" />
              </button>
              <span className="rounded-lg bg-white/5 px-4 py-2">15条/页</span>
              <span>跳至</span>
              <span className="rounded-lg bg-white/5 px-6 py-2">页</span>
            </div>

            <button
              onClick={() => onConfirm(selectedItems)}
              disabled={selectedItems.length === 0}
              className="rounded-xl bg-cyan-600 px-5 py-2.5 text-sm text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-45"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
