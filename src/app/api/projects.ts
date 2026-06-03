import { apiClient } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackendProject = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export type CanvasData = {
  project_id: string;
  nodes: unknown[];
  edges: unknown[];
  version: number;
};

export type UploadData = {
  url: string;
  filename: string;
  content_type: string;
};

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function listProjects(): Promise<BackendProject[]> {
  return apiClient.get<BackendProject[]>("/api/app/projects");
}

export function createProject(name: string): Promise<BackendProject> {
  return apiClient.post<BackendProject>("/api/app/projects", { name });
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

export function getCanvas(projectId: string): Promise<CanvasData> {
  return apiClient.get<CanvasData>(`/api/app/projects/${projectId}/canvas`);
}

export function saveCanvas(
  projectId: string,
  nodes: unknown[],
  edges: unknown[],
  options?: { keepalive?: boolean },
): Promise<CanvasData> {
  return apiClient.put<CanvasData>(
    `/api/app/projects/${projectId}/canvas`,
    { nodes, edges },
    options,
  );
}

export async function uploadFile(file: Blob, filename: string): Promise<UploadData> {
  const form = new FormData();
  form.append("file", file, filename);

  const response = await fetch("/api/app/upload", {
    method: "POST",
    body: form,
    credentials: "include",
  });

  const rawBody = await response.text();
  const body = rawBody.trim() ? JSON.parse(rawBody) as { data?: UploadData; error?: string } : {};
  if (!response.ok || !body.data) {
    throw new Error(body.error || `Upload failed (${response.status})`);
  }
  return body.data;
}
