import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, MousePointerClick, Plus, Rocket, Share2, Sparkles, X } from 'lucide-react';

// ─── 新手分步引导 ─────────────────────────────────────────────────────────
// 首次进入画布自动触发的产品导览:用居中卡片教会「加节点→写提示词→生成→
// 连线接力」的心智模型,不做像素级 spotlight(会被画布缩放/平移打乱)。
// localStorage 记录只弹一次;可从「使用指南」重看(replaySignal)。

const SEEN_KEY = 'ccy_onboarding_seen_v1';

type Step = {
  icon: React.ComponentType<{ className?: string }>;
  zhTitle: string; enTitle: string;
  zhDesc: string; enDesc: string;
};

const STEPS: Step[] = [
  {
    icon: Sparkles,
    zhTitle: '欢迎来到橙次元',
    enTitle: 'Welcome to CCY Canvas',
    zhDesc: '这是一块无限画布,你在上面摆「节点」、连「线」,把文字、图片、视频一步步生成出来。花 30 秒看完这几步,就能上手。',
    enDesc: 'An infinite canvas where you place nodes and wire them up to generate text, images and video step by step. 30 seconds and you are ready.',
  },
  {
    icon: Plus,
    zhTitle: '第一步 · 添加节点',
    enTitle: 'Step 1 · Add a node',
    zhDesc: '双击画布任意空白处,或点底部工具栏的图标,就能添加一个节点(图片 / 文本 / 视频…)。先加一个「图片」节点试试。',
    enDesc: 'Double-click any empty spot, or click an icon in the bottom toolbar, to add a node (image / text / video…). Try adding an Image node first.',
  },
  {
    icon: Sparkles,
    zhTitle: '第二步 · 写提示词生成',
    enTitle: 'Step 2 · Prompt & generate',
    zhDesc: '在节点下方的输入框写下你想要的画面,点右侧生成按钮(⚡ 会预估消耗积分),稍等片刻就出图。',
    enDesc: 'Type what you want in the box under the node, hit the generate button (⚡ shows the credit cost), and wait a moment for the result.',
  },
  {
    icon: Share2,
    zhTitle: '第三步 · 连线接力',
    enTitle: 'Step 3 · Wire nodes together',
    zhDesc: '从节点边缘拉一条线到下一个节点——上游的结果会自动喂给下游当参考。这就是节点画布的精髓:一步接一步地精修。',
    enDesc: 'Drag a line from a node edge to the next node — the upstream result feeds the downstream one as reference. This is the heart of a node canvas.',
  },
  {
    icon: Rocket,
    zhTitle: '开始创作吧',
    enTitle: 'Start creating',
    zhDesc: '随时点左下角的「?」可以重看本引导。现在,双击画布,做出你的第一个作品吧!',
    enDesc: 'Click the "?" at the bottom-left anytime to replay this tour. Now double-click the canvas and make your first piece!',
  },
];

type Props = { language: 'zh' | 'en'; replaySignal?: number };

export function OnboardingTour({ language, replaySignal = 0 }: Props) {
  const zh = language === 'zh';
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    try { return !window.localStorage.getItem(SEEN_KEY); } catch { return false; }
  });
  const [step, setStep] = useState(0);

  // 重看:replaySignal 递增时重新打开并回到第一步。
  useEffect(() => {
    if (replaySignal > 0) { setStep(0); setOpen(true); }
  }, [replaySignal]);

  const close = useCallback(() => {
    try { window.localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ }
    setOpen(false);
  }, []);

  if (!open) return null;
  const cur = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const Icon = cur.icon;

  return createPortal(
    <div className="fixed inset-0 z-[240] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm" data-testid="onboarding-tour">
      <div className="relative flex w-[440px] max-w-[92vw] flex-col rounded-2xl border border-white/10 bg-[#1a1d22]/98 p-6 shadow-2xl">
        <button
          type="button"
          onClick={close}
          data-testid="onboarding-skip"
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-400 transition hover:bg-white/[0.06]"
          title={zh ? '跳过' : 'Skip'}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-400/12 text-cyan-300">
          <Icon className="h-6 w-6" />
        </div>
        <div className="text-[17px] font-semibold text-neutral-100">{zh ? cur.zhTitle : cur.enTitle}</div>
        <p className="mt-2 text-[13px] leading-relaxed text-neutral-400">{zh ? cur.zhDesc : cur.enDesc}</p>

        {/* 进度点 */}
        <div className="mt-5 flex items-center gap-1.5" data-testid="onboarding-progress" data-step={step}>
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${i === step ? 'w-5 bg-cyan-400' : 'w-1.5 bg-white/15'}`}
            />
          ))}
        </div>

        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            onClick={close}
            className="text-[12px] text-neutral-500 transition hover:text-neutral-300"
          >
            {zh ? '跳过引导' : 'Skip'}
          </button>
          <div className="flex items-center gap-2">
            {step > 0 ? (
              <button
                type="button"
                onClick={() => setStep((s) => s - 1)}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[12px] text-neutral-300 transition hover:bg-white/[0.06]"
              >
                {zh ? '上一步' : 'Back'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => (isLast ? close() : setStep((s) => s + 1))}
              data-testid="onboarding-next"
              className="flex items-center gap-1 rounded-lg border border-cyan-400/40 bg-cyan-400/12 px-3 py-1.5 text-[12px] text-cyan-200 transition hover:bg-cyan-400/20"
            >
              {isLast ? (zh ? '开始创作' : 'Start') : (zh ? '下一步' : 'Next')}
              {isLast ? <MousePointerClick className="h-3.5 w-3.5" /> : <ArrowRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
