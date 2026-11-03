import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AudioLines, Check, ChevronRight, Download, Folder, Grid2X2, Image, ImagePlus, Info, LayoutTemplate, List, LoaderCircle, Minus, Plus, RefreshCw, Search, Shirt, SlidersHorizontal, Sparkles, Star, Tag, Trash2, Upload, Users, Video, WandSparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../auth/AuthProvider';
import { listAppProviderConfigs, type AppProviderConfig } from '../../api/providerConfigs';
import { listAssetsFromServer, listAssetFoldersFromServer, saveAssetToServer, saveAssetFolderToServer, deleteAssetFolderFromServer } from '../../api/assets';
import { listHistoryFromServer } from '../../api/history';
import { uploadFile } from '../../api/projects';
import type { AssetFolder } from '../../store';
import { toRenderableMediaUrl } from '../../reference-media';
import { MediaThumb } from '../MediaThumb';
import { ReferencePicker } from './ReferencePicker';
import { StudioDialog } from './StudioDialog';
import { useTryOnJobs } from './useTryOnJobs';
import { DEFAULT_FILTER, MAX_REFERENCES, assetRole, buildTryOnPayload, filterLibrary, mergeLibrary, preferencesKey, readPreferences, roleName, studioModels, toSavedAsset, validateUpload, type AssetMeta, type AssetRole, type LibraryFilter, type ReferenceAsset, type StudioAsset, type StudioPreferences } from './studio-library';
import './studio.css';

type Panel = 'models' | 'labels' | 'folders' | 'templates' | 'filter' | null;
const prompts = [
  { name: '极简棚拍', en: 'Studio portrait', prompt: '全身正面，干净的浅灰色摄影棚背景，柔和均匀的灯光，突出服装的版型和质感。' },
  { name: '街头穿搭', en: 'Street style', prompt: '自然站姿，现代城市街道背景，日光下的时尚街拍，展示完整穿搭与真实布料细节。' },
  { name: '电商展示', en: 'Product showcase', prompt: '白色背景的全身电商试衣图，双手自然下垂，服装完整无遮挡，不添加文字、水印或额外配饰。' },
];

export function TryOnStudio({ userId, zh }: { userId: string; zh: boolean }) {
  const { refreshCredits } = useAuth();
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [folders, setFolders] = useState<AssetFolder[]>([]);
  const [configs, setConfigs] = useState<AppProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [prefs, setPrefs] = useState(() => readPreferences(userId));
  const prefsRef = useRef(prefs);
  const [filter, setFilter] = useState<LibraryFilter>({ ...DEFAULT_FILTER, kind: 'image' });
  const [panel, setPanel] = useState<Panel>(null);
  const [picker, setPicker] = useState<AssetRole | null>(null);
  const [refs, setRefs] = useState<ReferenceAsset[]>([]);
  const [prompt, setPrompt] = useState('');
  const [polish, setPolish] = useState(true);
  const [size, setSize] = useState('3:4');
  const [quality, setQuality] = useState('Auto');
  const [count, setCount] = useState(1);
  const [modelKey, setModelKey] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [formError, setFormError] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const [deleteFolder, setDeleteFolder] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const actionLock = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const t = (cn: string, en: string) => zh ? cn : en;
  const upsert = useCallback((asset: StudioAsset) => setAssets(previous => [asset, ...previous.filter(a => a.id !== asset.id && a.url !== asset.url)]), []);
  const jobs = useTryOnJobs(userId, upsert, () => { void refreshCredits(); });
  useEffect(() => {
    let cancelled = false;
    if (!userId) { setLoading(false); setLoadError(t('请先登录后使用试衣库。', 'Sign in to use the studio.')); return; }
    setLoading(true); setLoadError('');
    void Promise.allSettled([listAssetsFromServer(), listHistoryFromServer(), listAssetFoldersFromServer(), listAppProviderConfigs()]).then(([library, history, dirs, models]) => {
      if (cancelled) return;
      const loaded = mergeLibrary(library.status === 'fulfilled' ? library.value : [], history.status === 'fulfilled' ? history.value : []);
      setAssets(previous => [...loaded, ...previous.filter(a => a.source === 'generated' && !loaded.some(b => b.id === a.id || b.url === a.url))]);
      if (dirs.status === 'fulfilled') setFolders(dirs.value);
      if (models.status === 'fulfilled') setConfigs(models.value);
      const failed = [[library, t('素材库', 'library')], [history, t('生成历史', 'history')], [dirs, t('文件夹', 'folders')], [models, t('生成模型', 'models')]].filter(([result]) => (result as PromiseSettledResult<unknown>).status === 'rejected').map(([, label]) => label);
      if (failed.length) setLoadError(`${failed.join('、')}${t('加载失败，请重试。', ' failed to load. Please retry.')}`);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [userId, reload, zh]);
  const models = useMemo(() => studioModels(configs), [configs]);
  const model = models.find(m => m.key === modelKey) ?? models[0];
  const activeSize = model?.sizes.includes(size) ? size : model?.sizes[0] ?? '';
  const activeQuality = model?.qualities.includes(quality) ? quality : model?.qualities[0] ?? '';
  const limit = model?.maxReferences ?? MAX_REFERENCES;
  const filtered = useMemo(() => filterLibrary(assets, prefs.metadata, filter), [assets, prefs.metadata, filter]);
  const tags = useMemo(() => Array.from(new Set(Object.values(prefs.metadata).flatMap(m => m.tags ?? []))).sort(), [prefs.metadata]);
  const selectedAsset = assets.find(a => a.id === preview);
  const person = refs.find(r => r.role === 'person' || r.role === 'model');
  const garment = refs.find(r => r.role === 'garment');
  const uncertain = jobs.jobs.some(j => ['unknown', 'submitting'].includes(j.status));
  const updatePrefs = (change: (previous: StudioPreferences) => StudioPreferences) => {
    const next = change(prefsRef.current);
    try { localStorage.setItem(preferencesKey(userId), JSON.stringify(next)); }
    catch { toast.error(t('偏好设置保存失败，浏览器存储空间可能不足。', 'Could not save preferences. Browser storage may be full.')); return; }
    prefsRef.current = next; setPrefs(next);
  };
  const updateMeta = (id: string, patch: AssetMeta) => updatePrefs(previous => ({ ...previous, metadata: { ...previous.metadata, [id]: { ...previous.metadata[id], ...patch } } }));
  const openPanel = (next: Panel) => { setName(''); setDialogError(''); setDeleteFolder(null); setPanel(next); };
  const upload = async (files: File[], role: AssetRole): Promise<StudioAsset[]> => {
    if (!userId) throw new Error(t('请先登录。', 'Please sign in.'));
    files.forEach(validateUpload);
    const uploaded: StudioAsset[] = [];
    for (const file of files) {
      if (!mounted.current) throw new Error('页面已切换，后续图片未继续上传。');
      const data = await uploadFile(file, file.name);
      if (!mounted.current) throw new Error('页面已切换，素材未继续保存。');
      const asset: StudioAsset = { id: crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, ''), category: role === 'person' || role === 'model' ? 'character' : role === 'garment' ? 'object' : 'other', kind: 'image', url: data.url, thumbnail: data.url, createdAt: Date.now(), source: 'library', folderId: filter.folder !== 'all' ? filter.folder : '' };
      try { await saveAssetToServer(toSavedAsset(asset)); }
      catch { throw new Error(t('图片已上传，但保存素材失败；请重试。此前成功保存的图片仍在素材库。', 'Upload completed, but saving the asset failed. Earlier uploads remain in your library.')); }
      upsert(asset); updateMeta(asset.id, { role }); uploaded.push(asset);
    }
    return uploaded;
  };
  const generateImages = async () => {
    if (!model || actionLock.current) return;
    setFormError(''); actionLock.current = true;
    try {
      const payload = buildTryOnPayload(model, refs, prompt, activeSize, activeQuality, polish);
      await jobs.start(payload, count, filter.folder !== 'all' ? filter.folder : '');
    } catch (e) { setFormError(e instanceof Error ? e.message : t('生成请求失败，请重试。', 'Generation could not be submitted.')); }
    finally { actionLock.current = false; }
  };
  const useReference = (asset: StudioAsset, role: AssetRole) => {
    if (refs.some(r => r.url === asset.url)) { setFormError(t('这张图片已经是参考素材，可在素材弹窗中修改用途。', 'This image is already selected. Change its role in the reference picker.')); setPreview(null); return; }
    if (refs.length >= limit) { setDialogError(t(`最多选择 ${limit} 张参考图片。`, `Select up to ${limit} references.`)); return; }
    setRefs(previous => [...previous, { ...asset, role }]); setPreview(null); setFormError('');
  };
  const saveFolder = async () => {
    if (!name.trim() || saving) return;
    setSaving(true); setDialogError('');
    try { const folder = { id: crypto.randomUUID(), name: name.trim(), createdAt: Date.now() }; await saveAssetFolderToServer(folder); setFolders([...folders, folder]); setName(''); }
    catch { setDialogError(t('文件夹创建失败，请重试。', 'Could not create folder.')); }
    finally { setSaving(false); }
  };
  const removeFolder = async (id: string) => {
    if (saving) return;
    setSaving(true); setDialogError('');
    try { await deleteAssetFolderFromServer(id); setFolders(folders.filter(f => f.id !== id)); setAssets(assets.map(a => a.folderId === id ? { ...a, folderId: '' } : a)); setFilter(f => f.folder === id ? { ...f, folder: '' } : f); setDeleteFolder(null); }
    catch { setDialogError(t('删除文件夹失败，请重试。', 'Could not delete folder.')); }
    finally { setSaving(false); }
  };
  const moveAsset = async (asset: StudioAsset, folderId: string) => {
    setSaving(true); setDialogError('');
    try { const moved = { ...asset, folderId, source: asset.source === 'history' ? 'library' as const : asset.source }; await saveAssetToServer(toSavedAsset(moved)); upsert(moved); }
    catch { setDialogError(t('移动失败，素材仍在原位置。', 'Move failed. The asset is still in its original folder.')); }
    finally { setSaving(false); }
  };
  const download = async (asset: StudioAsset) => {
    setDownloadBusy(true); setDialogError('');
    try { const response = await fetch(toRenderableMediaUrl(asset.url), { credentials: 'include' }); if (!response.ok) throw new Error(); const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = asset.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch { setDialogError(t('下载失败，请检查图片链接或稍后重试。', 'Download failed. Please retry later.')); }
    finally { setDownloadBusy(false); }
  };
  const activeJobs = jobs.jobs.filter(j => j.status !== 'success');

  return <main className="tryon-studio" aria-label={t('模特试衣工作室', 'Virtual try-on studio')}>
    <aside className="studio-create-panel">
      <div className="studio-panel-heading"><span className="studio-eyebrow">CCY CREATIVE STUDIO</span><h1>{t('模特试衣库', 'Virtual try-on')}</h1><p>{t('选好模特，让每一套穿搭都有主角。', 'The right model. A new story for every outfit.')}</p></div>
      <div className="studio-feature"><span><Shirt size={23} /></span><div><strong>{t('模特试衣', 'Virtual try-on')}</strong><small>{t('人物 × 服装，生成全新穿搭', 'Person × clothing. Create your next look.')}</small></div><Check size={17} /></div>
      <button type="button" className="studio-model-trigger" onClick={() => openPanel('models')}><span className="studio-setting-icon"><Sparkles size={21} /></span><span><small>{t('生成模型', 'AI model')}</small><strong>{loading ? t('加载中…', 'Loading…') : model?.label ?? t('暂无可用模型', 'No available model')}</strong></span><ChevronRight size={16} /></button>
      <section className="studio-prompt-panel"><div className="studio-section-label"><strong>{t('描述你的试衣效果', 'Describe your look')}</strong><button type="button" className="studio-icon-button" aria-label={t('打开试衣模板', 'Open try-on templates')} onClick={() => openPanel('templates')}><LayoutTemplate size={16} /></button></div>
        <div className="studio-reference-slots">{([{ asset: person, role: 'model', Icon: Users, title: t('选择人物 / 模特', 'Choose person / model') }, { asset: garment, role: 'garment', Icon: Shirt, title: t('选择试穿服装', 'Choose clothing') }] as const).map(({ asset, role, Icon, title }) => <button type="button" key={role} className={asset ? 'has-reference' : ''} onClick={() => setPicker(role)}>{asset ? <MediaThumb src={asset.thumbnail || asset.url} alt="" /> : <Icon size={23} />}<span><strong>{asset?.name ?? title}</strong><small>{asset ? t('点击更换或管理', 'Change or manage') : t('素材库选择 / 上传', 'Choose or upload')}</small></span><Plus size={14} /></button>)}</div>
        <button type="button" className="studio-add-reference" onClick={() => setPicker('reference')}><ImagePlus size={15} />{t('添加参考图片', 'Add visual references')}<span>{refs.length} / {limit}</span></button>
        <textarea aria-label={t('试衣提示词', 'Try-on prompt')} value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000} placeholder={t('描述姿态、场景和风格，例如：全身正面，白色摄影棚背景，柔和自然光，保留服装纹理…', 'Describe the pose, scene and style. For example: full-body front view, white studio, soft natural light…')} />
        <div className="studio-prompt-footer"><button className="studio-icon-button" type="button" title={t('清空提示词', 'Clear prompt')} aria-label={t('清空提示词', 'Clear prompt')} onClick={() => setPrompt('')} disabled={!prompt}><Trash2 size={15} /></button><small>{prompt.length} / 4000</small><label title={t('追加服装贴合、比例与光影要求，不调用额外模型', 'Adds fit, proportion and lighting instructions without an extra AI request')}><WandSparkles size={14} />{t('细节增强', 'Enhance detail')}<input type="checkbox" role="switch" aria-label={t('细节增强', 'Enhance detail')} checked={polish} onChange={e => setPolish(e.target.checked)} /></label></div>
      </section>
      <div className="studio-output-settings"><label><SlidersHorizontal size={17} /><span><small>{t('输出比例 / 尺寸', 'Output size')}</small><select aria-label={t('输出比例', 'Output size')} value={activeSize} onChange={e => setSize(e.target.value)} disabled={!model?.sizes.length}>{model?.sizes.length ? model.sizes.map(s => <option key={s} value={s}>{s}</option>) : <option value="">{t('模型默认', 'Model default')}</option>}</select></span></label><label><SlidersHorizontal size={17} /><span><small>{t('画质', 'Quality')}</small><select aria-label={t('画质', 'Quality')} value={activeQuality} onChange={e => setQuality(e.target.value)} disabled={!model?.qualities.length}>{model?.qualities.length ? model.qualities.map(q => <option key={q} value={q}>{q}</option>) : <option value="">{t('模型默认', 'Model default')}</option>}</select></span></label></div>
      <div className="studio-create-bottom">{formError && <p className="studio-error" role="alert">{formError}</p>}{!loading && !model && <p className="studio-error">{t('请管理员先配置支持参考图的图像模型。', 'Ask your administrator to configure an image-reference model.')}</p>}
        <p className="studio-create-note"><Info size={13} />{t('生成仅在点击按钮后开始，请使用有权使用的图片。', 'Generation starts only when you click. Use authorized images.')}</p>
        <div className="studio-generate-row"><div className="studio-stepper"><button type="button" aria-label={t('减少生成数量', 'Decrease output count')} disabled={count === 1 || jobs.submitting} onClick={() => setCount(c => c - 1)}><Minus size={14} /></button><span>{count}<small> / 8</small></span><button type="button" aria-label={t('增加生成数量', 'Increase output count')} disabled={count === 8 || jobs.submitting} onClick={() => setCount(c => c + 1)}><Plus size={14} /></button></div><button type="button" className="studio-button studio-primary studio-generate" onClick={() => void generateImages()} disabled={!userId || !model || loading || jobs.submitting || uncertain}>{jobs.submitting ? <LoaderCircle size={16} className="home-spinner" /> : <Sparkles size={16} />}{jobs.submitting ? t('正在提交', 'Submitting') : t('生成试衣效果', 'Generate look')}<small>{model ? t(`预计 ${model.cost * count} 积分`, `~${model.cost * count} credits`) : '—'}</small></button></div>
        {uncertain && <p className="studio-error">{t('有任务状态待确认，请先在右侧检查状态，避免重复扣费。', 'Resolve the uncertain task status before submitting again.')}</p>}
      </div>
    </aside>
    <section className="studio-library-panel" aria-label={t('素材与生成结果', 'Assets and generated results')}>
      <div className="studio-library-toolbar"><div className="studio-toolbar-group"><select className="studio-sort" aria-label={t('素材排序', 'Sort assets')} value={filter.sort} onChange={e => setFilter({ ...filter, sort: e.target.value })}><option value="newest">{t('最新优先', 'Newest first')}</option><option value="oldest">{t('最早优先', 'Oldest first')}</option><option value="name">{t('名称排序', 'Name')}</option></select><button type="button" className="studio-toolbar-button" onClick={() => openPanel('labels')} aria-pressed={Boolean(filter.tag)}><Tag size={16} /><span>{t('标签', 'Labels')}</span></button><button type="button" className="studio-toolbar-button" onClick={() => openPanel('folders')}><Folder size={16} /><span>{t('文件夹', 'Folders')}</span></button><button type="button" className="studio-toolbar-button" onClick={() => openPanel('templates')}><LayoutTemplate size={16} /><span>{t('模板', 'Templates')}</span></button></div>
        <div className="studio-toolbar-group studio-view-tools"><input className="studio-zoom" type="range" min={150} max={360} step={10} value={prefs.size} aria-label={t('缩略图大小', 'Thumbnail size')} onChange={e => updatePrefs(p => ({ ...p, size: Number(e.target.value) }))} /><div className="studio-segment studio-media-tabs" role="group" aria-label={t('媒体类型', 'Media type')}>{([{ key: 'image', Icon: Image, label: t('图片', 'Images') }, { key: 'video', Icon: Video, label: t('视频', 'Videos') }, { key: 'audio', Icon: AudioLines, label: t('音频', 'Audio') }] as const).map(({ key, Icon, label }) => <button type="button" key={key} aria-label={label} title={label} aria-pressed={filter.kind === key} onClick={() => setFilter({ ...filter, kind: key })}><Icon size={15} /></button>)}<button type="button" aria-pressed={filter.kind === 'all'} onClick={() => setFilter({ ...filter, kind: 'all' })}>{t('全部', 'All')}</button></div>
          <button type="button" className="studio-icon-button" title={t('仅看收藏', 'Favorites only')} aria-label={t('仅看收藏', 'Favorites only')} aria-pressed={filter.favorite} onClick={() => setFilter({ ...filter, favorite: !filter.favorite })}><Star size={17} fill={filter.favorite ? 'currentColor' : 'none'} /></button>
          <button type="button" className="studio-icon-button" title={prefs.layout === 'grid' ? t('切换列表布局', 'Switch to list') : t('切换网格布局', 'Switch to grid')} aria-label={prefs.layout === 'grid' ? t('切换列表布局', 'Switch to list') : t('切换网格布局', 'Switch to grid')} onClick={() => updatePrefs(p => ({ ...p, layout: p.layout === 'grid' ? 'list' : 'grid' }))}>{prefs.layout === 'grid' ? <Grid2X2 size={17} /> : <List size={17} />}</button>
          <button type="button" className="studio-icon-button" title={t('筛选素材', 'Filter assets')} aria-label={t('筛选素材', 'Filter assets')} aria-pressed={filter.date !== 'all' || filter.source !== 'all'} onClick={() => openPanel('filter')}><SlidersHorizontal size={17} /></button>
          <button type="button" className="studio-icon-button" title={t('搜索素材', 'Search assets')} aria-label={t('搜索素材', 'Search assets')} aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); if (!searchOpen) requestAnimationFrame(() => searchRef.current?.focus()); }}><Search size={17} /></button>
        </div>
      </div>
      <div className="studio-library-subbar"><div><strong>{t('我的素材', 'My library')}</strong><span>{filtered.length} {t('项', 'items')}</span><select aria-label={t('所在文件夹', 'Current folder')} value={filter.folder} onChange={e => setFilter({ ...filter, folder: e.target.value })}><option value="all">{t('所有文件夹', 'All folders')}</option><option value="">{t('未分类', 'Unsorted')}</option>{folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></div><button type="button" className="studio-toolbar-button" onClick={() => setReload(n => n + 1)} disabled={loading} aria-label={t('刷新素材库', 'Refresh library')}><RefreshCw size={14} className={loading ? 'home-spinner' : ''} /></button></div>
      {searchOpen && <label className="studio-search studio-library-search"><Search size={16} /><input ref={searchRef} aria-label={t('搜索素材名称或标签', 'Search names or labels')} placeholder={t('搜索素材名称或标签…', 'Search asset names or labels…')} value={filter.search} onChange={e => setFilter({ ...filter, search: e.target.value })} /><button type="button" className="studio-icon-button" aria-label={t('清除搜索', 'Clear search')} onClick={() => setFilter({ ...filter, search: '' })}><X size={14} /></button></label>}
      {(filter.tag || filter.favorite || filter.source !== 'all' || filter.date !== 'all' || filter.search) && <div className="studio-active-filters"><span>{t('已应用筛选', 'Filters applied')}{filter.tag ? ` · ${filter.tag}` : ''}</span><button type="button" onClick={() => setFilter({ ...DEFAULT_FILTER, folder: filter.folder, kind: filter.kind })}>{t('清除筛选', 'Clear filters')}<X size={12} /></button></div>}
      {loadError && <div className="studio-error studio-load-error" role="alert">{loadError}<button type="button" onClick={() => setReload(n => n + 1)}>{t('重试', 'Retry')}</button></div>}
      {jobs.storageError && <p className="studio-error" role="alert">{jobs.storageError}</p>}
      {activeJobs.length > 0 && <div className="studio-jobs" aria-live="polite">{activeJobs.map(job => <div key={job.id} className="studio-job">{['pending', 'submitting'].includes(job.status) ? <LoaderCircle size={18} className="home-spinner" /> : <Info size={18} />}<div><strong>{job.status === 'pending' ? t('试衣效果生成中', 'Generating your look') : job.status === 'submitting' ? t('正在提交生成请求', 'Submitting request') : job.status === 'unsaved' ? t('结果待保存', 'Result not saved') : job.status === 'unknown' ? t('任务状态待确认', 'Check task status') : t('生成未完成', 'Generation failed')}</strong><p>{job.message || t('可以继续浏览素材；返回此页面后会恢复任务状态。', 'You can browse assets. Task status resumes when you return.')}</p><small>{job.taskId ? `${t('任务', 'Task')} ${job.taskId}` : new Date(job.createdAt).toLocaleTimeString()}</small></div>{['unknown', 'unsaved'].includes(job.status) && <button type="button" className="studio-button" onClick={() => void jobs.check(job.id)}>{job.status === 'unsaved' ? t('重试保存', 'Retry save') : t('检查状态', 'Check status')}</button>}{job.status === 'error' && <button type="button" className="studio-icon-button" aria-label={t('收起失败任务', 'Dismiss failed task')} onClick={() => jobs.dismiss(job.id)}><X size={16} /></button>}</div>)}</div>}
      <div className="studio-library-scroll">
        {loading && !assets.length ? <div className="studio-empty"><LoaderCircle className="home-spinner" size={32} /><p>{t('正在加载素材…', 'Loading your library…')}</p></div> : filtered.length ? <div className={`studio-assets is-${prefs.layout}`} style={{ '--studio-tile-size': `${prefs.size}px` } as CSSProperties}>{filtered.map(asset => <article className="studio-asset" key={asset.id}><button type="button" className="studio-asset-open" onClick={() => { setPreview(asset.id); setDialogError(''); setName(''); }} aria-label={`${t('预览素材', 'Preview asset')}：${asset.name}`}><div className="studio-asset-media">{asset.kind === 'image' ? <MediaThumb src={asset.thumbnail || asset.url} alt={asset.name} /> : asset.kind === 'video' ? <><Video size={36} /><span>{t('视频', 'Video')}</span></> : <><AudioLines size={36} /><span>{t('音频', 'Audio')}</span></>}</div><div className="studio-asset-caption"><strong>{asset.name}</strong><small>{new Date(asset.createdAt).toLocaleDateString()} · {asset.kind === 'image' ? roleName(assetRole(asset, prefs.metadata), zh) : asset.kind}</small><div>{prefs.metadata[asset.id]?.tags?.map(tag => <span key={tag}>{tag}</span>)}</div></div></button><button type="button" className="studio-asset-star" aria-label={`${prefs.metadata[asset.id]?.favorite ? t('取消收藏', 'Unfavorite') : t('收藏', 'Favorite')}：${asset.name}`} aria-pressed={Boolean(prefs.metadata[asset.id]?.favorite)} onClick={() => updateMeta(asset.id, { favorite: !prefs.metadata[asset.id]?.favorite })}><Star size={16} fill={prefs.metadata[asset.id]?.favorite ? 'currentColor' : 'none'} /></button></article>)}</div> : <div className="studio-empty"><div className="studio-empty-art"><span /><span /><Shirt size={43} strokeWidth={1.1} /></div><h2>{assets.length ? t('没有找到匹配的素材', 'No matching assets') : t('你的下一套穿搭，从这里开始', 'Your next look starts here')}</h2><p>{assets.length ? t('试试其他关键词，或调整筛选条件。', 'Try another search or adjust your filters.') : t('选择人物或模特，搭配服装图片，生成的试衣效果会保存在这里。', 'Choose a model and an outfit. Your generated looks will appear here.')}</p><button type="button" className="studio-button" onClick={() => assets.length ? setFilter(DEFAULT_FILTER) : setPicker('model')}>{assets.length ? <RefreshCw size={15} /> : <Plus size={15} />}{assets.length ? t('重置全部筛选', 'Reset all filters') : t('添加第一张素材', 'Add your first reference')}</button></div>}
      </div>
      <div className="studio-library-footnote"><Info size={12} />{t('素材与文件夹同步到账户；收藏、标签、素材用途和试衣模板保存在当前浏览器。', 'Assets and folders sync to your account. Favorites, labels, roles and try-on presets are saved in this browser.')}</div>
    </section>
    {picker && <ReferencePicker assets={assets} metadata={prefs.metadata} selected={refs} requestedRole={picker} limit={limit} zh={zh} onUpload={upload} onClose={() => setPicker(null)} onConfirm={selected => { setRefs(selected); setFormError(''); setPicker(null); }} />}
    {panel && <StudioDialog title={({ models: t('选择生成模型', 'Choose an AI model'), labels: t('素材标签', 'Asset labels'), folders: t('管理文件夹', 'Manage folders'), templates: t('试衣模板', 'Try-on presets'), filter: t('筛选素材', 'Filter assets') })[panel]} description={panel === 'models' ? t('只显示后台已启用的图像模型；参考图支持情况以供应商实际能力为准。', 'Enabled image models. Reference support depends on the provider.') : panel === 'templates' || panel === 'labels' ? t('这些设置保存在当前浏览器，不会自动跨设备同步。', 'These settings are saved in this browser only.') : t('整理你的素材，快速找到需要的内容。', 'Organize your library and find the right assets.')} onClose={() => { if (!saving) setPanel(null); }}>
      <div className="studio-dialog-body">
        {panel === 'models' && <><label className="studio-search"><Search size={16} /><input aria-label={t('搜索生成模型', 'Search AI models')} placeholder={t('搜索模型名称…', 'Search models…')} value={modelSearch} onChange={e => setModelSearch(e.target.value)} /></label><div className="studio-model-list">{models.filter(m => `${m.label} ${m.provider.name}`.toLowerCase().includes(modelSearch.toLowerCase())).map(m => <button type="button" key={m.key} aria-pressed={model?.key === m.key} onClick={() => { setModelKey(m.key); setPanel(null); setFormError(''); }}><span className="studio-setting-icon"><Sparkles size={20} /></span><span><strong>{m.label}</strong><small>{m.provider.name} · {t(`${m.cost} 积分 / 次`, `${m.cost} credits / request`)}</small></span>{model?.key === m.key && <Check size={17} />}</button>)}{!models.length && <p>{t('尚未配置可用的图像模型，请联系管理员。', 'No image model configured. Contact your administrator.')}</p>}</div></>}
        {panel === 'labels' && <><p>{t('在素材预览中添加标签，点击下方标签筛选素材。', 'Add labels in an asset preview, then filter by a label here.')}</p><div className="studio-chips"><button type="button" aria-pressed={!filter.tag} onClick={() => { setFilter({ ...filter, tag: '' }); setPanel(null); }}>{t('全部标签', 'All labels')}</button>{tags.map(tag => <button type="button" key={tag} aria-pressed={filter.tag === tag} onClick={() => { setFilter({ ...filter, tag }); setPanel(null); }}>{tag}</button>)}</div>{!tags.length && <div className="studio-dialog-empty"><Tag size={30} /><p>{t('还没有标签。打开一张素材，为它添加第一个标签。', 'Open an asset to add your first label.')}</p></div>}</>}
        {panel === 'folders' && <><form className="studio-inline-form" onSubmit={e => { e.preventDefault(); void saveFolder(); }}><input aria-label={t('新文件夹名称', 'New folder name')} placeholder={t('新文件夹名称', 'New folder name')} value={name} maxLength={60} onChange={e => setName(e.target.value)} /><button type="submit" className="studio-button studio-primary" disabled={!name.trim() || saving}><Plus size={15} />{t('创建', 'Create')}</button></form><div className="studio-folder-list">{folders.map(f => <div key={f.id}><Folder size={18} /><button type="button" onClick={() => { setFilter({ ...filter, folder: f.id }); setPanel(null); }}>{f.name}<small>{assets.filter(a => a.folderId === f.id).length} {t('项', 'items')}</small></button><button type="button" className="studio-icon-button" aria-label={`${t('删除文件夹', 'Delete folder')}：${f.name}`} disabled={saving} onClick={() => setDeleteFolder(f.id)}><Trash2 size={15} /></button></div>)}</div>{deleteFolder && <div className="studio-folder-confirm"><p>{t('删除此文件夹？其中的素材将移至“未分类”，不会删除素材。', 'Delete this folder? Its assets will be moved to Unsorted, not deleted.')}</p><button type="button" className="studio-button" disabled={saving} onClick={() => setDeleteFolder(null)}>{t('取消', 'Cancel')}</button><button type="button" className="studio-button" disabled={saving} onClick={() => void removeFolder(deleteFolder)}>{t('确认删除文件夹', 'Confirm folder deletion')}</button></div>}<p className="studio-muted">{t('打开素材预览，可将素材移动到指定文件夹。', 'Open an asset preview to move it to a folder.')}</p></>}
        {panel === 'templates' && <><div className="studio-preset-list">{prompts.map(p => <button type="button" key={p.name} onClick={() => { setPrompt(p.prompt); setPanel(null); }}><LayoutTemplate size={22} /><span><strong>{zh ? p.name : p.en}</strong><small>{p.prompt}</small></span><ChevronRight size={16} /></button>)}{prefs.templates.map(p => <div key={p.id}><button type="button" onClick={() => { setPrompt(p.prompt); setSize(p.size); setQuality(p.quality); setPolish(p.polish); setPanel(null); }}><LayoutTemplate size={22} /><span><strong>{p.name}</strong><small>{p.prompt || t('使用已保存的输出设置', 'Use saved output settings')}</small></span></button><button type="button" className="studio-icon-button" aria-label={`${t('删除模板', 'Delete preset')}：${p.name}`} onClick={() => updatePrefs(previous => ({ ...previous, templates: previous.templates.filter(item => item.id !== p.id) }))}><Trash2 size={15} /></button></div>)}</div><form className="studio-inline-form" onSubmit={e => { e.preventDefault(); if (!name.trim()) return; updatePrefs(p => ({ ...p, templates: [{ id: crypto.randomUUID(), name: name.trim(), prompt, size: activeSize, quality: activeQuality, polish }, ...p.templates].slice(0, 50) })); setName(''); }}><input aria-label={t('试衣模板名称', 'Preset name')} placeholder={t('将当前设置保存为模板', 'Save current settings as a preset')} value={name} maxLength={60} onChange={e => setName(e.target.value)} /><button type="submit" className="studio-button studio-primary" disabled={!name.trim()}>{t('保存模板', 'Save preset')}</button></form></>}
        {panel === 'filter' && <div className="studio-filter-fields"><label>{t('素材来源', 'Source')}<select aria-label={t('素材来源', 'Asset source')} value={filter.source} onChange={e => setFilter({ ...filter, source: e.target.value })}>{[['all', t('全部来源', 'All sources')], ['library', t('我的素材库', 'My library')], ['history', t('画布生成历史', 'Canvas history')], ['generated', t('试衣生成结果', 'Try-on results')]].map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>{t('创建时间', 'Created')}<select aria-label={t('创建时间', 'Creation date')} value={filter.date} onChange={e => setFilter({ ...filter, date: e.target.value })}><option value="all">{t('不限时间', 'Any time')}</option><option value="7">{t('最近 7 天', 'Last 7 days')}</option><option value="30">{t('最近 30 天', 'Last 30 days')}</option></select></label><button type="button" className="studio-button" onClick={() => setFilter(DEFAULT_FILTER)}>{t('重置筛选', 'Reset filters')}</button><button type="button" className="studio-button studio-primary" onClick={() => setPanel(null)}>{t('查看筛选结果', 'View results')}</button></div>}
        {dialogError && <p className="studio-error" role="alert">{dialogError}</p>}
      </div>
    </StudioDialog>}
    {selectedAsset && <StudioDialog title={selectedAsset.name} description={t('预览素材、收藏、添加标签或整理到文件夹。', 'Preview, favorite, label or organize this asset.')} onClose={() => { if (!saving) setPreview(null); }} wide><div className="studio-preview"><div className="studio-preview-media">{selectedAsset.kind === 'image' ? <MediaThumb key={selectedAsset.url} src={selectedAsset.url} alt={selectedAsset.name} thumbWidth={0} /> : selectedAsset.kind === 'video' ? <video src={toRenderableMediaUrl(selectedAsset.url)} controls /> : <audio src={toRenderableMediaUrl(selectedAsset.url)} controls />}</div><div className="studio-preview-details"><button type="button" className="studio-button" aria-pressed={Boolean(prefs.metadata[selectedAsset.id]?.favorite)} onClick={() => updateMeta(selectedAsset.id, { favorite: !prefs.metadata[selectedAsset.id]?.favorite })}><Star size={16} fill={prefs.metadata[selectedAsset.id]?.favorite ? 'currentColor' : 'none'} />{prefs.metadata[selectedAsset.id]?.favorite ? t('已收藏', 'Favorited') : t('收藏素材', 'Favorite asset')}</button><label>{t('移动到文件夹', 'Move to folder')}<select aria-label={t('移动到文件夹', 'Move to folder')} disabled={saving} value={selectedAsset.folderId ?? ''} onChange={e => void moveAsset(selectedAsset, e.target.value)}><option value="">{t('未分类', 'Unsorted')}</option>{folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>{selectedAsset.kind === 'image' && <label>{t('素材用途', 'Asset role')}<select aria-label={t('素材用途', 'Asset role')} value={assetRole(selectedAsset, prefs.metadata)} onChange={e => updateMeta(selectedAsset.id, { role: e.target.value as AssetRole })}>{(['person', 'model', 'garment', 'reference'] as const).map(role => <option key={role} value={role}>{roleName(role, zh)}</option>)}</select></label>}<form onSubmit={e => { e.preventDefault(); if (name.trim()) { updateMeta(selectedAsset.id, { tags: Array.from(new Set([...(prefs.metadata[selectedAsset.id]?.tags ?? []), name.trim()])).slice(0, 20) }); setName(''); } }}><label>{t('素材标签', 'Asset labels')}<div className="studio-inline-form"><input aria-label={t('添加标签', 'Add label')} placeholder={t('输入标签', 'Enter a label')} value={name} maxLength={30} onChange={e => setName(e.target.value)} /><button type="submit" className="studio-icon-button" aria-label={t('确认添加标签', 'Confirm label')} disabled={!name.trim()}><Plus size={16} /></button></div></label></form><div className="studio-chips">{prefs.metadata[selectedAsset.id]?.tags?.map(tag => <button type="button" key={tag} aria-label={`${t('移除标签', 'Remove label')}：${tag}`} onClick={() => updateMeta(selectedAsset.id, { tags: prefs.metadata[selectedAsset.id]?.tags?.filter(t => t !== tag) })}>{tag}<X size={12} /></button>)}</div>{selectedAsset.kind === 'image' && <><button type="button" className="studio-button studio-primary" onClick={() => useReference(selectedAsset, 'model')}><Users size={16} />{t('用作人物 / 模特', 'Use as person / model')}</button><button type="button" className="studio-button" onClick={() => useReference(selectedAsset, 'garment')}><Shirt size={16} />{t('用作试穿服装', 'Use as clothing')}</button></>}<button type="button" className="studio-button" disabled={downloadBusy} onClick={() => void download(selectedAsset)}><Download size={16} />{downloadBusy ? t('下载中…', 'Downloading…') : t('下载素材', 'Download asset')}</button>{selectedAsset.text && <details><summary>{t('查看描述 / 提示词', 'Description / prompt')}</summary><p>{selectedAsset.text}</p></details>}{dialogError && <p className="studio-error" role="alert">{dialogError}</p>}</div></div></StudioDialog>}
  </main>;
}
