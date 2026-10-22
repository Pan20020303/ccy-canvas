import { Loader2, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";

type DestructiveConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  busyLabel?: string;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

export function DestructiveConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  busyLabel = "删除中…",
  busy = false,
  onOpenChange,
  onConfirm,
}: DestructiveConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => {
      if (!busy) onOpenChange(nextOpen);
    }}>
      <AlertDialogContent
        data-testid="destructive-confirm-dialog"
        className="max-w-[420px] gap-0 overflow-hidden rounded-2xl border-white/[0.10] bg-[#17181d] p-0 text-neutral-100 shadow-[0_28px_90px_rgba(0,0,0,0.65)]"
      >
        <div className="px-5 pb-5 pt-5">
          <AlertDialogHeader className="flex-row items-start gap-3 text-left">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-rose-400/20 bg-rose-500/10 text-rose-300">
              <Trash2 className="h-4.5 w-4.5" />
            </span>
            <div className="min-w-0 pt-0.5">
              <AlertDialogTitle className="text-[15px] font-semibold text-neutral-100">{title}</AlertDialogTitle>
              <AlertDialogDescription className="mt-2 text-[12.5px] leading-5 text-neutral-400">
                {description}
              </AlertDialogDescription>
            </div>
          </AlertDialogHeader>
        </div>
        <AlertDialogFooter className="flex-row justify-end gap-2 border-t border-white/[0.07] bg-white/[0.018] px-5 py-4">
          <AlertDialogCancel
            disabled={busy}
            className="h-9 rounded-lg border-white/[0.10] bg-white/[0.035] px-4 text-xs text-neutral-300 hover:bg-white/[0.07] hover:text-white disabled:opacity-50"
          >
            {cancelLabel}
          </AlertDialogCancel>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="inline-flex h-9 items-center justify-center rounded-lg border border-rose-400/25 bg-rose-500/20 px-4 text-xs font-medium text-rose-100 transition hover:bg-rose-500/30 disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
            {busy ? busyLabel : confirmLabel}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
