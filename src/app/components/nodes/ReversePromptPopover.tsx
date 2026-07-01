import { toRenderableMediaUrl } from '../../reference-media';

export function ReversePromptPopover({
  isOpen,
  imageUrl,
  draft,
  models,
  selectedModel,
  disabledReason,
  submitting,
  onChangeDraft,
  onChangeModel,
  onSubmit,
  onClose,
}: {
  isOpen: boolean;
  imageUrl: string | null;
  draft: string;
  models: Array<{ label: string; value: string }>;
  selectedModel: string;
  disabledReason?: string;
  submitting?: boolean;
  onChangeDraft: (value: string) => void;
  onChangeModel: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  if (!isOpen) return null;

  return (
    <div className="nodrag nopan absolute left-0 top-full z-50 mt-3 w-[520px] rounded-[24px] border border-white/12 bg-[#1f1f1f] p-4 shadow-2xl">
      <div className="mb-3 flex items-start gap-3">
        {imageUrl ? <img src={toRenderableMediaUrl(imageUrl)} alt="" className="h-12 w-12 rounded-xl object-cover" /> : null}
        <p className="text-sm text-neutral-200">
          根据图片生成结构化中文提示词，包括主体描述、环境、光影、镜头语言、风格关键词。
        </p>
      </div>
      <textarea
        value={draft}
        onChange={(event) => onChangeDraft(event.target.value)}
        className="min-h-[180px] w-full rounded-xl border border-white/10 bg-[#171717] p-3 text-sm text-neutral-100 outline-none"
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <select
          value={selectedModel}
          onChange={(event) => onChangeModel(event.target.value)}
          className="min-w-[180px] rounded-xl border border-white/10 bg-[#171717] px-3 py-2 text-sm text-neutral-100 outline-none"
        >
          {models.map((model) => (
            <option key={model.value} value={model.value}>
              {model.label}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-neutral-300">
            关闭
          </button>
          <button
            onClick={onSubmit}
            disabled={!imageUrl || !selectedModel || Boolean(disabledReason) || submitting}
            className="rounded-xl bg-white px-4 py-2 text-sm text-black disabled:opacity-40"
          >
            {submitting ? "处理中..." : "发送"}
          </button>
        </div>
      </div>
      {disabledReason ? <div className="mt-2 text-xs text-rose-300">{disabledReason}</div> : null}
    </div>
  );
}
