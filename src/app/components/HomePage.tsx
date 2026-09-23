import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { ArrowUp, ChevronRight, Layers3, LoaderCircle, Plus, Search, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../auth/AuthProvider';
import { useStore } from '../store';
import { listTemplates, useTemplate, type CanvasTemplate } from '../api/projects';
import logo from '../../imports/logo-login.png';
import { CanvasLibrary } from './CanvasLibrary';
import { TryOnStudio } from './studio/TryOnStudio';
import { MediaThumb } from './MediaThumb';
import { UserAvatar } from './UserAvatar';
import { ProfileSettingsModal } from './ProfileSettingsModal';
import { AccountCenter, type AccountTab } from './home/AccountCenter';
import { DiscoveryGallery } from './home/DiscoveryGallery';
import { HomeBanners } from './home/HomeBanners';
import { HomeSidebar, type HomeView } from './home/HomeSidebar';
import './home/home.css';

const COLLAPSE_KEY = 'ccy-home-sidebar-collapsed';
export function HomePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const { user, creditSummary, logout } = useAuth();
  const language = useStore(s => s.language);
  const theme = useStore(s => s.theme);
  const projects = useStore(s => s.backendProjects);
  const refreshProjects = useStore(s => s.refreshBackendProjects);
  const setProfileOpen = useStore(s => s.setProfileOpen);
  const zh = language === 'zh';
  const view: HomeView = params.get('view') === 'tryon' ? 'tryon' : params.get('view') === 'canvases' ? 'canvases' : params.get('view') === 'gallery' ? 'gallery' : 'home';
  const [collapsed, setCollapsed] = useState(() => { try { const saved = window.localStorage.getItem(COLLAPSE_KEY); return saved === null ? window.innerWidth < 760 : saved === 'true'; } catch { return window.innerWidth < 760; } });
  const [studioOpen, setStudioOpen] = useState(view === 'tryon');
  const [accountTab, setAccountTab] = useState<AccountTab | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [idea, setIdea] = useState('');
  const [recentTab, setRecentTab] = useState('all');
  const [recentSearch, setRecentSearch] = useState('');
  const [templates, setTemplates] = useState<CanvasTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState('');
  const ideaRef = useRef<HTMLInputElement>(null);
  const templateRequest = useRef(0);
  const changeView = (next: HomeView) => { setParams(next === 'home' ? {} : { view: next }); if (window.innerWidth < 760) setCollapsed(true); window.scrollTo({ top: 0, behavior: 'instant' }); };
  const openAccount = (tab: AccountTab = 'profile') => { if (!user) { navigate('/login'); return; } setAccountTab(tab); };
  const toggleSidebar = () => setCollapsed(value => { const next = !value; try { window.localStorage.setItem(COLLAPSE_KEY, String(next)); } catch { /* The layout still works without preference storage. */ } return next; });
  const refreshTemplates = useCallback(async () => {
    const request = ++templateRequest.current;
    if (!user) { setTemplates([]); return; }
    setTemplatesLoading(true); setTemplatesError('');
    try { const items = await listTemplates(); if (request === templateRequest.current) setTemplates(items); }
    catch { if (request === templateRequest.current) setTemplatesError(zh ? '精选模板暂时加载失败。' : 'Templates could not be loaded.'); }
    finally { if (request === templateRequest.current) setTemplatesLoading(false); }
  }, [user?.id, zh]);
  useEffect(() => { if (user) void refreshProjects(); }, [user?.id, refreshProjects]);
  useEffect(() => { void refreshTemplates(); return () => { templateRequest.current += 1; }; }, [refreshTemplates]);
  const recent = useMemo(() => projects.filter(p => (recentTab === 'all' || (recentTab === 'collab' ? p.is_collaborative : !p.is_collaborative)) && p.name.toLowerCase().includes(recentSearch.trim().toLowerCase())).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, 5), [projects, recentSearch, recentTab]);

  const run = async (action: () => Promise<void>) => {
    if (!user) { navigate('/login'); return; }
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { await action(); } catch (error) { toast.error(error instanceof Error ? error.message : (zh ? '操作失败，请稍后重试。' : 'Something went wrong. Please retry.')); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const create = (prompt = '') => run(async () => {
    const text = prompt.trim();
    const created = await useStore.getState().createBackendProject(text ? text.slice(0, 30) : (zh ? '未命名画布' : 'Untitled canvas'));
    if (!created) throw new Error(zh ? '创建画布失败，请检查连接后重试。' : 'Could not create canvas. Please retry.');
    if (text) {
      useStore.getState().addNode({ id: crypto.randomUUID(), type: 'textNode', position: { x: 260, y: 180 }, data: { content: text, label: zh ? '我的创意' : 'My idea' } });
      await useStore.getState().saveCanvasToBackend({ force: true });
      if (useStore.getState().canvasSaveStatus === 'error') toast.warning(zh ? '画布已创建，创意暂存于本地；进入画布后请重试保存。' : 'Canvas created. Your idea is local until saving can be retried.');
    }
    setIdea(''); navigate('/app');
  });
  const openProject = (id: string) => run(async () => {
    const state = useStore.getState();
    if (state.activeBackendProjectId !== id || !state.canvasHydrated) await state.switchBackendProject(id);
    if (!useStore.getState().canvasHydrated) throw new Error(zh ? '画布加载失败，请稍后重试。' : 'Canvas could not be loaded.');
    navigate('/app');
  });
  const applyTemplate = (id: string) => run(async () => {
    const created = await useTemplate(id);
    await refreshProjects(); await useStore.getState().switchBackendProject(created.id);
    if (!useStore.getState().canvasHydrated) throw new Error(zh ? '模板已复制，但加载失败，请在无限画布中重试打开。' : 'Template copied. Open it from Canvases to retry loading.');
    navigate('/app');
  });
  const startCreating = () => { void create(); };
  const hour = new Date().getHours();
  const greeting = zh ? (hour < 6 ? '夜深了' : hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好') : (hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');
  return <div className={`home-page ${collapsed ? 'is-collapsed' : ''}`} data-theme={theme}>
    {!collapsed && <button className="home-sidebar-scrim" type="button" aria-label={zh ? '收起导航遮罩' : 'Close navigation'} onClick={toggleSidebar} />}
    <HomeSidebar view={view} collapsed={collapsed} studioOpen={studioOpen} zh={zh} admin={user?.role === 'admin'} onToggle={toggleSidebar} onStudioToggle={() => setStudioOpen(v => !v)} onView={changeView} onCreate={startCreating} onAccount={() => openAccount()} onCli={() => openAccount('cli')} onHelp={() => openAccount('help')} onAdmin={() => navigate('/admin')} onFilm={() => navigate(location.pathname.startsWith('/__preview/') ? '/__preview/film' : '/studio/film')} />
    <div className="home-main-shell">
      <header className="home-topbar"><button className="home-community" type="button" onClick={() => openAccount('help')}>{zh ? '创作指南' : 'Creator guide'}</button><button className="home-credit-pill" type="button" onClick={() => openAccount('ledger')} aria-label={zh ? '查看我的积分' : 'View my credits'}><Sparkles size={15} /><span>{creditSummary?.current_balance?.toLocaleString() ?? '—'}</span></button><button className="home-membership-pill" type="button" disabled title={zh ? '会员订阅服务尚未开放' : 'Membership is not available yet'}>{zh ? '会员 · 敬请期待' : 'Membership · Soon'}</button><button className="home-avatar-button" type="button" onClick={() => openAccount()} aria-label={zh ? '打开我的账户' : 'Open my account'}><UserAvatar avatar={user?.avatar} name={user?.name || 'CCY'} className="home-user-avatar" fallbackClassName="home-avatar-fallback" /></button></header>
      <div className={`home-page-content ${view === 'tryon' ? 'home-studio-content' : ''}`}>
        {view === 'home' && <>
          <section className="home-hero" aria-label={zh ? '开始创作' : 'Start creating'}>
            <div className="home-hero-inner"><div className="home-greeting"><img src={logo} alt="" className="home-greeting-mark" /><h1><span>{greeting}，</span>{user?.name || (zh ? '今天要做点什么呢？' : 'What will you create?')}</h1></div>
              <form className="home-idea-box" onSubmit={e => { e.preventDefault(); if (idea.trim()) void create(idea); else ideaRef.current?.focus(); }}><Sparkles size={19} /><input ref={ideaRef} value={idea} onChange={e => setIdea(e.target.value)} placeholder={zh ? '说出你的创意，橙次元帮你在画布上实现…' : 'Describe your idea. Bring it to life on the canvas…'} aria-label={zh ? '你的创意' : 'Your idea'} maxLength={4000} disabled={busy} /><button type="submit" aria-label={zh ? '用这个创意创建画布' : 'Create canvas from this idea'} disabled={busy || !idea.trim()}>{busy ? <LoaderCircle className="home-spinner" size={18} /> : <ArrowUp size={19} />}</button></form>
              <div className="home-prompt-chips">{(zh ? ['电影感分镜', '角色设定', '国风奇幻世界', '画面风格设计', '产品创意短片'] : ['Cinematic storyboard', 'Character design', 'Fantasy world', 'Visual style', 'Product film']).map(text => <button className="home-prompt-chip" type="button" key={text} onClick={() => { setIdea(zh ? `我想创作一组${text}，` : `I want to create a ${text.toLowerCase()}, `); ideaRef.current?.focus(); }}>{text}</button>)}<button type="button" className="home-prompt-chip" onClick={() => changeView('gallery')}>{zh ? '探索模板' : 'Explore templates'}<ChevronRight size={13} /></button></div>
              <div className="home-recent-toolbar"><div className="home-recent-tabs" role="group" aria-label={zh ? '最近画布分类' : 'Recent canvas categories'}>{(['all', 'personal', 'collab'] as const).map((key, i) => <button className={recentTab === key ? 'is-active' : ''} type="button" key={key} aria-pressed={recentTab === key} onClick={() => setRecentTab(key)}>{(zh ? ['全部', '个人', '协作'] : ['All', 'Personal', 'Shared'])[i]}</button>)}</div><label className="home-search home-recent-search"><Search size={13} /><input placeholder={zh ? '搜索' : 'Search'} aria-label={zh ? '搜索最近画布' : 'Search recent canvases'} value={recentSearch} onChange={e => setRecentSearch(e.target.value)} /></label><button className="home-all-canvases" type="button" onClick={() => changeView('canvases')}>{zh ? '所有画布' : 'All canvases'}<ChevronRight size={13} /></button></div>
              <div className="home-recent-grid"><button className="home-recent-new" type="button" onClick={startCreating} disabled={busy}><span><Plus size={18} /></span>{zh ? '新建画布' : 'New canvas'}</button>{recent.map(project => <button type="button" className="home-recent-card" key={project.id} onClick={() => void openProject(project.id)} disabled={busy} aria-label={`${zh ? '打开画布' : 'Open canvas'}：${project.name}`}>
                {project.cover_url ? <MediaThumb src={project.cover_url} alt="" className="home-cover-image" /> : <div className="home-canvas-placeholder"><Layers3 size={28} /></div>}<span className="home-recent-caption"><strong>{project.name || (zh ? '未命名画布' : 'Untitled')}</strong><time>{new Date(project.updated_at).toLocaleDateString(zh ? 'zh-CN' : 'en-CA')}</time></span>{project.is_collaborative && <span className="home-collab-ribbon">{zh ? '协作' : 'Shared'}</span>}
              </button>)}{recent.length === 0 && <p className="home-recent-empty">{zh ? (recentSearch ? '没有匹配的画布' : '让第一个灵感，在这里发生。') : 'Your next idea starts here.'}</p>}</div>
            </div>
          </section>
          <HomeBanners zh={zh} onCreate={startCreating} onGallery={() => changeView('gallery')} />
        </>}
        {view === 'tryon' ? <TryOnStudio key={user?.id ?? 'guest'} userId={user?.id ?? ''} zh={zh} /> : view === 'canvases' ? <CanvasLibrary /> : <>{view === 'gallery' && <div className="home-discovery-heading"><h1>{zh ? '作品广场' : 'Discover'}</h1><p>{zh ? '探索灵感，让好想法在画布上发生。' : 'Explore inspiration. Bring ideas to your canvas.'}</p></div>}<DiscoveryGallery templates={templates} loading={templatesLoading} error={templatesError} busy={busy} zh={zh} onRetry={() => void refreshTemplates()} onUseTemplate={id => void applyTemplate(id)} /></>}
      </div>
    </div>
    <AccountCenter tab={accountTab} onTab={setAccountTab} onEditProfile={() => { setAccountTab(null); setProfileOpen(true); }} onProjects={() => { setAccountTab(null); changeView('canvases'); }} onAdmin={() => navigate('/admin')} onLogout={async () => { await logout(); navigate('/login'); }} />
    <ProfileSettingsModal />

  </div>;
}
