import { describe, expect, it } from 'vitest';

import type { SavedAsset } from '../store';
import { savedAssetsToPickedAssets } from './asset-picker-items';

const assets: SavedAsset[] = [
  {
    id: 'image-with-url',
    name: '人物正面图',
    category: 'character',
    thumbnail: '/thumbs/character.jpg',
    url: '/uploads/character.jpg',
    kind: 'image',
    createdAt: 3,
  },
  {
    id: 'image-thumbnail-only',
    name: '场景缩略图',
    category: 'scene',
    thumbnail: '/thumbs/scene.jpg',
    url: '',
    kind: 'image',
    createdAt: 2,
  },
  {
    id: 'video',
    name: '动作参考',
    category: 'other',
    thumbnail: '',
    url: '/uploads/action.mp4',
    kind: 'video',
    createdAt: 1,
  },
  {
    id: 'text',
    name: '不会进入媒体选择器',
    category: 'other',
    thumbnail: '',
    url: '',
    kind: 'text',
    text: 'text asset',
    createdAt: 0,
  },
];

describe('savedAssetsToPickedAssets', () => {
  it('returns selectable media and falls back to the thumbnail', () => {
    const result = savedAssetsToPickedAssets(assets, 'all');

    expect(result.map((item) => item.id)).toEqual([
      'library-image-with-url',
      'library-image-thumbnail-only',
      'library-video',
    ]);
    expect(result[1]?.url).toBe('/thumbs/scene.jpg');
    expect(result.every((item) => item.source === 'library')).toBe(true);
  });

  it('applies image and video filters', () => {
    expect(savedAssetsToPickedAssets(assets, 'image').map((item) => item.kind)).toEqual(['image', 'image']);
    expect(savedAssetsToPickedAssets(assets, 'video').map((item) => item.kind)).toEqual(['video']);
  });
});
