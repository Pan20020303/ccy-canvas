import type { SavedAsset } from '../store';
import type { PickedAsset } from './AssetPickerModal';

export type AssetPickerFilter = 'current_canvas' | 'all' | 'image' | 'video';

export function savedAssetsToPickedAssets(
  assets: SavedAsset[],
  filter: AssetPickerFilter,
): PickedAsset[] {
  return assets
    .filter((asset) => {
      if (asset.kind === 'text') return false;
      if (filter === 'image' && asset.kind !== 'image') return false;
      if (filter === 'video' && asset.kind !== 'video') return false;
      return asset.kind === 'image' || asset.kind === 'video' || asset.kind === 'audio';
    })
    .map((asset) => ({
      id: `library-${asset.id}`,
      source: 'library' as const,
      kind: asset.kind as PickedAsset['kind'],
      url: asset.url || asset.thumbnail || '',
      title: asset.name,
    }))
    .filter((asset) => Boolean(asset.url));
}
