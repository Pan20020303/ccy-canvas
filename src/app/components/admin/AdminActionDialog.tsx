import { useRef, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

export function AdminActionDialog({ title, description, busy = false, onClose, children }: {
  title: string; description: string; busy?: boolean; onClose: () => void; children: ReactNode;
}) {
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="admin-dialog-overlay" />
      <Dialog.Content className="admin-action-dialog" aria-busy={busy}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => { if (busy) e.preventDefault(); }}
        onCloseAutoFocus={(e) => { e.preventDefault(); previousFocus.current?.focus(); }}>
        <Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description>
        <button type="button" className="admin-dialog-close" aria-label="关闭对话框" onClick={onClose} disabled={busy}><X size={18} /></button>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
