import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, Languages, LogOut, Moon, Settings as SettingsIcon, Shield, Sun, User as UserIcon, Zap } from "lucide-react";
import { gsap } from "gsap";

import { useAuth } from "../auth/AuthProvider";
import { t } from "../i18n";
import { useStore } from "../store";
import logoUrl from "../../imports/logo.png";
import { TaskQueue } from "./TaskQueue";

export const Navbar = () => {
  const { language, toggleLanguage, setProfileOpen, setSettingsOpen } = useStore();
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const agentPanelOpen = useStore((s) => s.agentPanelOpen);
  const { user, creditSummary, logout, refreshCredits } = useAuth();
  const dict = t[language];
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Sync the chosen theme to <html data-theme=...> so CSS rules in globals.css
  // can react. Default 'dark' matches the existing palette.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    if (theme === "light") root.classList.add("theme-light");
    else root.classList.remove("theme-light");
  }, [theme]);

  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    const mm = gsap.matchMedia();
    const ctx = gsap.context(() => {
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(root, {
          autoAlpha: 0,
          y: -12,
          duration: 0.34,
          ease: "power2.out",
        });
      });
    }, root);

    return () => {
      ctx.revert();
      mm.revert();
    };
  }, []);

  useEffect(() => {
    if (!menuOpen || !menuRef.current) {
      return;
    }

    const menu = menuRef.current;
    gsap.fromTo(
      menu,
      { autoAlpha: 0, y: -8, scale: 0.98 },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.22, ease: "power2.out" },
    );
  }, [menuOpen]);

  // Keep the credit pill in sync with server-side balance:
  //   · refresh whenever the tab regains focus (covers in-flight tasks that
  //     completed in another tab, or balance changes from admin tools)
  //   · refresh whenever an in-flight generation settles (activeRun null←non-null)
  //   · poll once a minute as a low-cost safety net
  // CRITICAL: these paths use refreshCredits (user + balance ONLY). The full
  // refresh() reloads models AND projects — which replaced the live canvas
  // with the first backend project and wiped the undo stack once a minute.
  useEffect(() => {
    if (!user) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshCredits();
    };
    document.addEventListener("visibilitychange", onVisible);
    const intervalId = window.setInterval(() => { void refreshCredits(); }, 60_000);

    // Subscribe to activeRun transitions: any "running → idle" edge means
    // a generation just settled (success / failure / refund), so the
    // balance probably changed — fetch the new number now instead of
    // waiting up to a minute for the polling tick.
    let prevActive = useStore.getState().activeRun;
    const unsubscribe = useStore.subscribe((state) => {
      const next = state.activeRun;
      if (prevActive && !next) void refreshCredits();
      prevActive = next;
    });

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(intervalId);
      unsubscribe();
    };
  }, [user, refreshCredits]);

  // Floating layout: the navbar no longer occupies a horizontal strip \u2014 the
  // canvas runs edge-to-edge under it. The logo and the controls cluster sit
  // as independent rounded pills that hover over the canvas, so the actual
  // workspace area is uninterrupted.
  const pillBase = "rounded-full border border-white/[0.10] bg-black/55 backdrop-blur-xl shadow-[0_10px_32px_-12px_rgba(0,0,0,0.65)]";

  return (
    <div
      ref={rootRef}
      style={{ right: agentPanelOpen ? 480 : 0 }}
      className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-start justify-between px-5 pt-4 transition-[right] duration-200 ease-out"
    >
      {/* Left: logo pill + 返回 — both routes back to the project homepage. */}
      <div className="pointer-events-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => navigate('/home')}
          title={language === 'zh' ? '返回首页' : 'Back to home'}
          className={`flex items-center gap-2 ${pillBase} px-3 py-1.5 transition hover:bg-black/70`}
        >
          <img src={logoUrl} alt="CCY Canvas" className="h-6 w-6 rounded object-contain" />
          <span className="text-[13px] font-semibold tracking-wide text-neutral-100">CCY Canvas</span>
        </button>
        <button
          type="button"
          onClick={() => navigate('/home')}
          className={`flex h-9 items-center gap-1.5 ${pillBase} px-3 text-[12px] text-neutral-200 transition hover:-translate-y-0.5 hover:bg-black/70`}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {language === 'zh' ? '返回' : 'Back'}
        </button>
      </div>

      {/* Right: controls cluster */}
      <div className="pointer-events-auto flex items-center gap-2">
        {/* Icon-only language toggle (reference proportions); the current
            language lives in the tooltip. */}
        <button
          onClick={toggleLanguage}
          title={language === "en" ? "Language: EN \u2192 \u4e2d\u6587" : "\u8bed\u8a00: \u4e2d\u6587 \u2192 EN"}
          className={`flex h-9 w-9 items-center justify-center ${pillBase} text-neutral-200 transition hover:-translate-y-0.5 hover:bg-black/70`}
        >
          <Languages className="h-4 w-4" />
        </button>

        {user ? (
          // Show the pill whenever the user is logged in, even if the
          // credit summary hasn't loaded yet — falling back to `—` so the
          // pill doesn't visually disappear on transient backend errors
          // or before the first /auth/me response lands.
          <div className={`flex items-center gap-1 ${pillBase} px-3 py-1.5 text-[11px] text-neutral-200`}>
            <Zap className="h-3 w-3 text-amber-400" />
            <span className="tabular-nums">{creditSummary ? creditSummary.current_balance : "—"}</span>
            <span className="text-neutral-500">/</span>
            <span className="tabular-nums text-neutral-400">{creditSummary ? creditSummary.daily_quota : "—"}</span>
          </div>
        ) : null}

        {user ? <TaskQueue /> : null}

        {!user ? (
          <button
            onClick={() => navigate("/login")}
            className="rounded-full bg-cyan-600 px-4 py-1.5 text-xs font-medium text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-cyan-500"
          >
            {dict.login}
          </button>
        ) : (
          <div className="relative">
            <button
              onClick={() => setMenuOpen((open) => !open)}
              className={`flex items-center justify-center ${pillBase} h-9 w-9 p-0 transition hover:-translate-y-0.5 hover:bg-black/70`}
            >
              {user.avatar ? (
                <img src={user.avatar} alt={user.name} className="h-7 w-7 rounded-full object-cover" />
              ) : (
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan-500/20 text-xs text-cyan-200">
                  {user.name.slice(0, 1).toUpperCase()}
                </div>
              )}
            </button>

            {menuOpen ? (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div ref={menuRef} className="absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border border-white/10 bg-[#15181d]/95 py-1.5 shadow-2xl backdrop-blur-xl">
                  <div className="border-b border-white/5 px-3 py-2">
                    <div className="text-sm text-neutral-200">{user.name}</div>
                    <div className="text-[11px] text-neutral-500">{user.email}</div>
                  </div>
                  <MenuItem icon={UserIcon} label={dict.profile} onClick={() => { setMenuOpen(false); setProfileOpen(true); }} />
                  <MenuItem icon={SettingsIcon} label={language === "zh" ? "\u8bbe\u7f6e" : "Settings"} onClick={() => { setMenuOpen(false); setSettingsOpen(true); }} />
                  <ThemeToggleRow theme={theme} setTheme={setTheme} language={language} />
                  {user.role === "admin" ? (
                    <MenuItem icon={Shield} label={dict.admin_settings} onClick={() => { setMenuOpen(false); navigate("/admin"); }} />
                  ) : null}
                  <div className="my-1 border-t border-white/5" />
                  <MenuItem
                    icon={LogOut}
                    label={dict.logout}
                    onClick={async () => {
                      setMenuOpen(false);
                      await logout();
                      navigate("/login");
                    }}
                  />
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};

const MenuItem = ({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void | Promise<void>;
}) => (
  <button
    onClick={() => void onClick()}
    className="flex w-full items-center gap-2.5 px-3 py-2 text-xs text-neutral-300 transition hover:bg-white/5"
  >
    <Icon className="h-3.5 w-3.5 text-neutral-400" />
    <span>{label}</span>
  </button>
);

/** Light / Dark mode segmented toggle, styled like a pill with two icons. */
const ThemeToggleRow = ({
  theme,
  setTheme,
  language,
}: {
  theme: "dark" | "light";
  setTheme: (t: "dark" | "light") => void;
  language: "en" | "zh";
}) => (
  <div className="flex items-center justify-between px-3 py-2 text-xs text-neutral-300">
    <div className="flex items-center gap-2.5">
      {theme === "light" ? (
        <Sun className="h-3.5 w-3.5 text-neutral-400" />
      ) : (
        <Moon className="h-3.5 w-3.5 text-neutral-400" />
      )}
      <span>{language === "zh" ? "模式切换" : "Theme"}</span>
    </div>
    <div className="flex items-center rounded-full border border-white/10 bg-white/[0.04] p-0.5">
      <button
        type="button"
        onClick={() => setTheme("light")}
        title={language === "zh" ? "浅色模式" : "Light"}
        className={`flex h-5 w-7 items-center justify-center rounded-full transition ${
          theme === "light" ? "bg-white/15 text-white" : "text-neutral-500 hover:text-neutral-300"
        }`}
      >
        <Sun className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => setTheme("dark")}
        title={language === "zh" ? "深色模式" : "Dark"}
        className={`flex h-5 w-7 items-center justify-center rounded-full transition ${
          theme === "dark" ? "bg-white/15 text-white" : "text-neutral-500 hover:text-neutral-300"
        }`}
      >
        <Moon className="h-3 w-3" />
      </button>
    </div>
  </div>
);
