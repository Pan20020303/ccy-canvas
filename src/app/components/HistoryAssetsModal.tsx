import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Check,
  ChevronDown,
  Download,
  Eye,
  Minus,
  Music2,
  Plus,
  Square,
  Trash2,
  Video,
  X,
  Image as ImageIcon,
} from "lucide-react";

import {
  canPreviewHistoryItem,
  computeBatchActionAvailability,
  countHistoryByMediaType,
  filterHistoryByMediaType,
  getHistoryPreviewSequence,
  getHistoryItemAssetUrl,
  getPreviewCursor,
  getZoomLayout,
  groupHistoryByDate,
  type HistoryAssetsTab,
} from "../history-assets";
import { toRenderableMediaUrl } from "../reference-media";
import { useStore, type HistoryItem } from "../store";

const TAB_LABELS: Record<HistoryAssetsTab, { zh: string; en: string }> = {
  image: { zh: "图片历史", en: "Images" },
  video: { zh: "视频历史", en: "Videos" },
  audio: { zh: "音频历史", en: "Audio" },
};

const ZOOM_OPTIONS = [75, 100, 125] as const;

function triggerDownload(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.target = "_blank";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

export const HistoryAssetsModal = () => {
  const language = useStore((state) => state.language);
  const history = useStore((state) => state.history);
  const isOpen = useStore((state) => state.isHistoryAssetsOpen);
  const setOpen = useStore((state) => state.setHistoryAssetsOpen);
  const removeHistoryItems = useStore((state) => state.removeHistoryItems);
  const reuseHistoryItems = useStore((state) => state.reuseHistoryItems);
  const hydrateHistory = useStore((state) => state.hydrateHistory);

  // Pull the server-persisted history when the panel opens, so it shows up even
  // after a localStorage wipe or on a different device. Best-effort + local-first.
  useEffect(() => {
    if (isOpen) hydrateHistory();
  }, [isOpen, hydrateHistory]);

  const [activeTab, setActiveTab] = useState<HistoryAssetsTab>("image");
  const [zoom, setZoom] = useState<(typeof ZOOM_OPTIONS)[number]>(100);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [previewItem, setPreviewItem] = useState<HistoryItem | null>(null);

  const closeModal = () => {
    setOpen(false);
    setBulkMode(false);
    setSelectedIds([]);
    setPreviewItem(null);
  };

  const filteredHistory = useMemo(
    () => filterHistoryByMediaType(history, activeTab),
    [activeTab, history],
  );
  const counts = useMemo(() => countHistoryByMediaType(history), [history]);
  const groups = useMemo(() => groupHistoryByDate(filteredHistory), [filteredHistory]);
  const previewSequence = useMemo(() => getHistoryPreviewSequence(filteredHistory), [filteredHistory]);
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";
  const selectedItems = useMemo(
    () => filteredHistory.filter((item) => selectedIds.includes(item.id)),
    [filteredHistory, selectedIds],
  );
  const actions = useMemo(() => computeBatchActionAvailability(selectedItems), [selectedItems]);
  const layout = useMemo(() => getZoomLayout(zoom), [zoom]);
  const previewCursor = useMemo(
    () => (previewItem ? getPreviewCursor(previewSequence, previewItem.id) : null),
    [previewItem, previewSequence],
  );

  const toggleItem = (id: string) => {
    setSelectedIds((current) => (
      current.includes(id) ? current.filter((itemId) => itemId !== id) : [...current, id]
    ));
  };

  const toggleGroup = (ids: string[]) => {
    const allSelected = ids.every((id) => selectedIds.includes(id));
    setSelectedIds((current) => {
      if (allSelected) {
        return current.filter((id) => !ids.includes(id));
      }

      return Array.from(new Set([...current, ...ids]));
    });
  };

  const handleDelete = () => {
    if (!actions.canDelete) return;
    removeHistoryItems(selectedIds);
    setSelectedIds([]);
    setBulkMode(false);
  };

  const handleDownload = () => {
    if (!actions.canDownload) return;
    for (const item of selectedItems) {
      const url = getHistoryItemAssetUrl(item, apiBaseUrl);
      if (!url) continue;
      triggerDownload(url, item.title || item.id);
    }
  };

  const handleReuse = () => {
    if (!actions.canUse) return;
    reuseHistoryItems(selectedIds);
    setSelectedIds([]);
    setBulkMode(false);
    setOpen(false);
  };

  const previewUrl = previewItem ? getHistoryItemAssetUrl(previewItem, apiBaseUrl) : "";
  const movePreview = (direction: "previous" | "next") => {
    if (!previewCursor) return;
    const target = direction === "previous" ? previewCursor.previousItem : previewCursor.nextItem;
    if (target) {
      setPreviewItem(target);
    }
  };

  useEffect(() => {
    if (!previewItem) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewItem(null);
      }

      if (event.key === "ArrowLeft") {
        movePreview("previous");
      }

      if (event.key === "ArrowRight") {
        movePreview("next");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewItem, previewCursor]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="ccy-fade-in absolute inset-0 bg-black/72 backdrop-blur-md" onClick={closeModal} />
      <div className="ccy-modal-in relative z-10 flex h-[78vh] w-[min(1660px,calc(100vw-48px))] flex-col overflow-hidden rounded-[22px] border border-white/10 bg-[#262626]/96 shadow-[0_24px_80px_rgba(0,0,0,0.45)]">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="text-[15px] font-medium text-neutral-100">
            {language === "zh" ? "历史资产" : "History Assets"}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center rounded-xl border border-white/10 bg-black/20 px-2 py-1 text-sm text-neutral-200">
              <button
                onClick={() => setZoom((current) => ZOOM_OPTIONS[Math.max(0, ZOOM_OPTIONS.indexOf(current) - 1)] ?? 75)}
                className="rounded-md p-1 text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200"
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="min-w-14 text-center">{layout.percentage}%</span>
              <button
                onClick={() => setZoom((current) => ZOOM_OPTIONS[Math.min(ZOOM_OPTIONS.length - 1, ZOOM_OPTIONS.indexOf(current) + 1)] ?? 125)}
                className="rounded-md p-1 text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <button onClick={closeModal} className="rounded-md p-1 text-neutral-500 transition hover:bg-white/5 hover:text-neutral-200">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between px-5 pt-5">
          <div className="flex items-center gap-6 text-sm">
            {(["image", "video", "audio"] as HistoryAssetsTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`transition ${activeTab === tab ? "text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}
              >
                {language === "zh" ? TAB_LABELS[tab].zh : TAB_LABELS[tab].en}
                <span className="text-neutral-500">({counts[tab]})</span>
              </button>
            ))}
          </div>

          {bulkMode ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="rounded-xl bg-white/5 px-4 py-2 text-neutral-400">
                {language === "zh" ? `已选 ${selectedIds.length} 项` : `${selectedIds.length} selected`}
              </span>
              <button
                onClick={handleDelete}
                disabled={!actions.canDelete}
                className="flex items-center gap-1.5 rounded-xl bg-white/5 px-4 py-2 text-neutral-300 transition enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" />
                {language === "zh" ? "删除" : "Delete"}
              </button>
              <button
                onClick={handleDownload}
                disabled={!actions.canDownload}
                className="flex items-center gap-1.5 rounded-xl bg-white/5 px-4 py-2 text-neutral-300 transition enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Download className="h-4 w-4" />
                {language === "zh" ? "下载" : "Download"}
              </button>
              <button
                onClick={handleReuse}
                disabled={!actions.canUse}
                className="rounded-xl bg-white/5 px-4 py-2 text-neutral-300 transition enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {language === "zh" ? "使用" : "Use"}
              </button>
              <button
                onClick={() => {
                  setSelectedIds([]);
                  setBulkMode(false);
                }}
                className="px-3 py-2 text-neutral-300 transition hover:text-neutral-100"
              >
                {language === "zh" ? "取消选择" : "Cancel"}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-5 text-sm text-neutral-400">
              <button className="flex items-center gap-1 transition hover:text-neutral-200">
                <ChevronDown className="h-4 w-4 rotate-180" />
                {language === "zh" ? "时间降序" : "Newest first"}
              </button>
              <button onClick={() => setBulkMode(true)} className="transition hover:text-neutral-200">
                {language === "zh" ? "批量操作" : "Bulk actions"}
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-6 pt-7">
          {groups.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 px-8 py-16 text-center text-sm text-neutral-500">
              {language === "zh" ? "当前分类下还没有历史资产" : "No history assets in this tab yet"}
            </div>
          ) : (
            <div className="space-y-8">
              {groups.map((group) => {
                const groupIds = group.items.map((item) => item.id);
                const groupSelected = groupIds.length > 0 && groupIds.every((id) => selectedIds.includes(id));

                return (
                  <section key={group.dateKey}>
                    <div className="mb-4 flex items-center gap-3 text-lg font-semibold text-neutral-100">
                      {bulkMode ? (
                        <button
                          onClick={() => toggleGroup(groupIds)}
                          className="rounded-md border border-white/15 p-0.5 text-neutral-300 transition hover:bg-white/5"
                        >
                          {groupSelected ? <Check className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                        </button>
                      ) : null}
                      <span>{group.dateLabel}</span>
                    </div>

                    <div
                      className="grid gap-4"
                      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${layout.tileWidth}px, 1fr))` }}
                    >
                      {group.items.map((item) => {
                        const selected = selectedIds.includes(item.id);
                        const assetUrl = getHistoryItemAssetUrl(item, apiBaseUrl);
                        const previewable = canPreviewHistoryItem(item, apiBaseUrl);

                        return (
                          <article
                            key={item.id}
                            onClick={() => {
                              if (!bulkMode && previewable) {
                                setPreviewItem(item);
                              }
                            }}
                            onMouseMove={(event) => {
                              const r = event.currentTarget.getBoundingClientRect();
                              event.currentTarget.style.setProperty("--spot-x", `${event.clientX - r.left}px`);
                              event.currentTarget.style.setProperty("--spot-y", `${event.clientY - r.top}px`);
                            }}
                            className={`group relative overflow-hidden rounded-2xl border bg-[#1f1f1f] transition ${
                              selected ? "border-cyan-400/40 shadow-[0_0_0_1px_rgba(34,211,238,0.18)]" : "border-white/8 hover:border-white/15"
                            } ${!bulkMode && previewable ? "cursor-pointer" : ""}`}
                          >
                            {/* Spotlight glow following the cursor (React Bits "Spotlight Card"). */}
                            <div
                              className="pointer-events-none absolute inset-0 z-[1] opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                              style={{ background: "radial-gradient(190px circle at var(--spot-x, 50%) var(--spot-y, 50%), rgba(34, 211, 238, 0.14), transparent 60%)" }}
                            />
                            <div className="relative">
                              {bulkMode ? (
                                <button
                                  type="button"
                                  onClick={() => toggleItem(item.id)}
                                  className="absolute left-3 top-3 z-10 rounded-md border border-white/15 bg-black/35 p-0.5 text-neutral-200 backdrop-blur"
                                >
                                  {selected ? <Check className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                                </button>
                              ) : null}

                              {!bulkMode && assetUrl ? (
                                <div className="absolute right-3 top-3 z-10 flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                                  {previewable ? (
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setPreviewItem(item);
                                      }}
                                      className="rounded-md border border-white/15 bg-black/40 p-1.5 text-neutral-200 backdrop-blur transition hover:bg-black/60"
                                    >
                                      <Eye className="h-3.5 w-3.5" />
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      triggerDownload(assetUrl, item.title || item.id);
                                    }}
                                    className="rounded-md border border-white/15 bg-black/40 p-1.5 text-neutral-200 backdrop-blur transition hover:bg-black/60"
                                  >
                                    <Download className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              ) : null}

                              {item.mediaType === "image" && assetUrl ? (
                                <img src={toRenderableMediaUrl(assetUrl)} alt={item.title} className={`${layout.previewClassName} h-full w-full object-cover`} />
                              ) : null}
                              {item.mediaType === "video" && assetUrl ? (
                                <video src={toRenderableMediaUrl(assetUrl)} className={`${layout.previewClassName} h-full w-full object-cover`} muted />
                              ) : null}
                              {item.mediaType === "audio" ? (
                                <div className={`${layout.previewClassName} flex items-center justify-center bg-gradient-to-br from-neutral-800 to-neutral-900`}>
                                  <Music2 className="h-10 w-10 text-neutral-500" />
                                </div>
                              ) : null}
                            </div>

                            <div className="px-3 py-3">
                              <div className="line-clamp-2 text-sm text-neutral-100">{item.title}</div>
                              {item.promptExcerpt ? (
                                <div className="mt-1 line-clamp-2 text-xs leading-5 text-neutral-500">{item.promptExcerpt}</div>
                              ) : null}
                              <div className="mt-3 flex items-center gap-2 text-[11px] text-neutral-500">
                                {item.mediaType === "image" ? <ImageIcon className="h-3.5 w-3.5" /> : null}
                                {item.mediaType === "video" ? <Video className="h-3.5 w-3.5" /> : null}
                                {item.mediaType === "audio" ? <Music2 className="h-3.5 w-3.5" /> : null}
                                <span>{new Date(item.timestamp).toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}</span>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {previewItem && previewUrl ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/78 backdrop-blur-sm" onClick={() => setPreviewItem(null)} />
          <div className="relative z-10 w-[min(980px,calc(100vw-64px))] overflow-hidden rounded-[24px] border border-white/10 bg-[#171717]/98 shadow-[0_24px_80px_rgba(0,0,0,0.55)]">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-neutral-100">{previewItem.title}</div>
                <div className="mt-1 text-xs text-neutral-500">
                  {new Date(previewItem.timestamp).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-neutral-400">
                  {previewCursor ? `${previewCursor.currentIndex + 1} / ${previewCursor.total}` : "1 / 1"}
                </span>
                <button
                  type="button"
                  onClick={() => triggerDownload(previewUrl, previewItem.title || previewItem.id)}
                  className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-200 transition hover:bg-white/10"
                >
                  <Download className="h-4 w-4" />
                  {language === "zh" ? "下载" : "Download"}
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewItem(null)}
                  className="rounded-md p-1 text-neutral-500 transition hover:bg-white/5 hover:text-neutral-200"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="max-h-[75vh] overflow-auto bg-[#111] p-5">
              <div className="mb-4 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => movePreview("previous")}
                  disabled={!previewCursor?.hasPrevious}
                  className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-200 transition enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronLeft className="h-4 w-4" />
                  {language === "zh" ? "上一项" : "Previous"}
                </button>
                <button
                  type="button"
                  onClick={() => movePreview("next")}
                  disabled={!previewCursor?.hasNext}
                  className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-200 transition enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {language === "zh" ? "下一项" : "Next"}
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>

              {previewItem.mediaType === "image" ? (
                <img src={toRenderableMediaUrl(previewUrl)} alt={previewItem.title} className="mx-auto max-h-[68vh] max-w-full rounded-2xl object-contain" />
              ) : null}
              {previewItem.mediaType === "video" ? (
                <video src={toRenderableMediaUrl(previewUrl)} className="mx-auto max-h-[68vh] max-w-full rounded-2xl bg-black" controls autoPlay />
              ) : null}
              {previewItem.mediaType === "audio" ? (
                <div className="flex min-h-[320px] flex-col items-center justify-center gap-6 rounded-3xl border border-white/8 bg-gradient-to-br from-neutral-900 to-neutral-950 p-10">
                  <Music2 className="h-14 w-14 text-neutral-500" />
                  <div className="text-center">
                    <div className="text-lg text-neutral-100">{previewItem.title}</div>
                    {previewItem.promptExcerpt ? (
                      <div className="mt-2 max-w-xl text-sm leading-6 text-neutral-500">{previewItem.promptExcerpt}</div>
                    ) : null}
                  </div>
                  <audio src={toRenderableMediaUrl(previewUrl)} controls className="w-full max-w-xl" autoPlay />
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
