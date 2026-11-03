import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, CornerDownRight, Crosshair, Loader2, MessageSquare, Send, Trash2, X } from 'lucide-react';

import { createComment, deleteComment, listComments, resolveComment, type Comment } from '../api/comments';

// ─── 评论批注面板 ─────────────────────────────────────────────────────────
// 右侧抽屉:按锚定节点分组的评论线程,支持回复、解决、删除(本人/所有者),
// 点「定位」跳到画布节点。协作审阅闭环。

type Props = {
  open: boolean;
  projectId: string;
  currentUserId: string;
  isOwner: boolean;
  /** 当前选中的节点 id(新评论默认锚定到它;空=项目级)。 */
  selectedNodeId: string;
  selectedNodeLabel?: string;
  language: 'zh' | 'en';
  onClose: () => void;
  onJumpToNode: (nodeId: string) => void;
};

export function CommentsPanel({
  open, projectId, currentUserId, isOwner, selectedNodeId, selectedNodeLabel, language, onClose, onJumpToNode,
}: Props) {
  const zh = language === 'zh';
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; nodeId: string } | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try { setComments(await listComments(projectId)); } catch { /* 静默 */ } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  // 组线程:根评论(parent_id 空)+ 其回复,按节点分组。
  const threads = useMemo(() => {
    const roots = comments.filter((c) => !c.parent_id);
    const repliesByParent = new Map<string, Comment[]>();
    for (const c of comments) {
      if (c.parent_id) {
        const arr = repliesByParent.get(c.parent_id) ?? [];
        arr.push(c);
        repliesByParent.set(c.parent_id, arr);
      }
    }
    const visibleRoots = showResolved ? roots : roots.filter((r) => !r.resolved);
    return visibleRoots.map((r) => ({ root: r, replies: repliesByParent.get(r.id) ?? [] }));
  }, [comments, showResolved]);

  const unresolvedCount = useMemo(() => comments.filter((c) => !c.parent_id && !c.resolved).length, [comments]);

  const submitRoot = async () => {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await createComment(projectId, { node_id: selectedNodeId, body });
      setDraft('');
      await refresh();
    } finally { setBusy(false); }
  };

  const submitReply = async () => {
    const body = replyDraft.trim();
    if (!body || !replyTo || busy) return;
    setBusy(true);
    try {
      await createComment(projectId, { node_id: replyTo.nodeId, body, parent_id: replyTo.id });
      setReplyDraft('');
      setReplyTo(null);
      await refresh();
    } finally { setBusy(false); }
  };

  const toggleResolved = async (c: Comment) => {
    setComments((prev) => prev.map((x) => (x.id === c.id ? { ...x, resolved: !x.resolved } : x)));
    try { await resolveComment(c.id, !c.resolved); } catch { await refresh(); }
  };

  const remove = async (c: Comment) => {
    setComments((prev) => prev.filter((x) => x.id !== c.id && x.parent_id !== c.id));
    try { await deleteComment(c.id); } catch { await refresh(); }
  };

  const canDelete = (c: Comment) => c.author_id === currentUserId || isOwner;
  const fmtTime = (iso: string) => new Date(iso).toLocaleString(zh ? 'zh-CN' : undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (!open) return null;

  return (
    <div
      className="absolute right-0 top-0 z-[70] flex h-full w-[340px] flex-col border-l border-white/10 bg-[#14161b]/98 shadow-[-16px_0_48px_-24px_rgba(0,0,0,0.8)] backdrop-blur-xl"
      data-testid="comments-panel"
    >
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-neutral-200">
          <MessageSquare className="h-4 w-4 text-cyan-300" />
          {zh ? '评论' : 'Comments'}
          {unresolvedCount > 0 ? (
            <span className="rounded-full bg-cyan-400/15 px-1.5 py-0.5 text-[11px] text-cyan-300">{unresolvedCount}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className={`rounded-md px-2 py-1 text-[11px] transition ${showResolved ? 'bg-white/10 text-neutral-200' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            {zh ? '含已解决' : 'Resolved'}
          </button>
          <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-white/[0.06]">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="flex h-32 items-center justify-center gap-2 text-[13px] text-neutral-500"><Loader2 className="h-4 w-4 animate-spin" />{zh ? '加载中…' : 'Loading…'}</div>
        ) : threads.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-1 text-[13px] text-neutral-600">
            <MessageSquare className="h-6 w-6 opacity-40" />
            {zh ? '还没有评论' : 'No comments yet'}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {threads.map(({ root, replies }) => (
              <div key={root.id} className={`rounded-xl border p-3 transition ${root.resolved ? 'border-white/[0.05] bg-white/[0.01] opacity-70' : 'border-white/10 bg-white/[0.02]'}`} data-testid="comment-thread">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-neutral-200">{root.author_name}</span>
                  <span className="text-[11px] text-neutral-600">{fmtTime(root.created_at)}</span>
                  {root.node_id ? (
                    <button
                      type="button"
                      onClick={() => onJumpToNode(root.node_id)}
                      className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-cyan-300/80 transition hover:bg-cyan-400/10"
                      title={zh ? '定位到节点' : 'Jump to node'}
                    >
                      <Crosshair className="h-3 w-3" />{zh ? '定位' : 'Locate'}
                    </button>
                  ) : <span className="ml-auto text-[10.5px] text-neutral-600">{zh ? '项目级' : 'Project'}</span>}
                </div>
                <div className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-neutral-300 [overflow-wrap:anywhere]">{root.body}</div>

                {replies.map((rep) => (
                  <div key={rep.id} className="mt-2 flex gap-1.5 border-l border-white/10 pl-2.5">
                    <CornerDownRight className="mt-0.5 h-3 w-3 shrink-0 text-neutral-600" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[11.5px] font-medium text-neutral-300">{rep.author_name}</span>
                        <span className="text-[10.5px] text-neutral-600">{fmtTime(rep.created_at)}</span>
                        {canDelete(rep) ? (
                          <button type="button" onClick={() => void remove(rep)} className="ml-auto text-neutral-600 transition hover:text-rose-300" title={zh ? '删除' : 'Delete'}><Trash2 className="h-3 w-3" /></button>
                        ) : null}
                      </div>
                      <div className="whitespace-pre-wrap text-[12px] leading-relaxed text-neutral-400 [overflow-wrap:anywhere]">{rep.body}</div>
                    </div>
                  </div>
                ))}

                <div className="mt-2 flex items-center gap-2">
                  <button type="button" onClick={() => { setReplyTo({ id: root.id, nodeId: root.node_id }); setReplyDraft(''); }} className="text-[11px] text-neutral-500 transition hover:text-neutral-300">
                    {zh ? '回复' : 'Reply'}
                  </button>
                  <button type="button" onClick={() => void toggleResolved(root)} className={`flex items-center gap-1 text-[11px] transition ${root.resolved ? 'text-emerald-300/80' : 'text-neutral-500 hover:text-emerald-300'}`} data-testid="resolve-toggle">
                    <Check className="h-3 w-3" />{root.resolved ? (zh ? '已解决' : 'Resolved') : (zh ? '标记解决' : 'Resolve')}
                  </button>
                  {canDelete(root) ? (
                    <button type="button" onClick={() => void remove(root)} className="ml-auto text-[11px] text-neutral-600 transition hover:text-rose-300">{zh ? '删除' : 'Delete'}</button>
                  ) : null}
                </div>

                {replyTo?.id === root.id ? (
                  <div className="mt-2 flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={replyDraft}
                      onChange={(e) => setReplyDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void submitReply(); }}
                      placeholder={zh ? '回复…' : 'Reply…'}
                      className="h-8 flex-1 rounded-lg border border-white/10 bg-black/20 px-2.5 text-[12px] text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-cyan-400/40"
                    />
                    <button type="button" onClick={() => void submitReply()} disabled={busy || !replyDraft.trim()} className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-400/10 text-cyan-200 disabled:opacity-40">
                      <Send className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 新增评论:锚定到当前选中节点(或项目级) */}
      <div className="border-t border-white/[0.06] p-3">
        <div className="mb-1.5 text-[11px] text-neutral-500">
          {selectedNodeId
            ? (zh ? `评论将锚定到:${selectedNodeLabel || selectedNodeId}` : `Anchored to: ${selectedNodeLabel || selectedNodeId}`)
            : (zh ? '未选中节点 → 项目级评论(选中某节点可锚定)' : 'No node selected → project-level')}
        </div>
        <div className="flex items-end gap-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitRoot(); }}
            rows={2}
            placeholder={zh ? '写下你的意见…(Ctrl+Enter 发送)' : 'Add a comment… (Ctrl+Enter)'}
            className="prompt-editor-scroll max-h-24 min-h-[38px] flex-1 resize-none rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 text-[12.5px] text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-cyan-400/40"
            data-testid="comment-input"
          />
          <button
            type="button"
            onClick={() => void submitRoot()}
            disabled={busy || !draft.trim()}
            data-testid="comment-submit"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-400/40 bg-cyan-400/12 text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
