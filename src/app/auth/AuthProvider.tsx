import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { apiClient } from "../api/client";
import { listAppProviderConfigs } from "../api/providerConfigs";
import { subscribeRuntimeInvalidation } from "../runtimeInvalidation";
import { useStore, bindStorageToUser } from "../store";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  avatar?: string;
  workspaceSpaces?: Array<{
    id: string;
    name: string;
    type: "personal" | "team";
    role: "owner" | "editor" | "viewer";
  }>;
};

type CreditSummary = {
  daily_quota: number;
  current_balance: number;
  consumed_today: number;
};

type AuthPayload = {
  user: AuthUser;
  credit_summary?: CreditSummary;
};

type AuthContextValue = {
  user: AuthUser | null;
  creditSummary: CreditSummary | null;
  loading: boolean;
  login: (input: { email: string; password: string }) => Promise<AuthUser>;
  registerByInvite: (input: {
    email: string;
    password: string;
    name: string;
    invitationCode?: string;
  }) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<AuthUser | null>;
  /** Light-weight periodic sync: refreshes user + credit balance ONLY. Unlike
   *  refresh(), it does NOT reload backend models/projects — the full reload
   *  used to run on every 60s poll / tab refocus and REPLACED the live canvas
   *  (resetting to the first project and clearing the undo stack). */
  refreshCredits: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [creditSummary, setCreditSummary] = useState<CreditSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const setBackendModels = useStore((s) => s.setBackendModels);
  const loadBackendProjects = useStore((s) => s.loadBackendProjects);

  const loadBackendModels = useCallback(async () => {
    try {
      const configs = await listAppProviderConfigs();
      setBackendModels(configs);
    } catch { /* not authenticated or unavailable */ }
  }, [setBackendModels]);

  // After successful auth, load backend data (models + projects/canvas).
  const loadBackendData = useCallback(async () => {
    await loadBackendModels();
    await loadBackendProjects();
  }, [loadBackendModels, loadBackendProjects]);

  const refresh = useCallback(async () => {
    try {
      const data = await apiClient.get<AuthPayload>("/api/auth/me");
      bindStorageToUser(data.user.id);
      setUser(data.user);
      setCreditSummary(data.credit_summary ?? null);
      void loadBackendData();
      return data.user;
    } catch {
      setUser(null);
      setCreditSummary(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [loadBackendData]);

  // Credits-only sync for polling paths: never touches models/projects/canvas.
  const refreshCredits = useCallback(async () => {
    try {
      const data = await apiClient.get<AuthPayload>("/api/auth/me");
      setUser(data.user);
      setCreditSummary(data.credit_summary ?? null);
    } catch {
      // Transient failure — keep the last known balance; the next tick retries.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeUserId = user?.id;
  useEffect(() => {
    if (!activeUserId) return;

    const syncVisibleState = () => {
      if (document.visibilityState !== "visible") return;
      void refreshCredits();
      void loadBackendModels();
    };

    syncVisibleState();
    window.addEventListener("focus", syncVisibleState);
    window.addEventListener("pageshow", syncVisibleState);
    document.addEventListener("visibilitychange", syncVisibleState);

    const creditTimer = window.setInterval(() => { void refreshCredits(); }, 30_000);
    const modelTimer = window.setInterval(() => { void loadBackendModels(); }, 30_000);
    const unsubscribeInvalidation = subscribeRuntimeInvalidation((message) => {
      if (message.targetUserId && message.targetUserId !== activeUserId) return;
      if (message.scopes.includes("credits") || message.scopes.includes("identity")) {
        void refreshCredits();
      }
      if (message.scopes.includes("models")) {
        void loadBackendModels();
      }
    });

    return () => {
      window.removeEventListener("focus", syncVisibleState);
      window.removeEventListener("pageshow", syncVisibleState);
      document.removeEventListener("visibilitychange", syncVisibleState);
      window.clearInterval(creditTimer);
      window.clearInterval(modelTimer);
      unsubscribeInvalidation();
    };
  }, [activeUserId, loadBackendModels, refreshCredits]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      creditSummary,
      loading,
      async login(input) {
        const data = await apiClient.post<AuthPayload>("/api/auth/login", input);
        bindStorageToUser(data.user.id);
        setUser(data.user);
        setCreditSummary(data.credit_summary ?? null);
        void loadBackendData();
        return data.user;
      },
      async registerByInvite(input) {
        const data = await apiClient.post<AuthPayload>("/api/auth/register", {
          email: input.email,
          password: input.password,
          name: input.name,
          invitation_code: input.invitationCode?.trim() ?? "",
        });
        bindStorageToUser(data.user.id);
        setUser(data.user);
        setCreditSummary(data.credit_summary ?? null);
        void loadBackendData();
        return data.user;
      },
      async logout() {
        await apiClient.post("/api/auth/logout");
        setUser(null);
        setCreditSummary(null);
      },
      refresh,
      refreshCredits,
    }),
    [creditSummary, loadBackendData, loading, refresh, refreshCredits, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
