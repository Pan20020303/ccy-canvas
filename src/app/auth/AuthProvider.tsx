import { createContext, useContext, useEffect, useMemo, useState } from "react";

import { apiClient } from "../api/client";

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
    invitationCode: string;
  }) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<AuthUser | null>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [creditSummary, setCreditSummary] = useState<CreditSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const data = await apiClient.get<AuthPayload>("/api/auth/me");
      setUser(data.user);
      setCreditSummary(data.credit_summary ?? null);
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
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      creditSummary,
      loading,
      async login(input) {
        const data = await apiClient.post<AuthPayload>("/api/auth/login", input);
        setUser(data.user);
        setCreditSummary(data.credit_summary ?? null);
        return data.user;
      },
      async registerByInvite(input) {
        const data = await apiClient.post<AuthPayload>("/api/auth/register-by-invite", {
          email: input.email,
          password: input.password,
          name: input.name,
          invitation_code: input.invitationCode,
        });
        setUser(data.user);
        setCreditSummary(data.credit_summary ?? null);
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
