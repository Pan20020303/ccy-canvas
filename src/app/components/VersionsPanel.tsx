import { useCallback, useEffect, useState } from 'react';
import { History, Loader2, RotateCcw, Save, X } from 'lucide-react';

import { listVersions, restoreVersion, saveVersion, type CanvasVersion } from '../api/versions';

// ─── 版本历史面板 ─────────────────────────────────────────────────────────
// 右侧抽屉:保存当前画布为版本、查看历史、一键回滚(后端先自动备份,故可撤销)。
// 协作误删/写坏画布的安全网。

type Props = {
  open: boolean;
  projectId: string;
  language: 'zh' | 'en';
  onClose: () => void;
  /** 保存版本前先把当前画布刷到后端,确保快照是最新。 */
  onFlushCanvas: () => Promise<void>;
  /** 恢复成功后重载画布(不先保存,避免覆盖刚恢复的快照)。 */
  onReloadCanvas: () => Promise<void>;
};

export function VersionsPanel({ open, projectId, language, onClose, onFlushCanvas, onReloadCanvas }: Props) {
  const zh = language === 'zh';
  const [versions, setVersions] = useState<CanvasVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState('');
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try { setVersions(await listVersions(projectId)); } catch { /* 静默 */ } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setNote('');
    try {
      await onFlushCanvas();           // 先把当前画布刷到后端
      await saveVersion(projectId, label.trim());
      setLabel('');
      setNote(zh ? '已保存当前版本' : 'Version saved');
      await refresh();
    } catch {
      setNote(zh ? '保存失败' : 'Save failed');
    } finally { setSaving(false); }
  };

  const handleRestore = async (id: string) => {
    setRestoringId(id);
    setConfirmId(null);
    setNote('');
    try {
      await restoreVersion(id);
      await onReloadCanvas();          // 重载被恢复的画布
      setNote(zh ? '已恢复(原状态已自动备份)' : 'Restored (previous state auto-backed up)');
      await refresh();
    } catch {
      setNote(zh ? '恢复失败' : 'Restore failed');
    } finally { setRestoringId(null); }
  };

  const fmt = (iso: string) => new Date(iso).toLocaleString(zh ? 'zh-CN' : undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (!open) return null;

  return (
    <div
      className="absolute right-0 top-0 z-[70] flex h-full w-[320px] flex-col border-l border-white/10 bg-[#14161b]/98 shadow-[-16px_0_48px_-24px_rgba(0,0,0,0.8)] backdrop-blur-xl"
      data-testid="versions-panel"
    >
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-neutral-200">
          <History className="h-4 w-4 text-cyan-300" />
          {zh ? '版本历史' : 'Version history'}
        </div>
        <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-white/[0.06]"><X className="h-4 w-4" /></button>
      </div>

      {/* 保存当前版本 */}
      <div className="border-b border-white/[0.06] p-3">
        <div className="flex items-center gap-1.5">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSave(); }}
            maxLength={120}
            placeholder={zh ? '版本备注(可选)' : 'Label (optional)'}
            className="h-8 flex-1 rounded-lg border border-white/10 bg-black/20 px-2.5 text-[12px] text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-cyan-400/40"
          />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            data-testid="save-version"
            className="flex h-8 items-center gap-1 rounded-lg border border-cyan-400/40 bg-cyan-400/12 px-2.5 text-[12px] text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {zh ? '保存版本' : 'Save'}
          </button>
        </div>
        {note ? <div className="mt-1.5 text-[11px] text-cyan-300/80">{note}</div> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="flex h-32 items-center justify-center gap-2 text-[13px] text-neutral-500"><Loader2 className="h-4 w-4 animate-spin" />{zh ? '加载中…' : 'Loading…'}</div>
        ) : versions.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-1 text-[13px] text-neutral-600">
            <History className="h-6 w-6 opacity-40" />
            {zh ? '还没有保存的版本' : 'No versions yet'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {versions.map((v) => (
              <div key={v.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3" data-testid="version-item">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[12.5px] text-neutral-200">{v.label || (zh ? '未命名版本' : 'Untitled')}</span>
                  {confirmId === v.id ? (
                    <div className="ml-auto flex items-center gap-1">
                      <button type="button" onClick={() => void handleRestore(v.id)} className="rounded-md border border-cyan-400/40 bg-cyan-400/12 px-2 py-0.5 text-[11px] text-cyan-200" data-testid="confirm-restore">{zh ? '确认恢复' : 'Confirm'}</button>
                      <button type="button" onClick={() => setConfirmId(null)} className="rounded-md px-1.5 py-0.5 text-[11px] text-neutral-500 hover:text-neutral-300">{zh ? '取消' : 'Cancel'}</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmId(v.id)}
                      disabled={restoringId !== null}
                      data-testid="restore-version"
                      className="ml-auto flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-neutral-400 transition hover:bg-white/[0.06] hover:text-cyan-200 disabled:opacity-40"
                    >
                      {restoringId === v.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                      {zh ? '恢复' : 'Restore'}
                    </button>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-neutral-600">
                  {fmt(v.created_at)}{v.author_name ? ` · ${v.author_name}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
