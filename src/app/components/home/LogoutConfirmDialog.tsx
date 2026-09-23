import { useRef, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { CircleAlert, Loader2, X } from 'lucide-react';
import './logout-confirm.css';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
  zh: boolean;
};

export function LogoutConfirmDialog({ open, onOpenChange, onConfirm, zh }: Props) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changeOpen = (next: boolean) => {
    if (pending.current) return;
    setError('');
    onOpenChange(next);
  };
  const confirm = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : (zh ? '退出失败，请重试。' : 'Could not sign out. Please retry.'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return <AlertDialog.Root open={open} onOpenChange={changeOpen}>
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="logout-confirm-overlay" />
      <AlertDialog.Content className="logout-confirm" aria-busy={busy} onEscapeKeyDown={event => { if (pending.current) event.preventDefault(); }}>
        <AlertDialog.Title>{zh ? '登出确认' : 'Sign out'}</AlertDialog.Title>
        <AlertDialog.Cancel className="logout-confirm-close" disabled={busy} aria-label={zh ? '关闭登出确认' : 'Close sign-out confirmation'}><X size={16} /></AlertDialog.Cancel>
        <AlertDialog.Description><CircleAlert size={16} />{zh ? '确定要退出当前账号吗？' : 'Are you sure you want to sign out?'}</AlertDialog.Description>
        {error && <p className="logout-confirm-error" role="alert">{error}</p>}
        <div className="logout-confirm-actions">
          <AlertDialog.Cancel disabled={busy}>{zh ? '取消' : 'Cancel'}</AlertDialog.Cancel>
          <button type="button" className="logout-confirm-submit" disabled={busy} onClick={() => void confirm()}>{busy && <Loader2 size={14} className="animate-spin" />}{zh ? (busy ? '退出中…' : '确定登出') : (busy ? 'Signing out…' : 'Sign out')}</button>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}
