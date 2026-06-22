import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Languages, LogOut, Moon, Settings as SettingsIcon, Shield, Sun, User as UserIcon, Zap } from "lucide-react";
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
  const { user, creditSummary, logout } = useAuth();
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

  // Floating layout: the navbar no longer occupies a horizontal strip \u2014 the
  // canvas runs edge-to-edge under it. The logo and the controls cluster sit
  // as independent rounded pills that hover over the canvas, so the actual
  // workspace area is uninterrupted.
  const pillBase = "rounded-full border border-white/[0.10] bg-black/55 backdrop-blur-xl shadow-[0_10px_32px_-12px_rgba(0,0,0,0.65)]";

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-x-0 top-0 z-50 flex items-start justify-between px-5 pt-4">
      {/* Left: logo pill */}
      <div className={`pointer-events-auto flex items-center gap-2 ${pillBase} px-3 py-1.5`}>
        <img src={logoUrl} alt="CCY Canvas" className="h-6 w-6 rounded object-contain" />
        <span className="text-[13px] font-semibold tracking-wide text-neutral-100">CCY Canvas</span>
      </div>

      {/* Right: controls cluster */}
      <div className="pointer-events-auto flex items-center gap-2">
        <button
          onClick={toggleLanguage}
          className={`flex items-center gap-1.5 ${pillBase} px-3 py-1.5 text-xs text-neutral-200 transition hover:-translate-y-0.5 hover:bg-black/70`}
        >
          <Languages className="h-3.5 w-3.5" />
          <span>{language === "en" ? "EN" : "\u4e2d\u6587"}</span>
        </button>

        {user && creditSummary ? (
          <div className={`flex items-center gap-1 ${pillBase} px-3 py-1.5 text-[11px] text-neutral-200`}>
            <Zap className="h-3 w-3 text-amber-400" />
            <span className="tabular-nums">{creditSummary.current_balance}</span>
            <span className="text-neutral-500">/</span>
            <span className="tabular-nums text-neutral-400">{creditSummary.daily_quota}</span>
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
