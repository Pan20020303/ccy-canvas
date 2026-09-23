import { useEffect, useRef, useState } from 'react';
import { Download, FolderPlus, RefreshCw, Save, X } from 'lucide-react';
import type { CanvasRecoverySnapshot } from '../canvas-recovery';

export type CanvasRecoveryPanelProps = {
  zh: boolean;
  online: boolean;
  readOnly: boolean;
  activeProject: boolean;
  conflict: boolean;
  saveError: string | null;
  recoveryError: string | null;
  recovery: Pick<CanvasRecoverySnapshot, 'id' | 'projectName' | 'savedAt'> | null;
  onRetry: () => void;
  onSaveBackup: () => Promise<boolean>;
  onDownload: () => boolean;
  onReload: () => Promise<void>;
  onRestore: () => Promise<boolean>;
  onClose: () => void;
};

export function CanvasRecoveryPanel(props: CanvasRecoveryPanelProps) {
  const { zh, online, readOnly, activeProject, conflict, saveError, recoveryError, recovery, onClose } = props;
  const panelRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { panelRef.current?.focus(); }, []);
  const run = async (action: () => boolean | void | Promise<boolean | void>, success?: string, closeOnSuccess = false) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await action();
      if (result === false) {
        setActionError(zh ? '操作未完成，请查看错误详情；本地备份失败时请下载快照。' : 'The operation did not complete. Check the error details; download a snapshot if local backup fails.');
      } else {
        if (success) setNotice(success);
        if (closeOnSuccess && result === true) onClose();
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const savedAt = recovery ? new Date(recovery.savedAt) : null;
  const timestamp = savedAt && Number.isFinite(savedAt.getTime())
    ? savedAt.toLocaleString(zh ? 'zh-CN' : 'en-US') : recovery?.savedAt;
  const button = 'flex w-full items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-left text-xs text-neutral-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div id="canvas-recovery-panel" ref={panelRef} tabIndex={-1} role="dialog" aria-label={zh ? '保存与恢复' : 'Save and recovery'}
      className="absolute right-0 top-full z-50 mt-2 max-h-[75vh] w-[360px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-white/15 bg-[#15181d] p-4 text-xs shadow-2xl outline-none"
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') onClose(); }}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="font-medium text-neutral-100">{zh ? '保存与恢复' : 'Save and recovery'}</span>
        <button type="button" aria-label={zh ? '关闭保存恢复面板' : 'Close recovery panel'} onClick={onClose} className="rounded p-1 text-neutral-400 hover:bg-white/10"><X className="h-4 w-4" /></button>
      </div>
      {!readOnly && conflict ? <p className="mb-2 text-amber-300">{zh ? '服务器已有新版本（409）。当前编辑尚未覆盖服务器，已停止自动重试。' : 'The server has a newer version (409). Your edits have not overwritten it; automatic retries are paused.'}</p> : null}
      {!readOnly && saveError ? <p role="alert" className="mb-3 max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-rose-300">{saveError}</p> : null}
      {recovery ? <div className="mb-3 rounded-lg bg-white/5 p-2.5 text-neutral-300">
        <div className="break-words font-medium">{recovery.projectName || (zh ? '未命名项目' : 'Untitled project')}</div>
        <div className="mt-1 text-neutral-400">{zh ? '本地快照：' : 'Local snapshot: '}{timestamp}</div>
        <p className="mt-1 text-neutral-400">{zh ? '恢复副本会创建新项目，保留服务器原项目。' : 'Recovery creates a new project and preserves the original server project.'}</p>
      </div> : null}
      {recoveryError ? <p role="alert" className="mb-3 whitespace-pre-wrap break-words text-rose-300">{zh ? '本地备份失败：' : 'Local backup failed: '}{recoveryError}<br />{zh ? '请先下载快照，再离开当前页面。' : 'Download a snapshot before leaving this page.'}</p> : null}
      {actionError ? <p role="alert" className="mb-3 whitespace-pre-wrap break-words text-rose-300">{actionError}</p> : null}
      {notice ? <p role="status" className="mb-3 text-emerald-300">{notice}</p> : null}
      <div className="space-y-2" aria-busy={busy}>
        {!readOnly && !conflict && saveError ? <button type="button" disabled={busy || !online} className={button} onClick={() => void run(props.onRetry)}><RefreshCw className="h-3.5 w-3.5" />{zh ? '重试保存' : 'Retry save'}</button> : null}
        {!readOnly && activeProject ? <button type="button" disabled={busy} className={button} onClick={() => void run(props.onSaveBackup, zh ? '本地快照已保存。' : 'Local snapshot saved.')}><Save className="h-3.5 w-3.5" />{zh ? '保存本地备份' : 'Save local backup'}</button> : null}
        <button type="button" disabled={busy} className={button} onClick={() => void run(props.onDownload, zh ? '快照下载已发起。' : 'Snapshot download started.')}><Download className="h-3.5 w-3.5" />{zh ? '下载本地快照' : 'Download local snapshot'}</button>
        {!readOnly && activeProject ? <button type="button" disabled={busy || !online} className={button} onClick={() => void run(props.onReload)}><RefreshCw className="h-3.5 w-3.5" />{zh ? '备份后加载服务器' : 'Back up, then load server'}</button> : null}
        {recovery ? <button type="button" disabled={busy || !online} className={button} onClick={() => void run(props.onRestore, undefined, true)}><FolderPlus className="h-3.5 w-3.5" />{zh ? '恢复为新项目' : 'Recover as new project'}</button> : null}
      </div>
      {!online ? <p className="mt-3 text-amber-300">{zh ? '当前离线，仍可保存本地备份或下载快照。' : 'Offline. You can still back up locally or download a snapshot.'}</p> : null}
    </div>
  );
}
