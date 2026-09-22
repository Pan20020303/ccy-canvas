import { toRenderableMediaUrl } from '../../reference-media';
import type { LayerEditorLayer } from './LayerEditorNode';
import { normalizeCrop } from './layer-editor-crop';

/** Same source window as drawImage's export rectangle, including independently stretched layers. */
export function LayerEditorImage({ layer }: { layer: LayerEditorLayer }) {
  const c = normalizeCrop(layer.crop);
  return <div className="relative h-full w-full overflow-hidden" data-layer-image="true">
    <img src={layer.image.startsWith('data:') ? layer.image : (toRenderableMediaUrl(layer.image) || layer.image)} alt="" draggable={false}
      className="pointer-events-none absolute block h-full w-full max-w-none object-fill"
      style={{ left: `${-c.x / c.width * 100}%`, top: `${-c.y / c.height * 100}%`, width: `${100 / c.width}%`, height: `${100 / c.height}%` }} />
  </div>;
}
