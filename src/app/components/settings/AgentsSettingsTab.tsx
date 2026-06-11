import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Lock, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";

import { toUserMessage } from "../../api/errors";
import {
  createAgent,
  deleteAgent,
  listAgents,
  listSkills,
  updateAgent,
  type Agent,
  type AgentUpsert,
  type Skill,
} from "../../api/skills";
import { useStore } from "../../store";
import { applyAgentSettingsLoadResults, canSaveAgentEditor } from "./agent-settings-state";
import {
  getAgentAvailableModels,
  getAgentExperienceHints,
  getSkillCommandName,
  isPromptTemplateSkill,
} from "./skill-agent-presenters";

type AgentEditorState = {
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  skillIds: string[];
  canvasTools: boolean;
  enabled: boolean;
};

export function AgentsSettingsTab() {
  const language = useStore((s) => s.language);
  const backendModels = useStore((s) => s.backendModels);
  const zh = language === "zh";

  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentEditorState | null>(null);
  const [creating, setCreating] = useState(false);
  const agentsRef = useRef<Agent[]>([]);
  const skillsRef = useRef<Skill[]>([]);

  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  useEffect(() => {
    skillsRef.current = skills;
  }, [skills]);

  const availableSkills = useMemo(
    () => skills.filter((skill) => isPromptTemplateSkill(skill)),
    [skills],
  );

  const availableModels = useMemo(
    () => getAgentAvailableModels(backendModels, editing?.model),
    [backendModels, editing?.model],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentsResult, skillsResult] = await Promise.allSettled([listAgents(), listSkills()]);
      const next = applyAgentSettingsLoadResults(
        agentsRef.current,
        skillsRef.current,
        agentsResult,
        skillsResult,
      );
      setAgents(next.agents);
      setSkills(next.skills);

      if (agentsResult.status === "rejected" || skillsResult.status === "rejected") {
        setError(
          zh
            ? "智能体或技能列表刷新失败，已保留当前内容。"
            : "Failed to refresh agents or skills. Keeping the current data.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, [zh]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const startCreate = () => {
    setError(null);
    setCreating(true);
    setSelectedId(null);
    setEditing({
      name: zh ? "新智能体" : "New agent",
      description: "",
      systemPrompt: zh
        ? "优先使用当前会话上下文、绑定技能与管理员预配模型完成任务。"
        : "Use current conversation context, bound skills, and admin-configured models to complete the task.",
      model: availableModels[0] ?? "gpt-4.1-mini",
      skillIds: [],
      canvasTools: true,
      enabled: true,
    });
  };

  const startEdit = (agent: Agent) => {
    if (agent.scope === "global") {
      return;
    }
    setError(null);
    setCreating(false);
    setSelectedId(agent.id);
    setEditing({
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.system_prompt,
      model: agent.model,
      skillIds: agent.skill_ids,
      canvasTools: agent.canvas_tools,
      enabled: agent.enabled,
    });
  };

  const save = async () => {
    if (!editing) {
      return;
    }
    if (!canSaveAgentEditor(editing)) {
      setError(zh ? "请先填写智能体名称、模型和系统提示词。" : "Please fill in the agent name, model, and system prompt.");
      return;
    }

    const payload: AgentUpsert = {
      name: editing.name.trim(),
      description: editing.description.trim(),
      avatar: "",
      system_prompt: editing.systemPrompt.trim(),
      model: editing.model.trim(),
      skill_ids: editing.skillIds,
      canvas_tools: editing.canvasTools,
      strategy: "reactive",
      enabled: editing.enabled,
    };

    setSaving(true);
    setError(null);
    try {
      if (creating) {
        const created = await createAgent(payload);
        setSelectedId(created.id);
      } else if (selectedId) {
        await updateAgent(selectedId, payload);
      }

      await load();
      setEditing(null);
      setCreating(false);
    } catch (saveError) {
      setError(toUserMessage(saveError, zh ? "zh" : "en"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (agent: Agent) => {
    if (agent.scope === "global") {
      return;
    }
    if (!confirm(zh ? `确定删除智能体“${agent.name}”？` : `Delete agent "${agent.name}"?`)) {
      return;
    }
    await deleteAgent(agent.id);
    if (selectedId === agent.id) {
      setSelectedId(null);
    }
    await load();
  };

  return (
    <div className="flex h-full min-h-[420px] gap-3">
      <div className="flex w-[280px] flex-col rounded-xl border border-white/10">
        <div className="flex items-center justify-between border-b border-white/8 px-3 py-2">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-neutral-400">
              {zh ? "智能体" : "Agents"}
            </div>
            <div className="mt-1 text-[10px] text-neutral-500">
              {zh ? "带人设、上下文与技能的会话角色" : "Conversation roles with persona, context, and skills"}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void load()}
              className="rounded p-1 text-neutral-500 hover:bg-white/5 hover:text-neutral-200"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button onClick={startCreate} className="rounded p-1 text-cyan-300 hover:bg-cyan-500/10">
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div className="prompt-editor-scroll flex-1 overflow-y-auto">
          {agents.length === 0 && !loading ? (
            <div className="px-4 py-8 text-center text-xs text-neutral-500">
              {zh ? "暂无智能体。点击右上角 + 新建一个可对话角色。" : "No agents yet. Click + to create a conversation-ready role."}
            </div>
          ) : null}
          {agents.map((agent) => (
            <button
              key={agent.id}
              onClick={() => {
                setSelectedId(agent.id);
                setEditing(null);
                setCreating(false);
                setError(null);
              }}
              className={`w-full border-b border-white/5 px-3 py-2.5 text-left transition ${
                selectedId === agent.id ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"
              }`}
            >
              <div className="flex items-start gap-2">
                <Bot className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-neutral-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs text-neutral-200">{agent.name}</span>
                    {agent.scope === "global" ? <Lock className="h-3 w-3 text-neutral-500" /> : null}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-neutral-500">
                    <span>{agent.model}</span>
                    <span>·</span>
                    <span>{agent.skill_ids.length} {zh ? "个技能" : "skills"}</span>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="prompt-editor-scroll flex-1 overflow-y-auto rounded-xl border border-white/10 px-5 py-4">
        {error ? (
          <div className="mb-3 rounded-md border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {error}
          </div>
        ) : null}
        {editing ? (
          <AgentEditor
            value={editing}
            onChange={setEditing}
            onSave={save}
            onCancel={() => {
              setEditing(null);
              setCreating(false);
              setError(null);
            }}
            allSkills={availableSkills}
            allModels={availableModels}
            zh={zh}
            saving={saving}
          />
        ) : selected ? (
          <AgentDetail
            agent={selected}
            onEdit={() => startEdit(selected)}
            onDelete={() => void remove(selected)}
            allSkills={availableSkills}
            zh={zh}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            {zh ? "选择左侧智能体查看，或点击右上角 + 新建。" : "Select an agent on the left, or click + to create one."}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentDetail({
  agent,
  onEdit,
  onDelete,
  allSkills,
  zh,
}: {
  agent: Agent;
  onEdit: () => void;
  onDelete: () => void;
  allSkills: Skill[];
  zh: boolean;
}) {
  const skillNames = agent.skill_ids
    .map((id) => allSkills.find((skill) => skill.id === id))
    .filter(Boolean) as Skill[];
  const hints = getAgentExperienceHints(agent, allSkills, zh);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-medium text-neutral-100">{agent.name}</h3>
            {agent.scope === "global" ? (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                <Lock className="h-2.5 w-2.5" />
                {zh ? "管理员提供" : "Admin-provided"}
              </span>
            ) : (
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-neutral-400">
                {zh ? "我的智能体" : "My agent"}
              </span>
            )}
          </div>
          {agent.description ? <p className="mt-1 text-xs text-neutral-400">{agent.description}</p> : null}
        </div>
        {agent.scope !== "global" ? (
          <div className="flex gap-1">
            <button onClick={onEdit} className="rounded p-1.5 text-neutral-400 hover:bg-white/5 hover:text-cyan-300">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button onClick={onDelete} className="rounded p-1.5 text-neutral-400 hover:bg-white/5 hover:text-rose-300">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>

      {/* Hints — wrap horizontally, never force a fixed column count so the
          panel stays usable at any width. */}
      <div className="flex flex-wrap gap-2">
        {hints.map((hint) => (
          <span key={hint} className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-neutral-300">
            {hint}
          </span>
        ))}
      </div>

      {/* Stats — small inline meta row, no rigid sidebar. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-white/8 bg-white/[0.02] px-3 py-2.5 text-xs">
        <MetaInline label={zh ? "模型" : "Model"} value={agent.model} />
        <MetaInline label={zh ? "技能数" : "Skills"} value={`${skillNames.length}`} />
        <MetaInline label={zh ? "画布" : "Canvas"} value={agent.canvas_tools ? (zh ? "已开启" : "On") : (zh ? "关闭" : "Off")} />
      </div>

      {/* Persona — full width, prose-friendly so text wraps normally. */}
      <div className="rounded-md border border-white/8 bg-white/[0.02] p-3">
        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
          {zh ? "系统提示词 / 人设" : "System prompt / persona"}
        </div>
        <div className="whitespace-pre-wrap break-words rounded border border-white/10 bg-black/30 p-3 text-xs leading-6 text-neutral-300">
          {agent.system_prompt}
        </div>
      </div>

      {/* Bound skills — full width chip row. */}
      <div className="rounded-md border border-white/8 bg-white/[0.02] p-3">
        <div className="mb-1.5 text-[10px] uppercase tracking-wider text-neutral-500">
          {zh ? "可调用技能" : "Available skills"}
        </div>
        {skillNames.length === 0 ? (
          <div className="text-[11px] text-neutral-500">
            {zh
              ? "暂未绑定技能模板。用户仍可通过 /命令 唤出任何已安装的技能。"
              : "No skills bound. Users can still invoke any installed skill via slash command."}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {skillNames.map((skill) => (
              <span
                key={skill.id}
                className="inline-flex items-center gap-1 rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2.5 py-1 text-[11px] text-cyan-200"
              >
                <Sparkles className="h-3 w-3" />
                {getSkillCommandName(skill)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MetaInline({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</span>
      <span className="text-xs font-medium text-neutral-200">{value}</span>
    </div>
  );
}

function AgentEditor({
  value,
  onChange,
  onSave,
  onCancel,
  allSkills,
  allModels,
  zh,
  saving,
}: {
  value: AgentEditorState;
  onChange: (value: AgentEditorState) => void;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
  allSkills: Skill[];
  allModels: string[];
  zh: boolean;
  saving: boolean;
}) {
  const resolvedModel = allModels.includes(value.model) ? value.model : (allModels[0] ?? "");

  useEffect(() => {
    if (resolvedModel && resolvedModel !== value.model) {
      onChange({ ...value, model: resolvedModel });
    }
  }, [onChange, resolvedModel, value]);

  const toggleSkill = (id: string) => {
    const set = new Set(value.skillIds);
    if (set.has(id)) {
      set.delete(id);
    } else {
      set.add(id);
    }
    onChange({ ...value, skillIds: Array.from(set) });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-cyan-400/15 bg-cyan-500/[0.04] px-3 py-2 text-[11px] leading-5 text-cyan-100">
        {zh
          ? "智能体是一个可对话角色：使用管理员预配模型，保留上下文，并可调用你绑定的技能。"
          : "An agent is a conversation-ready role: it uses an admin-configured model, keeps context, and can invoke the skills you bind to it."}
      </div>

      <Row label={zh ? "智能体名称" : "Agent name"}>
        <input
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
          className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
        />
      </Row>

      <Row label={zh ? "描述 / 人设摘要" : "Description / persona summary"}>
        <textarea
          value={value.description}
          onChange={(event) => onChange({ ...value, description: event.target.value })}
          rows={2}
          className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
        />
      </Row>

      <div className="grid grid-cols-2 gap-3">
        <Row label={zh ? "默认模型" : "Default model"}>
          <select
            value={resolvedModel}
            onChange={(event) => onChange({ ...value, model: event.target.value })}
            className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
          >
            {allModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </Row>
        <Row label={zh ? "上下文策略" : "Context strategy"}>
          <div className="rounded border border-white/10 bg-black/30 px-3 py-2 text-xs text-neutral-300">
            {zh ? "当前会话上下文（默认保留）" : "Current conversation context (kept by default)"}
          </div>
        </Row>
      </div>

      <Row label={zh ? "系统提示词 / 角色设定" : "System prompt / role setup"}>
        <textarea
          value={value.systemPrompt}
          onChange={(event) => onChange({ ...value, systemPrompt: event.target.value })}
          rows={6}
          className="w-full rounded border border-white/10 bg-black/30 p-2 font-mono text-[11px] text-neutral-200 outline-none"
        />
      </Row>

      <Row label={zh ? "可调用技能" : "Available skills"}>
        <div className="prompt-editor-scroll max-h-48 overflow-y-auto rounded border border-white/10 bg-black/20 p-2">
          {allSkills.length === 0 ? (
            <p className="text-[11px] text-neutral-500">
              {zh ? "暂无可绑定的技能模板" : "No prompt-template skills available"}
            </p>
          ) : allSkills.map((skill) => {
            const checked = value.skillIds.includes(skill.id);
            return (
              <label
                key={skill.id}
                className="flex cursor-pointer items-start gap-2 rounded px-2 py-2 text-xs text-neutral-200 hover:bg-white/[0.03]"
              >
                <input type="checkbox" checked={checked} onChange={() => toggleSkill(skill.id)} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate">{skill.name}</span>
                    <span className="rounded bg-cyan-500/10 px-1.5 py-0.5 text-[9px] text-cyan-300">
                      {getSkillCommandName(skill)}
                    </span>
                  </div>
                  {skill.description ? <div className="mt-1 text-[10px] text-neutral-500">{skill.description}</div> : null}
                </div>
              </label>
            );
          })}
        </div>
      </Row>

      <Row label={zh ? "附加能力" : "Extra capabilities"}>
        <label className="flex items-center gap-2 text-xs text-neutral-200">
          <input
            type="checkbox"
            checked={value.canvasTools}
            onChange={(event) => onChange({ ...value, canvasTools: event.target.checked })}
          />
          {zh ? "允许访问当前画布上下文" : "Allow access to current canvas context"}
        </label>
      </Row>

      <Row label={zh ? "启用" : "Enabled"}>
        <label className="flex items-center gap-2 text-xs text-neutral-200">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          />
          {zh ? "允许用户在会话中使用这个智能体" : "Allow this agent to be used in conversation"}
        </label>
      </Row>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-neutral-400 hover:bg-white/5 hover:text-neutral-200">
          {zh ? "取消" : "Cancel"}
        </button>
        <button
          onClick={() => void onSave()}
          disabled={saving || !canSaveAgentEditor(value)}
          className="rounded bg-cyan-500/20 px-3 py-1.5 text-xs text-cyan-200 transition hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? (zh ? "保存中..." : "Saving...") : (zh ? "保存智能体" : "Save agent")}
        </button>
      </div>
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-1 text-xs text-neutral-200">{value}</div>
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
