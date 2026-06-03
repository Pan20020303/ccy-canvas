import { useCallback, useEffect, useState } from "react";
import { Bot, Loader2, Lock, Plus, Trash2, Pencil, RefreshCw } from "lucide-react";

import {
  listAgents, createAgent, updateAgent, deleteAgent,
  listSkills,
  type Agent, type AgentUpsert, type Skill,
} from "../../api/skills";
import { useStore } from "../../store";

/**
 * Settings panel: My Agents.
 *
 * Phase 2 ships CRUD only — the run/SSE protocol arrives in Phase 3
 * along with the canvas-CLI tool layer.
 */
export function AgentsSettingsTab() {
  const language = useStore((s) => s.language);
  const zh = language === "zh";

  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentUpsert | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, s] = await Promise.all([listAgents(), listSkills()]);
      setAgents(a);
      setSkills(s);
    } catch { /* */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  const startCreate = () => {
    setCreating(true);
    setSelectedId(null);
    setEditing({
      name: zh ? "新智能体" : "New agent",
      description: "",
      avatar: "",
      system_prompt: zh
        ? "你是一个画布助手，帮助用户在画布上完成创作。可以调用工具创建节点、连线和触发生成。"
        : "You are a canvas assistant. Use tools to create nodes, connect them, and trigger generation.",
      model: "gpt-4o-mini",
      skill_ids: [],
      canvas_tools: true,
      strategy: "reactive",
      enabled: true,
    });
  };

  const startEdit = (a: Agent) => {
    if (a.scope === "global") return;
    setCreating(false);
    setSelectedId(a.id);
    setEditing({
      name: a.name,
      description: a.description,
      avatar: a.avatar,
      system_prompt: a.system_prompt,
      model: a.model,
      skill_ids: a.skill_ids,
      canvas_tools: a.canvas_tools,
      strategy: a.strategy,
      enabled: a.enabled,
    });
  };

  const save = async () => {
    if (!editing) return;
    if (creating) await createAgent(editing);
    else if (selectedId) await updateAgent(selectedId, editing);
    await load();
    setEditing(null);
    setCreating(false);
  };

  const remove = async (a: Agent) => {
    if (a.scope === "global") return;
    if (!confirm(zh ? `确定删除「${a.name}」？` : `Delete "${a.name}"?`)) return;
    await deleteAgent(a.id);
    if (selectedId === a.id) setSelectedId(null);
    await load();
  };

  return (
    <div className="flex h-full min-h-[420px] gap-3">
      <div className="flex w-[260px] flex-col rounded-xl border border-white/10">
        <div className="flex items-center justify-between border-b border-white/8 px-3 py-2">
          <span className="text-[11px] uppercase tracking-wider text-neutral-400">{zh ? "智能体列表" : "Agents"}</span>
          <div className="flex items-center gap-1">
            <button onClick={load} className="rounded p-1 text-neutral-500 hover:bg-white/5 hover:text-neutral-200">
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button onClick={startCreate} className="rounded p-1 text-cyan-300 hover:bg-cyan-500/10">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {agents.length === 0 && !loading ? (
            <div className="px-3 py-8 text-center text-xs text-neutral-500">
              {zh ? "暂无智能体" : "No agents"}
            </div>
          ) : null}
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => { setSelectedId(a.id); setEditing(null); setCreating(false); }}
              className={`flex w-full items-center gap-2 border-b border-white/5 px-3 py-2 text-left transition ${
                selectedId === a.id ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"
              }`}
            >
              <Bot className="h-3.5 w-3.5 text-neutral-400" />
              <span className="flex-1 truncate text-xs text-neutral-200">{a.name}</span>
              {a.scope === "global" ? <Lock className="h-3 w-3 text-neutral-500" /> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto rounded-xl border border-white/10 px-5 py-4">
        {editing ? (
          <AgentEditor
            value={editing}
            onChange={setEditing}
            onSave={save}
            onCancel={() => { setEditing(null); setCreating(false); }}
            allSkills={skills}
            zh={zh}
          />
        ) : selected ? (
          <AgentDetail agent={selected} onEdit={() => startEdit(selected)} onDelete={() => remove(selected)} allSkills={skills} zh={zh} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            {zh ? "选择左侧智能体查看，或点击右上 ＋ 新建" : "Select an agent on the left, or click ＋ to create."}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentDetail({
  agent, onEdit, onDelete, allSkills, zh,
}: {
  agent: Agent;
  onEdit: () => void;
  onDelete: () => void;
  allSkills: Skill[];
  zh: boolean;
}) {
  const skillNames = agent.skill_ids
    .map((id) => allSkills.find((s) => s.id === id)?.name ?? id)
    .join(", ");
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-medium text-neutral-100">{agent.name}</h3>
            {agent.scope === "global" ? (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                <Lock className="h-2.5 w-2.5" />{zh ? "管理员配置" : "Admin"}
              </span>
            ) : null}
          </div>
          {agent.description ? <p className="mt-1 text-xs text-neutral-400">{agent.description}</p> : null}
        </div>
        {agent.scope !== "global" ? (
          <div className="flex gap-1">
            <button onClick={onEdit} className="rounded p-1.5 text-neutral-400 hover:bg-white/5 hover:text-cyan-300"><Pencil className="h-3.5 w-3.5" /></button>
            <button onClick={onDelete} className="rounded p-1.5 text-neutral-400 hover:bg-white/5 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ) : null}
      </div>
      <Field label={zh ? "模型" : "Model"} value={agent.model} />
      <Field label={zh ? "策略" : "Strategy"} value={agent.strategy} />
      <Field label={zh ? "画布操控" : "Canvas tools"} value={agent.canvas_tools ? "✓" : "✗"} />
      <Field label={zh ? "绑定技能" : "Skills"} value={skillNames || "—"} />
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">{zh ? "系统提示" : "System prompt"}</div>
        <pre className="rounded border border-white/10 bg-black/30 p-2 text-[11px] text-neutral-300 whitespace-pre-wrap">{agent.system_prompt}</pre>
      </div>
      <p className="rounded border border-amber-400/15 bg-amber-500/[0.05] px-3 py-2 text-[11px] text-amber-200">
        {zh ? "智能体运行（Run / 画布操控）将在下一阶段上线。" : "Run & canvas-CLI execution ships in the next phase."}
      </p>
    </div>
  );
}

function AgentEditor({
  value, onChange, onSave, onCancel, allSkills, zh,
}: {
  value: AgentUpsert;
  onChange: (v: AgentUpsert) => void;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
  allSkills: Skill[];
  zh: boolean;
}) {
  const toggle = (id: string) => {
    const set = new Set(value.skill_ids ?? []);
    if (set.has(id)) set.delete(id); else set.add(id);
    onChange({ ...value, skill_ids: Array.from(set) });
  };
  return (
    <div className="space-y-3">
      <Row label={zh ? "名称" : "Name"}>
        <input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })}
          className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none" />
      </Row>
      <Row label={zh ? "描述" : "Description"}>
        <textarea value={value.description ?? ""} onChange={(e) => onChange({ ...value, description: e.target.value })} rows={2}
          className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none" />
      </Row>
      <div className="grid grid-cols-2 gap-3">
        <Row label={zh ? "模型" : "Model"}>
          <input value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })}
            placeholder="gpt-4o-mini"
            className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none" />
        </Row>
        <Row label={zh ? "画布操控" : "Canvas tools"}>
          <label className="flex items-center gap-2 text-xs text-neutral-200">
            <input type="checkbox" checked={value.canvas_tools}
              onChange={(e) => onChange({ ...value, canvas_tools: e.target.checked })} />
            {zh ? "允许操控画布" : "Allow"}
          </label>
        </Row>
      </div>
      <Row label={zh ? "系统提示" : "System prompt"}>
        <textarea value={value.system_prompt} onChange={(e) => onChange({ ...value, system_prompt: e.target.value })}
          rows={5}
          className="w-full rounded border border-white/10 bg-black/30 p-2 font-mono text-[11px] text-neutral-200 outline-none" />
      </Row>
      <Row label={zh ? "绑定技能" : "Skills"}>
        <div className="max-h-40 overflow-y-auto rounded border border-white/10 bg-black/20 p-2">
          {allSkills.length === 0 ? (
            <p className="text-[11px] text-neutral-500">{zh ? "暂无可绑定的技能" : "No skills available"}</p>
          ) : allSkills.map((s) => {
            const checked = (value.skill_ids ?? []).includes(s.id);
            return (
              <label key={s.id} className="flex cursor-pointer items-center gap-2 px-1 py-1 text-xs text-neutral-200 hover:bg-white/[0.03]">
                <input type="checkbox" checked={checked} onChange={() => toggle(s.id)} />
                <span className="flex-1 truncate">{s.name}</span>
                <span className="text-[9px] text-neutral-500">{s.scope === "global" ? "global" : "mine"}</span>
              </label>
            );
          })}
        </div>
      </Row>
      <div className="flex items-center justify-end gap-2 pt-2">
        <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-neutral-400 hover:bg-white/5 hover:text-neutral-200">{zh ? "取消" : "Cancel"}</button>
        <button onClick={() => void onSave()} className="rounded bg-cyan-500/20 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/30">
          <span className="flex items-center gap-1"><Loader2 className="hidden h-3 w-3 animate-spin" />{zh ? "保存" : "Save"}</span>
        </button>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="text-xs text-neutral-200">{value}</div>
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
