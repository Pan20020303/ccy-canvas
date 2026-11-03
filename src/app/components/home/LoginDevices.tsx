import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Laptop, Monitor, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { listLoginDevices, revokeLoginDevice, type LoginDevice, type LoginDevicesResponse } from '../../api/devices';

function deviceDescription(agent: string, zh: boolean) {
  const os = /Windows/i.test(agent) ? 'Windows'
    : /Macintosh|Mac OS X/i.test(agent) ? 'macOS'
      : /iPhone|iPad/i.test(agent) ? 'iPhone / iPad'
        : /Android/i.test(agent) ? 'Android'
          : /Linux/i.test(agent) ? 'Linux' : (zh ? '未知设备' : 'Unknown device');
  const browser = /Edg\//i.test(agent) ? 'Edge'
    : /Firefox\//i.test(agent) ? 'Firefox'
      : /Chrome\//i.test(agent) ? 'Chrome'
        : /Safari\//i.test(agent) ? 'Safari' : (zh ? '浏览器' : 'Browser');
  return `${os} · ${browser}`;
}

function DeviceIcon({ agent }: { agent: string }) {
  if (/iPhone|iPad|Android|Mobile/i.test(agent)) return <Smartphone size={21} />;
  if (/Windows|Macintosh|Linux/i.test(agent)) return <Laptop size={21} />;
  return <Monitor size={21} />;
}

export function LoginDevices({ zh }: { zh: boolean }) {
  const [data, setData] = useState<LoginDevicesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await listLoginDevices()); }
    catch { setError(zh ? '设备列表加载失败，请重试。' : 'Could not load devices. Please retry.'); }
    finally { setLoading(false); }
  }, [zh]);
  useEffect(() => { void load(); }, [load]);

  const choose = (device: LoginDevice) => {
    if (device.current) return;
    setSelected(device.id === selected ? null : device.id);
    setPassword(''); setActionError('');
  };
  const revoke = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !password || working) return;
    setWorking(true); setActionError('');
    try {
      await revokeLoginDevice(selected, password);
      setSelected(null); setPassword('');
      toast.success(zh ? '该设备已退出登录。' : 'Device signed out.');
      await load();
    } catch {
      setActionError(zh ? '未能踢下线。请检查密码，或稍后重试。' : 'Could not sign out this device. Check your password and retry.');
    } finally { setWorking(false); }
  };
  const devices = [...(data?.devices ?? [])].sort((a, b) => Number(b.current) - Number(a.current));
  const date = (value: string) => new Date(value).toLocaleString(zh ? 'zh-CN' : 'en-US');

  return <section className="account-card account-devices">
    <div className="account-devices-heading"><div><h3>{zh ? '已登录的设备' : 'Signed-in devices'}</h3><p>{zh ? '管理当前账户的登录会话。踢出后，对方下次请求会要求重新登录。' : 'Manage active sessions. A removed device must sign in again on its next request.'}</p></div><button type="button" className="home-button" onClick={() => void load()} disabled={loading} aria-label={zh ? '刷新设备列表' : 'Refresh devices'}><RefreshCw size={14} />{zh ? '刷新' : 'Refresh'}</button></div>
    {loading ? <p className="home-empty" role="status">{zh ? '正在加载设备…' : 'Loading devices…'}</p> : error ? <div className="home-inline-status" role="alert">{error}<button type="button" onClick={() => void load()}>{zh ? '重试' : 'Retry'}</button></div> : <>
      <div className="account-device-list">{devices.map(device => <article className="account-device" key={device.id}>
        <div className="account-device-icon"><DeviceIcon agent={device.user_agent} /></div>
        <div className="account-device-body"><div className="account-device-title"><strong>{deviceDescription(device.user_agent, zh)}</strong>{device.current && <span className="account-device-current"><ShieldCheck size={13} />{zh ? '当前设备' : 'This device'}</span>}</div><p>{zh ? '最近活动' : 'Last active'}：{date(device.last_seen_at)} · {zh ? '登录于' : 'Signed in'}：{date(device.created_at)}</p>{device.ip_address && <p>IP：{device.ip_address}</p>}
          {selected === device.id && <form className="account-device-revoke" onSubmit={event => void revoke(event)}><label htmlFor={`device-password-${device.id}`}>{zh ? '输入当前账户密码以踢出这台设备' : 'Enter your account password to sign out this device'}</label><div><input id={`device-password-${device.id}`} type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} maxLength={1024} required disabled={working} /><button type="submit" className="home-button" disabled={working || !password}>{working ? (zh ? '处理中…' : 'Working…') : (zh ? '确认踢下线' : 'Confirm sign-out')}</button><button type="button" className="home-button" onClick={() => { setSelected(null); setPassword(''); setActionError(''); }} disabled={working}>{zh ? '取消' : 'Cancel'}</button></div>{actionError && <p className="account-device-error" role="alert">{actionError}</p>}</form>}
        </div>
        {!device.current && <button type="button" className="home-button account-device-action" onClick={() => choose(device)} disabled={!data?.password_available || working}>{zh ? '踢下线' : 'Sign out'}</button>}
      </article>)}</div>
      {devices.length === 0 && <p className="home-empty">{zh ? '暂无可显示的登录设备。' : 'No devices to show.'}</p>}
      {!data?.password_available && <p className="account-device-note">{zh ? '此账户没有本地密码，暂不能使用密码踢下线。' : 'This account has no local password, so password-confirmed sign-out is unavailable.'}</p>}
      <p className="account-device-note">{zh ? '功能上线前的旧登录可能尚未出现在列表里；你踢出任意设备时，未升级的旧登录也会一并失效。' : 'Older sessions may not appear until they are upgraded. Removing a device also invalidates any untracked older sessions.'}</p>
    </>}
  </section>;
}
