import { X, BarChart3, User as UserIcon, History } from "lucide-react";

import { useAuth } from "../auth/AuthProvider";
import { t } from "../i18n";
import { useStore } from "../store";
import { HistoryAssetsModal } from "./HistoryAssetsModal";

const ModalOverlay = ({
  isOpen,
  onClose,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-[#0c0e11] shadow-2xl">
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
    isProfileOpen,
    setProfileOpen,
    history,
  } = useStore();
  const { user } = useAuth();
  const dict = t[language];
  const zh = language === "zh";

  return (
    <>
      <HistoryAssetsModal />

      <ModalOverlay isOpen={isProfileOpen} onClose={() => setProfileOpen(false)}>
        <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-6 py-4">
          <div className="flex items-center space-x-2 text-neutral-200">
            <UserIcon className="h-5 w-5 text-cyan-500" />
            <span className="font-semibold">{dict.profile}</span>
          </div>
          <button onClick={() => setProfileOpen(false)} className="text-neutral-500 transition hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-6 p-6">
          {user ? (
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-full border border-white/15 bg-cyan-500/20 text-lg text-cyan-200">
                {user.name.slice(0, 1).toUpperCase()}
              </div>
              <div>
                <div className="text-neutral-100">{user.name}</div>
                <div className="text-xs text-neutral-500">{user.email}</div>
                <div className="mt-1 text-[10px] uppercase tracking-wider text-neutral-500">{user.role}</div>
              </div>
            </div>
          ) : null}
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm text-neutral-300">
              <History className="h-4 w-4 text-neutral-400" />
              {dict.history}
            </div>
            <div className="max-h-60 space-y-1.5 overflow-y-auto">
              {history.map((item) => (
                <div key={item.id} className="flex items-center justify-between rounded-md border border-white/5 bg-white/[0.03] px-3 py-2 text-xs">
                  <div>
                    <div className="text-neutral-200">{item.title}</div>
                    <div className="text-neutral-500">{item.type}</div>
                  </div>
                  <div className="text-neutral-500">{new Date(item.timestamp).toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </ModalOverlay>

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
