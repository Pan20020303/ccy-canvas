import type { FilmJob, FilmProject } from './film-project';

// Merge changes against the last acknowledged database document. Never let a
// stale browser's whole-document save silently remove another browser's work.
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return Array.isArray(a) === Array.isArray(b) && ak.length === bk.length && ak.every(k =>
    Object.prototype.hasOwnProperty.call(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};
export const sameFilmDocument = same;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const identified = (v: unknown): v is { id: string }[] => Array.isArray(v) && v.every(x => object(x) && typeof x.id === 'string') && new Set(v.map(x => x.id)).size === v.length;
class MergeConflict extends Error {}

function mergeJob(local: FilmJob, remote: FilmJob): FilmJob {
  if (!same(local.payload, remote.payload) || local.nodeId !== remote.nodeId || local.sourceScript !== remote.sourceScript) throw new MergeConflict();
  if (local.appliedAt && remote.appliedAt) {
    if (local.rawResult !== remote.rawResult) throw new MergeConflict();
    return remote;
  }
  if (local.appliedAt || remote.appliedAt) return local.appliedAt ? local : remote;
  const phase = ['preparing', 'submitted', 'queued', 'generating', 'received', 'parsing', 'error', 'applied'];
  const rank = (j: FilmJob) => ['success', 'partial'].includes(j.status) ? 100 : j.status === 'error' ? 90 : phase.indexOf(j.phase || 'preparing');
  return rank(local) === rank(remote) ? (local.lastSyncedAt || 0) > (remote.lastSyncedAt || 0) ? local : remote : rank(local) > rank(remote) ? local : remote;
}
function merge(base: unknown, local: unknown, remote: unknown, path: string): unknown {
  if (same(local, remote) || same(base, local)) return remote;
  if (same(base, remote)) return local;
  if (path === 'updatedAt') return Math.max(Number(local) || 0, Number(remote) || 0);
  // Navigation and transient export flags aren't collaborative content.
  if (path === 'step' || path === 'exporting') return local;
  if (path.startsWith('jobs.') && path.split('.').length === 2 && object(local) && object(remote)) return mergeJob(local as FilmJob, remote as FilmJob);
  if ((base === undefined || object(base)) && object(local) && object(remote)) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)])) {
      const value = merge((base as Record<string, unknown> | undefined)?.[key], local[key], remote[key], path ? `${path}.${key}` : key);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  if ((base === undefined || identified(base)) && identified(local) && identified(remote)) {
    const original = (base || []) as { id: string }[];
    const byId = (items: { id: string }[]) => new Map(items.map(x => [x.id, x]));
    const b = byId(original), l = byId(local), r = byId(remote);
    // Appends can be combined; incompatible simultaneous reordering cannot.
    const common = original.filter(x => l.has(x.id) && r.has(x.id)).map(x => x.id);
    const order = (items: { id: string }[]) => items.filter(x => common.includes(x.id)).map(x => x.id);
    const lo = order(local), ro = order(remote);
    if (!same(lo, common) && !same(ro, common) && !same(lo, ro)) throw new MergeConflict();
    const preferred = !same(lo, common) ? local : remote;
    return [...new Set([...preferred.map(x => x.id), ...remote.map(x => x.id), ...local.map(x => x.id), ...b.keys()])]
      .map(id => merge(b.get(id), l.get(id), r.get(id), `${path}.${id}`)).filter(x => x !== undefined);
  }
  throw new MergeConflict();
}
export function mergeFilmProjects(base: FilmProject, local: FilmProject, remote: FilmProject): FilmProject | null {
  if (base.id !== local.id || base.id !== remote.id) return null;
  try {
    const result = merge(base, local, remote, '') as FilmProject;
    // A new completion based on an older script cannot be silently applied to
    // a script concurrently replaced in another browser.
    if (result.jobs.some(j => ['extract', 'split'].includes(j.kind) && j.appliedAt && !base.jobs.find(b => b.id === j.id)?.appliedAt && j.sourceScript !== result.script)) return null;
    return result;
  } catch { return null; }
}
