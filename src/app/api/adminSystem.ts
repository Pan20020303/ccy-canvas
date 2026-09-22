import { apiClient } from './client';

export type StorageBackend = 'local' | 'oss' | 'cos';
export type CloudStorage = { bucket: string; region: string; endpoint: string; public_base_url: string; key_prefix: string; has_access_key_id: boolean; has_access_key_secret: boolean };
export type CloudStorageInput = Omit<CloudStorage, 'has_access_key_id' | 'has_access_key_secret'> & { access_key_id: string; access_key_secret: string };
export type StorageSettings = { backend: StorageBackend; oss: CloudStorage; cos: CloudStorage; revision: number; source: 'environment' | 'database'; updated_at: string | null; local_directory: string; configured: boolean };
export type StorageUpdate = { backend: StorageBackend; revision: number; cloud?: CloudStorageInput };
export function getStorageSettings() { return apiClient.get<StorageSettings>('/api/admin/storage'); }
export function saveStorageSettings(input: StorageUpdate) { return apiClient.put<StorageSettings>('/api/admin/storage', input); }
export type ResourceUsage = { total: number; used: number; available: number; percent: number };
export type ServerResources = { sampled_at: string; hostname: string; os: string; arch: string; cpu_cores: number; cpu_percent: number | null; memory: ResourceUsage | null; disk: ResourceUsage | null; disk_path: string; uptime_seconds: number; go_version: string; heap_bytes: number; heap_reserved_bytes: number; runtime_bytes: number; goroutines: number; gc_count: number; warnings: string[] };
export function getServerResources() { return apiClient.get<ServerResources>('/api/admin/system/resources'); }
