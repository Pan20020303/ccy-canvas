import { useState } from "react";
import { useNavigate } from "react-router";
import { History, Languages, LogOut, Settings as SettingsIcon, Shield, User as UserIcon } from "lucide-react";

import { useAuth } from "../auth/AuthProvider";
import { t } from "../i18n";
import { useStore } from "../store";
import logoUrl from "../../imports/logo.png";
import { TaskQueue } from "./TaskQueue";

export const Navbar = () => {
  const { language, toggleLanguage, setProfileOpen, setSettingsOpen } = useStore();
  const { user, logout } = useAuth();
  const dict = t[language];
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

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
