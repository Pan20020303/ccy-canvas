import { createBrowserRouter, Navigate } from "react-router";
import { useEffect } from "react";

import { listAppProviderConfigs } from "./api/providerConfigs";
import { useAuth } from "./auth/AuthProvider";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { AdminInvitationsPage } from "./components/admin/AdminInvitationsPage";
import { AdminLogsPage } from "./components/admin/AdminLogsPage";
import { AdminMembersPage } from "./components/admin/AdminMembersPage";
import { AdminModelCatalogPage } from "./components/admin/AdminModelCatalogPage";
import { AdminOverviewPage } from "./components/admin/AdminOverviewPage";
import { AdminSkillsPage } from "./components/admin/AdminSkillsPage";
import { AdminAgentRunsPage } from "./components/admin/AdminAgentRunsPage";
import { Canvas } from "./components/Canvas";
import { LoginPage } from "./components/LoginPage";
import { Modals } from "./components/Modals";
import { Navbar } from "./components/Navbar";
import { RegisterPage } from "./components/RegisterPage";
import { RunTimer } from "./components/RunTimer";
import { SettingsModal } from "./components/SettingsModal";
import { Toolbar } from "./components/Toolbar";
import { useStore } from "./store";

const Workspace = () => {
  const setBackendModels = useStore((state) => state.setBackendModels);

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
    <div className="relative h-screen w-full overflow-hidden bg-[#0a0a0a] font-sans text-neutral-200 selection:bg-cyan-500/30">
      <Navbar />
      <Toolbar />
      <Canvas />
      <RunTimer />
      <Modals />
      <SettingsModal />
    </div>
  );
};

const HomeRedirect = () => {
  const { loading, user } = useAuth();
  const language = useStore((state) => state.language);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] text-neutral-400">
        {language === "zh" ? "加载中..." : "Loading..."}
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <Navigate to={user.role === "admin" ? "/admin" : "/app"} replace />;
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
        <AdminModelCatalogPage />
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
        <AdminSkillsPage />
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
