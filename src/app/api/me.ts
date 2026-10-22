import { apiClient } from "./client";

/** Shape returned by GET /api/auth/me — { user, credit_summary }. We only need
 *  a display name for the agent greeting, read defensively. */
export type CurrentUser = {
  id?: string;
  name?: string;
  nickname?: string;
  email?: string;
  [key: string]: unknown;
};

type MeResponse = { user?: CurrentUser; credit_summary?: unknown };

export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const res = await apiClient.get<MeResponse>("/api/auth/me");
    return res?.user ?? null;
  } catch {
    return null;
  }
}

/** Best-effort display name for greetings. */
export function displayNameOf(user: CurrentUser | null): string {
  if (!user) return "";
  const name = (user.name || user.nickname || "").toString().trim();
  if (name) return name;
  const email = (user.email || "").toString().trim();
  if (email) return email.split("@")[0];
  return "";
}
