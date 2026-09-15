import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, Crown, FolderOpen, Save, Settings, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../auth/AuthProvider";
import { useStore } from "../store";
import { TaskQueue } from "./TaskQueue";
import { CollaborationControls } from "./CollaborationControls";
import { CreditLedgerModal } from "./CreditLedgerModal";
import { UserAvatar } from "./UserAvatar";
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
