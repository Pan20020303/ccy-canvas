import { describe, expect, it } from 'vitest';
import { hasTaskPreview, sameGeneratedMedia, taskMediaPatch, uniqueMediaVersions } from './media-result-state';

const file = '2026-09/11111111-2222-4333-8444-555555555555.png';
const preview = `/uploads/staging/generated/${file}`;
const final = `https://bucket.oss-cn-beijing.aliyuncs.com/ccy-canvas/generated/${file}`;

describe('generated media identity', () => {
  it('recognizes staging and promoted objects, including subpath deployments', () => {
    expect(sameGeneratedMedia(preview, final)).toBe(true);
    expect(sameGeneratedMedia(`https://canvas.example/ccy${preview}`, final)).toBe(true);
    expect(sameGeneratedMedia(preview, `https://bucket.cos.ap-beijing.myqcloud.com/generated/${file}`)).toBe(true);
    expect(sameGeneratedMedia(preview, 'https://unrelated.example/' + file)).toBe(false);
    expect(sameGeneratedMedia('https://a.example/result.png', 'https://b.example/result.png')).toBe(false);
  });

  it('counts first preview, repeat preview and final URL as one generation', () => {
    let data = taskMediaPatch({}, preview, 'task-1', 10);
    data = { ...data, ...taskMediaPatch(data, preview, 'task-1', 20) };
    data = { ...data, ...taskMediaPatch(data, final, 'task-1', 30) };
    expect(data.versions).toEqual([]);
    expect(data.url).toBe(final);
    expect(data.activeVersionTimestamp).toBe(10);
  });

  it('preserves the real previous result when the first preview replaces it', () => {
    const old = { url: 'https://example.com/old.png', activeVersionId: 'old', poster: 'old-poster' };
    const data = { ...old, ...taskMediaPatch(old, preview, 'task-2', 10) };
    const promoted = taskMediaPatch(data, final, 'task-2', 30);
    expect(promoted.versions).toEqual([expect.objectContaining({ id: 'old', url: old.url })]);
    expect(data.poster).toBeUndefined();
  });

  it('repairs legacy preview duplicates but preserves distinct historical outputs', () => {
    const older = { id: 'old', url: 'https://example.com/old.png', timestamp: 1 };
    const duplicate = { id: 'preview', url: preview, timestamp: 2 };
    expect(uniqueMediaVersions(final, [duplicate, older])).toEqual([older]);
    expect(taskMediaPatch({ url: preview, versions: [older] }, final, 'legacy').versions).toEqual([older]);
  });

  it('only exposes a current task preview, not the old result during a re-run', () => {
    expect(hasTaskPreview({ url: preview, status: 'running', taskPhase: 'persisting' })).toBe(true);
    expect(hasTaskPreview({ url: preview, status: 'running', taskPhase: 'generating' })).toBe(false);
    expect(hasTaskPreview({ taskPhase: 'persisting' })).toBe(false);
  });
});
