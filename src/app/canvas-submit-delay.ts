import { toast } from 'sonner';

const pending = new Map<string, () => void>();
export function cancelCanvasSubmissions() { for (const cancel of [...pending.values()]) cancel(); }
/** A local, cancellable grace period, before any provider/API request is issued. */
export function waitForCanvasSubmit(key: string, seconds: number): Promise<boolean> {
  pending.get(key)?.();
  if (seconds <= 0) return Promise.resolve(true);
  return new Promise(resolve => {
    let remaining = seconds;
    const toastId = `canvas-delay-${key}`;
    const finish = (submitted: boolean) => { clearInterval(timer); if (pending.get(key) === cancel) pending.delete(key); toast.dismiss(toastId); resolve(submitted); };
    const cancel = () => finish(false);
    const show = () => toast(`将在 ${remaining} 秒后提交生成`, { id: toastId, duration: Infinity, description: '尚未调用模型，可取消本次提交。', action: { label: '取消提交', onClick: cancel } });
    const timer = setInterval(() => { remaining--; if (remaining <= 0) finish(true); else show(); }, 1000);
    pending.set(key, cancel); show();
  });
}
