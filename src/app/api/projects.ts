import { apiClient, resolveApiUrl } from "./client";

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
  /** Canvas group rectangles; older snapshots may omit it. */
  groups?: unknown[];
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
  groups: unknown[] = [],
  options?: { keepalive?: boolean },
): Promise<CanvasData> {
  return apiClient.put<CanvasData>(
    `/api/app/projects/${projectId}/canvas`,
    { nodes, edges, groups },
    options,
  );
}

export async function uploadFile(file: Blob, filename: string): Promise<UploadData> {
  const form = new FormData();
  form.append("file", file, filename);

  const response = await fetch(resolveApiUrl("/api/app/upload"), {
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

// uploadFileWithProgress is uploadFile's XHR twin: fetch can't report upload
// progress, XHR can (xhr.upload.onprogress). Used by the canvas uploader so a
// node can show a live "上传中 (X%)" indicator. onProgress reports 0-100.
export function uploadFileWithProgress(
  file: Blob,
  filename: string,
  onProgress?: (percent: number) => void,
): Promise<UploadData> {
  return new Promise<UploadData>((resolve, reject) => {
    const form = new FormData();
    form.append("file", file, filename);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", resolveApiUrl("/api/app/upload"));
    xhr.withCredentials = true;

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
        }
      };
    }
    xhr.onload = () => {
      let body: { data?: UploadData; error?: string } = {};
      try {
        body = xhr.responseText.trim() ? JSON.parse(xhr.responseText) : {};
      } catch {
        body = {};
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.data) {
        resolve(body.data);
      } else {
        reject(new Error(body.error || `Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed (network error)"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.send(form);
  });
}
