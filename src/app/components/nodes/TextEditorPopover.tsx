import { useEffect, useState } from "react";

export function TextEditorPopover({
  isOpen,
  initialValue,
  onClose,
  onSave,
}: {
  isOpen: boolean;
  initialValue: string;
  onClose: () => void;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initialValue);

  useEffect(() => {
    setDraft(initialValue);
  }, [initialValue]);

  if (!isOpen) return null;

  return (
    <div className="nodrag nopan absolute left-0 top-full z-50 mt-3 w-[420px] rounded-[20px] border border-white/12 bg-[#1f1f1f] p-4 shadow-2xl">
      <div className="mb-3 flex items-center gap-3 rounded-2xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-xs text-neutral-300">
        <span>H1</span>
        <span>H2</span>
        <span>H3</span>
        <span>¶</span>
        <span>B</span>
        <span>I</span>
        <span>≡</span>
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="输入内容..."
        className="min-h-[180px] w-full rounded-xl border border-white/10 bg-[#171717] p-3 text-sm text-neutral-100 outline-none"
      />
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2 text-sm text-neutral-300">
          取消
        </button>
        <button
          onClick={() => {
            onSave(draft);
            onClose();
          }}
          className="rounded-xl bg-white px-4 py-2 text-sm text-black"
        >
          保存
        </button>
      </div>
    </div>
  );
}
