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
): Promise<CanvasData> {
  return apiClient.put<CanvasData>(`/api/app/projects/${projectId}/canvas`, {
    nodes,
    edges,
  });
}
