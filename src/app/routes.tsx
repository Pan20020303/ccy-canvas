import { createBrowserRouter, Navigate } from "react-router";
import { lazy, Suspense, useEffect } from "react";
import { useCanvasThemeStyle } from "./use-canvas-theme";
import './components/canvas-surfaces.css';
import { CanvasGenerationNotifications } from "./components/settings/CanvasPreferencesRuntime";

import { listAppProviderConfigs } from "./api/providerConfigs";
import { useAuth } from "./auth/AuthProvider";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { AdminCreditLedgerPage } from "./components/admin/AdminCreditLedgerPage";
import { AdminAnnouncementsPage } from "./components/admin/AdminAnnouncementsPage";
import { AdminInvitationsPage } from "./components/admin/AdminInvitationsPage";
import { AdminLogsPage } from "./components/admin/AdminLogsPage";
import { AdminMembersPage } from "./components/admin/AdminMembersPage";
import { AdminStoragePage } from "./components/admin/AdminStoragePage";
import { AdminResourcesPage } from "./components/admin/AdminResourcesPage";
import { AdminModelCatalogPage } from "./components/admin/AdminModelCatalogPage";
import { AdminOverviewPage } from "./components/admin/AdminOverviewPage";
import { AdminAgentRunsPage } from "./components/admin/AdminAgentRunsPage";
import { AdminPromptTemplatesPage } from "./components/admin/AdminPromptTemplatesPage";
import { AgentRunPanel } from "./components/AgentRunPanel";
import { Canvas } from "./components/Canvas";
import { CanvasLoader } from "./components/CanvasLoader";
import { HomePage } from "./components/HomePage";
import { LoginPage } from "./components/LoginPage";
import { Modals } from "./components/Modals";
import { Navbar } from "./components/Navbar";
import { RegisterPage } from "./components/RegisterPage";
import { RunTimer } from "./components/RunTimer";
import { SettingsModal } from "./components/SettingsModal";
import { Toolbar } from "./components/Toolbar";
import { useStore } from "./store";

const OneClickFilm = lazy(() => import('./components/film/OneClickFilm').then(module => ({ default: module.OneClickFilm })));
const FilmPage = () => <Suspense fallback={<div className="flex h-screen items-center justify-center bg-[#1c1f20] text-neutral-400">正在打开一键成片…</div>}><OneClickFilm /></Suspense>;

const Workspace = () => {
  const canvasThemeStyle = useCanvasThemeStyle();
  const setBackendModels = useStore((state) => state.setBackendModels);
  const agentPanelOpen = useStore((state) => state.agentPanelOpen);
  const setAgentPanelOpen = useStore((state) => state.setAgentPanelOpen);
  // 面板宽度可拖拽调节(AgentRunPanel 左缘手柄),主区 padding 跟随让位。
  // 拖拽期间禁用 padding 过渡 —— 画布实时跟手,不然有 200ms 滞后感。
  const agentPanelWidth = useStore((state) => state.agentPanelWidth);
  const agentPanelResizing = useStore((state) => state.agentPanelResizing);

  useEffect(() => {
    let ignore = false;

    listAppProviderConfigs()
      .then((configs) => {
        if (!ignore) {
          setBackendModels(configs);
        }
      })
      .catch(() => {
        if (!ignore) {
          setBackendModels([]);
        }
      });

    return () => {
      ignore = true;
    };
  }, [setBackendModels]);

  return (
    <div
      className={`canvas-workspace relative h-screen w-full overflow-hidden font-sans text-neutral-200 selection:bg-cyan-500/30 ${agentPanelResizing ? "" : "transition-[padding] duration-200 ease-out"}`}
      style={{ ...canvasThemeStyle, paddingRight: agentPanelOpen ? agentPanelWidth : 0 }}
    >
      <Navbar />
      <Toolbar />
      <Canvas />
      <RunTimer />
      <CanvasGenerationNotifications />
      <Modals />
      <SettingsModal />
      <AgentRunPanel open={agentPanelOpen} onClose={() => setAgentPanelOpen(false)} />
      <CanvasLoader />
    </div>
  );
};

const HomeRedirect = () => {
  const { loading, user } = useAuth();
  const language = useStore((state) => state.language);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#16181c] text-neutral-400">
        {language === "zh" ? "加载中..." : "Loading..."}
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // 项目创建 / 切换在首页完成，画布从首页进入。管理员保留原来的直达管理端。
  return <Navigate to={user.role === "admin" ? "/admin" : "/home"} replace />;
};

export const router = createBrowserRouter([
  ...(import.meta.env.DEV ? [
    {
      path: "/__preview/home",
      Component: HomePage,
    },
    {
      path: "/__preview/film",
      Component: FilmPage,
    },
    {
      path: "/__preview/automation",
      Component: () => <Navigate to="/home?view=tryon" replace />,
    },
  ] : []),
  {
    path: "/",
    Component: HomeRedirect,
  },
  {
    path: "/login",
    Component: LoginPage,
  },
  {
    path: "/register",
    Component: RegisterPage,
  },
  {
    path: "/home",
    Component: () => (
      <ProtectedRoute>
        <HomePage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/studio/film/:projectId?",
    Component: () => <ProtectedRoute><FilmPage /></ProtectedRoute>,
  },
  {
    path: "/app",
    Component: () => (
      <ProtectedRoute>
        <Workspace />
      </ProtectedRoute>
    ),
  },
  {
    path: "/automation",
    Component: () => (
      <ProtectedRoute>
        <Navigate to="/app" replace />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminModelCatalogPage panel="model-service" />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/agents",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminModelCatalogPage panel="agent-config" />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/prompts",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminModelCatalogPage panel="prompt-manage" />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/overview",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminOverviewPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/members",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminMembersPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/storage",
    Component: () => <ProtectedRoute requireRole="admin"><AdminStoragePage /></ProtectedRoute>,
  },
  {
    path: "/admin/resources",
    Component: () => <ProtectedRoute requireRole="admin"><AdminResourcesPage /></ProtectedRoute>,
  },
  {
    path: "/admin/credits",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminCreditLedgerPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/invitations",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminInvitationsPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/announcements",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminAnnouncementsPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/skills",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminModelCatalogPage panel="skill-management" />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/memory",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminModelCatalogPage panel="memory-config" />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/agent-runs",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminAgentRunsPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/prompt-templates",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminPromptTemplatesPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/logs",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminLogsPage />
      </ProtectedRoute>
    ),
  },
], {
  basename: import.meta.env.VITE_ROUTER_BASENAME || "/",
});
