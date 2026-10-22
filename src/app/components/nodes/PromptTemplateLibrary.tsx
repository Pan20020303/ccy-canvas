import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { Loader2, Plus, ThumbsDown, ThumbsUp, Trash2, X } from 'lucide-react';
import {
  createPromptTemplate,
  deletePromptTemplate,
  listPromptTemplates,
  votePromptTemplate,
  type PromptTemplate,
} from '../../api/promptTemplates';

// ─── 提示词库弹窗 ─────────────────────────────────────────────────────────
// 文本节点全屏编辑器工具栏的「提示词库」入口:共享模板池,点卡片写入节点,
// 可上传个人模板(全站可见)、点赞/踩(再点取消)、筛选只看自己、删自己的。

type Props = {
  open: boolean;
  onClose: () => void;
  /** 点击模板卡片:把模板正文交给调用方写入文本节点。 */
  onApply: (content: string) => void;
  language: 'zh' | 'en';
};

export function PromptTemplateLibrary({ open, onClose, onApply, language }: Props) {
  const zh = language === 'zh';
  const [items, setItems] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'all' | 'mine'>('all');
  const [showUpload, setShowUpload] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadContent, setUploadContent] = useState('');
  const [uploading, setUploading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await listPromptTemplates());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const visible = useMemo(
    () => (tab === 'mine' ? items.filter((t) => t.is_mine) : items),
    [items, tab],
  );

  const handleUpload = async () => {
    const title = uploadTitle.trim();
    const content = uploadContent.trim();
    if (!title || !content || uploading) return;
    setUploading(true);
    setError('');
    try {
      await createPromptTemplate({ title, content });
      setUploadTitle('');
      setUploadContent('');
      setShowUpload(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  // 投票:点已选的键 → 取消(0);否则改成新票。前端先乐观更新,失败再回滚刷新。
  const handleVote = async (tpl: PromptTemplate, vote: 1 | -1) => {
    const next: 1 | -1 | 0 = tpl.my_vote === vote ? 0 : vote;
    setItems((prev) =>
      prev.map((t) => {
        if (t.id !== tpl.id) return t;
        let { upvotes, downvotes } = t;
        if (t.my_vote === 1) upvotes -= 1;
        if (t.my_vote === -1) downvotes -= 1;
        if (next === 1) upvotes += 1;
        if (next === -1) downvotes += 1;
        return { ...t, my_vote: next, upvotes, downvotes };
      }),
    );
    try {
      await votePromptTemplate(tpl.id, next);
    } catch {
      await refresh();
    }
  };

  const handleDelete = async (tpl: PromptTemplate) => {
    try {
      await deletePromptTemplate(tpl.id);
      setItems((prev) => prev.filter((t) => t.id !== tpl.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
      onClick={onClose}
      data-testid="prompt-template-library"
    >
      <div
        className="relative flex h-[74vh] w-[46vw] min-w-[560px] max-w-[860px] flex-col rounded-2xl border border-white/10 bg-[#1a1d22]/98 px-5 py-4 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg border border-white/8 bg-white/[0.03] text-neutral-300 transition hover:bg-white/[0.06]"
        >
          <X className="h-4 w-4" />
        </button>
        {/* 头部:标题 + 筛选 tab + 上传入口 */}
        <div className="mb-3 flex items-center gap-3 pr-12">
          <div className="text-sm font-medium text-neutral-200">{zh ? '提示词库' : 'Prompt Library'}</div>
          <div className="flex items-center rounded-lg border border-white/10 bg-white/[0.03] p-0.5 text-[12px]">
            <button
              type="button"
              onClick={() => setTab('all')}
              className={clsx('rounded-md px-2.5 py-1 transition', tab === 'all' ? 'bg-white/12 text-white' : 'text-neutral-400 hover:text-neutral-200')}
            >
              {zh ? '全部' : 'All'}
            </button>
            <button
              type="button"
              onClick={() => setTab('mine')}
              className={clsx('rounded-md px-2.5 py-1 transition', tab === 'mine' ? 'bg-white/12 text-white' : 'text-neutral-400 hover:text-neutral-200')}
            >
              {zh ? '我的' : 'Mine'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setShowUpload((v) => !v)}
            className={clsx(
              'ml-auto flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[12px] transition',
              showUpload
                ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200'
                : 'border-white/10 bg-white/[0.03] text-neutral-300 hover:bg-white/[0.06]',
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            {zh ? '上传模板' : 'Upload'}
          </button>
        </div>
        {/* 上传表单(可折叠):标题 + 正文,上传即全站可见 */}
        {showUpload ? (
          <div className="mb-3 flex flex-col gap-2 rounded-xl border border-white/10 bg-black/20 p-3">
            <input
              value={uploadTitle}
              onChange={(event) => setUploadTitle(event.target.value)}
              maxLength={80}
              placeholder={zh ? '模板标题(如:赛博朋克人物设定)' : 'Template title'}
              className="h-8 rounded-lg border border-white/10 bg-black/20 px-2.5 text-[13px] text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-cyan-400/40"
            />
            <textarea
              value={uploadContent}
              onChange={(event) => setUploadContent(event.target.value)}
              rows={5}
              placeholder={zh ? '模板正文(提示词内容)…' : 'Template content…'}
              className="prompt-editor-scroll resize-none rounded-lg border border-white/10 bg-black/20 p-2.5 text-[13px] leading-relaxed text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-cyan-400/40"
            />
            <div className="flex items-center justify-between">
              <div className="text-[11px] text-neutral-500">{zh ? '上传后对所有人可见' : 'Visible to everyone after upload'}</div>
              <button
                type="button"
                onClick={() => void handleUpload()}
                disabled={uploading || !uploadTitle.trim() || !uploadContent.trim()}
                className="flex h-7 items-center gap-1 rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 text-[12px] text-cyan-200 transition hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {zh ? '确认上传' : 'Upload'}
              </button>
            </div>
          </div>
        ) : null}
        {error ? <div className="mb-2 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-1.5 text-[12px] text-rose-300">{error}</div> : null}
        {/* 模板列表:点卡片写入节点;右下角赞/踩;自己的可删 */}
        <div className="prompt-editor-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-neutral-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              {zh ? '加载中…' : 'Loading…'}
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[13px] text-neutral-500">
              {tab === 'mine' ? (zh ? '还没有上传过模板' : 'No templates uploaded yet') : (zh ? '暂无模板,来上传第一个吧' : 'No templates yet')}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {visible.map((tpl) => (
                <div
                  key={tpl.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onApply(tpl.content)}
                  onKeyDown={(event) => { if (event.key === 'Enter') onApply(tpl.content); }}
                  className="group cursor-pointer rounded-xl border border-white/10 bg-white/[0.02] p-3 transition hover:border-cyan-400/30 hover:bg-white/[0.04]"
                  data-testid="prompt-template-card"
                >
                  <div className="flex items-center gap-2">
                    <div className="truncate text-[13px] font-medium text-neutral-100">{tpl.title}</div>
                    {tpl.is_mine ? (
                      <span className="shrink-0 rounded bg-cyan-400/15 px-1.5 py-0.5 text-[10px] text-cyan-300">{zh ? '我的' : 'Mine'}</span>
                    ) : null}
                    <span className="ml-auto shrink-0 text-[11px] text-neutral-500">
                      {tpl.owner_name} · {new Date(tpl.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="mt-1.5 line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed text-neutral-400 [overflow-wrap:anywhere]">
                    {tpl.content}
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <span className="text-[11px] text-neutral-500 opacity-0 transition group-hover:opacity-100">
                      {zh ? '点击写入文本节点' : 'Click to insert'}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      {tpl.is_mine ? (
                        <button
                          type="button"
                          title={zh ? '删除我的模板' : 'Delete my template'}
                          onClick={(event) => { event.stopPropagation(); void handleDelete(tpl); }}
                          className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        title={zh ? '赞' : 'Upvote'}
                        onClick={(event) => { event.stopPropagation(); void handleVote(tpl, 1); }}
                        className={clsx(
                          'flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition',
                          tpl.my_vote === 1 ? 'bg-cyan-400/15 text-cyan-300' : 'text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-200',
                        )}
                        data-testid="tpl-upvote"
                      >
                        <ThumbsUp className="h-3.5 w-3.5" />
                        {tpl.upvotes}
                      </button>
                      <button
                        type="button"
                        title={zh ? '踩' : 'Downvote'}
                        onClick={(event) => { event.stopPropagation(); void handleVote(tpl, -1); }}
                        className={clsx(
                          'flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition',
                          tpl.my_vote === -1 ? 'bg-rose-400/15 text-rose-300' : 'text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-200',
                        )}
                        data-testid="tpl-downvote"
                      >
                        <ThumbsDown className="h-3.5 w-3.5" />
                        {tpl.downvotes}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
