import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { apiClient } from "../api/client";
import { listAppProviderConfigs } from "../api/providerConfigs";
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
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [creditSummary, setCreditSummary] = useState<CreditSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const setBackendModels = useStore((s) => s.setBackendModels);
  const loadBackendProjects = useStore((s) => s.loadBackendProjects);

  // After successful auth, load backend data (models + projects/canvas).
  const loadBackendData = async () => {
    try {
      const configs = await listAppProviderConfigs();
      setBackendModels(configs);
    } catch { /* not authenticated or unavailable */ }
    await loadBackendProjects();
  };

  const refresh = async () => {
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
  };

  useEffect(() => {
    void refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    }),
    [creditSummary, loading, user],
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
