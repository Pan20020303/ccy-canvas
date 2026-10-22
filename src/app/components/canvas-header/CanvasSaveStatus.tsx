import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudOff, Loader2 } from 'lucide-react';
import { useStore } from '../../store';

export function CanvasSaveStatus() {
  const status = useStore(s => s.canvasSaveStatus);
  const hydrated = useStore(s => s.canvasHydrated);
  const projectId = useStore(s => s.activeBackendProjectId);
  const retry = useStore(s => s.retryCanvasSave);
  const [online, setOnline] = useState(typeof navigator === 'undefined' || navigator.onLine);
  useEffect(() => {
    const on = () => { setOnline(true); if (useStore.getState().canvasSaveStatus === 'error') useStore.getState().retryCanvasSave(); };
    const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  const problem = !online || status === 'error';
  const label = !projectId ? '本地画布' : !online ? '离线 · 修改尚未同步' : status === 'error' ? '保存失败，点击重试' : status === 'saving' ? '正在保存画布' : !hydrated ? '正在加载画布' : status === 'saved' ? '所有更改已保存' : '画布已载入';
  const Icon = !online ? CloudOff : status === 'error' ? AlertTriangle : status === 'saving' || (projectId && !hydrated) ? Loader2 : CheckCircle2;
  return <button type="button" className={`canvas-save-status ${problem ? 'is-error' : ''}`} data-testid="save-status" data-status={!online ? 'offline' : status} aria-label={label} title={label} onClick={() => { if (online && status === 'error') retry(); }}>
    <Icon className={Icon === Loader2 ? 'canvas-spin' : ''} size={14} />{problem && <span className="canvas-save-label">{!online ? '离线' : '保存失败'}</span>}
  </button>;
}
