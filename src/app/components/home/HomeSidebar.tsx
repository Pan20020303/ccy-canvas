import { ChevronDown, ChevronRight, CircleUserRound, Clapperboard, Home, Shirt, Layers3, MessageCircle, PanelLeftClose, PanelLeftOpen, Plus, ShieldCheck, Terminal, Trophy, Video, WandSparkles } from 'lucide-react';
import logo from '../../../imports/logo-login.png';

export type HomeView = 'home' | 'canvases' | 'gallery' | 'tryon';
type Props = {
  view: HomeView; collapsed: boolean; studioOpen: boolean; zh: boolean; admin: boolean;
  onToggle: () => void; onStudioToggle: () => void; onView: (view: HomeView) => void;
  onCreate: () => void; onAccount: () => void; onHelp: () => void; onCli: () => void; onAdmin: () => void; onFilm?: () => void;
};

export function HomeSidebar(p: Props) {
  const items = [
    { id: 'home', icon: Home, label: p.zh ? '首页' : 'Home' },
    { id: 'gallery', icon: Clapperboard, label: p.zh ? '作品广场' : 'Discover' },
    { id: 'canvases', icon: Layers3, label: p.zh ? '无限画布' : 'Canvases' },
  ] as const;
  return <aside id="home-sidebar" className="home-sidebar" aria-label={p.zh ? '主导航' : 'Main navigation'}>
    <div className="home-sidebar-brand">
      <button type="button" className="home-brand" onClick={() => p.collapsed ? p.onToggle() : p.onView('home')} aria-label={p.collapsed ? (p.zh ? '展开导航' : 'Expand navigation') : (p.zh ? '橙次元首页' : 'CCY home')} title={p.zh ? '橙次元' : 'CCY Canvas'}>
        <img className="home-brand-mark" src={logo} alt="" /><span className="home-nav-label home-brand-name">橙次元</span>
      </button>
      <button type="button" className="home-collapse" aria-controls="home-sidebar" aria-expanded={!p.collapsed} aria-label={p.zh ? (p.collapsed ? '展开侧边栏' : '收起侧边栏') : (p.collapsed ? 'Expand sidebar' : 'Collapse sidebar')} onClick={p.onToggle}>
        {p.collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
      </button>
    </div>
    <button type="button" className="home-new-canvas" onClick={p.onCreate} title={p.zh ? '新建画布' : 'New canvas'}><Plus size={19} /><span className="home-nav-label">{p.zh ? '新建画布' : 'New canvas'}</span></button>
    <nav className="home-primary-nav">
      {items.map(({ id, icon: Icon, label }) => <button key={id} type="button" className={`home-nav-item ${p.view === id ? 'is-active' : ''}`} aria-current={p.view === id ? 'page' : undefined} onClick={() => p.onView(id)} title={label}><Icon size={20} strokeWidth={1.6} /><span className="home-nav-label">{label}</span></button>)}
      <button type="button" className="home-nav-item" disabled title={p.zh ? '创作者竞技场 · 筹备中' : 'Creator arena · Coming soon'}><Trophy size={20} strokeWidth={1.6} /><span className="home-nav-label">{p.zh ? '创作者竞技场' : 'Creator arena'}</span><small className="home-nav-label home-soon">{p.zh ? '筹备中' : 'Soon'}</small></button>
      <button type="button" className="home-nav-item" onClick={p.onStudioToggle} aria-expanded={p.studioOpen} aria-controls="home-studio-nav" title={p.zh ? '工作室' : 'Studio'}><WandSparkles size={20} strokeWidth={1.6} /><span className="home-nav-label">{p.zh ? '工作室' : 'Studio'}</span><ChevronDown className={`home-nav-label home-nav-chevron ${p.studioOpen ? 'is-open' : ''}`} size={15} /></button>
      {p.studioOpen && <div id="home-studio-nav" className="home-studio-nav">
        <button type="button" className="home-nav-item" title={p.zh ? '一键成片' : 'Film studio'} onClick={p.onFilm}><Clapperboard size={16} /><span className="home-nav-label">{p.zh ? '一键成片' : 'Film studio'}</span></button>
        <button type="button" className={`home-nav-item ${p.view === 'tryon' ? 'is-active' : ''}`} aria-current={p.view === 'tryon' ? 'page' : undefined} title={p.zh ? '模特试衣库' : 'Virtual try-on'} onClick={() => p.onView('tryon')}><Shirt size={16} /><span className="home-nav-label">{p.zh ? '模特试衣库' : 'Virtual try-on'}</span></button>
        <button type="button" className="home-nav-item" disabled title={p.zh ? '数字人 · 尚未开放' : 'Digital humans · Coming soon'}><Video size={16} /><span className="home-nav-label">{p.zh ? '数字人' : 'Digital humans'}</span></button>
      </div>}
    </nav>
    <div className="home-sidebar-bottom">
      {p.admin && <button type="button" className="home-nav-item" title={p.zh ? '管理后台' : 'Administration'} onClick={p.onAdmin}><ShieldCheck size={18} /><span className="home-nav-label">{p.zh ? '管理后台' : 'Administration'}</span></button>}
      <button type="button" className="home-nav-item home-bottom-item" title="CLI & Skill" onClick={p.onCli}><Terminal size={19} /><span className="home-nav-label">CLI & Skill</span></button>
      <button type="button" className="home-nav-item home-bottom-item" title={p.zh ? '我的账户' : 'My account'} onClick={p.onAccount}><CircleUserRound size={19} /><span className="home-nav-label">{p.zh ? '我的账户' : 'My account'}</span><ChevronRight className="home-nav-label home-nav-chevron" size={15} /></button>
      <button type="button" className="home-nav-item home-bottom-item home-help" title={p.zh ? '使用帮助' : 'Help'} onClick={p.onHelp}><MessageCircle size={18} /><span className="home-nav-label">{p.zh ? '使用帮助' : 'Help & guide'}</span></button>
    </div>
  </aside>;
}
