import { Navigate } from "react-router";

import { useStore } from "../store";
import { useAuth } from "./AuthProvider";

export function ProtectedRoute({
  children,
  requireRole,
}: {
  children: React.ReactNode;
  requireRole?: "admin" | "member";
}) {
  const { loading, user } = useAuth();
  const language = useStore((state) => state.language);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] text-sm text-neutral-400">
        {language === "zh" ? "\u52a0\u8f7d\u4e2d..." : "Loading..."}
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (requireRole && user.role !== requireRole) {
    return <Navigate to="/app" replace />;
  }

  return <>{children}</>;
}
