import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AlertTriangle, ArrowLeft, Check, CloudOff, Crown, FolderOpen, Loader2, Moon, Save, Settings, Sparkles, Sun } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../auth/AuthProvider";
import { useStore } from "../store";
import { TaskQueue } from "./TaskQueue";
import { CollaborationControls } from "./CollaborationControls";
import { CreditLedgerModal } from "./CreditLedgerModal";
import { UserAvatar } from "./UserAvatar";
import { CanvasRecoveryPanel } from "./CanvasRecoveryPanel";
import { AccountCenter, type AccountTab } from "./home/AccountCenter";
import { CanvasSwitcher } from "./canvas-header/CanvasSwitcher";
import { prepareCanvasNavigation } from "./canvas-header/canvas-navigation";
import "./home/home.css";
import "./canvas-header/canvas-header.css";

export const Navbar = () => {
  const language = useStore(s => s.language);
  const setProfileOpen = useStore(s => s.setProfileOpen);
  const setSettingsOpen = useStore(s => s.setSettingsOpen);
  const panelOpen = useStore(s => s.agentPanelOpen);
  const panelWidth = useStore(s => s.agentPanelWidth);
  const panelResizing = useStore(s => s.agentPanelResizing);
  const project = useStore(s => s.backendProjects.find(p => p.id === s.activeBackendProjectId));
  const { user, creditSummary, logout, refreshCredits } = useAuth();
  const navigate = useNavigate();
  const zh = language === "zh";
  const [accountTab, setAccountTab] = useState<AccountTab | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const navigationBusy = useRef(false);

  // Refresh only the balance, never reload or replace the active canvas.
  useEffect(() => {
    if (!user) return;
    const visible = () => { if (document.visibilityState === "visible") void refreshCredits(); };
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(() => void refreshCredits(), 60_000);
    let previous = useStore.getState().activeRun;
    const unsubscribe = useStore.subscribe(state => {
      if (previous && !state.activeRun) void refreshCredits();
      previous = state.activeRun;
    });
    return () => { document.removeEventListener("visibilitychange", visible); window.clearInterval(timer); unsubscribe(); };
  }, [user, refreshCredits]);

  const leave = async (path: string) => {
    if (navigationBusy.current) return;
    navigationBusy.current = true;
    try { await prepareCanvasNavigation(); setAccountTab(null); navigate(path); }
    catch (error) { toast.error(error instanceof Error ? error.message : "暂时无法离开画布，请重试。"); }
    finally { navigationBusy.current = false; }
  };
  const save = async () => {
    const state = useStore.getState();
    if (!state.activeBackendProjectId) { toast.info("当前为本地画布，修改保存在此设备。"); return; }
    if (project?.my_role === "visitor") { toast.info("当前画布为只读权限。"); return; }
    if (!state.canvasHydrated || state.backendSyncing) { toast.info("画布尚未加载完成。"); return; }
    await state.saveCanvasToBackend({ force: true });
    if (useStore.getState().canvasSaveStatus === "error") toast.error("保存失败，请检查连接后重试。");
    else toast.success("画布已保存");
  };
  return <>
    <header className="canvas-navbar" data-agent-open={panelOpen} style={{ right: panelOpen ? panelWidth : 0, transition: panelResizing ? "none" : undefined }} aria-label={zh ? "画布导航" : "Canvas navigation"}>
      <div className="canvas-navbar-content">
        <CanvasSwitcher onHome={() => void leave("/home")} />
        <div className="canvas-top-actions">
          <TaskQueue variant="more" menuActions={[
            { label: zh ? "保存画布" : "Save canvas", icon: Save, onSelect: save },
            { label: zh ? "管理画布" : "Manage canvases", icon: FolderOpen, onSelect: () => leave("/home?view=canvases") },
            { label: zh ? "画布设置" : "Canvas settings", icon: Settings, onSelect: () => setSettingsOpen(true) },
            { label: zh ? "返回首页" : "Back to home", icon: ArrowLeft, onSelect: () => leave("/home") },
          ]} />
          {user && <CollaborationControls compact />}
          {user ? <>
            <div className="canvas-billing-pill">
              {!project?.is_collaborative && <button type="button" className="canvas-credit-button" onClick={() => setLedgerOpen(true)} aria-label={zh ? "查看积分明细" : "Credit details"} title={zh ? `可用积分 ${creditSummary?.current_balance ?? "—"} · 每日额度 ${creditSummary?.daily_quota ?? "—"}，点击查看明细` : "Balance and daily allowance"}>
                <Sparkles className="canvas-credit-star" size={15} /><span className="canvas-credit-amount">{creditSummary?.current_balance?.toLocaleString() ?? "—"}</span>
              </button>}
              <button type="button" className="canvas-membership-button" aria-label={zh ? "开通会员" : "Membership"} title={zh ? "会员订阅尚未开放，点击查看账户权益" : "Subscriptions are not available yet. View account access."} onClick={() => setAccountTab("profile")}><Crown className="canvas-membership-icon" size={15} /><span className="canvas-membership-label">{zh ? "开通会员" : "Membership"}</span></button>
            </div>
            <button type="button" className="canvas-account-button" aria-label={zh ? "我的账户" : "My account"} title={user.name} onClick={() => setAccountTab("profile")}><UserAvatar avatar={user.avatar} name={user.name} className="canvas-account-avatar" fallbackClassName="canvas-avatar-fallback" /></button>
          </> : <button type="button" className="canvas-login-button" onClick={() => navigate("/login")}>{zh ? "登录" : "Log in"}</button>}
        </div>
      </div>
    </header>
    <CreditLedgerModal open={ledgerOpen} onClose={() => setLedgerOpen(false)} language={language} />
    <AccountCenter tab={accountTab} onTab={setAccountTab} onEditProfile={() => { setAccountTab(null); setProfileOpen(true); }} onProjects={() => void leave("/home?view=canvases")} onAdmin={() => void leave("/admin")} onLogout={async () => { await prepareCanvasNavigation({ logout: true }); await logout(); navigate("/login"); }} />
  </>;
};

/** Save failures remain visible; conflicts pause retries and expose recovery.
 * Saved notices fade, while a retained local snapshot keeps its recovery entry. */
export const SaveStatusIndicator = ({ language }: { language: "zh" | "en" }) => {
  const status = useStore((s) => s.canvasSaveStatus);
  const retry = useStore((s) => s.retryCanvasSave);
  const activeProject = useStore((s) => s.activeBackendProjectId);
  const readOnly = useStore((s) => s.backendProjects.find(project => project.id === s.activeBackendProjectId)?.my_role === 'visitor');
  const conflict = useStore((s) => s.canvasSaveConflict);
  const saveError = useStore((s) => s.canvasSaveError);
  const recovery = useStore((s) => s.canvasRecovery);
  const recoveryError = useStore((s) => s.canvasRecoveryError);
  const [panelOpen, setPanelOpen] = useState(false);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [showSaved, setShowSaved] = useState(false);
  const zh = language === "zh";

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      // 恢复网络后自动重试上次失败的保存,不必等用户下一次编辑。
      const state = useStore.getState();
      const visitor = state.backendProjects.find(project => project.id === state.activeBackendProjectId)?.my_role === 'visitor';
      if (state.canvasSaveStatus === "error" && !state.canvasSaveConflict && !visitor) state.retryCanvasSave();
    };
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  useEffect(() => {
    if (status === "saved") {
      setShowSaved(true);
      const t = setTimeout(() => setShowSaved(false), 2500);
      return () => clearTimeout(t);
    }
  }, [status]);

  useEffect(() => {
    if ((!readOnly && (status === 'error' || conflict)) || recoveryError) setPanelOpen(true);
  }, [status, conflict, recoveryError, readOnly]);

  if (!activeProject && !recovery && !recoveryError) return null;
  const base = "flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[11px] transition";

  const hasSaveProblem = !readOnly && (conflict || status === 'error' || !online);
  if (hasSaveProblem || recovery || recoveryError) {
    const stateLabel = hasSaveProblem ? (conflict ? 'conflict' : !online ? 'offline' : 'error') : 'recovery';
    const label = stateLabel === 'conflict' ? (zh ? '保存冲突' : 'Save conflict')
      : stateLabel === 'offline' ? (zh ? '离线 · 未保存' : 'Offline · unsaved')
      : stateLabel === 'error' ? (zh ? '保存失败' : 'Save failed')
      : (zh ? '本地恢复' : 'Local recovery');
    return <div className="relative">
      <button type="button" data-testid="save-status" data-status={stateLabel} aria-expanded={panelOpen} aria-controls="canvas-recovery-panel"
        onClick={() => setPanelOpen(open => !open)} title={hasSaveProblem && saveError ? saveError : label}
        className={`${base} ${hasSaveProblem || recoveryError ? 'bg-amber-500/15 text-amber-300 hover:bg-amber-500/25' : 'bg-white/[0.06] text-neutral-300 hover:bg-white/10'}`}>
        {stateLabel === 'offline' ? <CloudOff className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}<span>{label}</span>
      </button>
      {panelOpen ? <CanvasRecoveryPanel zh={zh} online={online} readOnly={readOnly} activeProject={Boolean(activeProject)} conflict={conflict}
        saveError={saveError} recovery={recovery} recoveryError={recoveryError} onRetry={retry}
        onSaveBackup={() => useStore.getState().saveCanvasRecovery()} onDownload={() => useStore.getState().downloadCanvasRecovery()}
        onReload={() => useStore.getState().reloadActiveCanvas()} onRestore={() => useStore.getState().restoreCanvasRecoveryCopy()}
        onClose={() => setPanelOpen(false)} /> : null}
    </div>;
  }
  if (readOnly) return null;

  if (status === "saving") {
    return (
      <div data-testid="save-status" data-status="saving" className={`${base} bg-white/[0.04] text-neutral-400`}>
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>{zh ? "保存中…" : "Saving…"}</span>
      </div>
    );
  }
  if (status === "saved" && showSaved) {
    return (
      <div data-testid="save-status" data-status="saved" className={`${base} text-neutral-500`}>
        <Check className="h-3 w-3" />
        <span>{zh ? "已保存" : "Saved"}</span>
      </div>
    );
  }
  return null;
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
