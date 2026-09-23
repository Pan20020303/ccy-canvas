import { ImagePlus, Layers3, Plus, X } from 'lucide-react';
import type { FilmAsset, FilmReference } from './film-project';
import { filmReferenceLabels } from './film-references';
import { toRenderableMediaUrl } from '../../reference-media';

export function FilmReferenceGallery({ refs, boundAssets, onUpload, onRemove, busy }: { refs: FilmReference[]; boundAssets: FilmAsset[]; onUpload: () => void; onRemove: (ref: FilmReference) => void; busy: boolean }) {
  const labels = filmReferenceLabels(refs);
  const missing = boundAssets.filter(a => !a.url);
  return <div className="film-reference-gallery"><button className="film-reference-upload" onClick={onUpload} disabled={busy}><span className="film-reference-stack">{refs.filter(r => r.kind === 'image').slice(0, 3).map(r => <img className="film-stack-image" src={toRenderableMediaUrl(r.url)} alt="" key={r.id} />)}{!refs.length && <ImagePlus className="film-stack-empty" size={23} />}</span><span className="film-reference-upload-copy"><strong className="film-reference-upload-title">添加视觉参考</strong><small className="film-muted">图片在上方独立排列，输入 @ 引用素材</small></span><span className="film-reference-total">{refs.length}</span><Plus className="film-reference-upload-icon" size={17} /></button>
    {(['character', 'scene', 'prop', 'position', 'other'] as const).map(layer => {
      const rows = labels.filter(r => (r.layer || 'other') === layer), absent = missing.filter(a => a.type === layer);
      if (!rows.length && !absent.length) return null;
      return <section className="film-reference-layer" key={layer} aria-label={`${{ character: '人物', scene: '场景', prop: '道具', position: '人物站位', other: '上传与其他参考' }[layer]}参考层`}><div className="film-reference-layer-label"><Layers3 className="film-layer-icon" size={11} />{{ character: '人物', scene: '场景', prop: '道具', position: '人物站位', other: '上传与其他参考' }[layer]}</div><div className="film-reference-tiles">{rows.map(r => <figure className="film-reference-tile" key={r.id} title={`${r.name} · ${r.label}`}>
        {r.kind === 'image' ? <img className="film-reference-image" src={toRenderableMediaUrl(r.url)} alt={r.name} /> : r.kind === 'video' ? <video className="film-reference-image" src={toRenderableMediaUrl(r.url)} preload="metadata" muted /> : <span className="film-reference-audio">音频</span>}
        <figcaption className="film-reference-caption">{r.label}</figcaption><button className="film-reference-remove" aria-label={`移除${r.name}`} disabled={busy} onClick={() => onRemove(r)}><X className="film-reference-close" size={12} /></button>
      </figure>)}{absent.map(a => <span key={a.id} className="film-reference-missing" title="先在场景角色道具中生成或上传参考图，完成后自动带入"><ImagePlus className="film-reference-missing-icon" size={18} /><span className="film-reference-missing-name">{a.name}</span><small className="film-reference-missing-state">待上传参考图</small></span>)}</div></section>;
    })}
  </div>;
}
