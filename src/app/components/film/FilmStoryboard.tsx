import { useRef, useState } from 'react';
import { Check, Clapperboard, ImagePlus, LoaderCircle, Plus, Settings2, Sparkles, Upload, X } from 'lucide-react';
import { uploadFile } from '../../api/projects';
import { reconcileStoryboardAssetReferences } from '../../automation-workflow';
import { toRenderableMediaUrl } from '../../reference-media';
import { editorId } from '../../video-editor-project';
import { filmShotPrompt, type FilmAsset, type FilmGenerationSettings, type FilmModel, type FilmProject, type FilmShot } from './film-project';
import { activeFilmJob, filmError, filmStore, startFilmJob } from './film-store';
import { FilmDialog, FilmModelSelect } from './FilmControls';
import { FilmPromptEditor } from './FilmPromptEditor';
import { FilmOutputSettings } from './FilmOutputSettings';
import { filmImageRequest, filmReferenceLabels, filmReferences, filmRefToken, filmShotVideoRequest } from './film-references';

type AssetLayer = 'character' | 'scene' | 'prop';
const layerNames = { character: '人物', scene: '场景', prop: '道具' };
type Props = { project: FilmProject; userId: string; models: FilmModel[]; selectedId: string; onSelect: (id: string) => void; onAdd: () => void; onGenerateScript: () => void; onEditAsset: (id: string) => void; onMedia: (id: string, kind: 'image' | 'video') => void; onTasks: () => void; preparing: boolean; search: string; onSearch: (value: string) => void; onSettings: () => void };

export function FilmStoryboard(props: Props) {
  const { project: p, selectedId, onSelect } = props;
  const shot = p.shots.find(s => s.id === selectedId) || p.shots[0];
  return <div className="film-storyboard-workbench">
    <aside className="film-shot-rail" aria-label="镜头列表"><header><strong>分镜脚本 <span>{p.shots.length}</span></strong><button className="film-icon" aria-label="新增分镜" onClick={props.onAdd}><Plus size={17} /></button></header>
      <input className="film-shot-search" aria-label="搜索分镜" placeholder="搜索镜头" value={props.search} onChange={e => props.onSearch(e.target.value)} />
      <div className="film-shot-rail-items">{p.shots.filter(s => (s.title + s.description).includes(props.search)).map(s => <button className={`film-shot-rail-item ${s.id === shot?.id ? 'is-active' : ''}`} key={s.id} aria-label={`选择${s.title}`} aria-pressed={s.id === shot?.id} onClick={() => onSelect(s.id)}><span className="film-shot-rail-thumb">{s.imageUrl ? <img src={toRenderableMediaUrl(s.imageUrl)} alt="" /> : <Clapperboard size={21} />}</span><span className="film-shot-rail-copy"><strong>{String(p.shots.indexOf(s) + 1).padStart(2, '0')} · {s.title}</strong><small>{s.shot} · {s.duration}</small><small>{s.assetIds.length} 个资产 · {s.videoUrl ? '视频就绪' : s.imageUrl ? '分镜图就绪' : '待生成'}</small></span></button>)}{!p.shots.length && <p className="film-muted film-small">完成资产准备后，将剧本拆解为镜头。</p>}</div>
      <button className="film-button film-accent film-split-button" disabled={props.preparing || !p.script.trim()} onClick={props.onGenerateScript}>{props.preparing ? <LoaderCircle className="film-spin" size={15} /> : <Sparkles size={15} />}{p.shots.length ? '追加分镜' : '生成分镜脚本'}</button>
    </aside>
    {shot ? <ShotDetail key={shot.id} {...props} shot={shot} /> : <section className="film-storyboard-empty"><Clapperboard size={42} /><h2>从剧本到每一个镜头</h2><p>生成分镜后，提示词和本镜头的人物、场景、道具会自动填入。</p><div><button className="film-primary" disabled={props.preparing} onClick={props.onGenerateScript}><Sparkles size={16} />生成分镜脚本</button><button className="film-button" onClick={props.onAdd}><Plus size={16} />手动新增镜头</button></div></section>}
  </div>;
}

function ShotDetail({ project: p, shot, userId, models, onEditAsset, onMedia, onTasks, onSettings }: Props & { shot: FilmShot }) {
  const store = filmStore(userId, p.cloudId);
  const syncStatus = store(s => s.syncStatus);
  const [mode, setMode] = useState<'image' | 'video'>(p.settings.method === 'reference' ? 'video' : 'image');
  const [picker, setPicker] = useState<AssetLayer | null>(null), [pickerSearch, setPickerSearch] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null), lock = useRef(false);
  const refs = filmReferences(p, shot.id, mode), labels = filmReferenceLabels(refs);
  const saved = shot.generation?.[mode] || {};
  const options = models.filter(m => m.type === mode), modelKey = saved.modelKey || p.settings[`${mode}Model`];
  const model = options.find(m => m.key === modelKey) || (!modelKey ? options[0] : undefined);
  const job = [...p.jobs].reverse().find(j => j.targetId === shot.id && j.kind === mode);
  const running = Boolean(job && activeFilmJob(job));
  const prompt = filmShotPrompt(shot, mode === 'video');
  const update = (change: Partial<FilmShot> | ((s: FilmShot) => Partial<FilmShot>)) => store.getState().patch(current => ({ shots: current.shots.map(s => s.id === shot.id ? { ...s, ...(typeof change === 'function' ? change(s) : change) } : s) }));
  const parameters = (change: Partial<FilmGenerationSettings>) => update(s => ({ generation: { ...s.generation, [mode]: { ...s.generation?.[mode], ...change } } }));
  const toggleAsset = (asset: FilmAsset) => {
    const token = filmRefToken({ id: `asset:${asset.id}` });
    update(s => {
      const removing = s.assetIds.includes(asset.id);
      return { assetIds: removing ? s.assetIds.filter(id => id !== asset.id) : [...s.assetIds, asset.id], autoBindReferences: true,
        excludedReferenceIds: (s.excludedReferenceIds || []).filter(id => id !== `asset:${asset.id}`),
        ...(removing ? { prompt: s.prompt?.split(token).join(asset.name), videoPrompt: s.videoPrompt?.split(token).join(asset.name) } : {}) };
    });
  };
  const matchAssets = () => {
    const current = store.getState().project, selected = current.shots.find(s => s.id === shot.id);
    if (selected) update({ assetIds: reconcileStoryboardAssetReferences([selected], current.assets)[0].assetIds, autoBindReferences: true, excludedReferenceIds: [] });
  };
  const uploadPosition = async (files: File[]) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('站位图支持 PNG、JPG、WebP，单张不超过20MB。');
        const result = await uploadFile(file, file.name);
        update(s => ({ autoBindReferences: true, references: [...(s.references || []), { id: editorId(), name: file.name, kind: 'image', url: result.url, duration: 0, layer: 'position' }] }));
      }
    } catch (e) { setError(filmError(e)); } finally { setBusy(false); lock.current = false; }
  };
  const submit = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const current = store.getState().project, selected = current.shots.find(s => s.id === shot.id);
      if (!selected) throw new Error('镜头已被移除。');
      const payload = mode === 'video' ? filmShotVideoRequest(current, selected, models) : filmImageRequest(current, selected.id, 'image', models);
      onTasks(); await startFilmJob(userId, mode, payload, selected.id, p.cloudId);
    } catch (e) { setError(filmError(e)); } finally { setBusy(false); lock.current = false; }
  };
  return <>
    <section className="film-shot-writing" aria-label="当前镜头编辑"><header className="film-shot-writing-header"><div><span className="film-eyebrow">SHOT {String(p.shots.indexOf(shot) + 1).padStart(2, '0')}</span><input aria-label="当前镜头名称" value={shot.title} onChange={e => update({ title: e.target.value })} /></div><button className="film-button" onClick={matchAssets}><Sparkles size={14} />匹配素材</button></header>
      <div className="film-shot-writing-meta"><label>景别<input aria-label="当前镜头景别" value={shot.shot} onChange={e => update({ shot: e.target.value })} /></label><label>脚本时长<input aria-label="当前镜头时长" type="number" min={1} max={30} value={Number.parseFloat(shot.duration) || 4} onChange={e => update({ duration: `${e.target.value}s` })} /><span>秒</span></label></div>
      <div className="film-shot-prompt-tabs" role="tablist" aria-label="镜头提示词类型"><button role="tab" aria-selected={mode === 'image'} onClick={() => { setMode('image'); setError(''); }}>{p.settings.method === 'grid' ? '宫格图提示词' : '分镜图提示词'}</button><button role="tab" aria-selected={mode === 'video'} onClick={() => { setMode('video'); setError(''); }}>视频提示词</button></div>
      <div className="film-shot-prompt-body"><FilmPromptEditor value={prompt} refs={refs} onChange={value => update({ [mode === 'video' ? 'videoPrompt' : 'prompt']: value })} placeholder="描述这个镜头的画面、动作与运镜。输入 @ 引用右侧素材…" /><footer><span>{prompt.length} 字 · 输入 @ 插入参考素材</span><span>{syncStatus === 'conflict' || syncStatus === 'error' ? '本机修改待同步' : syncStatus === 'saving' ? '正在保存…' : syncStatus === 'saved' ? '已保存到数据库' : '自动保存'}</span></footer></div>
      <details className="film-shot-script-details"><summary>原始分镜与连续性</summary><label className="film-form-field">画面与对白<textarea aria-label="当前分镜脚本" rows={4} value={shot.description} onChange={e => update({ description: e.target.value })} /></label><label className="film-form-field">运镜<input aria-label="当前镜头运镜" value={shot.camera || ''} onChange={e => update({ camera: e.target.value })} /></label><label className="film-form-field">动作<input value={shot.action || ''} onChange={e => update({ action: e.target.value })} /></label><label className="film-form-field">连续性<input value={shot.continuity || ''} onChange={e => update({ continuity: e.target.value })} /></label></details>
      {(shot.imageUrl || shot.videoUrl) && <div className="film-shot-result-inline"><header><strong>本镜头生成结果</strong><button className="film-plain" onClick={() => onMedia(shot.id, mode)}>历史版本 / 上传</button></header>{mode === 'video' && shot.videoUrl ? <video src={toRenderableMediaUrl(shot.videoUrl)} controls preload="metadata" onLoadedMetadata={e => { const duration = e.currentTarget.duration; if (Number.isFinite(duration) && duration > 0 && duration !== shot.videoDuration) update({ videoDuration: duration }); }} /> : shot.imageUrl ? <img src={toRenderableMediaUrl(shot.imageUrl)} alt={`${shot.title}分镜图`} /> : <p className="film-muted">视频已完成，切换至视频提示词查看。</p>}</div>}
    </section>
    <aside className="film-shot-materials" aria-label="本镜头素材与生成设置"><header><strong>镜头素材</strong><span className="film-muted film-small">随分镜自动带入</span></header>
      <div className="film-shot-materials-scroll">{(['character', 'scene', 'prop'] as const).map(layer => <section className="film-shot-asset-section" key={layer} aria-label={`本镜头的${layerNames[layer]}`}><div className="film-shot-asset-heading"><h3>{layer === 'scene' ? '本镜头的场景' : `本镜头出现的${layerNames[layer]}`}</h3><span>{p.assets.filter(a => a.type === layer && shot.assetIds.includes(a.id)).length}</span></div><div className="film-shot-asset-tiles">{p.assets.filter(a => a.type === layer && shot.assetIds.includes(a.id)).map(a => <div className="film-shot-asset-tile" key={a.id}><button title={`编辑${a.name}`} onClick={() => onEditAsset(a.id)}>{a.url ? <img src={toRenderableMediaUrl(a.url)} alt={a.name} /> : <span className="film-shot-asset-missing"><ImagePlus size={20} /><small>待制作</small></span>}<span className="film-shot-asset-name">{a.name}</span><small>{labels.find(r => r.assetId === a.id)?.label || (a.url ? '已关联' : '缺少参考图')}</small></button><button className="film-shot-asset-remove" aria-label={`取消关联${a.name}`} onClick={() => toggleAsset(a)}><X size={12} /></button></div>)}<button className="film-shot-add-reference" aria-label={`添加${layerNames[layer]}参考`} onClick={() => { setPicker(layer); setPickerSearch(''); }}><Plus size={23} /><span>添加</span></button></div></section>)}
      <section className="film-shot-asset-section" aria-label="人物站位图"><div className="film-shot-asset-heading"><h3>人物站位图 <small>可选</small></h3></div><div className="film-shot-asset-tiles">{(shot.references || []).filter(r => r.layer === 'position').map(r => <div className="film-shot-asset-tile" key={r.id}><img src={toRenderableMediaUrl(r.url)} alt={r.name} /><span className="film-shot-asset-name">{r.name}</span><button className="film-shot-asset-remove" aria-label={`移除站位图${r.name}`} onClick={() => update(s => ({ references: s.references?.filter(ref => ref.id !== r.id), prompt: s.prompt?.split(filmRefToken(r)).join(r.name), videoPrompt: s.videoPrompt?.split(filmRefToken(r)).join(r.name) }))}><X size={12} /></button></div>)}<button className="film-shot-add-reference" disabled={busy} onClick={() => input.current?.click()}><Upload size={20} /><span>上传站位</span></button></div><input hidden ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e => { void uploadPosition(Array.from(e.target.files || [])); e.target.value = ''; }} /><p className="film-muted film-small">用于约束人物位置与构图。图生视频时先应用到分镜图。</p></section>
      {refs.some(r => !r.assetId && r.layer !== 'position') && <section className="film-shot-asset-section"><div className="film-shot-asset-heading"><h3>其他参考</h3></div><div className="film-shot-asset-tiles">{labels.filter(r => !r.assetId && r.layer !== 'position').map(r => <figure className="film-shot-asset-tile" key={r.id}>{r.kind === 'image' ? <img src={toRenderableMediaUrl(r.url)} alt={r.name} /> : <span>{r.kind === 'video' ? '视频' : '音频'}</span>}<figcaption className="film-shot-asset-name" title={r.name}>{r.name}</figcaption><small>{r.label}</small></figure>)}</div></section>}
      {shot.autoBindReferences !== true && shot.references !== undefined && <button className="film-button" onClick={matchAssets}>启用自动素材绑定</button>}
      </div>
      <footer className="film-shot-generation"><div className="film-shot-model-heading"><strong>{mode === 'video' ? '视频模型' : '图片模型'}</strong><button className="film-icon" aria-label="打开制作设置" onClick={onSettings}><Settings2 size={16} /></button></div><FilmModelSelect models={options} value={model?.key || ''} onChange={modelKey => parameters({ modelKey })} label="当前镜头生成模型" />{modelKey && !model && <p className="film-error">已选模型不可用，请重新选择。</p>}<FilmOutputSettings model={model} project={p} shot={shot} saved={saved} video={mode === 'video'} onChange={parameters} />
        <p className="film-shot-method-note">{mode === 'image' ? '生成后自动保存为本镜头分镜图' : p.settings.method === 'reference' ? `全能参考 · 使用本镜头 ${refs.length} 个素材` : '图生视频 · 使用本镜头已完成的画面'}</p><button className="film-primary film-shot-generate" disabled={busy || running || !model || !prompt.trim()} onClick={() => void submit()}>{running || busy ? <LoaderCircle className="film-spin" size={16} /> : <Sparkles size={16} />}{busy ? '正在提交…' : running ? '正在后台生成…' : mode === 'video' ? '生成本镜头视频' : p.settings.method === 'grid' ? '生成宫格分镜图' : '生成分镜图'}</button><button className="film-plain film-shot-upload-result" onClick={() => onMedia(shot.id, mode)}>上传已有{mode === 'video' ? '视频' : '分镜图'} / 查看历史</button>{(error || job?.status === 'error') && <p className="film-error" role="alert">{error || job?.error}</p>}
      </footer>
    </aside>
    {picker && <FilmDialog title={`选择本镜头${layerNames[picker]}`} onClose={() => setPicker(null)}><input className="film-shot-search" aria-label="搜索可选资产" value={pickerSearch} onChange={e => setPickerSearch(e.target.value)} placeholder="按名称搜索" /><div className="film-asset-picker-grid">{p.assets.filter(a => a.type === picker && a.name.includes(pickerSearch)).map(a => <button className={shot.assetIds.includes(a.id) ? 'is-active' : ''} aria-pressed={shot.assetIds.includes(a.id)} key={a.id} onClick={() => toggleAsset(a)}>{a.url ? <img src={toRenderableMediaUrl(a.url)} alt="" /> : <ImagePlus size={28} />}<span>{a.name}</span><small>{a.url ? '参考图已就绪' : '待上传 / 生成'}</small>{shot.assetIds.includes(a.id) && <Check size={17} />}</button>)}</div>{!p.assets.some(a => a.type === picker) && <p className="film-muted">尚无此类资产，请先在“场景角色道具”中添加。</p>}<footer className="film-dialog-footer"><button className="film-primary" onClick={() => setPicker(null)}>完成选择</button></footer></FilmDialog>}
  </>;
}
