import { describe, expect, it } from 'vitest';
import { mergeFilmProjects, sameFilmDocument } from './film-merge';
import { newFilmProject, type FilmJob, type FilmShot } from './film-project';

const shot = (id: string): FilmShot => ({ id, title: id, description: '原描述', shot: '全景', duration: '5', assetIds: [], status: 'draft', history: [] });
const job = (changes: Partial<FilmJob> = {}): FilmJob => ({ id: 'job', nodeId: 'node', kind: 'split', status: 'running', startedAt: 1, sourceScript: '', payload: { service_type: 'text', model: 'writer', prompt: '分镜' }, ...changes });
describe('cross-browser three-way film merge', () => {
  it('compares database JSON independent of object key order', () => {
    expect(sameFilmDocument({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true);
    expect(sameFilmDocument([2, 3], [3, 2])).toBe(false);
  });
  it('ignores omitted optional JSON fields, including nested generation parameters', () => {
    expect(sameFilmDocument({ error: undefined, payload: { size: undefined, parameters: { quality: undefined } } }, { payload: { parameters: {} } })).toBe(true);
    expect(sameFilmDocument({ error: undefined }, { error: null })).toBe(false);
  });
  it('merges polling updates after the API strips undefined payload fields', () => {
    const b = { ...newFilmProject(), jobs: [job({ payload: { service_type: 'text', model: 'writer', prompt: '分镜', size: undefined } })] };
    const l = { ...b, jobs: [{ ...b.jobs[0], phase: 'generating' as const, lastSyncedAt: 200 }] };
    const r = JSON.parse(JSON.stringify({ ...b, jobs: [{ ...b.jobs[0], phase: 'generating', lastSyncedAt: 300 }] }));
    expect(mergeFilmProjects(b, l, r)?.jobs[0].lastSyncedAt).toBe(300);
  });
  it('accepts an authoritative remote snapshot with completed jobs from a previous script', () => {
    const b = { ...newFilmProject(), jobs: [job()] };
    const r = { ...b, script: '完成任务后又修改了剧本', jobs: [job({ status: 'success', appliedAt: 20, rawResult: 'result' })], shots: [shot('generated')] };
    expect(mergeFilmProjects(b, { ...b, name: '本机只改标题' }, r)).toMatchObject({ script: r.script, name: '本机只改标题', shots: r.shots });
  });
  it('combines independent edits on the same shot', () => {
    const b = { ...newFilmProject(), shots: [shot('one')] };
    const result = mergeFilmProjects(b, { ...b, shots: [{ ...b.shots[0], title: '本机标题' }] }, { ...b, shots: [{ ...b.shots[0], videoUrl: '/generated.mp4' }] });
    expect(result?.shots[0]).toMatchObject({ title: '本机标题', videoUrl: '/generated.mp4' });
  });
  it('combines distinct shot additions and respects deletions of unchanged records', () => {
    const b = { ...newFilmProject(), shots: [shot('old')] };
    const result = mergeFilmProjects(b, { ...b, shots: [shot('local')] }, { ...b, shots: [...b.shots, shot('remote')] });
    expect(result?.shots.map(s => s.id)).toEqual(['remote', 'local']);
  });
  it('does not discard a remote edit when a local browser deletes the same shot', () => {
    const b = { ...newFilmProject(), shots: [shot('one')] };
    expect(mergeFilmProjects(b, { ...b, shots: [] }, { ...b, shots: [{ ...b.shots[0], title: '远端改名' }] })).toBeNull();
  });
  it('does not silently choose between overlapping prompt edits', () => {
    const b = { ...newFilmProject(), shots: [shot('one')] };
    expect(mergeFilmProjects(b, { ...b, shots: [{ ...b.shots[0], prompt: '版本A' }] }, { ...b, shots: [{ ...b.shots[0], prompt: '版本B' }] })).toBeNull();
  });
  it('never downgrades completed jobs to a stale running or failed status', () => {
    const b = { ...newFilmProject(), jobs: [job()] };
    for (const status of ['running', 'error'] as const) {
      const result = mergeFilmProjects(b, { ...b, jobs: [job({ status, lastSyncedAt: 500 })] }, { ...b, jobs: [job({ status: 'success', appliedAt: 100, rawResult: 'result' })] });
      expect(result?.jobs[0].status).toBe('success');
    }
  });
  it('does not append the same generated shot twice when both clients finish a task', () => {
    const b = { ...newFilmProject(), jobs: [job()] };
    const l = { ...b, jobs: [job({ status: 'success', appliedAt: 10, rawResult: 'result' })], shots: [shot('film-job-shot-0')] };
    const r = { ...l, jobs: [job({ status: 'success', appliedAt: 20, rawResult: 'result' })] };
    expect(mergeFilmProjects(b, l, r)?.shots).toHaveLength(1);
  });
  it('protects a new script against an old-script completion', () => {
    const b = { ...newFilmProject(), jobs: [job()] };
    expect(mergeFilmProjects(b, { ...b, script: '新剧本' }, { ...b, jobs: [job({ status: 'success', appliedAt: 20, rawResult: 'result' })], shots: [shot('generated')] })).toBeNull();
  });
});
