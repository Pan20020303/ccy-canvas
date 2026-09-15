import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Activity, BarChart3, Bell, BookOpen, Box, Check, Copy, Gift, GraduationCap, Heart, LogOut, Mail, Monitor, Pencil, ReceiptText, RefreshCw, Settings2, ShieldCheck, Sparkles, Star, Terminal, Ticket, UserRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../auth/AuthProvider';
import { useStore } from '../../store';
import { listMyCreditLedger, type CreditLedgerEntry } from '../../api/credits';
import { listAnnouncements, type Announcement } from '../../api/announcements';
import { isCreditDebit, presentCreditReason } from '../../credit-ledger-display';
import { UserAvatar } from '../UserAvatar';

export type AccountTab = 'profile' | 'ledger' | 'usage' | 'messages' | 'settings' | 'cli' | 'help';
type Props = { tab: AccountTab | null; onTab: (tab: AccountTab | null) => void; onEditProfile: () => void; onProjects: () => void; onLogout: () => Promise<void>; onAdmin: () => void };
const labels = { profile: ['个人信息', 'Profile'], ledger: ['积分账单', 'Credit ledger'], usage: ['用量统计', 'Usage'], messages: ['站内消息', 'Messages'], settings: ['体验设置', 'Preferences'], cli: ['CLI & Skill', 'CLI & Skill'], help: ['使用帮助', 'Help & guide'] };
const ledgerLabels: Record<string, string[]> = { daily_reset: ['每日重置', 'Daily reset'], reserve: ['生成扣费', 'Generation'], charge: ['扣费', 'Charge'], refund: ['退款', 'Refund'], admin_adjustment: ['管理员调整', 'Admin adjustment'], project_transfer_out: ['项目划转', 'Project transfer'], project_refund_in: ['项目退款', 'Project refund'] };

export function AccountCenter(p: Props) {
  const { user, creditSummary, refreshCredits } = useAuth();
  const language = useStore(s => s.language);
  const theme = useStore(s => s.theme);
  const toggleLanguage = useStore(s => s.toggleLanguage);
  const toggleTheme = useStore(s => s.toggleTheme);
  const zh = language === 'zh';
  const [entries, setEntries] = useState<CreditLedgerEntry[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setPage(0); setError(''); setCopied(false); }, [p.tab]);
  useEffect(() => {
    if (!p.tab || !user) return;
    void refreshCredits();
  }, [p.tab, user?.id, refreshCredits]);
  useEffect(() => {
    if (p.tab !== 'ledger' && p.tab !== 'messages') return;
    let ignore = false;
    setLoading(true); setError('');
    if (p.tab === 'ledger') {
      listMyCreditLedger(30, page * 30).then(data => { if (!ignore) { setEntries(data); setHasMore(data.length === 30); } }).catch(() => { if (!ignore) setError(zh ? '账单加载失败，请重试。' : 'Could not load your ledger.'); }).finally(() => { if (!ignore) setLoading(false); });
    } else {
      listAnnouncements().then(data => { if (!ignore) setAnnouncements(data); }).catch(() => { if (!ignore) setError(zh ? '消息加载失败，请重试。' : 'Could not load messages.'); }).finally(() => { if (!ignore) setLoading(false); });
    }
    return () => { ignore = true; };
  }, [p.tab, page, retry, zh]);
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { toast.error(zh ? '复制失败，请手动选择并复制。' : 'Copy failed. Please copy manually.'); } };
  const nav = (key: AccountTab, Icon: typeof UserRound) => <button type="button" className={`account-nav-item ${p.tab === key ? 'is-active' : ''}`} aria-current={p.tab === key ? 'page' : undefined} onClick={() => p.onTab(key)}><Icon size={16} />{labels[key][zh ? 0 : 1]}</button>;
  const soon = (title: string, en: string, Icon: typeof UserRound) => <button type="button" className="account-nav-item" disabled title={zh ? '尚未开放' : 'Not available yet'}><Icon size={16} />{zh ? title : en}</button>;
  return <Dialog.Root open={p.tab !== null} onOpenChange={open => { if (!open && !loggingOut) p.onTab(null); }}><Dialog.Portal><Dialog.Overlay className="home-dialog-overlay" /><Dialog.Content className="account-center" data-theme={theme} aria-describedby="account-description">
    <Dialog.Description id="account-description" className="sr-only">{zh ? '管理个人资料、积分账单和账户设置。' : 'Manage your profile, credits and preferences.'}</Dialog.Description>
    <aside className="account-sidebar"><h2 className="account-heading">{zh ? '账户中心' : 'Account center'}</h2><nav className="account-nav">
      <small>{zh ? '我的' : 'MY ACCOUNT'}</small>{nav('profile', UserRound)}{nav('ledger', Activity)}{nav('usage', BarChart3)}{soon('赚取积分', 'Earn credits', Gift)}
      <small>{zh ? '权益' : 'BENEFITS'}</small>{soon('社群课程', 'Courses', GraduationCap)}{soon('礼品卡', 'Gift cards', Gift)}{soon('优惠券', 'Vouchers', Ticket)}{soon('宝箱', 'Rewards', Box)}
      <small>{zh ? '作品' : 'WORKS'}</small><button type="button" className="account-nav-item" onClick={p.onProjects}><Star size={16} />{zh ? '我的作品' : 'My canvases'}</button>{soon('我的点赞', 'My likes', Heart)}
      <small>{zh ? '账户' : 'ACCOUNT'}</small>{nav('messages', Bell)}{soon('发票管理', 'Invoices', ReceiptText)}{soon('登录设备', 'Devices', Monitor)}{nav('settings', Settings2)}{nav('cli', Terminal)}{nav('help', BookOpen)}
      {user?.role === 'admin' && <button type="button" className="account-nav-item" onClick={p.onAdmin}><ShieldCheck size={16} />{zh ? '管理后台' : 'Administration'}</button>}
    </nav><button type="button" className="account-logout" disabled={loggingOut} onClick={async () => { setLoggingOut(true); try { await p.onLogout(); } catch { toast.error(zh ? '退出失败，请重试。' : 'Could not sign out.'); } finally { setLoggingOut(false); } }}><LogOut size={16} />{zh ? (loggingOut ? '退出中…' : '退出账号') : 'Sign out'}</button></aside>
    <main className="account-main"><Dialog.Title className="account-title">{p.tab ? labels[p.tab][zh ? 0 : 1] : ''}</Dialog.Title><Dialog.Close className="home-dialog-close" disabled={loggingOut} aria-label={zh ? '关闭账户中心' : 'Close account center'}><X size={19} /></Dialog.Close>
      <div className="account-content">
        {p.tab === 'profile' && <>
          <section className="account-card account-profile"><UserAvatar avatar={user?.avatar} name={user?.name || 'CCY'} className="account-avatar" fallbackClassName="account-avatar-fallback" /><div className="account-identity"><div className="account-name"><h3>{user?.name || (zh ? '创作者' : 'Creator')}</h3><button type="button" onClick={p.onEditProfile} aria-label={zh ? '编辑个人资料' : 'Edit profile'}><Pencil size={14} /></button></div><div className="account-identifiers"><span><Mail size={12} />{user?.email}</span><button type="button" className="account-uid" onClick={() => user && void copy(user.id)} title={user?.id}><span>UID: {user?.id}</span>{copied ? <Check size={12} /> : <Copy size={12} />}</button></div></div></section>
          <section className="account-card account-balance"><div className="account-balance-head"><div><Sparkles size={22} /><strong>{creditSummary?.current_balance?.toLocaleString() ?? '—'}</strong><span>{zh ? '可用总积分' : 'Available credits'}</span></div><button type="button" className="home-button" onClick={() => p.onTab('ledger')}>{zh ? '查看账单' : 'View ledger'}</button><button type="button" className="home-button" disabled title={zh ? '尚未接入充值服务' : 'Top-ups are not available'}>{zh ? '充值 · 未开放' : 'Top-up · Soon'}</button></div><div className="account-balance-details"><div><strong>{creditSummary?.daily_quota?.toLocaleString() ?? '—'}</strong><span>{zh ? '每日积分额度' : 'Daily allowance'}</span></div><div><strong>{creditSummary?.consumed_today?.toLocaleString() ?? '—'}</strong><span>{zh ? '今日已消耗' : 'Used today'}</span></div></div></section>
          <section className="account-card"><div className="account-membership-heading">{zh ? '账户权益' : 'Account access'}<span>{user?.role === 'admin' ? 'ADMIN' : 'MEMBER'}</span></div><div className="account-membership"><p>{zh ? '当前使用每日积分额度，会员订阅服务尚未开放。' : 'Daily credit allowance is active. Subscriptions are not available yet.'}</p><button type="button" className="home-button" disabled>{zh ? '升级会员' : 'Upgrade'}</button></div></section>
        </>}
        {p.tab === 'usage' && <section className="account-card"><h3>{zh ? '今日用量' : 'Today’s usage'}</h3><div className="account-usage-number">{creditSummary?.consumed_today?.toLocaleString() ?? '—'}<span>{zh ? '积分' : 'credits'}</span></div><p className="home-muted">{zh ? `每日额度 ${creditSummary?.daily_quota?.toLocaleString() ?? '—'} · 当前余额 ${creditSummary?.current_balance?.toLocaleString() ?? '—'}` : `Daily allowance ${creditSummary?.daily_quota ?? '—'} · Balance ${creditSummary?.current_balance ?? '—'}`}</p><p className="home-muted">{zh ? '统计来自当前账户实时积分汇总，历史变动可在积分账单查看。' : 'Based on the live account summary. View the ledger for historical changes.'}</p><button type="button" className="home-button" onClick={() => p.onTab('ledger')}>{zh ? '查看积分账单' : 'View credit ledger'}</button></section>}
        {(p.tab === 'ledger' || p.tab === 'messages') && <>
          {loading ? <p className="home-empty" role="status">{zh ? '加载中…' : 'Loading…'}</p> : error ? <div className="home-inline-status" role="alert">{error}<button type="button" onClick={() => setRetry(v => v + 1)}><RefreshCw size={14} />{zh ? '重试' : 'Retry'}</button></div> : p.tab === 'ledger' ? <section className="account-card account-ledger">
            <div className="account-table-scroll"><table><thead><tr><th>{zh ? '时间' : 'Time'}</th><th>{zh ? '类型' : 'Type'}</th><th>{zh ? '变动' : 'Change'}</th><th>{zh ? '余额' : 'Balance'}</th><th>{zh ? '说明' : 'Description'}</th></tr></thead><tbody>{entries.map(entry => <tr key={entry.id}><td>{new Date(entry.created_at).toLocaleString(zh ? 'zh-CN' : 'en-US')}</td><td>{ledgerLabels[entry.type]?.[zh ? 0 : 1] ?? entry.type}</td><td className={isCreditDebit(entry) ? '' : 'account-credit-positive'}>{isCreditDebit(entry) ? '−' : '+'}{Math.abs(entry.amount)}</td><td>{entry.balance_after.toLocaleString()}</td><td>{presentCreditReason(entry, language).summary}</td></tr>)}</tbody></table></div>{entries.length === 0 && <p className="home-empty">{zh ? '暂无积分记录' : 'No credit entries yet.'}</p>}
            <div className="account-pagination"><button type="button" className="home-button" disabled={page === 0} onClick={() => setPage(v => v - 1)}>{zh ? '上一页' : 'Previous'}</button><span>{page + 1}</span><button type="button" className="home-button" disabled={!hasMore} onClick={() => setPage(v => v + 1)}>{zh ? '下一页' : 'Next'}</button></div>
          </section> : <div className="account-announcements">{announcements.map(item => <article className="account-card" key={item.id}><h3>{item.title}</h3><time>{new Date(item.created_at).toLocaleDateString()}</time><p className="account-announcement-text">{item.content}</p></article>)}{announcements.length === 0 && <p className="home-empty">{zh ? '暂无新公告' : 'No announcements yet.'}</p>}</div>}
        </>}
        {p.tab === 'settings' && <section className="account-card"><div className="account-setting"><div><h3>{zh ? '界面语言' : 'Language'}</h3><p>{zh ? '切换中英文界面' : 'Switch interface language'}</p></div><button type="button" className="home-button" onClick={toggleLanguage}>{zh ? '简体中文 → English' : 'English → 简体中文'}</button></div><div className="account-setting"><div><h3>{zh ? '外观主题' : 'Appearance'}</h3><p>{zh ? '跟随你的创作习惯' : 'Choose your preferred appearance'}</p></div><button type="button" className="home-button" onClick={toggleTheme}>{theme === 'dark' ? (zh ? '深色 → 浅色' : 'Dark → Light') : (zh ? '浅色 → 深色' : 'Light → Dark')}</button></div><p className="home-muted">{zh ? '轮播会自动尊重系统的“减少动态效果”设置。' : 'Carousels respect your system’s reduced-motion preference.'}</p></section>}
        {p.tab === 'cli' && <section className="account-card account-guide"><Terminal size={28} /><h3>CCY CLI & Skill</h3><p>{zh ? '通过命令行连接本地服务，管理项目并调用生成能力。先在项目目录构建客户端，再使用自己的账户登录。' : 'Build the CLI from the repository, then sign in with your own account to manage projects and generation.'}</p><pre><code>{'cd backend\ngo build -o ../bin/ccy ./cmd/ccy\nccy login -e you@example.com\nccy projects list\nccy providers -s image'}</code></pre><p className="home-muted">{zh ? '服务使用非默认端口时，通过 --base-url 指定实际后端地址。生成任务会按账户规则消耗积分。完整说明见项目 backend/cmd/ccy/README.md。' : 'For a custom backend port, pass --base-url. Generation consumes credits. See backend/cmd/ccy/README.md for full instructions.'}</p></section>}
        {p.tab === 'help' && <section className="account-card account-guide"><BookOpen size={28} /><h3>{zh ? '从一个灵感开始' : 'Start with an idea'}</h3><ol><li>{zh ? '新建画布：直接进入无限画布，自由编排创作节点。' : 'Create a canvas and freely arrange your creative nodes.'}</li><li>{zh ? '首页创意框：输入想法后创建画布，内容会保存为文本节点；不会自动发起付费生成。' : 'The home idea box saves your idea as a text node, without starting paid generation.'}</li><li>{zh ? '作品广场：预览创作灵感，或使用已发布模板创建自己的副本。' : 'Preview inspiration or create a copy of a published template.'}</li><li>{zh ? '无限画布：管理封面、文件夹，查找个人和协作项目。' : 'Manage covers, folders, personal and collaborative canvases.'}</li></ol><p className="home-muted">{zh ? '会员、社群课程、充值、发票与登录设备等灰色入口尚未开放。' : 'Disabled entries, including memberships, top-ups and devices, are not available yet.'}</p></section>}
      </div>
    </main>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
