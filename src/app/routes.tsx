import { createBrowserRouter, Navigate } from "react-router";

import { useAuth } from "./auth/AuthProvider";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { AdminInvitationsPage } from "./components/admin/AdminInvitationsPage";
import { AdminMembersPage } from "./components/admin/AdminMembersPage";
import { AdminOverviewPlaceholder } from "./components/admin/AdminOverviewPlaceholder";
import { AdminShell } from "./components/admin/AdminShell";
import { ModelConfigPage } from "./components/admin/ModelConfigPage";
import { Canvas } from "./components/Canvas";
import { LoginPage } from "./components/LoginPage";
import { Modals } from "./components/Modals";
import { Navbar } from "./components/Navbar";
import { RegisterPage } from "./components/RegisterPage";
import { RunTimer } from "./components/RunTimer";
import { SettingsModal } from "./components/SettingsModal";
import { Toolbar } from "./components/Toolbar";
import { useStore } from "./store";

const Workspace = () => (
  <div className="relative h-screen w-full overflow-hidden bg-[#0a0a0a] font-sans text-neutral-200 selection:bg-cyan-500/30">
    <Navbar />
    <Toolbar />
    <Canvas />
    <RunTimer />
    <Modals />
    <SettingsModal />
  </div>
);

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

const AdminPlaceholderPage = ({ title }: { title: string }) => (
  <AdminShell
    title={title}
    description="这个模块已经进入管理后台的开发范围。当前阶段先完成团队空间、成员权限和模型配置，随后继续补齐这里的真实业务能力。"
  >
    <AdminOverviewPlaceholder title={title} />
  </AdminShell>
);

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
        <ModelConfigPage />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin/overview",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminPlaceholderPage title="概览" />
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
    path: "/admin/logs",
    Component: () => (
      <ProtectedRoute requireRole="admin">
        <AdminPlaceholderPage title="日志" />
      </ProtectedRoute>
    ),
  },
]);
