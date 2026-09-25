import { describe, expect, it } from 'vitest';
import { buildImageResultNodes, imageGalleryEntries, imageGallerySelectionPatch, imageResultGroupPatch, imageResultUrlUpgrade } from './image-result-group';

describe('grouped image result state', () => {
  it('keeps batches and legacy history ordered when selecting an older primary and replaying completion', () => {
    let data: Record<string, unknown> = { url: '/a.png', imageResults: ['/a.png', '/b.png'], imageResultTaskId: 'old', mediaTaskId: 'old', model: 'gpt-image-2', activeVersionId: 'v-old', activeVersionTimestamp: 10,
      versions: [{ id: 'legacy', url: '/legacy.png', timestamp: 5, model: 'seedream' }] };
    data = { ...data, ...imageResultGroupPatch(data, '/c.png', ['/c.png', '/d.png'], 'new', 20) };
    const expected = ['/c.png', '/d.png', '/a.png', '/b.png', '/legacy.png'];
    expect(imageGalleryEntries(data).map(entry => entry.url)).toEqual(expected);
    data = { ...data, ...imageGallerySelectionPatch(data, '/b.png') };
    expect(data).toMatchObject({ url: '/b.png', imageResults: ['/a.png', '/b.png'], mediaTaskId: 'old' });
    expect(imageGalleryEntries(data).map(entry => entry.url)).toEqual(expected);
    data = { ...data, ...imageResultGroupPatch(data, '/c.png', ['/c.png', '/d.png'], 'new', 30) };
    expect(data.url).toBe('/b.png');
    expect(imageGalleryEntries(data).map(entry => entry.url)).toEqual(expected);
    data = { ...data, ...imageGallerySelectionPatch(data, '/legacy.png') };
    expect(data).toMatchObject({ url: '/legacy.png', model: 'seedream', imageResults: undefined });
    expect(imageGalleryEntries(data).map(entry => entry.url)).toEqual(expected);
    const source = { id: 'source', type: 'imageNode', position: { x: 0, y: 0 }, data };
    const copies = buildImageResultNodes(source, [source]);
    expect(copies.map(node => node.data.url)).toEqual(expected);
    const selected = { ...source, data: { ...data, ...imageGallerySelectionPatch(data, '/d.png') } };
    expect(buildImageResultNodes(selected, [selected, ...copies])).toEqual([]);
  });

  it('upgrades a historical batch while preserving its selected main and all siblings', () => {
    const data = { url: '/current.png', versions: [{ id: 'old', url: '/old.png', timestamp: 1, imageResults: ['/old.png', 'https://example.com/b.png'] }] };
    const patch = imageResultUrlUpgrade(data, 'https://example.com/b.png', '/b.png');
    expect(imageGalleryEntries({ ...data, ...patch }).map(entry => entry.url)).toEqual(['/current.png', '/old.png', '/b.png']);
    expect(patch).not.toHaveProperty('url');
  });
  it('maps a selected image by position when same-task signed URLs change', () => {
    const old = ['https://media.example/a.png?sign=old', 'https://media.example/b.png?sign=old'];
    const next = old.map(url => url.replace('old', 'new'));
    const patch = imageResultGroupPatch({
      imageResults: old, imageResultTaskId: 'task', url: old[1], mediaTaskId: 'task', versions: [],
    }, next[0], next, 'task');
    expect(patch).toMatchObject({ imageResults: next, url: next[1], output: next[1], originalUrl: next[1], referenceValue: next[1] });
    expect(patch.versions).toEqual([]);
  });

  it('resets the selected image on a new task, including a single-image result', () => {
    const previous = { imageResults: ['/uploads/a.png', '/uploads/b.png'], imageResultTaskId: 'old', url: '/uploads/b.png', mediaTaskId: 'old' };
    const batch = imageResultGroupPatch(previous, '/uploads/c.png', ['/uploads/c.png', '/uploads/d.png'], 'new');
    expect(batch).toMatchObject({ imageResults: ['/uploads/c.png', '/uploads/d.png'], imageResultTaskId: 'new', url: '/uploads/c.png' });
    const single = imageResultGroupPatch(previous, '/uploads/c.png', undefined, 'single');
    expect(single).toMatchObject({ imageResults: undefined, imageResultTaskId: undefined, url: '/uploads/c.png' });
  });

  it('upgrades a secondary URL without replacing the selected primary', () => {
    const patch = imageResultUrlUpgrade({ imageResults: ['/uploads/a.png', 'https://media.example/b.png'], url: '/uploads/a.png' }, 'https://media.example/b.png', '/uploads/b.png');
    expect(patch).toEqual({ imageResults: ['/uploads/a.png', '/uploads/b.png'] });
  });
});
