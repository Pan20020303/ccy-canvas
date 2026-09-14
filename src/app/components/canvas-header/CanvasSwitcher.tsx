import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, ChevronRight, Folder, Image as ImageIcon, Loader2, Plus, RefreshCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { listFolders, listProjects, type BackendFolder } from '../../api/projects';
import { useAuth } from '../../auth/AuthProvider';
import { useStore } from '../../store';
import { MediaThumb } from '../MediaThumb';
import { CanvasSaveStatus } from './CanvasSaveStatus';
import { createHeaderProject, switchHeaderProject } from './canvas-navigation';
import logo from '../../../imports/logo-login.png';

type Scope = 'all' | 'personal' | 'collab';
type CanvasEntry = { id: string; name: string; cover: string; folderId: string; collab: boolean; updated: number };
export function CanvasSwitcher({ onHome }: { onHome: () => void }) {
  const { user } = useAuth();
  const language = useStore(s => s.language);
  const remote = useStore(s => s.backendProjects);
  const local = useStore(s => s.projects);
  const remoteId = useStore(s => s.activeBackendProjectId);
  const localId = useStore(s => s.activeProjectId);
  const zh = language === 'zh';
  const activeId = user ? remoteId : localId;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [folders, setFolders] = useState<BackendFolder[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const entries: CanvasEntry[] = useMemo(() => (user ? remote.map(p => ({ id:p.id, name:p.name, cover:p.cover_url ?? '', folderId:p.folder_id ?? '', collab:Boolean(p.is_collaborative), updated:Date.parse(p.updated_at) })) : local.map(p => ({ id:p.id, name:p.name, cover:'', folderId:'', collab:false, updated:p.updatedAt }))).sort((a,b) => Number(b.id===activeId)-Number(a.id===activeId) || b.updated-a.updated), [user, remote, local, activeId]);
  const current = entries.find(p => p.id === activeId);
  useEffect(() => {
    if (open && current?.folderId) setExpanded(previous => previous.has(current.folderId) ? previous : new Set([...previous, current.folderId]));
  }, [open, current?.folderId]);
  const load = useCallback(async () => {
    if (!user) return;
    const revision = ++requestId.current;
    setLoading(true); setError('');
    const [projectsResult, foldersResult] = await Promise.allSettled([listProjects(), listFolders()]);
    if (requestId.current !== revision) return;
    if (projectsResult.status === 'fulfilled') useStore.setState({ backendProjects: projectsResult.value });
    if (foldersResult.status === 'fulfilled') setFolders(foldersResult.value);
    if (projectsResult.status === 'rejected' || foldersResult.status === 'rejected') setError(zh ? '画布列表未能完整刷新，请重试。' : 'Could not refresh the complete list.');
    setLoading(false);
  }, [user?.id, zh]);
  useEffect(() => { if (open) void load(); return () => { requestId.current += 1; }; }, [open, load]);
  const query = search.trim().toLocaleLowerCase();
  const filtered = entries.filter(p => (scope === 'all' || (scope === 'collab' ? p.collab : !p.collab)) && (!query || p.name.toLocaleLowerCase().includes(query) || folders.some(f => f.id === p.folderId && f.name.toLocaleLowerCase().includes(query))));
  const roots = filtered.filter(p => !p.folderId || !folders.some(f => f.id === p.folderId));
  const visibleFolders = folders.filter(f => filtered.some(p => p.folderId === f.id) || (!query && scope === 'all') || (scope === 'all' && f.name.toLocaleLowerCase().includes(query)));
  const perform = async (id: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(id);
    try { await action(); setOpen(false); } catch (reason) { toast.error(reason instanceof Error ? reason.message : '画布操作失败，请重试。'); }
    finally { busyRef.current = false; setBusy(null); }
  };
  const row = (p: CanvasEntry) => <button type="button" key={p.id} className={`canvas-switcher-row ${p.id === activeId ? 'is-current' : ''}`} aria-current={p.id === activeId ? 'page' : undefined} disabled={busy !== null} title={p.name} onClick={() => void perform(p.id, () => switchHeaderProject(p.id, Boolean(user)))}>
    <span className="canvas-project-cover">{p.cover ? <MediaThumb className="canvas-project-image" src={p.cover} alt="" /> : <ImageIcon className="canvas-cover-placeholder" size={16} />}</span>
    <span className="canvas-project-name">{p.name || (zh ? '未命名画布' : 'Untitled canvas')}</span>
    {p.collab && <span className="canvas-collab-badge">{zh ? '协作' : 'Shared'}</span>}{busy === p.id ? <Loader2 className="canvas-spin canvas-row-end" size={14} /> : p.id === activeId ? <Check className="canvas-row-end" size={14} /> : null}
  </button>;
  return <div className="canvas-project-nav">
    <div className="canvas-project-pill">
      <button type="button" className="canvas-home-mark" onClick={onHome} aria-label={zh ? '返回橙次元首页' : 'Back to home'} title={zh ? '返回首页' : 'Home'}><img className="canvas-brand-icon" src={logo} alt="橙次元" /></button>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild><button type="button" className={`canvas-project-trigger ${open ? 'is-open' : ''}`} aria-label={zh ? '切换画布' : 'Switch canvas'} title={current?.name}><span className="canvas-current-name">{current?.name || (zh ? '无限画布' : 'Untitled canvas')}</span><ChevronDown className="canvas-project-chevron" size={13} /></button></Popover.Trigger>
        <Popover.Portal><Popover.Content className="canvas-switcher" align="start" sideOffset={12} alignOffset={-48} collisionPadding={10} aria-label={zh ? '画布切换菜单' : 'Canvas switcher'} onOpenAutoFocus={event => { event.preventDefault(); searchRef.current?.focus(); }}>
          <label className="canvas-switcher-search"><Search className="canvas-search-icon" size={15} /><input className="canvas-search-input" ref={searchRef} aria-label={zh ? '搜索画布' : 'Search canvases'} placeholder={zh ? '搜索画布' : 'Search canvases'} value={search} onChange={event => setSearch(event.target.value)} /></label>
          <div className="canvas-switcher-tabs" role="group" aria-label={zh ? '画布分类' : 'Canvas categories'}>{(['all','personal','collab'] as const).map((key, index) => <button type="button" key={key} className={scope === key ? 'is-active' : ''} aria-pressed={scope === key} onClick={() => setScope(key)}>{(zh ? ['全部','个人','协作'] : ['All','Personal','Shared'])[index]}</button>)}</div>
          {error && <div className="canvas-list-error" role="alert"><span className="canvas-error-copy">{error}</span><button className="canvas-retry" type="button" aria-label="重新加载画布列表" onClick={() => void load()}><RefreshCw size={14} /></button></div>}
          <div className="canvas-switcher-list" aria-busy={loading}>
            {loading && !entries.length ? <p className="canvas-list-empty" role="status"><Loader2 className="canvas-spin" size={16} />{zh ? '加载中…' : 'Loading…'}</p> : <>
              {roots.filter(p => p.id === activeId).map(row)}
              {visibleFolders.map(folder => { const children = filtered.filter(p => p.folderId === folder.id); const isExpanded = expanded.has(folder.id) || Boolean(query); return <div className="canvas-folder" key={folder.id}>
                <button type="button" className="canvas-switcher-row canvas-folder-trigger" aria-expanded={isExpanded} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next; })}><span className="canvas-project-cover"><Folder size={16} /></span><span className="canvas-project-name">{folder.name}</span><ChevronRight size={13} className={`canvas-folder-chevron ${isExpanded ? 'is-expanded' : ''}`} /></button>
                {isExpanded && <div className="canvas-folder-children">{children.length ? children.map(row) : <p className="canvas-folder-empty">{zh ? '暂无画布' : 'No canvases'}</p>}</div>}
              </div>; })}
              {roots.filter(p => p.id !== activeId).map(row)}
              {!filtered.length && !visibleFolders.length && <p className="canvas-list-empty">{query ? (zh ? '没有找到匹配的画布' : 'No matching canvases') : (zh ? '暂无画布' : 'No canvases yet')}</p>}
            </>}
          </div>
          <button type="button" className="canvas-switcher-create" disabled={busy !== null} onClick={() => void perform('new', () => createHeaderProject(Boolean(user), zh ? '未命名画布' : 'Untitled canvas'))}>{busy === 'new' ? <Loader2 size={14} className="canvas-spin" /> : <Plus size={15} className="canvas-create-icon" />}{zh ? '新建画布' : 'New canvas'}</button>
        </Popover.Content></Popover.Portal>
      </Popover.Root>
      <CanvasSaveStatus />
    </div>
  </div>;
}
