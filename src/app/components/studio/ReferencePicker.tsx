import { useMemo, useRef, useState } from 'react';
import { Check, ImagePlus, Plus, Search, Shirt, Users, Upload, LoaderCircle } from 'lucide-react';
import { MediaThumb } from '../MediaThumb';
import { StudioDialog } from './StudioDialog';
import { assetRole, roleName, type AssetMeta, type AssetRole, type ReferenceAsset, type StudioAsset } from './studio-library';

export function ReferencePicker({ assets, metadata, selected, requestedRole, limit, zh, onConfirm, onClose, onUpload }: {
  assets: StudioAsset[]; metadata: Record<string, AssetMeta>; selected: ReferenceAsset[]; requestedRole: AssetRole; limit: number; zh: boolean;
  onConfirm: (refs: ReferenceAsset[]) => void; onClose: () => void; onUpload: (files: File[], role: AssetRole) => Promise<StudioAsset[]>;
}) {
  const [tab, setTab] = useState<'people' | 'images'>(['person', 'model'].includes(requestedRole) ? 'people' : 'images');
  const [source, setSource] = useState('all');
  const [role, setRole] = useState<AssetRole | 'all'>('all');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState(selected);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const currentRole: AssetRole = role !== 'all' ? role : tab === 'people' ? (requestedRole === 'person' ? 'person' : 'model') : (requestedRole === 'reference' ? 'reference' : 'garment');
  const filtered = useMemo(() => assets.filter(a => a.kind === 'image'
    && (tab === 'people' ? ['person', 'model'].includes(assetRole(a, metadata)) : !['person', 'model'].includes(assetRole(a, metadata)))
    && a.name.toLowerCase().includes(search.trim().toLowerCase())
    && (source === 'all' || (source === 'history' ? a.source !== 'library' : a.source === 'library'))
    && (role === 'all' || assetRole(a, metadata) === role)), [assets, metadata, role, search, source, tab]);
  const choose = (asset: StudioAsset) => {
    setError('');
    const previous = chosen.find(c => c.url === asset.url);
    if (previous) { setChosen(chosen.filter(c => c.url !== asset.url)); return; }
    if (chosen.length >= limit) { setError(zh ? `最多选择 ${limit} 张参考图片。` : `Select up to ${limit} references.`); return; }
    setChosen([...chosen, { ...asset, role: currentRole }]);
  };
  const upload = async (files: File[]) => {
    if (!files.length || uploading) return;
    if (files.length + chosen.length > limit) { setError(zh ? `最多选择 ${limit} 张参考图片。` : `Select up to ${limit} references.`); return; }
    setUploading(true); setError('');
    try {
      const uploaded = await onUpload(files, currentRole);
      setChosen(previous => [...previous, ...uploaded.map(a => ({ ...a, role: currentRole }))].slice(0, limit));
    } catch (e) { setError(e instanceof Error ? e.message : (zh ? '上传失败，请重试。' : 'Upload failed.')); }
    finally { setUploading(false); }
  };
  return <StudioDialog title={zh ? '添加参考素材' : 'Add visual references'} description={zh ? '选择人物或模特，再添加要试穿的服装。可为每张已选图片指定用途。' : 'Select a person or model and clothing. Assign a role to each reference.'} onClose={onClose} wide>
    <div className="studio-picker-tabs" role="group" aria-label={zh ? '素材类型' : 'Reference types'}>
      <button type="button" aria-pressed={tab === 'people'} onClick={() => { setTab('people'); setRole('all'); }}><Users size={23} /><strong>{zh ? '人物与模特' : 'People & models'}</strong><small>{zh ? '保留人物特征，演绎不同穿搭' : 'Keep the identity. Explore new looks.'}</small></button>
      <button type="button" aria-pressed={tab === 'images'} onClick={() => { setTab('images'); setRole('all'); }}><Shirt size={23} /><strong>{zh ? '服装与图片' : 'Clothing & images'}</strong><small>{zh ? '上传服装、姿态或风格参考' : 'Clothing, pose and visual references'}</small></button>
    </div>
    <div className="studio-picker-filters">
      <div className="studio-segment">{[['all', zh ? '全部素材' : 'All assets'], ['library', zh ? '我的素材' : 'My library'], ['history', zh ? '生成历史' : 'Generations']].map(([key, label]) => <button type="button" key={key} aria-pressed={source === key} onClick={() => setSource(key)}>{label}</button>)}</div>
      <div className="studio-chips"><button type="button" aria-pressed={role === 'all'} onClick={() => setRole('all')}>{zh ? '全部' : 'All'}</button>{(tab === 'people' ? ['person', 'model'] as const : ['garment', 'reference'] as const).map(r => <button type="button" key={r} aria-pressed={role === r} onClick={() => setRole(r)}>{roleName(r, zh)}</button>)}</div>
      <label className="studio-search"><Search size={15} /><input aria-label={zh ? '搜索参考素材' : 'Search references'} placeholder={zh ? '搜索素材…' : 'Search…'} value={search} onChange={e => setSearch(e.target.value)} /></label>
    </div>
    <div className="studio-picker-body">
      <div className="studio-picker-grid">
        <button type="button" className="studio-upload-tile" onClick={() => input.current?.click()} disabled={uploading}><span>{uploading ? <LoaderCircle className="home-spinner" size={23} /> : <Plus size={23} />}</span><strong>{zh ? `上传${roleName(currentRole, true)}` : `Upload ${roleName(currentRole, false).toLowerCase()}`}</strong><small>JPG / PNG / WebP · 20 MB</small></button>
        {filtered.map(asset => { const selectedRef = chosen.find(c => c.url === asset.url); return <button type="button" className="studio-picker-card" key={asset.id} onClick={() => choose(asset)} aria-pressed={Boolean(selectedRef)} aria-label={`${zh ? '选择素材' : 'Select asset'}：${asset.name}`}><MediaThumb src={asset.thumbnail || asset.url} alt={asset.name} /><span className="studio-selection-check">{selectedRef && <Check size={13} />}</span><span className="studio-picker-caption"><strong>{asset.name}</strong><small>{roleName(assetRole(asset, metadata), zh)}</small></span></button>; })}
      </div>
      {filtered.length === 0 && <div className="studio-picker-empty"><ImagePlus size={32} /><p>{zh ? '还没有匹配的素材' : 'No matching references yet'}</p><small>{zh ? '上传一张人物或服装图片，就可以开始试衣。' : 'Upload a person or a garment to get started.'}</small></div>}
    </div>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden aria-label={zh ? '上传参考图片' : 'Upload references'} onChange={e => { void upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
    <div className="studio-selected-references">{chosen.map(ref => <div key={ref.id}><MediaThumb src={ref.thumbnail || ref.url} alt={ref.name} /><select aria-label={`${zh ? '参考用途' : 'Reference role'}：${ref.name}`} value={ref.role} onChange={e => setChosen(chosen.map(c => c.id === ref.id ? { ...c, role: e.target.value as AssetRole } : c))}>{(['person', 'model', 'garment', 'reference'] as const).map(r => <option key={r} value={r}>{roleName(r, zh)}</option>)}</select><button type="button" aria-label={`${zh ? '移除参考' : 'Remove reference'}：${ref.name}`} onClick={() => setChosen(chosen.filter(c => c.id !== ref.id))}>×</button></div>)}</div>
    {error && <p className="studio-error" role="alert">{error}</p>}
    <footer><span>{zh ? `已选择 ${chosen.length} / ${limit} 张` : `${chosen.length} / ${limit} selected`}</span><button type="button" className="studio-button" onClick={() => input.current?.click()} disabled={uploading}><Upload size={14} />{zh ? '上传图片' : 'Upload'}</button><button type="button" className="studio-button studio-primary" disabled={uploading} onClick={() => onConfirm(chosen)}>{zh ? '使用所选素材' : 'Use selected references'}</button></footer>
  </StudioDialog>;
}
