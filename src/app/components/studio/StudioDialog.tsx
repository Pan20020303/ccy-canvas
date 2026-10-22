import { useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

export function StudioDialog({ title, description, onClose, children, wide = false }: { title: string; description: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const [returnFocus] = useState(() => document.activeElement as HTMLElement | null);
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Overlay className="studio-dialog-overlay" />
    <Dialog.Content className={`studio-dialog ${wide ? 'studio-dialog-wide' : ''}`} onCloseAutoFocus={event => { event.preventDefault(); returnFocus?.focus(); }}>
      <header><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div><Dialog.Close asChild><button type="button" className="studio-icon-button" aria-label="关闭弹窗 / Close dialog"><X size={18} /></button></Dialog.Close></header>
      {children}
    </Dialog.Content>
  </Dialog.Root>;
}
