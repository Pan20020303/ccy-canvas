import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Check, CheckCircle2, ChevronRight, Clapperboard, Clock3, Copy, Download, FileText, FolderUp, History, ImagePlus, LoaderCircle, PanelLeftClose, PanelLeftOpen, PencilLine, Plus, Redo2, RefreshCw, Replace, Search, Settings2, Sparkles, Trash2, Undo2, Video, WandSparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../auth/AuthProvider';
import { listAppProviderConfigs } from '../../api/providerConfigs';
import { listSkills } from '../../api/skills';
import { uploadFile } from '../../api/projects';
import { extractScriptDocumentText } from '../../document-text';
import { toRenderableMediaUrl } from '../../reference-media';
import { editorId, type EditorAsset } from '../../video-editor-project';
import { FILM_STEPS, SCRIPT_LIMIT, filmModels, filmTextPayload, type FilmAsset, type FilmJob, type FilmModel, type FilmShot, type FilmTextKind } from './film-project';
import { activeFilmJob, filmError, filmStore, pollFilmJobs, recoverFilmJob, retryFilmJob, startFilmJob } from './film-store';
import { FilmDialog, FilmModelSelect, FilmSettings } from './FilmControls';
import { FilmMediaEditor } from './FilmMediaEditor';
import { FilmPreview } from './FilmPreview';
import { FilmProductionSettings } from './FilmProductionSettings';
import { FilmLibrary } from './FilmLibrary';
import { downloadFilmBackup, loadCloudFilm, syncCloudFilm, useCloudVersion } from './film-cloud';
import { filmImageRequest, filmShotVideoRequest } from './film-references';
import { FilmTaskPanel } from './FilmTaskPanel';
import './film.css';

export function OneClickFilm() {
  const { user } = useAuth();
  const { projectId } = useParams();
  const location = useLocation();
  if (location.pathname.startsWith('/__preview/')) return <FilmWorkspace userId="" />;
  if (!projectId) return <FilmLibrary key={user?.id} userId={user?.id || ''} />;
  return <CloudFilmWorkspace key={`${user?.id}/${projectId}`} userId={user?.id || ''} cloudId={projectId} />;
}
function CloudFilmWorkspace({ userId, cloudId }: { userId: string; cloudId: string }) {
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const navigate = useNavigate();
  useEffect(() => { let cancelled = false; setError(''); void loadCloudFilm(userId, cloudId).then(() => { if (!cancelled) setReady(true); }).catch(e => { if (!cancelled) setError(filmError(e)); }); return () => { cancelled = true; }; }, [userId, cloudId, retry]);
  if (!ready) return <main className="film-library film-loading"><Clapperboard size={36} /><p role={error ? 'alert' : 'status'}>{error ? `项目读取失败：${error}` : '正在从数据库恢复项目…'}</p>{error && <button className="film-button" onClick={() => setRetry(v => v + 1)}>重试</button>}<button className="film-button" onClick={() => navigate('/studio/film')}>返回项目列表</button></main>;
  return <FilmWorkspace userId={userId} cloudId={cloudId} />;
}
export function FilmWorkspace({ userId, cloudId }: { userId: string; cloudId?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const useFilm = filmStore(userId, cloudId);
  const p = useFilm(s => s.project), patch = useFilm(s => s.patch), saved = useFilm(s => s.saved);
  const syncStatus = useFilm(s => s.syncStatus), syncError = useFilm(s => s.syncError);
  const [collapsed, setCollapsed] = useState(false), [models, setModels] = useState<FilmModel[]>([]), [modelError, setModelError] = useState('');
  const [reload, setReload] = useState(0), [modelsLoading, setModelsLoading] = useState(true), [reading, setReading] = useState(false);
  const [scriptEditing, setScriptEditing] = useState(Boolean(p.script)), [modal, setModal] = useState<'write' | 'history' | 'replace' | 'reset' | 'clear' | 'addAsset' | null>(null);
  const [idea, setIdea] = useState(''), [replaceFrom, setReplaceFrom] = useState(''), [replaceTo, setReplaceTo] = useState('');
  const [assetType, setAssetType] = useState<FilmAsset['type']>('scene'), [assetName, setAssetName] = useState(''), [search, setSearch] = useState('');
  const [mediaEditor, setMediaEditor] = useState<{ kind: 'asset' | 'image' | 'video'; id: string } | null>(null);
  const [editingShot, setEditingShot] = useState<FilmShot | null>(null), [showJobs, setShowJobs] = useState(() => p.jobs.some(activeFilmJob)), [batching, setBatching] = useState(false);
  const undo = useRef<string[]>([]), redo = useRef<string[]>([]), scriptRef = useRef<HTMLTextAreaElement>(null), fileRef = useRef<HTMLInputElement>(null), styleRef = useRef<HTMLInputElement>(null);
  const [historyTick, setHistoryTick] = useState(0);
  const [showProductionSettings, setShowProductionSettings] = useState(false), [preparingText, setPreparingText] = useState(false);
  const textSubmitLock = useRef(false);
  const running = p.jobs.filter(activeFilmJob), textRunning = preparingText || running.some(j => ['write', 'extract', 'split'].includes(j.kind));
  const textModels = models.filter(m => m.type === 'text'), textModel = textModels.find(m => m.key === p.settings.textModel) || textModels[0];
  useEffect(() => {
    let ignore = false; setModelsLoading(true);
    if (!userId) { setModelsLoading(false); return; }
    listAppProviderConfigs().then(configs => { if (!ignore) { setModels(filmModels(configs)); setModelError(''); } }).catch(e => { if (!ignore) setModelError(filmError(e)); }).finally(() => { if (!ignore) setModelsLoading(false); });
    return () => { ignore = true; };
  }, [userId, reload]);
  useEffect(() => {
    if (!userId || (!cloudId && !running.length)) return;
    let busy = false, disposed = false;
    const poll = () => {
      if (busy || disposed) return;
      busy = true;
      void (async () => {
        // Discover other browsers' tasks/results even when this tab has no
        // running jobs. Read before polling to avoid re-applying a result.
        if (cloudId) await syncCloudFilm(userId, cloudId);
        if (!disposed) await pollFilmJobs(userId, cloudId);
      })().catch(() => { /* Recovery copies survive network interruptions. */ }).finally(() => { busy = false; });
    };
    const visible = () => { if (document.visibilityState === 'visible') poll(); };
    poll(); const timer = setInterval(poll, 3000);
    window.addEventListener('online', poll); window.addEventListener('focus', poll); document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('online', poll); window.removeEventListener('focus', poll); document.removeEventListener('visibilitychange', visible); };
  }, [userId, cloudId, running.length]);
  useEffect(() => () => { void useFilm.getState().flush?.().catch(() => {}); }, [useFilm]);
  const safeAction = async (action: () => Promise<unknown>) => { try { await action(); } catch (e) { toast.error(filmError(e)); } };
  const setScript = (text: string, checkpoint = false) => {
    if (text.length > SCRIPT_LIMIT) toast.warning(`单集最多 ${SCRIPT_LIMIT} 字，已保留前 ${SCRIPT_LIMIT} 字。`);
    const current = useFilm.getState().project;
    undo.current = [...undo.current.slice(-49), current.script]; redo.current = [];
    patch({ script: text.slice(0, SCRIPT_LIMIT), ...(checkpoint ? { scriptHistory: [...current.scriptHistory, { text: current.script, at: Date.now() }].slice(-20) } : {}) });
    setScriptEditing(true); setHistoryTick(t => t + 1);
  };
  const restore = (direction: 'undo' | 'redo') => {
    const source = direction === 'undo' ? undo : redo, destination = direction === 'undo' ? redo : undo;
    const text = source.current.pop(); if (text === undefined) return;
    destination.current.push(p.script); patch({ script: text }); setHistoryTick(t => t + 1);
  };
  const importScript = async (file?: File, shot = false) => {
    if (!file) return; setReading(true);
    try { const text = await extractScriptDocumentText(file); if (shot && editingShot) setEditingShot({ ...editingShot, description: text, prompt: text }); else { setScript(text, true); if (p.name === '未命名项目') patch({ name: file.name.replace(/\.[^.]+$/, '') }); } toast.success('剧本导入成功'); }
    catch (e) { toast.error(filmError(e)); } finally { setReading(false); }
  };
  const runText = async (kind: FilmTextKind, retryId?: string) => {
    if (textSubmitLock.current || useFilm.getState().project.jobs.some(j => activeFilmJob(j) && ['write', 'extract', 'split'].includes(j.kind))) throw new Error('剧本任务正在处理中，请等待完成。');
    if (!userId) throw new Error('请先登录后使用生成服务。');
    const snapshot = useFilm.getState().project;
    if (kind !== 'write' && !snapshot.script.trim()) throw new Error('请先添加剧本。');
    if (kind === 'write' && !idea.trim()) throw new Error('请先描述你的创意。');
    textSubmitLock.current = true; setPreparingText(true); setShowJobs(true);
    try {
      const skillId = kind === 'write' ? '' : snapshot.settings[`${kind}SkillId`];
      // Refresh availability before a billable submission; never silently replace a saved selection.
      const [configs, skills] = await Promise.all([listAppProviderConfigs(), skillId ? listSkills(true) : Promise.resolve([])]);
      const current = useFilm.getState().project;
      if (current.id !== snapshot.id || current.script !== snapshot.script || current.settings !== snapshot.settings) throw new Error('制作内容或设置已改变，请重新点击生成。');
      const availableModels = filmModels(configs); setModels(availableModels); setModelError('');
      const payload = filmTextPayload(snapshot, kind, availableModels, skills, idea);
      setModal(null);
      if (retryId) await retryFilmJob(userId, retryId, payload, cloudId);
      else await startFilmJob(userId, kind, payload, undefined, cloudId);
      if (kind === 'write') setScriptEditing(true);
    } finally { textSubmitLock.current = false; setPreparingText(false); }
  };
  const retryJob = async (job: FilmJob) => {
    if (job.status === 'error' && (job.kind === 'extract' || job.kind === 'split')) await runText(job.kind, job.id);
    else await retryFilmJob(userId, job.id, undefined, cloudId);
  };
  const nextStep = async () => {
    if (p.step === 0) { if (!p.script.trim()) { toast.error('请先粘贴、上传或生成剧本。'); return; } patch({ step: 1 }); }
    else if (p.step === 1) { patch({ step: 2 }); if (!p.assets.length && !textRunning && textModel) await safeAction(() => runText('extract')); }
    else if (p.step === 2) { patch({ step: 3 }); if (!p.shots.length && !textRunning && textModel) await safeAction(() => runText('split')); }
    else if (p.step < 5) patch({ step: p.step + 1 });
  };
  const addAsset = () => {
    if (!assetName.trim()) return;
    const asset: FilmAsset = { id: editorId(), type: assetType, name: assetName.trim(), description: '', source: 'uploaded', locked: false, history: [] };
    patch(current => ({ assets: [...current.assets, asset] })); setModal(null); setAssetName(''); setMediaEditor({ kind: 'asset', id: asset.id });
  };
  const addShot = () => { if (p.shots.length >= 32) { toast.error('每个项目最多32个分镜。'); return; } const shot: FilmShot = { id: editorId(), title: `分镜 ${String(p.shots.length + 1).padStart(2, '0')}`, description: '', shot: '中景', duration: '4s', assetIds: [], status: 'draft', history: [] }; patch(current => ({ shots: [...current.shots, shot] })); setEditingShot(shot); };
  const batchVideo = async () => {
    const pending = p.shots.filter(s => !s.videoUrl && !running.some(j => j.targetId === s.id && j.kind === 'video'));
    if (!pending.length) throw new Error('暂无需要生成的分镜。');
    // Same per-shot bindings, prompt serialization and parameters as individual generation.
    const requests = pending.map(s => ({ id: s.id, payload: filmShotVideoRequest(p, s, models) }));
    setShowJobs(true);
    setBatching(true);
    try { for (const req of requests) await startFilmJob(userId, 'video', req.payload, req.id, cloudId); } finally { setBatching(false); }
  };
  const batchImages = async () => {
    const kind = p.step === 2 ? 'asset' : 'image';
    const pending = kind === 'asset' ? p.assets.filter(a => !a.url && !running.some(j => j.kind === kind && j.targetId === a.id)) : p.shots.filter(s => !s.imageUrl && !running.some(j => j.kind === kind && j.targetId === s.id));
    if (!pending.length) throw new Error('暂无需要生成的图片。');
    const requests = pending.map(item => ({ id: item.id, payload: filmImageRequest(p, item.id, kind, models) }));
    setShowJobs(true); setBatching(true);
    try { for (const req of requests) await startFilmJob(userId, kind, req.payload, req.id, cloudId); } finally { setBatching(false); }
  };
  const complete = [Boolean(p.script.trim()), Boolean(p.script.trim()), p.assets.length > 0 && p.assets.every(a => a.url), p.shots.length > 0, p.shots.length > 0 && p.shots.every(s => s.videoUrl), Boolean(p.exportUrl)];
  const failed = p.jobs.filter(j => j.status === 'error' || j.status === 'unknown' || j.status === 'partial');
  return <main className={`film-workspace ${collapsed ? 'is-collapsed' : ''} ${showJobs ? 'has-task-panel' : ''}`}>
    <aside className="film-sidebar"><div className="film-project-heading"><button className="film-icon" aria-label="返回项目列表" onClick={() => navigate(location.pathname.startsWith('/__preview/') ? '/__preview/home' : '/studio/film')}><ArrowLeft size={19} /></button><input className="film-project-name" aria-label="项目名称" maxLength={60} value={p.name} onChange={e => patch({ name: e.target.value })} onBlur={() => { if (!p.name.trim()) patch({ name: '未命名项目' }); }} /></div>
      <nav className="film-step-list" aria-label="一键成片制作流程">{FILM_STEPS.map((step, i) => <button className={`film-step ${p.step === i ? 'is-active' : ''}`} key={step} aria-current={p.step === i ? 'step' : undefined} title={step} onClick={() => patch({ step: i })}><span className="film-step-number">{i + 1}</span><span className="film-step-name">{step}</span>{complete[i] && <CheckCircle2 size={15} className="film-step-check" />}</button>)}</nav>
      <div className="film-sidebar-bottom"><span className={`film-save-state ${saved ? '' : 'film-error'}`}>{saved ? <Check size={12} /> : <Clock3 size={12} />}{cloudId ? ({ saved: '已保存到数据库', saving: '正在保存到数据库…', error: '保存失败，请重试', conflict: '版本冲突，修改已保留' })[syncStatus || 'saving'] : saved ? '预览草稿已保存到本机' : '本机保存失败，请导出备份'}</span><button className="film-sidebar-action" onClick={() => cloudId ? navigate('/studio/film') : setModal('reset')}><Plus size={15} />新建项目</button><button className="film-sidebar-action" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `${p.name}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}><Download size={15} />导出项目备份</button></div>
    </aside>
    <div className="film-body"><header className="film-topbar"><button className="film-icon" aria-label={collapsed ? '展开步骤导航' : '收起步骤导航'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button><span className="film-header-summary">{p.step === 2 ? <>共 <b>{p.assets.length}</b> 个资产，已完成 <b>{p.assets.filter(a => a.url).length}</b> 个</> : p.step === 3 || p.step === 4 ? <>共 <b>{p.shots.length}</b> 个{p.step === 3 ? '分镜' : '视频'}，已完成 <b>{p.shots.filter(s => p.step === 3 ? Boolean(s.description) : Boolean(s.videoUrl)).length}</b> 个</> : <span className="film-header-brand"><Clapperboard size={15} />一键成片</span>}</span><span className="film-spacer" />
      <button className="film-button" onClick={() => { setShowJobs(false); setShowProductionSettings(true); setReload(v => v + 1); }}><Settings2 size={15} />制作设置</button>
      {p.jobs.length > 0 && <button className="film-button film-task-button" onClick={() => setShowJobs(!showJobs)}>{running.length ? <LoaderCircle className="film-spin" size={14} /> : <Clock3 size={14} />}任务 {running.length || p.jobs.length}{failed.length > 0 && <span className="film-error-count">{failed.length}</span>}</button>}
      {p.step === 0 && <label className="film-shot-count">分镜数量：<select className="film-select" aria-label="分镜数量" value={p.settings.shotCount} onChange={e => patch({ settings: { ...p.settings, shotCount: Number(e.target.value) } })}>{[0, 4, 8, 12, 16, 24, 32].map(v => <option key={v} value={v}>{v || '自动'}</option>)}</select></label>}
      {p.step === 4 && <button className="film-button film-accent" disabled={!p.shots.length || batching} onClick={() => void safeAction(batchVideo)}><Video size={15} />{batching ? '正在提交…' : '批量生视频'}</button>}
      {(p.step === 2 || p.step === 3) && <button className="film-button film-accent" disabled={!(p.step === 2 ? p.assets.length : p.shots.length) || batching} onClick={() => void safeAction(batchImages)}><ImagePlus size={15} />{batching ? '正在提交…' : p.step === 2 ? '批量生成参考图' : '批量生分镜图'}</button>}
      {p.step < 5 && <button className="film-primary film-next" disabled={p.step === 0 && !p.script.trim()} onClick={() => void nextStep()}>下一步·{FILM_STEPS[p.step + 1]}<ChevronRight size={14} /></button>}
    </header>
    {cloudId && syncError && <div className="film-connection-notice film-error" role="alert">{syncError}{!saved && ' 本机备份也未能写入，请立即导出备份。'}<button className="film-button" onClick={() => void safeAction(() => useFilm.getState().flush!())}>重试保存</button>{syncStatus === 'conflict' && <button className="film-button" onClick={() => void safeAction(() => useCloudVersion(userId, cloudId))}>备份并载入云端</button>}<button className="film-button" onClick={() => downloadFilmBackup(p)}>导出本机备份</button></div>}
    {(!userId || modelError) && <div className="film-connection-notice" role="status">{!userId ? '当前为页面预览。登录后可使用模型生成、上传和视频导出。' : `模型加载失败：${modelError}`}<button className="film-plain" onClick={() => !userId ? navigate('/login') : setReload(v => v + 1)}>{!userId ? '登录' : '重试'}</button></div>}
    {showJobs && <FilmTaskPanel jobs={p.jobs} preparing={preparingText} syncStatus={syncStatus} onClose={() => setShowJobs(false)} onRetry={job => safeAction(() => retryJob(job))} onRecover={job => safeAction(() => recoverFilmJob(userId, job.id, cloudId))} />}
    {showProductionSettings && <FilmProductionSettings settings={p.settings} models={models} modelsLoading={modelsLoading} modelError={modelError} userId={userId} onRefreshModels={() => setReload(v => v + 1)} onClose={() => setShowProductionSettings(false)} onSave={settings => { patch(current => ({ settings: { ...current.settings, ...settings } })); setShowProductionSettings(false); toast.success('制作设置已保存，后续提取和分镜任务将使用新设置'); }} />}
    <div className={`film-stage film-stage-${p.step}`}>
      {p.step === 0 && <><div className="film-editor-toolbar"><button className="film-button film-rounded" disabled={textRunning || !textModel} onClick={() => setModal('write')}><Sparkles size={15} />橙次元AI帮写</button><button className="film-button film-rounded" disabled={reading || textRunning} onClick={() => fileRef.current?.click()}><FolderUp size={15} />{reading ? '读取中…' : '上传剧本'}</button><span className="film-toolbar-separator" /><button className="film-icon" title="撤销" disabled={!undo.current.length || textRunning} onClick={() => restore('undo')}><Undo2 size={15} /></button><button className="film-icon" title="重做" disabled={!redo.current.length || textRunning} onClick={() => restore('redo')}><Redo2 size={15} /></button><button className="film-button film-plain" disabled={!p.script} onClick={() => void navigator.clipboard.writeText(p.script).then(() => toast.success('剧本已复制')).catch(() => toast.error('复制失败'))}><Copy size={14} />复制</button><button className="film-button film-plain" disabled={!p.script || textRunning} onClick={() => setModal('clear')}><Trash2 size={14} />清空</button><button className="film-button film-plain" disabled={!p.script || textRunning} onClick={() => setModal('replace')}><Replace size={14} />替换</button><span className="film-spacer" /><button className="film-button film-plain" onClick={() => setModal('history')}><History size={15} />历史版本</button></div>
        {textRunning && <div className="film-progress-line"><LoaderCircle className="film-spin" size={16} />正在处理剧本…可在任务列表查看实时状态</div>}
        {p.script || scriptEditing ? <div className="film-script-area" data-history={historyTick}><textarea className="film-script" ref={scriptRef} aria-label="剧本正文" placeholder="在这里粘贴或编写你的剧本，描述场景、人物、动作与对白…" value={p.script} disabled={textRunning} onChange={e => setScript(e.target.value)} onBlur={() => { const latest = p.scriptHistory.at(-1); if (p.script.trim() && latest?.text !== p.script) patch({ scriptHistory: [...p.scriptHistory, { text: p.script, at: Date.now() }].slice(-20) }); }} /><footer className="film-script-footer"><span>支持 TXT、Markdown、DOCX、PDF</span><span>{p.script.length.toLocaleString()} / {SCRIPT_LIMIT.toLocaleString()} 字</span></footer></div> : <div className="film-script-empty"><div className="film-script-illustration"><div className="film-script-paper"><i /><i /><i /></div></div><p>选择一种方式添加剧本</p><div className="film-script-options"><button className="film-script-option" onClick={() => { setScriptEditing(true); setTimeout(() => scriptRef.current?.focus(), 0); }}><Copy size={18} /><span><strong>粘贴剧本</strong><small>已有内容可直接粘贴修改</small></span></button><button className="film-script-option" disabled={reading} onClick={() => fileRef.current?.click()}><FolderUp size={20} /><span><strong>上传剧本</strong><small>支持文档导入后继续编辑</small></span></button><button className="film-script-option" onClick={() => setModal('write')}><WandSparkles size={20} /><span><strong>橙次元AI帮写</strong><small>从想法开始生成完整剧本</small></span></button></div></div>}</>}
      {p.step === 1 && <FilmSettings project={p} models={models} patch={settings => patch({ settings: { ...p.settings, ...settings } })} uploadStyle={() => styleRef.current?.click()} />}
      {(p.step === 2 || p.step === 3 || p.step === 4) && <>
        <div className="film-content-toolbar">
          {p.step === 2 ? <div className="film-tabs">
            {([['scene', '场景'], ['character', '角色'], ['prop', '道具']] as const).map(([key, label]) =>
              <button key={key} className={assetType === key ? 'is-active' : ''} onClick={() => setAssetType(key)}>
                {label}<span>{p.assets.filter(a => a.type === key).length}</span>
              </button>)}
          </div> : <span className="film-muted">{p.step === 3 ? '逐镜编辑描述、运镜与关联资产' : '点击镜头，开始制作你的分镜视频'}</span>}
          <span className="film-spacer" />
          <label className="film-search"><Search size={14} /><input aria-label="搜索素材与分镜" placeholder="搜索" value={search} onChange={e => setSearch(e.target.value)} /></label>
          <button className="film-button" onClick={() => p.step === 2 ? setModal('addAsset') : addShot()}><Plus size={16} />新增</button>
          {p.step !== 4 && <button className="film-button film-accent" disabled={textRunning || !p.script || !textModel || modelsLoading} onClick={() => void safeAction(() => runText(p.step === 2 ? 'extract' : 'split'))}><Sparkles size={15} />{p.step === 2 ? '提取场景角色道具' : p.shots.length ? '追加分镜' : '生成分镜脚本'}</button>}
        </div>
        {textRunning && <div className="film-progress-line"><LoaderCircle className="film-spin" size={17} />{p.step === 2 ? '正在为您提取场景、角色和道具…' : '正在为您拆解分镜…'}</div>}
        <div className="film-card-grid">{p.step === 2 ? p.assets.filter(a => a.type === assetType && (a.name + a.description).includes(search)).map(a => <article className="film-asset-card" key={a.id}><div className="film-card-heading"><span>{a.name}</span><span className="film-muted film-small">{a.url ? '已完成' : '待制作'}</span></div><button className="film-card-image" onClick={() => setMediaEditor({ kind: 'asset', id: a.id })}>{a.url ? <img className="film-cover" src={toRenderableMediaUrl(a.url)} alt={a.name} /> : <><ImagePlus size={27} strokeWidth={1.3} /><span>点击生成 / 上传</span></>}</button><p className="film-card-description">{a.description || '添加视觉描述，统一角色与场景'}</p><button className="film-card-edit" onClick={() => setMediaEditor({ kind: 'asset', id: a.id })}><PencilLine size={14} />编辑素材<ChevronRight size={14} /></button></article>) : p.shots.filter(s => (s.title + s.description).includes(search)).map((s, i) => { const job = [...p.jobs].reverse().find(j => j.targetId === s.id && j.kind === (p.step === 4 ? 'video' : 'image')); return <article className="film-shot-card" key={s.id}><div className="film-card-heading"><Clapperboard size={16} /><strong>{String(i + 1).padStart(2, '0')}</strong><span className="film-truncate">{s.title}</span><button className="film-icon" title="编辑分镜脚本" onClick={() => setEditingShot(s)}><PencilLine size={14} /></button></div><button className="film-card-image" onClick={() => setMediaEditor({ kind: p.step === 4 ? 'video' : 'image', id: s.id })}>{p.step === 4 && s.videoUrl ? <video className="film-cover" src={toRenderableMediaUrl(s.videoUrl)} preload="metadata" muted /> : s.imageUrl ? <img className="film-cover" src={toRenderableMediaUrl(s.imageUrl)} alt={s.title} /> : <><PencilLine size={27} /><span>点击编辑</span></>}{job && activeFilmJob(job) && <span className="film-card-status"><LoaderCircle className="film-spin" size={14} />生成中</span>}</button>{p.step === 3 && <><p className="film-card-description">{s.description || '尚未填写分镜内容'}</p><div className="film-shot-meta"><span>{s.shot}</span><span>{s.duration}</span><span>{s.assetIds.length} 个资产</span></div></>}{job?.status === 'error' && <p className="film-error film-card-error">{job.error}</p>}</article>; })}</div>
        {(p.step === 2 ? !p.assets.some(a => a.type === assetType) : !p.shots.length) && !textRunning && <div className="film-collection-empty"><div className="film-empty-art">{p.step === 2 ? <ImagePlus size={40} /> : <Clapperboard size={40} />}</div><h3>{p.step === 2 ? '为故事准备场景、角色和道具' : p.step === 3 ? '把剧本，变成看得见的镜头' : '从第一个镜头开始'}</h3><p className="film-muted">{p.step === 2 ? '从剧本自动提取资产，或手动添加并上传参考图片' : '可自动拆解剧本，也可以手动新增分镜'}</p><button className="film-button" onClick={() => p.step === 2 ? setModal('addAsset') : addShot()}><Plus size={16} />{p.step === 2 ? '添加资产' : '新增分镜'}</button></div>}</>}
      {p.step === 5 && <FilmPreview project={p} userId={userId} onVideoStep={() => patch({ step: 4 })} />}
    </div></div>
    <input className="film-hidden" ref={fileRef} type="file" accept=".txt,.md,.docx,.pdf" onChange={e => { void importScript(e.target.files?.[0]); e.target.value = ''; }} />
    <input className="film-hidden" ref={styleRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void safeAction(async () => { if (file.size > 20 * 1024 * 1024) throw new Error('风格参考图不能超过20MB。'); const result = await uploadFile(file, file.name); patch(current => ({ settings: { ...current.settings, styleImage: result.url } })); }); }} />
    {modal && <FilmDialog title={{ write: '橙次元AI帮写', history: '剧本历史版本', replace: '查找与替换', reset: '新建项目', clear: '清空剧本', addAsset: '添加资产' }[modal]} onClose={() => setModal(null)}>
      {modal === 'write' && <><p className="film-dialog-copy">告诉我故事的主角、情节、时长或想传达的感受。</p><textarea className="film-dialog-textarea" aria-label="剧本创意" placeholder="例如：一个在深夜便利店工作的机器人，第一次感受到人类的善意…" value={idea} maxLength={4000} onChange={e => setIdea(e.target.value)} /><FilmModelSelect models={textModels} value={textModel?.key || ''} onChange={key => patch({ settings: { ...p.settings, textModel: key } })} label="编剧模型" /><footer className="film-dialog-footer"><button className="film-button" onClick={() => setModal(null)}>取消</button><button className="film-primary" disabled={!idea.trim() || !textModel || textRunning} onClick={() => void safeAction(() => runText('write'))}><Sparkles size={15} />生成剧本</button></footer></>}
      {modal === 'history' && <div className="film-version-list">{p.scriptHistory.length ? [...p.scriptHistory].reverse().map((v, i) => <button className="film-version" key={`${v.at}-${i}`} disabled={textRunning} onClick={() => { setScript(v.text, true); setModal(null); }}><History size={18} /><span><strong>{new Date(v.at).toLocaleString()}</strong><small>{v.text.slice(0, 75) || '空白剧本'}</small></span><span>{v.text.length} 字</span></button>) : <p className="film-dialog-copy">还没有历史版本，编辑或导入剧本后会自动保留。</p>}</div>}
      {modal === 'replace' && <><label className="film-form-field">查找<input value={replaceFrom} onChange={e => setReplaceFrom(e.target.value)} /></label><label className="film-form-field">替换为<input value={replaceTo} onChange={e => setReplaceTo(e.target.value)} /></label><footer className="film-dialog-footer"><button className="film-primary" disabled={!replaceFrom} onClick={() => { setScript(p.script.replaceAll(replaceFrom, replaceTo), true); setModal(null); }}>全部替换</button></footer></>}
      {(modal === 'reset' || modal === 'clear') && <><p className="film-dialog-copy">{modal === 'reset' ? '当前本机草稿会被新项目替换。建议先通过左下角导出项目备份。已上传素材和后台任务记录会保留。' : '确定清空剧本吗？当前内容会保留在历史版本中。'}</p><footer className="film-dialog-footer"><button className="film-button" onClick={() => setModal(null)}>取消</button><button className="film-primary" onClick={() => { if (modal === 'reset') { useFilm.getState().reset(); setScriptEditing(false); undo.current = []; redo.current = []; } else setScript('', true); setModal(null); }}>确认</button></footer></>}
      {modal === 'addAsset' && <><label className="film-form-field">资产名称<input autoFocus value={assetName} onChange={e => setAssetName(e.target.value)} placeholder="例如：云上宫殿、少年主角、青铜钥匙" maxLength={60} /></label><label className="film-form-field">类型<select value={assetType} onChange={e => setAssetType(e.target.value as FilmAsset['type'])}><option value="scene">场景</option><option value="character">角色</option><option value="prop">道具</option></select></label><footer className="film-dialog-footer"><button className="film-primary" disabled={!assetName.trim()} onClick={addAsset}>添加并编辑</button></footer></>}
    </FilmDialog>}
    {editingShot && <FilmDialog title={`分镜脚本：${editingShot.title}`} className="film-shot-dialog" onClose={() => setEditingShot(null)}><div className="film-shot-form"><label className="film-form-field">镜头名称<input value={editingShot.title} onChange={e => setEditingShot({ ...editingShot, title: e.target.value })} /></label><label className="film-form-field">景别<input value={editingShot.shot} onChange={e => setEditingShot({ ...editingShot, shot: e.target.value })} /></label><label className="film-form-field">时长（秒）<input type="number" min={1} max={30} value={Number.parseFloat(editingShot.duration) || 4} onChange={e => setEditingShot({ ...editingShot, duration: `${e.target.value}s` })} /></label></div><div className="film-shot-dialog-toolbar"><span className="film-muted">画面、动作、对白与运镜</span><label className="film-button"><FolderUp size={15} />导入文档<input className="film-hidden" type="file" accept=".txt,.md,.docx,.pdf" onChange={e => { void importScript(e.target.files?.[0], true); }} /></label></div><textarea className="film-shot-script" aria-label="分镜脚本内容" value={editingShot.description} onChange={e => setEditingShot({ ...editingShot, description: e.target.value, prompt: e.target.value })} /><div className="film-shot-asset-links"><span className="film-muted">关联资产</span>{p.assets.map(a => <label className="film-checkbox" key={a.id}><input type="checkbox" checked={editingShot.assetIds.includes(a.id)} onChange={e => setEditingShot({ ...editingShot, assetIds: e.target.checked ? [...editingShot.assetIds, a.id] : editingShot.assetIds.filter(id => id !== a.id) })} />{a.name}</label>)}</div><footer className="film-dialog-footer"><button className="film-primary" onClick={() => { patch(current => ({ shots: current.shots.map(s => s.id === editingShot.id ? { ...s, title: editingShot.title, description: editingShot.description, prompt: editingShot.prompt, shot: editingShot.shot, duration: editingShot.duration, assetIds: editingShot.assetIds } : s) })); setEditingShot(null); }}>保存</button></footer></FilmDialog>}
    {mediaEditor && <FilmMediaEditor key={`${mediaEditor.kind}-${mediaEditor.id}`} userId={userId} project={p} target={mediaEditor.id} kind={mediaEditor.kind} models={models} onClose={() => setMediaEditor(null)} onTarget={id => setMediaEditor({ ...mediaEditor, id })} />}
  </main>;
}
