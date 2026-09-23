import { useCallback, useEffect, useState } from "react";
import { Loader2, Lock, Plus, RefreshCw, Trash2 } from "lucide-react";

import {
  adminListSkills, adminCreateSkill, adminUpdateSkill, adminDeleteSkill,
  type Skill, type SkillUpsert,
} from "../../api/skills";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AdminShell } from "./AdminShell";

/**
 * Admin page: manage global Skills available to everyone.
 *
 * Uses the same admin-shell + side-drawer pattern as AdminModelCatalogPage
 * so the UX is consistent with the rest of the console.
 */
export function AdminSkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState<{ mode: "create" } | { mode: "edit"; skill: Skill } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setSkills(await adminListSkills()); } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleDelete = async (s: Skill) => {
    if (!confirm(`确定删除「${s.name}」？`)) return;
    await adminDeleteSkill(s.id);
    await load();
  };

  return (
    <AdminShell
      title="通用技能"
      description="管理所有用户可见的技能。成员只能使用，不能修改这些通用技能。"
      action={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} className="border-white/10 text-neutral-300 hover:bg-white/5 gap-1.5">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button
            size="sm"
            onClick={() => setDrawer({ mode: "create" })}
            className="rounded-full bg-[#ff6a1f] px-5 text-white hover:bg-[#ff7b35]"
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> 新增技能
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-3">
          <Stat label="技能总数" value={skills.length} />
          <Stat label="通用 (global)" value={skills.filter((s) => s.scope === "global").length} />
          <Stat label="个人 (personal)" value={skills.filter((s) => s.scope === "personal").length} />
        </div>

        <div data-admin-panel className="overflow-hidden rounded-[30px] border border-white/[0.08] bg-[#111111]/95">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                {["名称", "类型", "Scope", "Category", "状态", "操作"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {loading ? (
                <tr><td colSpan={6} className="py-16 text-center text-neutral-500"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
              ) : skills.length === 0 ? (
                <tr><td colSpan={6} className="py-16 text-center text-sm text-neutral-600">暂无技能</td></tr>
              ) : skills.map((s) => (
                <tr key={s.id} className="group hover:bg-white/[0.02] transition">
                  <td className="px-4 py-3">
                    <div className="font-medium text-neutral-200">{s.name}</div>
                    {s.description ? <div className="text-[11px] text-neutral-500">{s.description}</div> : null}
                  </td>
                  <td className="px-4 py-3">
                    <Badge className="bg-white/[0.06] text-neutral-300 border-white/10">{s.kind}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    {s.scope === "global" ? (
                      <span className="inline-flex items-center gap-1 text-xs text-amber-300">
                        <Lock className="h-3 w-3" /> global
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-400">{s.scope}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-neutral-400">{s.category}</td>
                  <td className="px-4 py-3 text-xs">
                    <span className={s.enabled ? "text-emerald-400" : "text-neutral-500"}>
                      {s.enabled ? "● 已启用" : "○ 已停用"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 opacity-0 transition group-hover:opacity-100">
                      <button onClick={() => setDrawer({ mode: "edit", skill: s })} className="text-xs text-neutral-400 hover:text-cyan-300">编辑</button>
                      <button onClick={() => handleDelete(s)} className="text-neutral-500 hover:text-rose-400">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {drawer ? (
        <SkillDrawer
          mode={drawer.mode}
          initial={drawer.mode === "edit" ? drawer.skill : null}
          onClose={() => setDrawer(null)}
          onSaved={async () => { setDrawer(null); await load(); }}
        />
      ) : null}
    </AdminShell>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div data-admin-card className="rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4">
      <p className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-white">{value}</p>
    </div>
  );
}

function SkillDrawer({
  mode, initial, onClose, onSaved,
}: {
  mode: "create" | "edit";
  initial: Skill | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [form, setForm] = useState<SkillUpsert>(() => initial ? {
    name: initial.name, description: initial.description, category: initial.category, icon: initial.icon,
    kind: initial.kind, spec: initial.spec, input_schema: initial.input_schema, output_schema: initial.output_schema,
    enabled: initial.enabled,
  } : {
    name: "新技能", description: "", category: "other", icon: "", kind: "http",
    spec: { url: "", method: "POST", headers: {}, body_template: "{}", response_path: "", timeout_ms: 30000 },
    input_schema: {}, output_schema: {}, enabled: true,
  });

  const [specText, setSpecText] = useState(JSON.stringify(form.spec, null, 2));
  const [specErr, setSpecErr] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    try {
      const parsed = JSON.parse(specText || "{}");
      const payload = { ...form, spec: parsed };
      setSaving(true);
      if (mode === "create") await adminCreateSkill(payload);
      else if (initial) await adminUpdateSkill(initial.id, payload);
      await onSaved();
    } catch (e) {
      setSpecErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 flex w-[520px] flex-col overflow-y-auto bg-[#141414] border-l border-white/[0.08] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4">
          <h3 className="text-sm font-semibold text-white">
            {mode === "create" ? "新增通用技能" : `编辑：${initial?.name}`}
          </h3>
          <button onClick={onClose} className="text-neutral-500 hover:text-white">✕</button>
        </div>
        <div className="space-y-4 px-6 py-5">
          <Field label="名称">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white" />
          </Field>
          <Field label="描述">
            <textarea value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2}
              className="w-full rounded-lg border border-white/[0.08] bg-[#1a1a1a] px-3 py-2 text-sm text-white" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="类型">
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as SkillUpsert["kind"] })}
                className="w-full rounded-lg border border-white/[0.08] bg-[#1a1a1a] px-3 py-2 text-sm text-white">
                <option value="http">http</option>
                <option value="prompt">prompt</option>
              </select>
            </Field>
            <Field label="分类">
              <Input value={form.category ?? ""} onChange={(e) => setForm({ ...form, category: e.target.value })} className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white" />
            </Field>
          </div>
          <Field label="规格 JSON">
            <textarea value={specText} onChange={(e) => setSpecText(e.target.value)} rows={12} spellCheck={false}
              className={`w-full rounded-lg border bg-[#1a1a1a] px-3 py-2 font-mono text-[11px] text-neutral-200 ${specErr ? "border-rose-400/40" : "border-white/[0.08]"}`} />
            {specErr ? <p className="mt-1 text-xs text-rose-300">{specErr}</p> : null}
          </Field>
          <label className="flex items-center gap-2 text-xs text-neutral-200">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            启用
          </label>
        </div>
        <div className="mt-auto flex gap-3 border-t border-white/[0.06] px-6 py-4">
          <Button onClick={onClose} variant="outline" className="border-white/10 text-neutral-300 hover:bg-white/5 rounded-full px-5">取消</Button>
          <Button onClick={save} disabled={saving} className="rounded-full bg-[#ff6a1f] px-5 text-white hover:bg-[#ff7b35]">
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}保存
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-neutral-400">{label}</div>
      {children}
    </div>
  );
}
