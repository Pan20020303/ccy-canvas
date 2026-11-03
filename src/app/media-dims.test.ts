import { afterEach, describe, expect, it } from 'vitest';
import { mediaDimCache, rememberMediaDims, resolveMediaDims } from './media-dims';

afterEach(() => mediaDimCache.clear());

describe('resolveMediaDims', () => {
  it('uses dimensions measured for the current URL over stale node dimensions', () => {
    rememberMediaDims('https://example.com/square.png', 1024, 1024);
    expect(resolveMediaDims({
      url: 'https://example.com/square.png',
      mediaWidth: 1920,
      mediaHeight: 1080,
    })).toEqual({ w: 1024, h: 1024 });
  });

  it('falls back to saved dimensions before the image loads', () => {
    expect(resolveMediaDims({ url: 'https://example.com/image.png', mediaWidth: 800, mediaHeight: 600 }))
      .toEqual({ w: 800, h: 600 });
  });
});
