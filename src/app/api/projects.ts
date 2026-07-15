import { apiClient, resolveApiUrl } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackendProject = {
  id: string;
  name: string;
  cover_url?: string;
  folder_id?: string;
  /** True once the owner turns the project into a collaborative one. */
  is_collaborative?: boolean;
  /** The current user's effective role on this project. */
  my_role?: BackendMemberRole;
  created_at: string;
  updated_at: string;
};

/** creator = 项目创建者(owner);其余为受邀成员角色。 */
export type BackendMemberRole = "creator" | "admin" | "collaborator" | "visitor";

export type BackendMember = {
  uid: string;
  name: string;
  role: BackendMemberRole;
};

export type BackendFolder = {
  id: string;
  name: string;
  created_at: string;
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

/** Patch project metadata. Omitted fields stay untouched; empty string clears
 *  (cover removed / moved back to the root level). */
export function updateProject(
  projectId: string,
  patch: { name?: string; cover_url?: string; folder_id?: string },
): Promise<BackendProject> {
  return apiClient.patch<BackendProject>(`/api/app/projects/${projectId}`, patch);
}

export function deleteProject(projectId: string): Promise<{ deleted: boolean }> {
  return apiClient.delete<{ deleted: boolean }>(`/api/app/projects/${projectId}`);
}

export function duplicateProject(projectId: string): Promise<BackendProject> {
  return apiClient.post<BackendProject>(`/api/app/projects/${projectId}/duplicate`, {});
}

// ---------------------------------------------------------------------------
// Templates(画布模板:首页「从模板开始」)
// ---------------------------------------------------------------------------

export type CanvasTemplate = {
  id: string;
  name: string;
  cover_url: string;
  created_at: string;
};

/** 全站公开模板(任何登录用户可见)。 */
export function listTemplates(): Promise<CanvasTemplate[]> {
  return apiClient.get<CanvasTemplate[]>("/api/app/templates");
}

/** 从模板创建:复用 duplicate,后端对模板放行非 owner 复制。 */
export function useTemplate(templateId: string): Promise<BackendProject> {
  return duplicateProject(templateId);
}

/** 管理员:把某项目标记/取消为模板。 */
export function setProjectTemplate(
  projectId: string,
  isTemplate: boolean,
): Promise<{ id: string; is_template: boolean }> {
  return apiClient.patch<{ id: string; is_template: boolean }>(
    `/api/admin/projects/${projectId}/template`,
    { is_template: isTemplate },
  );
}

// ---------------------------------------------------------------------------
// Collaboration
// ---------------------------------------------------------------------------

/** Owner-only: flip a project between private and collaborative. Turning it off
 *  also drops every member on the backend. */
export function setProjectCollaboration(
  projectId: string,
  collaborative: boolean,
): Promise<{ is_collaborative: boolean }> {
  return apiClient.put<{ is_collaborative: boolean }>(
    `/api/app/projects/${projectId}/collaboration`,
    { collaborative },
  );
}

export function listProjectMembers(projectId: string): Promise<BackendMember[]> {
  return apiClient.get<BackendMember[]>(`/api/app/projects/${projectId}/members`);
}

/** Invite a resolved user (uid from /users/lookup) as a member. Owner/admin only. */
export function inviteProjectMember(
  projectId: string,
  uid: string,
  role: Exclude<BackendMemberRole, "creator">,
): Promise<BackendMember> {
  return apiClient.post<BackendMember>(`/api/app/projects/${projectId}/members`, { uid, role });
}

export function updateProjectMemberRole(
  projectId: string,
  uid: string,
  role: Exclude<BackendMemberRole, "creator">,
): Promise<BackendMember> {
  return apiClient.patch<BackendMember>(`/api/app/projects/${projectId}/members/${uid}`, { role });
}

export function removeProjectMember(
  projectId: string,
  uid: string,
): Promise<{ removed: boolean }> {
  return apiClient.delete<{ removed: boolean }>(`/api/app/projects/${projectId}/members/${uid}`);
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export function listFolders(): Promise<BackendFolder[]> {
  return apiClient.get<BackendFolder[]>("/api/app/folders");
}

export function createFolder(name: string): Promise<BackendFolder> {
  return apiClient.post<BackendFolder>("/api/app/folders", { name });
}

export function deleteFolder(folderId: string): Promise<{ deleted: boolean }> {
  return apiClient.delete<{ deleted: boolean }>(`/api/app/folders/${folderId}`);
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
