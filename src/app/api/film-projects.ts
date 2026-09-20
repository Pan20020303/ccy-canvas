import { apiClient } from './client';
import type { FilmProject } from '../components/film/film-project';

export type FilmRecord = { id: string; document: FilmProject; revision: number; mutation_id: string; created_at: string; updated_at: string };
export type FilmSummary = { id: string; name: string; excerpt: string; cover_url: string; step: number; completed: boolean; updated_at: string };
export type FilmSave = { document: FilmProject; revision: number; mutation_id: string };
export async function listFilmProjects() { return apiClient.get<FilmSummary[]>('/api/app/film-projects'); }
export async function createFilmProject(document: FilmProject) { return apiClient.post<FilmRecord>('/api/app/film-projects', { document }); }
export async function getFilmProject(id: string) { return apiClient.get<FilmRecord>(`/api/app/film-projects/${encodeURIComponent(id)}`); }
export async function saveFilmProject(id: string, body: FilmSave) { return apiClient.put<FilmRecord>(`/api/app/film-projects/${encodeURIComponent(id)}`, body); }
