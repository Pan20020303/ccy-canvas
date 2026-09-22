import { useEffect, useRef, useState } from 'react';
import { Database, HardDrive, Cloud, RefreshCw, ShieldCheck } from 'lucide-react';
import { getStorageSettings, saveStorageSettings, type StorageBackend, type StorageSettings, type CloudStorageInput, type CloudStorage } from '../../api/adminSystem';
import { AdminShell } from './AdminShell';
import { AdminActionDialog } from './AdminActionDialog';

const providers = [{ key: 'local', name: '本地磁盘', note: '服务器上传目录', icon: HardDrive }, { key: 'oss', name: '阿里云 OSS', note: '适合公网媒体访问', icon: Cloud }, { key: 'cos', name: '腾讯云 COS', note: '兼容现有 COS 素材', icon: Cloud }] as const;
const label = (key: StorageBackend) => providers.find((p) => p.key === key)?.name || key;
const editable = (c: CloudStorage): CloudStorageInput => ({ bucket: c.bucket, region: c.region, endpoint: c.endpoint, public_base_url: c.public_base_url, key_prefix: c.key_prefix, access_key_id: '', access_key_secret: '' });
const message = (e: unknown) => e instanceof Error ? e.message : '请求失败，请稍后重试';

function StorageEditor({ initial, onReload }: { initial: StorageSettings; onReload: () => void }) {
  const [saved, setSaved] = useState(initial);
  const [backend, setBackend] = useState(initial.backend);
  const [drafts, setDrafts] = useState({ oss: editable(initial.oss), cos: editable(initial.cos) });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const cloud = backend === 'local' ? null : drafts[backend];
  const storedCloud = backend === 'local' ? null : saved[backend];
  const dirty = backend !== saved.backend || (cloud !== null && JSON.stringify(cloud) !== JSON.stringify(editable(saved[backend as 'oss' | 'cos'])));
  const valid = backend === 'local' || Boolean(cloud?.bucket.trim() && cloud.region.trim() && (cloud.access_key_id.trim() || storedCloud?.has_access_key_id) && (cloud.access_key_secret.trim() || storedCloud?.has_access_key_secret));
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const change = (key: keyof CloudStorageInput, value: string) => {
    if (backend === 'local') return;
    setDrafts((current) => ({ ...current, [backend]: { ...current[backend], [key]: value } })); setSuccess(''); setError('');
  };
  const save = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const next = await saveStorageSettings({ backend, revision: saved.revision, ...(cloud ? { cloud } : {}) });
      setSaved(next); setDrafts({ oss: editable(next.oss), cos: editable(next.cos) }); setConfirm(false);
      setSuccess('配置已加密保存。当前服务已切换，其他服务实例将在约 5 秒内同步；未迁移或删除旧文件。');
    } catch (e) { setError(message(e)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const fields: { key: keyof CloudStorageInput; title: string; placeholder: string; secret?: boolean }[] = [
    { key: 'bucket', title: 'Bucket 存储桶', placeholder: '例如 ccy-media' },
    { key: 'region', title: 'Region 地域', placeholder: backend === 'oss' ? '例如 cn-hangzhou（不含 oss-）' : '例如 ap-guangzhou' },
    { key: 'access_key_id', title: backend === 'cos' ? 'Secret ID' : 'AccessKey ID', placeholder: storedCloud?.has_access_key_id ? '已配置，留空保持不变' : '尚未配置，请输入', secret: true },
    { key: 'access_key_secret', title: backend === 'cos' ? 'Secret Key' : 'AccessKey Secret', placeholder: storedCloud?.has_access_key_secret ? '已配置，留空保持不变' : '尚未配置，请输入', secret: true },
    { key: 'endpoint', title: 'Endpoint（可选）', placeholder: backend === 'oss' ? 'https://oss-cn-hangzhou.aliyuncs.com' : 'https://bucket.cos.ap-guangzhou.myqcloud.com' },
    { key: 'public_base_url', title: '媒体访问地址 / CDN（可选）', placeholder: 'https://media.example.com' },
    { key: 'key_prefix', title: '对象目录前缀（可选）', placeholder: '例如 ccy-canvas' },
  ];
  return <>
    {success && <div className="admin-notice success" role="status"><ShieldCheck size={18} />{success}</div>}
    {!confirm && error && <div className="admin-notice error" role="alert">{error}</div>}
    <div className="admin-storage-layout"><section className="admin-panel">
      <h2>上传存储方式</h2><p className="admin-help">选择后不会立即生效。检查配置并确认保存，才会切换后续上传与生成媒体的保存位置。</p>
      <div className="admin-provider-options" role="group" aria-label="存储方式">{providers.map(({ key, name, note, icon: Icon }) => <button key={key} type="button" disabled={busy} aria-pressed={backend === key} onClick={() => { setBackend(key); setError(''); setSuccess(''); }}><Icon size={20} /><strong>{name}</strong><span>{note}</span></button>)}</div>
      <form onSubmit={(e) => { e.preventDefault(); if (valid && dirty) setConfirm(true); }}>
        <fieldset className="admin-form-stack" disabled={busy}>
          {cloud ? <><div className="admin-field-grid">{fields.map((field) => <label key={`${backend}-${field.key}`}>{field.title}<input type={field.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} maxLength={field.key === 'bucket' || field.key === 'region' ? 63 : field.key === 'key_prefix' ? 256 : 512} value={cloud[field.key]} placeholder={field.placeholder} onChange={(e) => change(field.key, e.target.value)} /></label>)}</div><p className="admin-help">Endpoint 留空由地域自动生成；访问地址留空使用存储桶默认域名。密钥不回显，留空保留原值。云存储沿用现有 public-read 写入方式，请确保桶策略允许；不要在此存放保密媒体。</p></> : <><label>本地上传目录（由服务器环境配置）<input readOnly value={saved.local_directory} /></label><div className="admin-notice warning">本地文件依赖当前服务器的磁盘与备份。多实例需共享挂载；第三方模型读取参考图时，还需要可访问的公网地址。</div></>}
        </fieldset>
        <div className="admin-form-actions"><span className="admin-help">{dirty ? '有未保存的更改' : '配置未更改'}</span><button type="button" className="admin-button" disabled={busy} onClick={() => { setBackend(saved.backend); setDrafts({ oss: editable(saved.oss), cos: editable(saved.cos) }); setError(''); setSuccess(''); }}>撤销更改</button><button className="admin-button primary" disabled={!valid || !dirty || busy} type="submit">检查并保存</button></div>
      </form>
    </section><aside className="admin-panel"><h2>当前生效配置</h2><dl className="admin-definition" style={{ marginTop: 24 }}><div><dt>存储方式</dt><dd>{label(saved.backend)}</dd></div><div><dt>配置状态</dt><dd>{saved.configured ? '参数已配置' : '配置不完整'}</dd></div><div><dt>来源</dt><dd>{saved.source === 'database' ? '数据库' : '服务器环境变量'}</dd></div><div><dt>版本</dt><dd>v{saved.revision}</dd></div><div><dt>最后保存</dt><dd>{saved.updated_at ? new Date(saved.updated_at).toLocaleString('zh-CN') : '尚未在后台保存'}</dd></div></dl><div className="admin-notice"><Database size={18} /><p>密钥使用服务器加密密钥加密入库。保存不等于云端连通性测试，实际上传仍受凭证、权限和网络影响。</p></div><p className="admin-help">旧素材地址保持不变，并保留旧存储的读取配置；不会自动搬迁或清理文件。其他管理员修改配置时，本次旧版本保存会被拒绝。</p><button className="admin-button" style={{ marginTop: 20 }} disabled={dirty || busy} onClick={onReload}><RefreshCw size={14} />重新加载</button></aside></div>
    {confirm && <AdminActionDialog title="确认保存媒体存储" description="此设置影响整个平台的新媒体文件，请确认存储桶与访问地址正确。" busy={busy} onClose={() => { setConfirm(false); setError(''); }}><div className="admin-change-preview"><span>{label(saved.backend)}</span><span>→</span><b>{label(backend)}</b></div>{cloud && <dl className="admin-definition" style={{ marginTop: 20 }}><div><dt>存储桶</dt><dd>{cloud.bucket}</dd></div><div><dt>地域</dt><dd>{cloud.region}</dd></div><div><dt>密钥</dt><dd>{cloud.access_key_id || cloud.access_key_secret ? '更新已填写的密钥字段' : '保持原有密钥'}</dd></div></dl>}<div className="admin-notice warning">不会搬迁或删除旧文件。进行中的上传继续使用提交时的存储配置。</div>{error && <div className="admin-notice error" role="alert">{error}</div>}<div className="admin-form-actions"><button className="admin-button" disabled={busy} onClick={() => setConfirm(false)}>取消</button><button className="admin-button primary" disabled={busy} onClick={() => void save()}>{busy ? '正在保存…' : '确认保存并生效'}</button></div></AdminActionDialog>}
  </>;
}

export function AdminStoragePage() {
  const [settings, setSettings] = useState<StorageSettings | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadKey, setLoadKey] = useState(0);
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    getStorageSettings().then((data) => { if (alive) setSettings(data); }).catch((e) => { if (alive) setError(message(e)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [loadKey]);
  return <AdminShell title="媒体存储" description="管理全平台媒体保存位置与云存储配置。密钥安全保存，历史素材保持不变。">
    {loading ? <div className="admin-panel admin-empty">正在读取存储配置…</div> : error ? <div className="admin-notice error" role="alert">{error}<button className="admin-button" onClick={() => setLoadKey((k) => k + 1)}>重试</button></div> : settings && <StorageEditor key={loadKey} initial={settings} onReload={() => setLoadKey((k) => k + 1)} />}
  </AdminShell>;
}
