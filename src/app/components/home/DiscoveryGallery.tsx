import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight, Layers3, Play, Search, X } from 'lucide-react';
import type { CanvasTemplate } from '../../api/projects';
import { MediaThumb } from '../MediaThumb';
import { showcaseScenes as SHOWCASE_SCENES } from '../auth/showcase-scenes';

type Props = { templates: CanvasTemplate[]; loading: boolean; error: string; busy: boolean; zh: boolean; onRetry: () => void; onUseTemplate: (id: string) => void };
export function DiscoveryGallery(p: Props) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<number | null>(null);
  const q = search.trim().toLowerCase();
  const templates = p.templates.filter(t => t.name.toLowerCase().includes(q));
  const scenes = SHOWCASE_SCENES.filter(s => `${s.title.zh} ${s.title.en}`.toLowerCase().includes(q));
  const selected = preview === null ? null : SHOWCASE_SCENES[preview];
  return <section className="home-discovery" aria-label={p.zh ? '作品广场' : 'Discover'}>
    <div className="home-discovery-toolbar">
      <div className="home-gallery-tabs" role="group" aria-label={p.zh ? '作品分类' : 'Categories'}>
        {([['all', '全部', 'All'], ['templates', '精选模板', 'Templates'], ['inspiration', '创作灵感', 'Inspiration']] as const).map(([key, zh, en]) => <button key={key} type="button" className={filter === key ? 'is-active' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{p.zh ? zh : en}</button>)}
      </div>
      <label className="home-search"><Search size={15} /><input aria-label={p.zh ? '搜索作品与模板' : 'Search works and templates'} placeholder={p.zh ? '搜索作品与模板…' : 'Search works…'} value={search} onChange={e => setSearch(e.target.value)} /></label>
    </div>
    {p.error && filter !== 'inspiration' && <div className="home-inline-status" role="alert">{p.error}<button type="button" onClick={p.onRetry}>{p.zh ? '重试' : 'Retry'}</button></div>}
    {p.loading && filter !== 'inspiration' && <p className="home-muted" role="status">{p.zh ? '正在加载精选模板…' : 'Loading templates…'}</p>}
    <div className="home-gallery-grid">
      {filter !== 'inspiration' && templates.map(t => <article className="home-work" key={t.id} data-testid="template-card">
        <button type="button" className="home-work-cover" onClick={() => p.onUseTemplate(t.id)} disabled={p.busy} aria-label={`${p.zh ? '使用模板' : 'Use template'}：${t.name}`} data-testid="use-template">
          {t.cover_url ? <MediaThumb src={t.cover_url} alt={t.name} className="home-cover-image" /> : <div className="home-canvas-placeholder"><Layers3 size={28} /></div>}
          <span className="home-media-badge">{p.zh ? '画布模板' : 'TEMPLATE'}</span><span className="home-cover-action"><ArrowUpRight size={21} /></span>
        </button><h3>{t.name}</h3>
      </article>)}
      {filter !== 'templates' && scenes.map(s => <article className="home-work" key={s.id}>
        <button type="button" className="home-work-cover" onClick={() => setPreview(SHOWCASE_SCENES.indexOf(s))} aria-label={`${p.zh ? '预览' : 'Preview'}：${p.zh ? s.title.zh : s.title.en}`}>
          <img src={s.poster} alt="" className="home-cover-image" loading="lazy" /><span className="home-media-badge">{p.zh ? (s.video ? '品牌短片' : '灵感图集') : (s.video ? 'BRAND FILM' : 'INSPIRATION')}</span><span className="home-cover-action"><Play size={21} /></span>
        </button><h3>{p.zh ? s.title.zh : s.title.en}</h3>
      </article>)}
    </div>
    {!p.loading && (filter === 'templates' ? templates.length === 0 : filter === 'inspiration' ? scenes.length === 0 : templates.length + scenes.length === 0) && <div className="home-empty">{q ? (p.zh ? '没有找到匹配的作品，换个关键词试试。' : 'No matching works. Try another search.') : (p.zh ? '暂无公开模板，管理员发布后会显示在这里。' : 'No published templates yet.')}</div>}
    <p className="home-gallery-note">{p.zh ? '精选模板来自平台已发布画布；创作灵感为橙次元展示素材。' : 'Templates are published canvases. Inspiration features CCY showcase assets.'}</p>
    <Dialog.Root open={selected !== null} onOpenChange={open => { if (!open) setPreview(null); }}><Dialog.Portal><Dialog.Overlay className="home-dialog-overlay" /><Dialog.Content className="home-media-dialog" aria-describedby={undefined}>
      <Dialog.Title className="home-media-title">{selected && (p.zh ? selected.title.zh : selected.title.en)}</Dialog.Title>
      <Dialog.Close className="home-dialog-close" aria-label={p.zh ? '关闭预览' : 'Close preview'}><X size={19} /></Dialog.Close>
      {selected && (selected.video ? <video className="home-media-full" src={selected.video} poster={selected.poster} controls playsInline /> : <img className="home-media-full" src={selected.poster} alt={p.zh ? selected.title.zh : selected.title.en} />)}
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
