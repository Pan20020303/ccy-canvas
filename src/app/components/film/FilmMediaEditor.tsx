import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Copy, Download, Expand, Grid2X2, ImagePlus, LoaderCircle, Plus, Sparkles, Trash2, Upload, Video, WandSparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { uploadFile } from '../../api/projects';
import { toRenderableMediaUrl } from '../../reference-media';
import { editorId, inspectEditorAsset, type EditorAsset } from '../../video-editor-project';
import { REFERENCE_MODE_SPECS, type ReferenceModeKey } from '../../reference-modes';
import { FilmDialog, FilmModelSelect } from './FilmControls';
import { filmMediaPayload, filmShotPrompt, type FilmModel, type FilmProject, type FilmVersion, type FilmGenerationSettings, type FilmReference } from './film-project';
import { FilmOutputSettings } from './FilmOutputSettings';
import { FilmReferenceGallery } from './FilmReferenceGallery';
import { FilmPromptEditor } from './FilmPromptEditor';
import { filmDisplayPrompt, filmGenerationValues, filmReferences, filmReferencePrompt, filmRefToken } from './film-references';
import { activeFilmJob, filmError, filmStore, startFilmJob } from './film-store';

export async function downloadFilmMedia(url: string, name: string) {
  const response = await fetch(toRenderableMediaUrl(url), { credentials: 'include' });
  if (!response.ok) throw new Error('下载失败，请检查素材是否仍然可用。');
  const objectUrl = URL.createObjectURL(await response.blob());
  const a = document.createElement('a'); a.href = objectUrl; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
export function FilmMediaEditor({ userId, project: p, target, kind, models, onClose, onTarget }: {
  userId: string; project: FilmProject; target: string; kind: 'asset' | 'image' | 'video'; models: FilmModel[]; onClose: () => void; onTarget: (id: string) => void;
}) {
  const isVideo = kind === 'video';
  const assets = kind === 'asset' ? p.assets : p.shots;
  const item = assets.find(a => a.id === target)!;
  const asset = p.assets.find(a => a.id === target), shot = p.shots.find(s => s.id === target);
  const name = asset?.name || shot?.title || '未命名';
  const output = isVideo ? shot?.videoUrl : asset?.url || shot?.imageUrl;
  const [prompt, setPrompt] = useState(asset?.generationPrompt || (shot ? filmShotPrompt(shot, isVideo) : item.description));
  const [imageMode, setImageMode] = useState<'generate' | 'edit'>('generate');
  const typeModels = models.filter(m => m.type === (isVideo ? 'video' : 'image'));
  const mediaType = isVideo ? 'video' : 'image';
  const savedSettings = item.generation?.[mediaType] || {};
  const modelKey = savedSettings.modelKey || (isVideo ? p.settings.videoModel : p.settings.imageModel);
  const model = typeModels.find(m => m.key === modelKey) || (!modelKey ? typeModels[0] : undefined);
  const template = model?.template;
  const modes = template?.referenceModes?.length ? template.referenceModes : ['text-to-video' as const, 'multi-image' as const];
  const values = filmGenerationValues(model, p, savedSettings, shot), activeMode = values.mode;
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const refs = filmReferences(p, target, kind);
  const boundAssets = shot ? p.assets.filter(a => shot.assetIds.includes(a.id) && !(item.excludedReferenceIds || []).includes('asset:' + a.id)) : [];
  const input = useRef<HTMLInputElement>(null), uploadTarget = useRef<'reference' | 'result'>('reference');
  const actionLock = useRef(false);
  const job = [...p.jobs].reverse().find(j => j.targetId === target && j.kind === kind);
  const running = job && activeFilmJob(job);
  const patch = filmStore(userId, p.cloudId).getState().patch;
  const updatePrompt = (value: string) => {
    setPrompt(value);
    patch(current => kind === 'asset' ? { assets: current.assets.map(a => a.id === target ? { ...a, generationPrompt: value } : a) } : { shots: current.shots.map(s => s.id === target ? { ...s, [isVideo ? 'videoPrompt' : 'prompt']: value } : s) });
  };
  const updateGeneration = (change: Partial<FilmGenerationSettings>) => patch(current => kind === 'asset'
    ? { assets: current.assets.map(a => a.id === target ? { ...a, generation: { ...a.generation, [mediaType]: { ...a.generation?.[mediaType], ...change } } } : a) }
    : { shots: current.shots.map(s => s.id === target ? { ...s, generation: { ...s.generation, [mediaType]: { ...s.generation?.[mediaType], ...change } } } : s) });
  const updateRefs = (next: FilmReference[], excluded = item.excludedReferenceIds || []) => {
    patch(current => kind === 'asset' ? { assets: current.assets.map(a => a.id === target ? { ...a, references: next, autoBindReferences: true, excludedReferenceIds: excluded } : a) } : { shots: current.shots.map(s => s.id === target ? { ...s, references: next, autoBindReferences: true, excludedReferenceIds: excluded } : s) });
  };
  const removeRef = (ref: FilmReference) => {
    updateRefs(refs.filter(r => r.id !== ref.id), [...(item.excludedReferenceIds || []), ref.id]);
    updatePrompt(prompt.split(filmRefToken(ref)).join(ref.name));
  };
  const chooseFile = (destination: 'reference' | 'result') => { uploadTarget.current = destination; input.current?.click(); };
  const upload = async (files: File[]) => {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true); setError('');
    try {
      const imported: EditorAsset[] = [];
      for (const file of files) {
        const mediaKind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : null;
        if (!mediaKind || (!isVideo && mediaKind !== 'image') || file.size > 512 * 1024 * 1024) throw new Error('请选择支持的图片、视频或音频，单个文件不超过512MB。');
        if (uploadTarget.current === 'result' && mediaKind !== (isVideo ? 'video' : 'image')) throw new Error(isVideo ? '这里需要上传分镜视频。' : '这里需要上传图片。');
        const objectUrl = URL.createObjectURL(file);
        let info;
        try { info = await inspectEditorAsset(objectUrl, mediaKind); } finally { URL.revokeObjectURL(objectUrl); }
        const result = await uploadFile(file, file.name);
        const media: EditorAsset = { id: editorId(), name: file.name, kind: mediaKind, url: result.url, ...info };
        imported.push(media);
        if (uploadTarget.current === 'result') {
          const version: FilmVersion = { id: media.id, url: media.url, createdAt: Date.now(), label: '本地上传', kind: isVideo ? 'video' : 'image' };
          patch(current => kind === 'asset' ? { assets: current.assets.map(a => a.id === target ? { ...a, url: media.url, history: [...a.history, version] } : a) } : { shots: current.shots.map(s => s.id === target ? { ...s, ...(isVideo ? { videoUrl: media.url, videoDuration: info.duration } : { imageUrl: media.url, status: 'generated' as const }), history: [...s.history, version] } : s) });
        }
      }
      if (uploadTarget.current === 'reference') updateRefs([...refs, ...imported]);
    } catch (e) { setError(filmError(e)); } finally { setBusy(false); actionLock.current = false; }
  };
  const submit = async () => {
    if (!model || actionLock.current) return;
    actionLock.current = true; setError('');
    try {
      const selectedRefs = imageMode === 'edit' && output && !isVideo && !refs.some(r => r.url === output) ? [...refs, { id: 'current', name: '当前图片', kind: 'image' as const, url: output, duration: 0 }] : refs;
      const payload = filmMediaPayload(model, p, filmReferencePrompt(prompt, selectedRefs), isVideo ? 'video' : 'image', selectedRefs, values);
      await startFilmJob(userId, kind, payload, target, p.cloudId);
    } catch (e) { setError(filmError(e)); } finally { actionLock.current = false; }
  };
  const selectHistory = (v: FilmVersion) => patch(current => kind === 'asset' ? { assets: current.assets.map(a => a.id === target ? { ...a, url: v.url } : a) } : { shots: current.shots.map(s => s.id === target ? { ...s, ...(isVideo ? { videoUrl: v.url, videoDuration: undefined } : { imageUrl: v.url }) } : s) });
  const transform = (instruction: string) => { setImageMode('edit'); updatePrompt(instruction); };
  const saveDuration = (value: number) => { if (shot && Number.isFinite(value) && value > 0 && shot.videoDuration !== value) patch(current => ({ shots: current.shots.map(s => s.id === target ? { ...s, videoDuration: value } : s) })); };
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Content className="film-media-editor" aria-describedby={undefined}><Dialog.Title className="film-sr-only">{name} · {isVideo ? '视频制作' : '图片制作'}</Dialog.Title>
    <header className="film-media-header"><button className="film-button film-plain" onClick={onClose}><ArrowLeft size={17} />返回</button><strong className="film-truncate">{p.name}</strong><span className="film-muted">共 {assets.length} 个{kind === 'asset' ? '资产' : '分镜'}</span></header>
    <input ref={input} className="film-hidden" type="file" accept={isVideo ? 'image/*,video/*,audio/*' : 'image/*'} multiple onChange={e => { void upload(Array.from(e.target.files || [])); e.target.value = ''; }} />
    <div className="film-media-columns"><section className="film-media-compose">
      <div className="film-media-tabs">{isVideo ? modes.map(m => <button key={m} className={activeMode === m ? 'is-active' : ''} onClick={() => updateGeneration({ mode: m })}>{REFERENCE_MODE_SPECS[m].label.zh}</button>) : <><button className={imageMode === 'generate' ? 'is-active' : ''} onClick={() => setImageMode('generate')}><ImagePlus size={18} />生图</button><button className={imageMode === 'edit' ? 'is-active' : ''} onClick={() => setImageMode('edit')}><WandSparkles size={18} />改图</button></>}</div>
      <div className="film-media-model-row"><FilmModelSelect models={typeModels} value={model?.key || ''} onChange={value => updateGeneration({ modelKey: value })} /></div>
      <div className="film-media-prompt"><div className="film-prompt-heading"><strong className="film-prompt-heading-title">描述这个镜头</strong><span className="film-muted film-small">{name}</span></div>
        <FilmReferenceGallery refs={refs} boundAssets={boundAssets} onUpload={() => chooseFile('reference')} onRemove={removeRef} busy={busy} />
        <FilmPromptEditor value={prompt} refs={refs} onChange={updatePrompt} placeholder={imageMode === 'edit' ? '描述你想修改的画面内容，输入 @ 引用素材…' : '描述画面、动作与运镜，输入 @ 引用本镜头素材…'} />
        <div className="film-prompt-tools"><button className="film-icon" title="复制提示词" onClick={() => void navigator.clipboard.writeText(filmDisplayPrompt(prompt, refs)).then(() => toast.success('已复制')).catch(() => toast.error('复制失败'))}><Copy size={15} /></button><button className="film-icon" title="清空提示词" onClick={() => updatePrompt('')}><Trash2 size={15} /></button><span className="film-muted film-small">{prompt.length}/6000</span><span className="film-spacer" /><Sparkles size={17} /></div>
      </div>
      <FilmOutputSettings model={model} project={p} shot={shot} saved={savedSettings} video={isVideo} onChange={updateGeneration} />
      <button className="film-primary film-generate" disabled={!model || !prompt.trim() || Boolean(running) || busy} onClick={() => void submit()}>{running || busy ? <LoaderCircle className="film-spin" size={18} /> : <WandSparkles size={18} />}{busy ? '正在上传…' : running ? '正在生成…' : isVideo ? '生成视频' : imageMode === 'edit' ? '生成修改图' : '生成图片'}<span className="film-small">按渠道计费</span></button>
      {(error || job?.status === 'error' || job?.status === 'unknown') && <p role="alert" className="film-error">{error || job?.error}</p>}
    </section>
    <section className="film-media-result"><div className="film-result-main"><div className="film-result-label">{output ? name : '生成结果'}<span className="film-muted film-small">{running ? '任务正在后台处理中' : ''}</span></div>
      {output ? <><div className="film-result-preview">{isVideo ? <video className="film-result-video" src={toRenderableMediaUrl(output)} controls playsInline onLoadedMetadata={e => saveDuration(e.currentTarget.duration)} /> : <img className="film-result-image" src={toRenderableMediaUrl(output)} alt={name} onDoubleClick={() => setPreview(true)} />}<div className="film-result-actions"><button className="film-icon" title="放大预览" onClick={() => setPreview(true)}><Expand size={17} /></button><button className="film-icon" title="下载素材" onClick={() => void downloadFilmMedia(output, name + (isVideo ? '.mp4' : '.png')).catch(e => setError(filmError(e)))}><Download size={17} /></button></div></div>{!isVideo && <div className="film-image-tools"><button className="film-button" onClick={() => transform('保持原图人物、场景、服装和光线一致，生成2x2四宫格连续关键帧，每格不同景别，不添加文字。')}><Grid2X2 size={15} />四宫格</button><button className="film-button" onClick={() => transform('保持主体外观和场景一致，生成该场景的全景广角视图。')}>全景视图</button><button className="film-button" onClick={() => setImageMode('edit')}><WandSparkles size={15} />改图</button><button className="film-button" onClick={() => transform('保持原图构图和内容完全不变，提高画面清晰度和纹理细节，不添加新元素。')}>变清晰</button><button className="film-button" onClick={() => transform('保持主体身份、服装和光线一致，生成正面、侧面、背面三个机位的画面。')}>多机位</button></div>}</> : <div className="film-media-empty">{running ? <LoaderCircle size={42} className="film-spin" /> : <div className="film-empty-art"><FilmIcon video={isVideo} /></div>}<p className="film-muted">{running ? '正在生成，请稍候…可返回其他步骤继续编辑' : '请在左侧生成素材，或从右侧上传已有素材'}</p></div>}
    </div><aside className="film-history"><span>历史记录</span><button className="film-history-upload" disabled={busy} onClick={() => chooseFile('result')}><Plus size={22} />上传</button>{item.history.filter(v => v.kind === (isVideo ? 'video' : 'image')).slice().reverse().map(v => <button className={`film-history-item ${output === v.url ? 'is-active' : ''}`} title={`${v.label} · ${new Date(v.createdAt).toLocaleString()}`} key={v.id} onClick={() => selectHistory(v)}>{isVideo ? <video className="film-cover" src={toRenderableMediaUrl(v.url)} preload="metadata" muted /> : <img className="film-cover" src={toRenderableMediaUrl(v.url)} alt={v.label} />}{output === v.url && <Check size={16} />}</button>)}</aside></section></div>
    <footer className="film-media-footer"><div className="film-media-filmstrip">{assets.map((a, i) => { const s = p.shots.find(s => s.id === a.id), src = kind === 'asset' ? p.assets.find(v => v.id === a.id)?.url : s?.imageUrl; return <button key={a.id} className={`film-filmstrip-item ${target === a.id ? 'is-active' : ''}`} onClick={() => onTarget(a.id)}>{src ? <img className="film-cover" src={toRenderableMediaUrl(src)} alt="" /> : <Video size={21} />}<span>{String(i + 1).padStart(2, '0')}</span></button>; })}</div><button className="film-icon" aria-label="上一项" disabled={assets.findIndex(a => a.id === target) === 0} onClick={() => onTarget(assets[assets.findIndex(a => a.id === target) - 1].id)}><ChevronLeft /></button><button className="film-icon" aria-label="下一项" disabled={assets.findIndex(a => a.id === target) === assets.length - 1} onClick={() => onTarget(assets[assets.findIndex(a => a.id === target) + 1].id)}><ChevronRight /></button></footer>
    {preview && output && <FilmDialog title={name} className="film-preview-dialog" onClose={() => setPreview(false)}>{isVideo ? <video className="film-preview-full" src={toRenderableMediaUrl(output)} controls autoPlay playsInline /> : <img className="film-preview-full" src={toRenderableMediaUrl(output)} alt={name} />}</FilmDialog>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
function FilmIcon({ video }: { video: boolean }) { return video ? <Video size={46} strokeWidth={1} /> : <ImagePlus size={46} strokeWidth={1} />; }
