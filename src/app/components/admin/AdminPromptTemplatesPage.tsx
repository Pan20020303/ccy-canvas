import { useCallback, useEffect, useState } from "react";
import { Loader2, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";

import type { PromptTemplate } from "../../api/promptTemplates";
import { deleteAdminPromptTemplate, listAdminPromptTemplates } from "../../api/promptTemplates";
import { AdminShell } from "./AdminShell";

// ─── 提示词模板记录 ──────────────────────────────────────────────────────────
// 用户在文本节点「提示词库」上传的模板记录:谁、什么时候、传了什么、口碑如何;
// 违规内容可在此直接删除(删除后对所有用户消失)。

export function AdminPromptTemplatesPage() {
  const [items, setItems] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setItems(await listAdminPromptTemplates()); } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (item: PromptTemplate) => {
    setBusyId(item.id);
    try {
      await deleteAdminPromptTemplate(item.id);
      await load();
    } finally { setBusyId(null); }
  };

  return (
    <AdminShell
      title="提示词模板"
      description="用户在文本节点「提示词库」上传的共享模板记录。全站可见,他人可点赞/踩;违规内容可在此删除。"
    >
      <div
        data-admin-panel
        className="overflow-hidden rounded-[30px] border border-white/[0.08] bg-[#111111]/95 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]"
      >
        {loading ? (
          <div className="py-16 text-center text-neutral-500"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
        ) : items.length === 0 ? (
          <div className="py-16 text-center text-sm text-neutral-600">还没有用户上传过提示词模板</div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {items.map((item) => (
              <div key={item.id} className="group px-6 py-5 transition hover:bg-white/[0.02]">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <h4 className="text-sm font-semibold text-white">{item.title}</h4>
                      <span className="flex items-center gap-1 text-[11px] text-neutral-500">
                        <ThumbsUp className="h-3 w-3" />{item.upvotes}
                      </span>
                      <span className="flex items-center gap-1 text-[11px] text-neutral-500">
                        <ThumbsDown className="h-3 w-3" />{item.downvotes}
                      </span>
                      <span className="shrink-0 text-[11px] text-neutral-600">
                        {new Date(item.created_at).toLocaleString("zh-CN")}
                        {" · "}
                        {item.owner_name}
                        {item.owner_email ? `(${item.owner_email})` : ""}
                      </span>
                    </div>
                    <p
                      className={`mt-2 cursor-pointer whitespace-pre-wrap text-[13px] leading-6 text-neutral-400 [overflow-wrap:anywhere] ${expandedId === item.id ? "" : "line-clamp-3"}`}
                      title={expandedId === item.id ? "收起" : "展开全文"}
                      onClick={() => setExpandedId((cur) => (cur === item.id ? null : item.id))}
                    >
                      {item.content}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDelete(item)}
                    disabled={busyId === item.id}
                    title="删除该模板(对所有用户消失)"
                    className="shrink-0 text-neutral-600 opacity-0 transition hover:text-red-400 disabled:opacity-30 group-hover:opacity-100"
                  >
                    {busyId === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  );
}
