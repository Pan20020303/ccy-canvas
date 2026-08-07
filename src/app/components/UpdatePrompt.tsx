import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";

import { CURRENT_VERSION, type Release } from "../version";

/**
 * Watches for a newly deployed frontend build and shows a NON-blocking card
 * (bottom-right) that lists, in plain language, what changed — and a "刷新更新"
 * button. We never auto-reload: the user updates when convenient, so no
 * in-progress work is interrupted.
 *
 * How it works: each release bumps src/app/releases.json (version + 大白话 notes)
 * and the build writes the newest entry into dist/version.json. A running (older)
 * tab polls /version.json; when the deployed version differs from CURRENT_VERSION
 * it shows this card with the deployed release's notes.
 */
const POLL_MS = 3 * 60 * 1000;

export function UpdatePrompt() {
  const [release, setRelease] = useState<Release | null>(null);
  const dismissedRef = useRef<string | null>(null);

  useEffect(() => {
    // Only meaningful in a real build — dev uses HMR and has no version.json.
    if (!import.meta.env.PROD) return;

    let stopped = false;

    const check = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/version.json?ts=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as Partial<Release>;
        const deployed = (data?.version ?? "").toString();
        if (!deployed || deployed === CURRENT_VERSION || deployed === dismissedRef.current) {
          return;
        }
        setRelease({
          version: deployed,
          date: (data?.date ?? "").toString(),
          notes: Array.isArray(data?.notes) ? data!.notes!.map(String) : [],
        });
      } catch {
        // Offline / transient — ignore and retry on the next tick.
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };

    check();
    const timer = window.setInterval(check, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, []);

  if (!release) return null;

  const dismiss = () => {
    dismissedRef.current = release.version; // stay quiet until an even newer build
    setRelease(null);
  };

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[200] flex justify-end p-4 sm:inset-x-auto sm:right-4">
      <div className="pointer-events-auto w-[min(92vw,360px)] overflow-hidden rounded-xl border border-white/12 bg-[#14161b]/95 text-white shadow-2xl backdrop-blur-xl">
        <div className="flex items-start gap-3 px-4 pt-3.5">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/20 text-violet-300">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              <span>发现新版本</span>
              <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[11px] text-white/80">
                v{release.version}
              </span>
            </div>
            <p className="mt-0.5 text-[11.5px] text-white/45">这次更新了这些:</p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white/40 transition hover:bg-white/10 hover:text-white/80"
            title="稍后"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {release.notes.length > 0 ? (
          <ul className="mt-1.5 space-y-1 px-4 text-[12.5px] leading-relaxed text-white/85">
            {release.notes.map((note, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-violet-300/80" />
                <span className="min-w-0">{note}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-3 flex items-center justify-end gap-2 border-t border-white/8 px-4 py-2.5">
          <button
            type="button"
            onClick={dismiss}
            className="rounded-md px-3 py-1.5 text-[12px] text-white/60 transition hover:bg-white/[0.06] hover:text-white/90"
          >
            稍后
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-violet-500 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-violet-400"
          >
            刷新更新
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
