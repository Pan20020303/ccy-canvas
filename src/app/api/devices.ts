import { apiClient } from './client';

export type LoginDevice = {
  id: string;
  user_agent: string;
  ip_address: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  current: boolean;
};

export type LoginDevicesResponse = {
  devices: LoginDevice[];
  password_available: boolean;
};

export function listLoginDevices(): Promise<LoginDevicesResponse> {
  return apiClient.get<LoginDevicesResponse>('/api/auth/devices');
}

export function revokeLoginDevice(id: string, password: string): Promise<{ ok: boolean }> {
  return apiClient.post<{ ok: boolean }>(`/api/auth/devices/${encodeURIComponent(id)}/revoke`, { password });
}
