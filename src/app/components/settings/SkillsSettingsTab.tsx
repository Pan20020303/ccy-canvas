import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Lock, Plus, Trash2, Pencil, Play, RefreshCw } from "lucide-react";

import {
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  invokeSkill,
  type Skill,
  type SkillUpsert,
} from "../../api/skills";
import { useStore } from "../../store";

/**
 * Settings panel: My Skills.
 *
 * Layout: master/detail.
 *   Left  — list of visible skills (globals locked, personals editable).
 *   Right — viewer/editor/runner for the currently-selected skill.
 */
export function SkillsSettingsTab() {
  const language = useStore((s) => s.language);
  const zh = language === "zh";

  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<SkillUpsert | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setSkills(await listSkills()); } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(
    () => skills.find((s) => s.id === selectedId) ?? null,
    [skills, selectedId],
  );

  const startCreate = () => {
    setCreating(true);
    setSelectedId(null);
    setEditing({
      name: zh ? "新技能" : "New skill",
      description: "",
      category: "other",
      icon: "",
      kind: "http",
      spec: { url: "", method: "POST", headers: {}, body_template: "{}", response_path: "" },
      input_schema: {},
      output_schema: {},
      enabled: true,
    });
  };

  const startEdit = (s: Skill) => {
    if (s.scope === "global") return; // can't edit globals
    setCreating(false);
    setSelectedId(s.id);
    setEditing({
      name: s.name,
      description: s.description,
      category: s.category,
      icon: s.icon,
      kind: s.kind,
      spec: s.spec,
      input_schema: s.input_schema,
      output_schema: s.output_schema,
      enabled: s.enabled,
    });
  };

  const save = async () => {
    if (!editing) return;
    if (creating) {
      const created = await createSkill(editing);
      await load();
      setSelectedId(created.id);
    } else if (selectedId) {
      await updateSkill(selectedId, editing);
      await load();
    }
    setEditing(null);
    setCreating(false);
  };

  const remove = async (s: Skill) => {
    if (s.scope === "global") return;
    if (!confirm(zh ? `确定删除技能「${s.name}」？` : `Delete skill "${s.name}"?`)) return;
    await deleteSkill(s.id);
    if (selectedId === s.id) setSelectedId(null);
    await load();
  };

  return (
    <div className="flex h-full min-h-[420px] gap-3">
      {/* Left list */}
      <div className="flex w-[260px] flex-col rounded-xl border border-white/10">
        <div className="flex items-center justify-between border-b border-white/8 px-3 py-2">
          <span className="text-[11px] uppercase tracking-wider text-neutral-400">
            {zh ? "技能列表" : "Skills"}
          </span>
          <div className="flex items-center gap-1">
            <button onClick={load} title={zh ? "刷新" : "Refresh"} className="rounded p-1 text-neutral-500 hover:bg-white/5 hover:text-neutral-200">
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button onClick={startCreate} title={zh ? "新建" : "New"} className="rounded p-1 text-cyan-300 hover:bg-cyan-500/10">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {skills.length === 0 && !loading ? (
            <div className="px-3 py-8 text-center text-xs text-neutral-500">
              {zh ? "暂无技能" : "No skills"}
            </div>
          ) : null}
          {skills.map((s) => (
            <button
              key={s.id}
              onClick={() => { setSelectedId(s.id); setEditing(null); setCreating(false); }}
              className={`flex w-full items-center gap-2 border-b border-white/5 px-3 py-2 text-left transition ${
                selectedId === s.id ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"
              }`}
            >
              <span className="flex-1 truncate text-xs text-neutral-200">{s.name}</span>
              {s.scope === "global" ? <Lock className="h-3 w-3 text-neutral-500" /> : null}
              <span className="rounded bg-white/[0.06] px-1 py-0.5 text-[9px] text-neutral-400">{s.kind}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Right detail */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-white/10 px-5 py-4">
        {editing ? (
          <SkillEditor
            value={editing}
            onChange={setEditing}
            onSave={save}
            onCancel={() => { setEditing(null); setCreating(false); }}
            zh={zh}
          />
        ) : selected ? (
          <SkillDetail skill={selected} onEdit={() => startEdit(selected)} onDelete={() => remove(selected)} zh={zh} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            {zh ? "选择左侧技能查看，或点击右上 ＋ 新建" : "Select a skill on the left, or click ＋ to create."}
          </div>
        )}
      </div>
    </div>
  );
}

/** Read-only view + Run-with-inputs panel. */
function SkillDetail({
  skill, onEdit, onDelete, zh,
}: {
  skill: Skill;
  onEdit: () => void;
  onDelete: () => void;
  zh: boolean;
}) {
  const [inputs, setInputs] = useState("{}");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string>("");

  const run = async () => {
    setRunning(true);
    setResult("");
    try {
      const parsed = JSON.parse(inputs || "{}");
      const r = await invokeSkill(skill.id, parsed);
      setResult(`✅ ${r.duration_ms}ms\n\n${r.content}`);
    } catch (e: unknown) {
      setResult(`❌ ${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-medium text-neutral-100">{skill.name}</h3>
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-neutral-400">{skill.kind}</span>
            {skill.scope === "global" ? (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                <Lock className="h-2.5 w-2.5" />
                {zh ? "管理员配置 · 仅可使用" : "Admin-managed · use only"}
              </span>
            ) : (
              <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] text-cyan-300">
                {zh ? "我的" : "Mine"}
              </span>
            )}
          </div>
          {skill.description ? (
            <p className="mt-1 text-xs leading-5 text-neutral-400">{skill.description}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {skill.scope !== "global" ? (
            <>
              <button onClick={onEdit} className="rounded p-1.5 text-neutral-400 hover:bg-white/5 hover:text-cyan-300">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button onClick={onDelete} className="rounded p-1.5 text-neutral-400 hover:bg-white/5 hover:text-rose-300">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          ) : null}
        </div>
      </div>

      <details className="rounded-md border border-white/8 bg-white/[0.02] p-3 text-[11px] text-neutral-400">
        <summary className="cursor-pointer text-neutral-300">{zh ? "规格 (spec)" : "Spec"}</summary>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-[10px] text-neutral-500">{JSON.stringify(skill.spec, null, 2)}</pre>
      </details>

      <div className="rounded-md border border-cyan-400/15 bg-cyan-500/[0.04] p-3">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-cyan-200">
          {zh ? "试运行" : "Test run"}
        </div>
        <textarea
          value={inputs}
          onChange={(e) => setInputs(e.target.value)}
          rows={5}
          spellCheck={false}
          className="w-full rounded border border-white/10 bg-black/30 p-2 font-mono text-[11px] text-neutral-200 outline-none focus:border-cyan-400/40"
          placeholder='{"text":"hello"}'
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            onClick={run}
            disabled={running}
            className="flex items-center gap-1 rounded-md bg-cyan-500/15 px-3 py-1.5 text-xs text-cyan-200 transition hover:bg-cyan-500/25 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {zh ? "运行" : "Run"}
          </button>
        </div>
        {result ? (
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[11px] text-neutral-200">{result}</pre>
        ) : null}
      </div>
    </div>
  );
}

/** Form for create / edit. Kept compact — power-users will edit the raw JSON. */
function SkillEditor({
  value, onChange, onSave, onCancel, zh,
}: {
  value: SkillUpsert;
  onChange: (v: SkillUpsert) => void;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
  zh: boolean;
}) {
  const [specText, setSpecText] = useState(JSON.stringify(value.spec, null, 2));
  const [specErr, setSpecErr] = useState<string>("");

  const commitSpec = () => {
    try {
      const parsed = JSON.parse(specText || "{}");
      onChange({ ...value, spec: parsed });
      setSpecErr("");
    } catch (e) {
      setSpecErr((e as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <Row label={zh ? "名称" : "Name"}>
        <input
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
          className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
        />
      </Row>
      <Row label={zh ? "描述" : "Description"}>
        <textarea
          value={value.description ?? ""}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
          rows={2}
          className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
        />
      </Row>
      <div className="grid grid-cols-3 gap-3">
        <Row label={zh ? "分类" : "Category"}>
          <input
            value={value.category ?? ""}
            onChange={(e) => onChange({ ...value, category: e.target.value })}
            className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
          />
        </Row>
        <Row label={zh ? "类型" : "Kind"}>
          <select
            value={value.kind}
            onChange={(e) => onChange({ ...value, kind: e.target.value as SkillUpsert["kind"] })}
            className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
          >
            <option value="http">http</option>
            <option value="prompt">prompt</option>
          </select>
        </Row>
        <Row label={zh ? "启用" : "Enabled"}>
          <label className="flex items-center gap-2 text-xs text-neutral-200">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
            />
            {zh ? "开启" : "On"}
          </label>
        </Row>
      </div>
      <Row label={zh ? "规格 (JSON)" : "Spec JSON"}>
        <textarea
          value={specText}
          onChange={(e) => setSpecText(e.target.value)}
          onBlur={commitSpec}
          rows={10}
          spellCheck={false}
          className={`w-full rounded border bg-black/30 p-2 font-mono text-[11px] text-neutral-200 outline-none ${
            specErr ? "border-rose-400/40" : "border-white/10"
          }`}
        />
        {specErr ? <p className="mt-1 text-[10px] text-rose-300">{specErr}</p> : (
          <p className="mt-1 text-[10px] text-neutral-500">
            {value.kind === "http"
              ? zh
                ? "字段：url, method, headers, body_template, response_path, timeout_ms"
                : "fields: url, method, headers, body_template, response_path, timeout_ms"
              : zh
                ? "字段：system_prompt, user_template, model_hint"
                : "fields: system_prompt, user_template, model_hint"}
          </p>
        )}
      </Row>
      <div className="flex items-center justify-end gap-2 pt-2">
        <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-neutral-400 hover:bg-white/5 hover:text-neutral-200">
          {zh ? "取消" : "Cancel"}
        </button>
        <button
          onClick={() => { commitSpec(); void onSave(); }}
          disabled={!!specErr}
          className="rounded bg-cyan-500/20 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-50"
        >
          {zh ? "保存" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      {children}
    </div>
  );
}
