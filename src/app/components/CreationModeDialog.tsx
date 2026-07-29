import {
  ArrowRight,
  Bot,
  Check,
  MousePointer2,
  Sparkles,
  X,
} from "lucide-react";

type CreationMode = "free" | "automation";

type Props = {
  open: boolean;
  busy: boolean;
  zh: boolean;
  onClose: () => void;
  onSelect: (mode: CreationMode) => void;
};

const modes: Array<{
  key: CreationMode;
  icon: typeof MousePointer2;
  titleZh: string;
  titleEn: string;
  descriptionZh: string;
  descriptionEn: string;
  featuresZh: string[];
  featuresEn: string[];
}> = [
  {
    key: "free",
    icon: MousePointer2,
    titleZh: "自由模式",
    titleEn: "Free canvas",
    descriptionZh: "直接进入无限画布，自由添加和连接文本、图片、视频与音频节点。",
    descriptionEn: "Enter the infinite canvas and build a node workflow freely.",
    featuresZh: ["自由编排节点", "随时调用生成模型", "适合探索式创作"],
    featuresEn: ["Arrange nodes freely", "Run any generation model", "Best for exploration"],
  },
  {
    key: "automation",
    icon: Bot,
    titleZh: "全自动模式",
    titleEn: "Automated production",
    descriptionZh: "从剧本开始，由系统整理资产并推进到分镜与线稿生产。",
    descriptionEn: "Start from a script, organize assets, then prepare storyboards and line-art tasks.",
    featuresZh: ["剧本自动拆解", "人物 / 场景 / 道具 / 音频", "资产锁定后生成分镜"],
    featuresEn: ["Automatic script breakdown", "Production asset library", "Storyboard after asset lock"],
  },
];

export function CreationModeDialog({ open, busy, zh, onClose, onSelect }: Props) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/75 px-5 py-8 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="creation-mode-title"
      data-testid="creation-mode-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="relative w-full max-w-[860px] overflow-hidden rounded-[28px] border border-white/10 bg-[#18191d] shadow-[0_32px_100px_rgba(0,0,0,0.72)]">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(70%_120%_at_50%_0%,rgba(255,91,36,0.13),transparent_70%)]" />
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label={zh ? "关闭" : "Close"}
          className="absolute right-5 top-5 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-neutral-400 transition hover:bg-white/[0.09] hover:text-white disabled:opacity-40"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="relative px-7 pb-7 pt-9 sm:px-10 sm:pb-10">
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-2xl border border-[#ff6a33]/25 bg-[#ff5b24]/10 text-[#ff7847]">
              <Sparkles className="h-5 w-5" />
            </div>
            <h2 id="creation-mode-title" className="text-[24px] font-semibold tracking-tight text-white">
              {zh ? "选择创作模式" : "Choose how to create"}
            </h2>
            <p className="mt-2 text-[13px] text-neutral-500">
              {zh ? "模式只决定起步方式，之后仍可回到自由画布继续编辑。" : "This only changes how you start. You can continue on the canvas later."}
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {modes.map((mode) => {
              const Icon = mode.icon;
              const automated = mode.key === "automation";
              return (
                <button
                  key={mode.key}
                  type="button"
                  disabled={busy}
                  onClick={() => onSelect(mode.key)}
                  data-testid={`creation-mode-${mode.key}`}
                  className={`group relative min-h-[286px] overflow-hidden rounded-[22px] border p-6 text-left transition duration-300 disabled:cursor-wait disabled:opacity-60 ${
                    automated
                      ? "border-[#ff6633]/30 bg-[#ff5b24]/[0.055] hover:border-[#ff7448]/60 hover:bg-[#ff5b24]/[0.09]"
                      : "border-white/10 bg-white/[0.025] hover:border-white/25 hover:bg-white/[0.055]"
                  }`}
                >
                  {automated ? (
                    <span className="absolute right-4 top-4 rounded-full border border-[#ff6b39]/25 bg-[#ff5b24]/10 px-2.5 py-1 text-[10px] font-medium tracking-wide text-[#ff946e]">
                      {zh ? "推荐长流程" : "FOR PRODUCTIONS"}
                    </span>
                  ) : null}

                  <span className={`mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border ${
                    automated
                      ? "border-[#ff6b39]/25 bg-[#ff5b24]/10 text-[#ff7b4c]"
                      : "border-white/10 bg-white/[0.055] text-neutral-300"
                  }`}>
                    <Icon className="h-5 w-5" />
                  </span>

                  <h3 className="text-[18px] font-semibold text-neutral-100">
                    {zh ? mode.titleZh : mode.titleEn}
                  </h3>
                  <p className="mt-2 min-h-[42px] text-[12.5px] leading-5 text-neutral-500">
                    {zh ? mode.descriptionZh : mode.descriptionEn}
                  </p>

                  <ul className="mt-5 space-y-2.5">
                    {(zh ? mode.featuresZh : mode.featuresEn).map((feature) => (
                      <li key={feature} className="flex items-center gap-2 text-[12px] text-neutral-400">
                        <span className={`flex h-4 w-4 items-center justify-center rounded-full ${
                          automated ? "bg-[#ff5b24]/15 text-[#ff885d]" : "bg-white/[0.07] text-neutral-500"
                        }`}>
                          <Check className="h-2.5 w-2.5" />
                        </span>
                        {feature}
                      </li>
                    ))}
                  </ul>

                  <span className={`absolute bottom-5 right-5 flex h-9 w-9 items-center justify-center rounded-full border transition ${
                    automated
                      ? "border-[#ff6b39]/25 bg-[#ff5b24]/10 text-[#ff8b61] group-hover:translate-x-1 group-hover:bg-[#ff5b24]/20"
                      : "border-white/10 bg-white/[0.04] text-neutral-500 group-hover:translate-x-1 group-hover:text-neutral-200"
                  }`}>
                    <ArrowRight className="h-4 w-4" />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
