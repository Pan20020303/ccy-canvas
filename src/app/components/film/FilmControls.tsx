import { useState, type CSSProperties, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronDown, Film, Monitor, Plus, Smartphone, Square, X } from 'lucide-react';
import { FILM_STYLES, type FilmModel, type FilmProject, type FilmStyle } from './film-project';
import { toRenderableMediaUrl } from '../../reference-media';
import dragon from '../../../imports/auth/dragon-realm.webp';
import stellar from '../../../imports/auth/stellar-voyage.webp';
import origin from '../../../imports/auth/origin-poster.jpg';

export function FilmDialog({ title, children, onClose, className = '' }: { title: string; children: ReactNode; onClose: () => void; className?: string }) {
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="film-overlay" />
    <Dialog.Content className={`film-dialog ${className}`} aria-describedby={undefined}>
      <header className="film-dialog-header"><Dialog.Title className="film-dialog-title">{title}</Dialog.Title><Dialog.Close className="film-icon" aria-label="关闭弹窗"><X size={20} /></Dialog.Close></header>
      {children}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
export function FilmModelSelect({ models, value, onChange, label = '生成模型' }: { models: FilmModel[]; value: string; onChange: (value: string) => void; label?: string }) {
  return <label className="film-model-select"><Film size={15} /><select className="film-select" aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
    {!models.length && <option value="">暂无可用模型</option>}
    {models.length > 0 && !models.some(m => m.key === value) && <option value={value}>{value ? '已选模型不可用，请重新选择' : '请选择模型'}</option>}
    {models.map(m => <option key={m.key} value={m.key}>{m.name} · {m.provider.name}</option>)}
  </select><ChevronDown size={13} /></label>;
}
function StyleCard({ style, active, onClick }: { style: FilmStyle; active: boolean; onClick: () => void }) {
  return <button className={`film-style-card ${active ? 'is-active' : ''}`} style={{ '--style-tone': style.tone } as CSSProperties} aria-pressed={active} onClick={onClick} title={style.prompt}>
    <img className="film-style-image" src={style.category === '2D' ? dragon : style.category === '3D' ? origin : stellar} alt="" loading="lazy" />
    <span className="film-style-tint" /><span className="film-style-name">{style.name}</span>{active && <Check className="film-style-check" size={14} />}
  </button>;
}
export function FilmSettings({ project: p, models, patch, uploadStyle }: { project: FilmProject; models: FilmModel[]; patch: (settings: Partial<FilmProject['settings']>) => void; uploadStyle: () => void }) {
  const [expanded, setExpanded] = useState(false), [showStyles, setShowStyles] = useState(false);
  const [category, setCategory] = useState('全部'), [pending, setPending] = useState(p.settings.style);
  const selectedStyle = FILM_STYLES.find(s => s.id === p.settings.style) || FILM_STYLES[0];
  const featured = [selectedStyle, ...FILM_STYLES.filter(s => s.id !== selectedStyle.id)].slice(0, 7);
  return <div className="film-settings">
    <section className="film-setting-section"><h2 className="film-section-title">视频画面比例 <span className="film-info">i</span></h2>
      <div className="film-ratios">{(['9:16', '16:9', ...(expanded ? ['1:1'] : [])] as FilmProject['settings']['ratio'][]).map(ratio => {
        const Icon = ratio === '9:16' ? Smartphone : ratio === '16:9' ? Monitor : Square;
        return <button className={`film-ratio ${p.settings.ratio === ratio ? 'is-active' : ''}`} key={ratio} aria-pressed={p.settings.ratio === ratio} onClick={() => patch({ ratio })}><Icon size={22} />{ratio === '9:16' ? '竖屏' : ratio === '16:9' ? '横屏' : '方形'} <span className="film-muted">({ratio})</span></button>;
      })}<button className="film-pill" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开'}</button></div>
    </section>
    <section className="film-setting-section"><h2 className="film-section-title">生分镜视频方式 <span className="film-info">i</span></h2><div className="film-methods">
      {([{ id: 'reference', title: '全能参考模式', desc: '使用场景与角色参考图，直接生成连贯视频' }, { id: 'image', title: '图生视频模式', desc: '先生成分镜画面，再由画面生成视频' }, { id: 'grid', title: '多宫格生视频', desc: '先制作连续关键帧，统一镜头的动作与构图' }] as const).map(m => <button key={m.id} className={`film-method ${p.settings.method === m.id ? 'is-active' : ''}`} aria-pressed={p.settings.method === m.id} onClick={() => patch({ method: m.id })}><strong className="film-method-title">{m.title}</strong><span className="film-method-desc">{m.desc}</span></button>)}
    </div></section>
    <section className="film-setting-section"><h2 className="film-section-title">选择画面风格 <span className="film-info">i</span></h2><p className="film-muted film-small">风格库</p>
      <div className="film-style-row">{featured.map(s => <StyleCard key={s.id} style={s} active={p.settings.style === s.id} onClick={() => patch({ style: s.id })} />)}<button className="film-style-more" onClick={() => { setPending(p.settings.style); setShowStyles(true); }}>更多 →</button></div>
      <p className="film-small film-muted film-style-description">{selectedStyle.prompt}。缩略图为平台风格示意，实际效果以生成结果为准。</p>
      <p className="film-small film-style-caption">上传参考图，自定义画风。参考图会随生成请求一起提交。</p>
      <div className="film-style-upload-row"><button className="film-style-upload" onClick={uploadStyle}>{p.settings.styleImage ? <img className="film-cover" src={toRenderableMediaUrl(p.settings.styleImage)} alt="自定义风格参考" /> : <><Plus size={24} /><span>添加风格</span></>}</button>{p.settings.styleImage && <button className="film-button" onClick={() => patch({ styleImage: undefined })}>移除参考图</button>}</div>
    </section>
    <section className="film-setting-section film-model-section"><h2 className="film-section-title">制作模型</h2><p className="film-muted film-small">来自后台已启用的服务渠道，生成时使用对应模型计费。</p><div className="film-models-row">{(['text', 'image', 'video'] as const).map((type, i) => {
      const options = models.filter(m => m.type === type), key = `${type}Model` as 'textModel' | 'imageModel' | 'videoModel';
      return <div className="film-model-field" key={type}><span className="film-muted">{['剧本与分镜', '场景与分镜图', '分镜视频'][i]}</span><FilmModelSelect models={options} value={p.settings[key] || options[0]?.key || ''} onChange={value => patch({ [key]: value })} label={['文字模型', '图片模型', '视频模型'][i]} /></div>;
    })}</div></section>
    {showStyles && <FilmDialog title="全部风格" onClose={() => setShowStyles(false)} className="film-styles-dialog"><div className="film-tabs">{['全部', '真人', '3D', '2D'].map(c => <button className={category === c ? 'is-active' : ''} onClick={() => setCategory(c)} key={c}>{c}</button>)}</div><div className="film-style-grid">{FILM_STYLES.filter(s => category === '全部' || s.category === category).map(s => <StyleCard key={s.id} style={s} active={pending === s.id} onClick={() => setPending(s.id)} />)}</div><footer className="film-dialog-footer"><button className="film-button" onClick={() => setShowStyles(false)}>取消</button><button className="film-primary" onClick={() => { patch({ style: pending }); setShowStyles(false); }}>确认</button></footer></FilmDialog>}
  </div>;
}
