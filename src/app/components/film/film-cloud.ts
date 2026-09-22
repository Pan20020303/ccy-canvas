import { ApiClientError } from '../../api/client';
import { createFilmProject, getFilmProject, saveFilmProject, type FilmRecord, type FilmSave } from '../../api/film-projects';
import { newFilmProject, type FilmProject } from './film-project';
import { filmError, filmStorageKey, filmStore } from './film-store';
import { mergeFilmProjects, sameFilmContent, sameFilmDocument } from './film-merge';

type Journal = { version?: 2; revision: number; project: FilmProject; base?: FilmProject; baseTrusted?: boolean; request?: FilmSave; conflict?: boolean };
type Session = { flush: () => Promise<void>; refresh: () => Promise<void>; keepLocal: () => Promise<void>; close: () => void };
const sessions = new Map<string, Session>();
const opening = new Map<string, Promise<void>>();
const migrations = new Map<string, Promise<boolean>>();
export const filmJournalKey = (user: string, id: string) => `ccy-film-pending-v1:${user}:${id}`;
export const filmConflictBackupPrefix = (user: string, id: string) => `ccy-film-conflict-backup-v1:${user}:${id}:`;
const keyFor = (user: string, id: string) => `${user}/${id}`;
const valid = (p: FilmProject) => p?.version === 1 && typeof p.id === 'string' && typeof p.script === 'string' && Array.isArray(p.assets) && Array.isArray(p.shots) && Array.isArray(p.jobs);
const restore = (p: FilmProject, id: string): FilmProject => ({ ...newFilmProject(), ...p, cloudId: id, backendId: id,
  settings: { ...newFilmProject().settings, ...p.settings }, exporting: false,
  jobs: p.jobs.map(j => j.status === 'submitting' ? { ...j, status: 'unknown' } : j) });

// A journal is only a recovery copy, not the source of the project library.
// Keep the exact in-flight mutation so a lost response is safe to retry.
export function attachCloudFilm(user: string, record: FilmRecord) {
  const key = keyFor(user, record.id), storageKey = filmJournalKey(user, record.id);
  sessions.get(key)?.close();
  const store = filmStore(user, record.id);
  let revision = record.revision, request: FilmSave | undefined, dirty = false, conflict = false;
  let base = restore(record.document, record.id);
  let baseTrusted = true;
  let initial = record.document;
  try {
    const pending = JSON.parse(localStorage.getItem(storageKey) || 'null') as Journal | null;
    if (pending && valid(pending.project)) {
      initial = pending.project; dirty = true;
      const acknowledged = pending.request && record.mutation_id === pending.request.mutation_id;
      if (acknowledged) {
        dirty = !sameFilmDocument(pending.project, pending.request!.document);
        if (!dirty) initial = record.document;
      } else if (sameFilmContent(restore(pending.project, record.id), base)) {
        // An already synchronized draft must not resurrect a cached warning.
        initial = record.document; dirty = false;
      } else if (!pending.conflict && pending.revision === record.revision) { request = pending.request; base = pending.base ? restore(pending.base, record.id) : base; }
      else {
        // New journals carry the common ancestor, so reconnect can merge
        // independent edits. Legacy drafts without one must remain protected.
        // Old conflict journals may have overwritten the common ancestor on
        // reload. Only the new format explicitly guarantees it was preserved.
        baseTrusted = !!pending.base && (pending.version === 2 ? pending.baseTrusted !== false : !pending.conflict);
        const merged = baseTrusted && mergeFilmProjects(restore(pending.base!, record.id), restore(pending.project, record.id), base);
        if (merged) { initial = merged; dirty = !sameFilmContent(merged, base); baseTrusted = true; }
        else {
          conflict = true;
          // Keep the original revision and ancestor together across reloads.
          revision = pending.revision;
          if (pending.base) base = restore(pending.base, record.id);
        }
      }
    }
  } catch { /* The database document is authoritative if the recovery copy is unreadable. */ }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let refreshing: Promise<void> | undefined;
  let resolving: Promise<void> | undefined;
  let applying = false;
  let closed = false;
  store.setState({ project: restore(initial, record.id), saved: true, syncStatus: conflict ? 'conflict' : dirty ? 'saving' : 'saved', syncError: conflict ? '项目已在其他页面更新，本机未同步的修改已保留。' : undefined });
  const backup = () => {
    try {
      if (dirty || request || conflict) localStorage.setItem(storageKey, JSON.stringify({ version: 2, revision, project: store.getState().project, base, baseTrusted, request, conflict } satisfies Journal));
      else localStorage.removeItem(storageKey);
      store.setState({ saved: true });
    } catch { store.setState({ saved: false }); }
  };
  const acceptRemote = (result: FilmRecord) => {
    if (closed || result.revision < revision || (result.revision === revision && !conflict)) return;
    const remote = restore(result.document, record.id), local = store.getState().project;
    const ancestor = request && result.mutation_id === request.mutation_id ? request.document : base;
    const merged = sameFilmContent(local, remote) ? remote : baseTrusted ? mergeFilmProjects(ancestor, local, remote) : null;
    if (!merged) {
      conflict = true;
      store.setState({ syncStatus: 'conflict', syncError: baseTrusted ? '检测到同一处内容有不同修改，本机内容已保留，请确认要保留的版本。' : '旧版本冲突的共同底稿无法确认，本机内容已保留，请备份后选择版本。' });
      backup(); throw new Error('项目版本冲突，本机修改已保留。');
    }
    // Don't move the user away from the step they are reading, or abort a
    // local export. These view/runtime fields don't trigger an echo save.
    dirty = !sameFilmContent(merged, remote);
    revision = result.revision; base = remote; baseTrusted = true; request = undefined; conflict = false;
    applying = true;
    store.setState({ project: { ...merged, step: local.step, exporting: local.exporting }, syncStatus: dirty ? 'saving' : 'saved', syncError: undefined });
    applying = false;
    backup();
  };
  const drain = async () => {
    if (conflict) throw new Error('项目版本冲突，请先选择保留本机或载入云端版本。');
    let rebases = 0;
    while (!closed && (dirty || request)) {
      store.setState({ syncStatus: 'saving', syncError: undefined });
      request ??= { document: store.getState().project, revision, mutation_id: crypto.randomUUID() };
      const sent = request;
      backup();
      try {
        const result = await saveFilmProject(record.id, sent);
        if (closed) return;
        revision = result.revision;
        base = sent.document;
        dirty = !sameFilmContent(store.getState().project, sent.document);
        request = undefined;
        backup();
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 409 && rebases++ < 3) {
          try { acceptRemote(await getFilmProject(record.id)); } catch (readError) {
            if (!conflict) store.setState({ syncStatus: 'error', syncError: `同步暂时中断，本机修改已保留：${filmError(readError)}` });
            backup(); throw readError;
          }
          if (!closed && !conflict) continue;
        }
        // Contention alone is not a content conflict. Let the next refresh
        // rebase automatically rather than latching a permanent warning.
        store.setState({ syncStatus: 'error', syncError: e instanceof ApiClientError && e.status === 409 ? '更新较频繁，正在等待重新同步；本机内容已保留。' : `尚未保存到数据库：${filmError(e)}` });
        backup(); throw e;
      }
    }
    if (!closed) store.setState({ syncStatus: 'saved', syncError: undefined });
  };
  const flush = async () => {
    clearTimeout(timer);
    if (resolving) await resolving;
    if (refreshing) await refreshing;
    if (conflict) await refresh();
    if (!inFlight) inFlight = drain().finally(() => { inFlight = undefined; });
    await inFlight;
    // An edit may arrive in the promise finalizer between the last check and resolve.
    if (!closed && dirty) await flush();
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void flush().catch(() => {}), 600); };
  store.setState({ flush });
  const unsubscribe = store.subscribe((state, prev) => {
    if (state.project === prev.project || closed || applying) return;
    if (sameFilmContent(state.project, prev.project)) { if (dirty || request || conflict) backup(); return; }
    dirty = true; backup();
    if (!conflict) { store.setState({ syncStatus: 'saving' }); schedule(); }
  });
  const refresh = async () => {
    if (closed || resolving) return;
    if (refreshing) return refreshing;
    // Wait for a save before reading, but merge edits that happen during GET.
    if (inFlight) await inFlight;
    if (closed) return;
    if (refreshing) return refreshing;
    refreshing = getFilmProject(record.id).then(acceptRemote).finally(() => { refreshing = undefined; });
    try { await refreshing; } catch (e) {
      if (!conflict && !closed) store.setState({ syncStatus: dirty ? 'error' : store.getState().syncStatus, syncError: `连接中断，正在等待重新同步；本机内容已保留。${filmError(e)}` });
      throw e;
    }
    if (!closed && !conflict) {
      store.setState({ syncError: undefined });
      if (dirty) schedule();
    }
  };
  const online = () => { if (dirty && !conflict) void flush().catch(() => {}); };
  const leave = (event: BeforeUnloadEvent) => { if (dirty || request) { backup(); event.preventDefault(); event.returnValue = ''; } };
  const hidden = () => { if (document.visibilityState === 'hidden') online(); };
  // This is an explicit user decision, never an automatic conflict retry.
  // Back up BOTH versions first and keep optimistic concurrency protection.
  const keepLocal = async () => {
    if (resolving) return resolving;
    if (closed || !conflict) throw new Error('当前没有需要处理的版本冲突。');
    clearTimeout(timer);
    resolving = (async () => {
      if (inFlight) await inFlight.catch(() => {});
      if (refreshing) await refreshing.catch(() => {});
      if (closed) throw new Error('项目已关闭，请重新打开后处理。');
      const remote = await getFilmProject(record.id);
      if (closed) throw new Error('项目已关闭，请重新打开后处理。');
      const local = store.getState().project;
      if (local.id !== remote.document.id) throw new Error('项目身份不一致，已停止保存，本机内容未丢失。');
      const mutation = crypto.randomUUID();
      const recovery = JSON.stringify({ version: 1, projectId: record.id, savedAt: new Date().toISOString(), local, cloud: remote }, null, 2);
      // Fail closed if the recovery backup cannot be persisted.
      localStorage.setItem(filmConflictBackupPrefix(user, record.id) + mutation, recovery);
      const url = URL.createObjectURL(new Blob([recovery], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `${local.name || '未命名项目'}-冲突双版本备份-${Date.now()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      request = { document: local, revision: remote.revision, mutation_id: mutation };
      backup();
      store.setState({ syncStatus: 'saving', syncError: '正在保留本机版本，双版本备份已保存。' });
      try {
        const result = await saveFilmProject(record.id, request);
        if (closed) return;
        revision = result.revision; base = restore(result.document, record.id); baseTrusted = true; request = undefined; conflict = false;
        // Edits made while saving remain in memory and are saved next.
        dirty = !sameFilmContent(store.getState().project, base);
        store.setState({ syncStatus: dirty ? 'saving' : 'saved', syncError: undefined });
        backup();
      } catch (error) {
        if (!closed) {
          conflict = true;
          store.setState({ syncStatus: 'conflict', syncError: error instanceof ApiClientError && error.status === 409 ? '保存期间云端又有更新，未覆盖新内容。本机及双版本备份已保留，请确认后重试。' : `本机版本尚未确认保存，内容及备份已保留：${filmError(error)}` });
          backup();
        }
        throw error;
      }
    })().finally(() => { resolving = undefined; });
    await resolving;
    if (!closed && dirty && !conflict) await flush();
  };
  window.addEventListener('online', online); window.addEventListener('beforeunload', leave); document.addEventListener('visibilitychange', hidden);
  sessions.set(key, { flush, refresh, keepLocal, close: () => { closed = true; clearTimeout(timer); unsubscribe(); window.removeEventListener('online', online); window.removeEventListener('beforeunload', leave); document.removeEventListener('visibilitychange', hidden); } });
  backup(); if (dirty && !conflict) schedule();
}

// Development hot updates must not leave old autosave subscriptions writing
// alongside the new module in the very same browser tab.
if (import.meta.hot) import.meta.hot.dispose(() => {
  for (const session of sessions.values()) session.close();
  sessions.clear();
});

export async function loadCloudFilm(user: string, id: string) {
  const key = keyFor(user, id);
  const session = sessions.get(key);
  if (session) { await session.refresh(); return; }
  if (!opening.has(key)) opening.set(key, getFilmProject(id).then(r => attachCloudFilm(user, r)).finally(() => opening.delete(key)));
  await opening.get(key);
}
export async function syncCloudFilm(user: string, id: string) { await sessions.get(keyFor(user, id))?.refresh(); }
export async function keepLocalFilmVersion(user: string, id: string) {
  const session = sessions.get(keyFor(user, id));
  if (!session) throw new Error('请先打开项目。');
  await session.keepLocal();
}
export async function flushFilmProjects(user: string) {
  await Promise.all([...sessions].filter(([key]) => key.startsWith(`${user}/`)).map(([,s]) => s.flush()));
}
export async function newCloudFilm(user: string, draft = newFilmProject()) {
  const record = await createFilmProject(draft); attachCloudFilm(user, record); return record.id;
}
export function downloadFilmBackup(project: FilmProject) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `${project.name || '未命名项目'}-备份.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function useCloudVersion(user: string, id: string) {
  const record = await getFilmProject(id); // Do not drop recovery data if this fails.
  downloadFilmBackup(filmStore(user, id).getState().project);
  localStorage.removeItem(filmJournalKey(user, id));
  attachCloudFilm(user, record);
}
export async function migrateFilmDraft(user: string): Promise<boolean> {
  if (!user) return false;
  if (!migrations.has(user)) migrations.set(user, (async () => {
    const raw = localStorage.getItem(filmStorageKey(user));
    if (!raw) return false;
    const draft = JSON.parse(raw) as FilmProject;
    if (!valid(draft)) throw new Error('旧草稿格式无法识别，原内容已保留，请导出备份后检查。');
    const marker = `ccy-film-migrated:${user}:${draft.id}`;
    if (localStorage.getItem(marker)) return false;
    if (!draft.script && !draft.assets.length && !draft.shots.length && !draft.jobs.length && !draft.backendId && draft.name === '未命名项目' && !draft.settings.splitSkillId && !draft.settings.extractSkillId) return false;
    // Server de-duplicates by owner + draft ID. Never overwrites a newer cloud copy.
    const record = await createFilmProject(draft);
    localStorage.setItem(marker, record.id);
    // Keep the original legacy value as a recovery backup.
    return true;
  })().finally(() => migrations.delete(user)));
  return migrations.get(user)!;
}
