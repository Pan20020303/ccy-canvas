import { useCallback, useEffect, useState } from "react";
import { Loader2, Megaphone, Plus, Trash2, XCircle } from "lucide-react";

import type { Announcement } from "../../api/announcements";
import { createAnnouncement, deleteAnnouncement, listAdminAnnouncements } from "../../api/announcements";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AdminShell } from "./AdminShell";

// ─── 发布抽屉 ────────────────────────────────────────────────────────────────

function PublishDrawer({ open, onClose, onPublished }: { open: boolean; onClose: () => void; onPublished: () => void }) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setTitle("");
      setContent("");
      setError("");
      setSaving(false);
    }
  }, [open]);

  const handlePublish = async () => {
    if (!title.trim() || !content.trim()) {
      setError("标题和内容不能为空");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await createAnnouncement({ title: title.trim(), content: content.trim() });
      onPublished();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "发布失败");
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 flex w-[460px] flex-col bg-[#141414] border-l border-white/[0.08] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4">
          <h3 className="text-sm font-semibold text-white">发布公告</h3>
          <button onClick={onClose} className="text-neutral-500 hover:text-white transition">
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <div className="space-y-1.5">
            <label className="flex items-center gap-1 text-xs font-medium text-neutral-400">
              <span className="text-[#ff6a1f]">*</span> 标题
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              placeholder="例如「新模型上线:Kling 2.5」"
              className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white"
            />
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center gap-1 text-xs font-medium text-neutral-400">
              <span className="text-[#ff6a1f]">*</span> 内容
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={5000}
              rows={10}
              placeholder="公告正文,发布后所有用户都会在右上角铃铛中看到。"
              className="w-full resize-y rounded-lg border border-white/[0.08] bg-[#1a1a1a] px-3 py-2 text-sm leading-6 text-white outline-none placeholder:text-neutral-600 focus:border-[#ff6a1f]/40"
            />
            <p className="text-right text-[10px] text-neutral-600">{content.length} / 5000</p>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex gap-3 border-t border-white/[0.06] px-6 py-4">
          <Button onClick={onClose} variant="outline" className="border-white/10 text-neutral-300 hover:bg-white/5 rounded-full px-5">取消</Button>
          <Button onClick={handlePublish} disabled={saving} className="bg-[#ff6a1f] text-white hover:bg-[#ff7b35] rounded-full px-5">
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Megaphone className="mr-1.5 h-3.5 w-3.5" />}
            发布公告
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── 主页面 ──────────────────────────────────────────────────────────────────

export function AdminAnnouncementsPage() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setAnnouncements(await listAdminAnnouncements()); } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (item: Announcement) => {
    setBusyId(item.id);
    try {
      await deleteAnnouncement(item.id);
      await load();
    } finally { setBusyId(null); }
  };

  return (
    <AdminShell
      title="公告管理"
      description="发布平台公告。发布后所有用户都可以在画布右上角的铃铛中看到,有新公告时铃铛会亮起红点。"
      action={
        <Button className="rounded-full bg-[#ff6a1f] px-5 text-white hover:bg-[#ff7b35]" onClick={() => setDrawerOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          发布公告
        </Button>
      }
    >
      <div
        data-admin-panel
        className="overflow-hidden rounded-[30px] border border-white/[0.08] bg-[#111111]/95 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]"
      >
        {loading ? (
          <div className="py-16 text-center text-neutral-500"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
        ) : announcements.length === 0 ? (
          <div className="py-16 text-center text-sm text-neutral-600">暂无公告,点击「发布公告」开始</div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {announcements.map((item) => (
              <div key={item.id} className="group px-6 py-5 transition hover:bg-white/[0.02]">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <h4 className="text-sm font-semibold text-white">{item.title}</h4>
                      <span className="shrink-0 text-[11px] text-neutral-600">
                        {new Date(item.created_at).toLocaleString("zh-CN")}
                        {item.creator_name ? ` · ${item.creator_name}` : ""}
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-neutral-400">{item.content}</p>
                  </div>
                  <button
                    onClick={() => handleDelete(item)}
                    disabled={busyId === item.id}
                    title="删除公告"
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

      <PublishDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onPublished={load} />
    </AdminShell>
  );
}
