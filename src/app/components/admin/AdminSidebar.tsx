import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { ArrowLeft, ChevronDown, PanelLeftClose, PanelLeftOpen, ShieldCheck } from 'lucide-react';
import logoUrl from '../../../imports/logo-login.png';
import { ADMIN_GROUPS_KEY, adminNavGroups, adminOverview, getAdminNavGroup, readAdminGroups, type AdminNavItem } from './admin-navigation';

type Props = { collapsed: boolean; mobile: boolean; onToggle: () => void; onClose: () => void };

export function AdminSidebar({ collapsed, mobile, onToggle, onClose }: Props) {
  const { pathname } = useLocation();
  const activeGroup = getAdminNavGroup(pathname);
  const [groups, setGroups] = useState(() => readAdminGroups(activeGroup?.id));
  const sidebarRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (activeGroup) setGroups((current) => ({ ...current, [activeGroup.id]: true }));
  }, [pathname, activeGroup]);
  useEffect(() => {
    try { localStorage.setItem(ADMIN_GROUPS_KEY, JSON.stringify(groups)); } catch { /* Optional preference. */ }
  }, [groups]);
  useEffect(() => {
    if (!mobile || collapsed) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    toggleRef.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; };
  }, [mobile, collapsed]);

  const renderLink = (item: AdminNavItem, child = false) => {
    const Icon = item.icon;
    return <NavLink key={item.to} to={item.to} end title={item.label} onClick={() => { if (mobile) onClose(); }}
      className={({ isActive }) => `admin-nav-item${child ? ' admin-nav-child' : ''}${isActive ? ' is-active' : ''}`}>
      <Icon size={child ? 16 : 19} strokeWidth={1.6} /><span className="admin-nav-label">{item.label}</span>
    </NavLink>;
  };

  return <>
    {mobile && !collapsed && <button type="button" tabIndex={-1} className="admin-nav-backdrop" aria-label="关闭导航遮罩" onClick={onClose} />}
    <aside ref={sidebarRef} id="admin-sidebar" className="admin-sidebar" aria-label="后台导航" onKeyDown={(event) => {
      if (!mobile || collapsed) return;
      if (event.key === 'Escape') { onClose(); toggleRef.current?.focus(); }
      if (event.key !== 'Tab') return;
      const focusable = [...(sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])].filter((element) => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="admin-sidebar-brand">
        <Link to="/home" className="admin-brand" title="橙次元首页"><img src={logoUrl} alt="" /><span className="admin-nav-label">橙次元</span></Link>
        <button ref={toggleRef} type="button" className="admin-collapse" aria-label={collapsed ? '展开后台侧边栏' : '收起后台侧边栏'} aria-controls="admin-sidebar" aria-expanded={!collapsed} onClick={onToggle}>
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>
      <div className="admin-sidebar-caption admin-nav-label">管理后台</div>
      <nav aria-label="后台功能" className="admin-navigation">
        {renderLink(adminOverview)}
        <p className="admin-nav-section-label admin-nav-label">管理功能</p>
        {adminNavGroups.map((group) => {
          const Icon = group.icon;
          const open = !collapsed && groups[group.id];
          return <div className="admin-nav-group" key={group.id}>
            <button type="button" className={`admin-nav-item admin-nav-parent${activeGroup?.id === group.id ? ' has-active-child' : ''}`}
              title={group.label} aria-expanded={Boolean(open)} aria-controls={`admin-group-${group.id}`} onClick={() => {
                if (collapsed) { onToggle(); setGroups((current) => ({ ...current, [group.id]: true })); }
                else setGroups((current) => ({ ...current, [group.id]: !current[group.id] }));
              }}>
              <Icon size={19} strokeWidth={1.6} /><span className="admin-nav-label">{group.label}</span>
              <ChevronDown size={14} className={`admin-nav-label admin-nav-chevron${open ? ' is-open' : ''}`} />
            </button>
            <div id={`admin-group-${group.id}`} className="admin-nav-children" hidden={!open}>{group.items.map((item) => renderLink(item, true))}</div>
          </div>;
        })}
      </nav>
      <div className="admin-sidebar-footer">
        <Link to="/home" className="admin-nav-item admin-return-home" title="返回首页"><ArrowLeft size={18} /><span className="admin-nav-label">返回首页</span></Link>
        <div className="admin-sidebar-identity" title="管理员工作台"><ShieldCheck size={16} /><span className="admin-nav-label">管理员工作台</span></div>
      </div>
    </aside>
  </>;
}
