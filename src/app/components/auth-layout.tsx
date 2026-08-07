import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { gsap } from "gsap";

import { getUserMotionPreset, userMotionTokens } from "./motion/user-motion";
import logoUrl from "../../imports/logo-login.png";
import loginVideoUrl from "../../imports/login-background.mp4";

export function AuthLayout({
  children,
  subtitle,
  title,
}: {
  children: ReactNode;
  subtitle: string;
  title: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const visualRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    const mm = gsap.matchMedia();
    const ctx = gsap.context(() => {
      mm.add(
        {
          reduceMotion: "(prefers-reduced-motion: reduce)",
          noPreference: "(prefers-reduced-motion: no-preference)",
        },
        ({ conditions }) => {
          const reduceMotion = Boolean(conditions?.reduceMotion);
          const items = gsap.utils.toArray<HTMLElement>("[data-auth-item]");
          const visual = visualRef.current;
          const shell = formRef.current;

          if (reduceMotion) {
            gsap.set([visual, shell, ...items], {
              clearProps: "all",
              autoAlpha: 1,
              x: 0,
              y: 0,
              scale: 1,
            });
            return;
          }

          const basePreset = getUserMotionPreset(false);

          gsap.set(shell, { autoAlpha: 1 });

          if (visual) {
            gsap.from(visual, {
              autoAlpha: 0,
              scale: 1.035,
              duration: userMotionTokens.enter.slow,
              ease: userMotionTokens.ease.emphasized,
            });
          }

          gsap.from(items, {
            ...basePreset,
            duration: userMotionTokens.enter.base,
            stagger: userMotionTokens.stagger.base,
            ease: userMotionTokens.ease.emphasized,
          });
        },
      );
    }, root);

    return () => {
      ctx.revert();
      mm.revert();
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const freezeOnEnd = () => {
      video.pause();
      if (Number.isFinite(video.duration)) {
        video.currentTime = Math.max(0, video.duration - 0.05);
      }
    };

    video.addEventListener("ended", freezeOnEnd);
    return () => {
      video.removeEventListener("ended", freezeOnEnd);
    };
  }, []);

  const replayBackground = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.currentTime = 0;
    void video.play();
  };

  return (
    <div
      ref={rootRef}
      className="relative min-h-screen overflow-hidden bg-[#07080c] text-white"
    >
      <div ref={visualRef} data-auth-visual className="absolute inset-0 cursor-pointer" onClick={replayBackground}>
        <video
          ref={videoRef}
          src={loginVideoUrl}
          className="h-full w-full object-cover object-center"
          autoPlay
          muted
          playsInline
          aria-hidden="true"
        />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_50%,rgba(15,18,25,0.06),rgba(6,7,10,0.18)_58%,rgba(6,7,10,0.58)_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(6,7,10,0.06)_0%,rgba(6,7,10,0.10)_66%,rgba(6,7,10,0.36)_82%,rgba(6,7,10,0.68)_100%)]" />
      </div>

      <div className="pointer-events-none relative z-10 flex min-h-screen items-center justify-center px-5 py-10 sm:px-8 lg:justify-end lg:px-12 xl:px-16">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 84% 70%, rgba(255,91,22,0.10), transparent 15%), radial-gradient(circle at 30% 20%, rgba(255,255,255,0.03), transparent 18%), linear-gradient(180deg, rgba(22,25,32,0.06) 0%, rgba(13,16,22,0.14) 100%)",
          }}
        />
        <div className="pointer-events-none absolute inset-0 opacity-[0.045] [background-image:linear-gradient(rgba(255,255,255,0.16)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.16)_1px,transparent_1px)] [background-size:96px_96px]" />

        <div
          ref={formRef}
          className="pointer-events-auto relative z-10 w-full max-w-[444px] rounded-[28px] border border-white/12 bg-[linear-gradient(180deg,rgba(28,32,40,0.42),rgba(17,20,28,0.50))] px-7 py-9 shadow-[0_26px_76px_rgba(0,0,0,0.44)] backdrop-blur-[24px] sm:px-10 sm:py-11"
          data-auth-shell
        >
          <div className="mb-8 flex flex-col items-center text-center">
            <img data-auth-item="logo" src={logoUrl} alt={title} className="h-[78px] w-[78px] object-contain" />
            <h1 data-auth-item="title" className="mt-6 text-[56px] font-semibold leading-none tracking-[0.06em] text-white">
              {title}
            </h1>
            <p data-auth-item="subtitle" className="mt-3 text-[15px] text-white/64 sm:text-[16px]">
              {subtitle}
            </p>
          </div>

          <div data-auth-item="form">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function AuthField({
  icon,
  label,
  onChange,
  placeholder,
  trailing,
  type,
  value,
}: {
  icon: ReactNode;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  trailing?: ReactNode;
  type: string;
  value: string;
}) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <div className="flex h-[56px] items-center rounded-[12px] border border-white/14 bg-[linear-gradient(180deg,rgba(22,26,33,0.60),rgba(15,18,25,0.66))] px-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition focus-within:border-[#ff6d30]/70 focus-within:shadow-[0_0_0_1px_rgba(255,109,48,0.28)]">
        <div className="mr-3.5 shrink-0">{icon}</div>
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 border-none bg-transparent text-[16px] text-white placeholder:text-white/40 focus:outline-none"
        />
        {trailing ? <div className="ml-4 shrink-0">{trailing}</div> : null}
      </div>
    </label>
  );
}
