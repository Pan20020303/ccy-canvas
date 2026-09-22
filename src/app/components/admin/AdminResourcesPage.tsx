import { useEffect, useRef, useState } from 'react';
import { Cpu, MemoryStick, HardDrive, RefreshCw } from 'lucide-react';
import { getServerResources, type ServerResources } from '../../api/adminSystem';
import { AdminShell } from './AdminShell';

export function formatBytes(value: number) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = Math.max(0, value), i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}
export function AdminResourcesPage() {
  const [data, setData] = useState<ServerResources | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    let alive = true, running = false;
    const id = ++sequence.current;
    const load = async () => {
      if (running) return; running = true; setLoading(true);
      try { const next = await getServerResources(); if (alive && sequence.current === id) { setData(next); setError(''); } }
      catch (e) { if (alive && sequence.current === id) setError(e instanceof Error ? e.message : '无法读取服务器资源'); }
      finally { running = false; if (alive && sequence.current === id) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(() => { if (auto && !document.hidden) void load(); }, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [auto, refresh]);
  const cards = [
    { label: 'CPU 使用率', percent: data?.cpu_percent, icon: Cpu, detail: data ? `${data.cpu_cores} 个逻辑核心 · 200ms 采样` : '等待采样' },
    { label: '系统内存', percent: data?.memory?.percent, icon: MemoryStick, detail: data?.memory ? `已用 ${formatBytes(data.memory.used)} / 总计 ${formatBytes(data.memory.total)} · 可用 ${formatBytes(data.memory.available)}` : '暂无可用数据' },
    { label: '媒体目录所在磁盘', percent: data?.disk?.percent, icon: HardDrive, detail: data?.disk ? `已用 ${formatBytes(data.disk.used)} / 总计 ${formatBytes(data.disk.total)} · 可用 ${formatBytes(data.disk.available)}` : '暂无可用数据' },
  ];
  return <AdminShell title="服务器资源" description="查看当前后端实例的资源状态。每 10 秒刷新，后台页面隐藏时暂停自动刷新。" action={<><label className="admin-help"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 自动刷新</label><button className="admin-button" disabled={loading} onClick={() => setRefresh((v) => v + 1)}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />{loading ? '采集中…' : '刷新统计'}</button></>}>
    {error && <div className="admin-notice error" role="alert">{error}{data ? '；下方保留上次采样，不代表当前状态。' : '；请确认新版后端已启动。'}</div>}
    <p className="admin-help" style={{ marginBottom: 16 }} role="status">{data ? `实例 ${data.hostname} · ${data.os} / ${data.arch} · 最近采样 ${new Date(data.sampled_at).toLocaleString('zh-CN')}${error ? '（已过期）' : ''}` : loading ? '正在采集服务器数据…' : '尚未获取服务器数据'}</p>
    <div className="admin-summary-grid">{cards.map(({ label, percent, icon: Icon, detail }) => <div className="admin-summary-card admin-resource-card" key={label}><span><Icon size={18} />{label}</span><strong>{percent == null ? '—' : `${percent.toFixed(1)}%`}</strong><div className={`admin-meter ${(percent ?? 0) >= 90 ? 'is-high' : ''}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={percent == null ? '不可用' : undefined}><span style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }} /></div><p className="admin-help">{detail}</p></div>)}</div>
    {data?.warnings.map((warning) => <div key={warning} className="admin-notice warning">{warning}</div>)}
    {data && <div className="admin-storage-layout"><section className="admin-panel"><h2>应用进程 · Go 运行时</h2><p className="admin-help">以下是后端应用自身的统计，不是整个服务器的内存占用。</p><dl className="admin-definition" style={{ marginTop: 24 }}>{[
      ['已运行', `${Math.floor(data.uptime_seconds / 3600)} 小时 ${Math.floor(data.uptime_seconds % 3600 / 60)} 分钟`], ['堆内存使用', formatBytes(data.heap_bytes)], ['堆内存保留', formatBytes(data.heap_reserved_bytes)], ['运行时申请内存', formatBytes(data.runtime_bytes)], ['Goroutines', String(data.goroutines)], ['GC 次数', String(data.gc_count)], ['运行时版本', data.go_version],
    ].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl></section><aside className="admin-panel"><h2>采集范围</h2><p className="admin-help">系统指标来自后端所在操作系统的可见资源；容器部署时可能显示宿主机资源，并不等同于容器配额。多实例部署时，当前采样只代表响应本次请求的实例。</p><dl className="admin-definition" style={{ marginTop: 24 }}><div><dt>磁盘采样路径</dt><dd>{data.disk_path || '不可用'}</dd></div></dl><div className="admin-notice">此页只读，不会主动清理磁盘、执行 GC 或中断生成任务。磁盘容量不包含 OSS / COS 云端空间。</div></aside></div>}
  </AdminShell>;
}
