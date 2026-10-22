import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { X, BarChart3 } from "lucide-react";

import { t } from "../i18n";
import { useStore } from "../store";
import { HistoryAssetsModal } from "./HistoryAssetsModal";
import { ProfileSettingsModal } from "./ProfileSettingsModal";

const ModalOverlay = ({
  isOpen,
  onClose,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen || !overlayRef.current || !panelRef.current) {
      return;
    }

    const mm = gsap.matchMedia();
    let ctx: gsap.Context | null = null;

    mm.add(
      {
        reduceMotion: "(prefers-reduced-motion: reduce)",
        noPreference: "(prefers-reduced-motion: no-preference)",
      },
      ({ conditions }) => {
        if (conditions?.reduceMotion) {
          gsap.set([overlayRef.current, panelRef.current], {
            clearProps: "all",
            autoAlpha: 1,
            y: 0,
            scale: 1,
          });
          return;
        }

        ctx = gsap.context(() => {
          gsap.fromTo(
            overlayRef.current,
            { autoAlpha: 0 },
            { autoAlpha: 1, duration: 0.18, ease: "power2.out" },
          );

          gsap.fromTo(
            panelRef.current,
            { autoAlpha: 0, y: 18, scale: 0.985 },
            { autoAlpha: 1, y: 0, scale: 1, duration: 0.26, ease: "power3.out" },
          );
        });
      },
    );

    return () => {
      ctx?.revert();
      mm.revert();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div ref={panelRef} className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#0c0e11] shadow-2xl">
        {children}
      </div>
    </div>
  );
};

export const Modals = () => {
  const {
    language,
    isDashboardOpen,
    setDashboardOpen,
  } = useStore();
  const dict = t[language];
  const zh = language === "zh";

  return (
    <>
      <HistoryAssetsModal />
      <ProfileSettingsModal />

      <ModalOverlay isOpen={isDashboardOpen} onClose={() => setDashboardOpen(false)}>
        <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-6 py-4">
          <div className="flex items-center space-x-2 text-neutral-200">
            <BarChart3 className="h-5 w-5 text-cyan-500" />
            <span className="font-semibold">{dict.usage_dash}</span>
          </div>
          <button onClick={() => setDashboardOpen(false)} className="text-neutral-500 transition hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="mb-1 text-xs text-neutral-500">{zh ? "总渲染时长" : "Total Render Time"}</div>
              <div className="text-2xl font-semibold text-neutral-200">12h 45m</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="mb-1 text-xs text-neutral-500">{zh ? "生成资产" : "Generated Assets"}</div>
              <div className="text-2xl font-semibold text-neutral-200">1,204</div>
            </div>
          </div>
        </div>
      </ModalOverlay>
    </>
  );
};
