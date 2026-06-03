import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { History, Languages, LogOut, Moon, Settings as SettingsIcon, Shield, Sun, User as UserIcon, Zap } from "lucide-react";

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

  // Sync the chosen theme to <html data-theme=...> so CSS rules in globals.css
  // can react. Default 'dark' matches the existing palette.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    if (theme === "light") root.classList.add("theme-light");
    else root.classList.remove("theme-light");
  }, [theme]);

  return (
    <div className="absolute left-0 right-0 top-0 z-50 flex h-14 items-center justify-between border-b border-white/10 bg-black/40 px-6 backdrop-blur-md">
      <div className="flex items-center space-x-2">
        <img src={logoUrl} alt="CCY Canvas" className="h-7 w-7 rounded object-contain" />
        <span className="font-semibold tracking-wide text-neutral-200">CCY Canvas</span>
      </div>

      <div className="flex items-center space-x-2">
        <button
          onClick={toggleLanguage}
          className="flex items-center space-x-1.5 rounded-md px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-white/5"
        >
          <Languages className="h-3.5 w-3.5" />
          <span>{language === "en" ? "EN" : "\u4e2d\u6587"}</span>
        </button>

        {user && creditSummary ? (
          <div className="flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11px] text-neutral-300">
            <Zap className="h-3 w-3 text-amber-400" />
            <span className="tabular-nums">{creditSummary.current_balance}</span>
            <span className="text-neutral-600">/</span>
            <span className="tabular-nums text-neutral-500">{creditSummary.daily_quota}</span>
          </div>
        ) : null}

        {user ? <TaskQueue /> : null}

        {!user ? (
          <button
            onClick={() => navigate("/login")}
            className="rounded-md bg-cyan-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cyan-500"
          >
            {dict.login}
          </button>
        ) : (
          <div className="relative">
            <button onClick={() => setMenuOpen((open) => !open)} className="flex items-center">
              {user.avatar ? (
                <img src={user.avatar} alt={user.name} className="h-8 w-8 rounded-full border border-white/15" />
              ) : (
                <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-cyan-500/20 text-xs text-cyan-200">
                  {user.name.slice(0, 1).toUpperCase()}
                </div>
              )}
            </button>

            {menuOpen ? (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border border-white/10 bg-[#15181d]/95 py-1.5 shadow-2xl backdrop-blur-xl">
                  <div className="border-b border-white/5 px-3 py-2">
                    <div className="text-sm text-neutral-200">{user.name}</div>
                    <div className="text-[11px] text-neutral-500">{user.email}</div>
                  </div>
                  <MenuItem icon={UserIcon} label={dict.profile} onClick={() => { setMenuOpen(false); setProfileOpen(true); }} />
                  <MenuItem icon={History} label={dict.history} onClick={() => { setMenuOpen(false); setProfileOpen(true); }} />
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
