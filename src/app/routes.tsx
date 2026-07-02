import { createBrowserRouter, Navigate } from "react-router";
import { useEffect } from "react";

import { listAppProviderConfigs } from "./api/providerConfigs";
import { useAuth } from "./auth/AuthProvider";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { AdminCreditLedgerPage } from "./components/admin/AdminCreditLedgerPage";
import { AdminInvitationsPage } from "./components/admin/AdminInvitationsPage";
import { AdminLogsPage } from "./components/admin/AdminLogsPage";
import { AdminMembersPage } from "./components/admin/AdminMembersPage";
import { AdminModelCatalogPage } from "./components/admin/AdminModelCatalogPage";
import { AdminOverviewPage } from "./components/admin/AdminOverviewPage";
import { AdminAgentRunsPage } from "./components/admin/AdminAgentRunsPage";
import { AgentRunPanel } from "./components/AgentRunPanel";
import { Canvas } from "./components/Canvas";
import { HomePage } from "./components/HomePage";
import { LoginPage } from "./components/LoginPage";
import { Modals } from "./components/Modals";
import { Navbar } from "./components/Navbar";
import { RegisterPage } from "./components/RegisterPage";
import { RunTimer } from "./components/RunTimer";
import { SettingsModal } from "./components/SettingsModal";
import { Toolbar } from "./components/Toolbar";
import { useStore } from "./store";

const AGENT_PANEL_WIDTH = 480;

const Workspace = () => {
  const setBackendModels = useStore((state) => state.setBackendModels);
  const agentPanelOpen = useStore((state) => state.agentPanelOpen);
  const setAgentPanelOpen = useStore((state) => state.setAgentPanelOpen);

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
      className="relative h-screen w-full overflow-hidden bg-[#16181c] font-sans text-neutral-200 transition-[padding] duration-200 ease-out selection:bg-cyan-500/30"
      style={{ paddingRight: agentPanelOpen ? AGENT_PANEL_WIDTH : 0 }}
    >
      <Navbar />
      <Toolbar />
      <Canvas />
      <RunTimer />
      <Modals />
      <SettingsModal />
      <AgentRunPanel open={agentPanelOpen} onClose={() => setAgentPanelOpen(false)} />
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
    path: "/app",
    Component: () => (
      <ProtectedRoute>
        <Workspace />
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
    path: "/admin/logs",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminLogsPage />
      </ProtectedRoute>
    ),
  },
]);
