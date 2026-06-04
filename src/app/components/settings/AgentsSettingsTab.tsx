import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Lock, MessageSquareText, Pencil, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";

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
import {
  getAgentAvailableModels,
  getAgentExperienceHints,
  getSkillCommandName,
  isPromptTemplateSkill,
} from "./skill-agent-presenters";

type AgentEditorState = {
  name: string;
  description: string;
  persona: string;
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AgentEditorState | null>(null);
  const [creating, setCreating] = useState(false);

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
    try {
      const [agentsResult, skillsResult] = await Promise.all([listAgents(), listSkills()]);
      setAgents(agentsResult);
      setSkills(skillsResult);
    } catch {
      // Keep the current UI stable on fetch failures.
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const startCreate = () => {
    setCreating(true);
    setSelectedId(null);
    setEditing({
      name: zh ? "新智能体" : "New agent",
      description: "",
      persona: zh ? "你是一位高效、可靠的智能体，善于基于上下文完成任务。" : "You are a reliable, context-aware agent who helps move work forward.",
      systemPrompt: zh ? "优先使用当前会话上下文、绑定技能与管理员预配模型完成任务。" : "Use current conversation context, bound skills, and admin-configured models to complete the task.",
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
    setCreating(false);
    setSelectedId(agent.id);
    setEditing({
      name: agent.name,
      description: agent.description,
      persona: agent.description || "",
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

    const payload: AgentUpsert = {
      name: editing.name.trim(),
      description: editing.description,
      avatar: "",
      system_prompt: editing.systemPrompt,
      model: editing.model,
      skill_ids: editing.skillIds,
      canvas_tools: editing.canvasTools,
      strategy: "reactive",
      enabled: editing.enabled,
    };

    if (creating) {
      await createAgent(payload);
    } else if (selectedId) {
      await updateAgent(selectedId, payload);
    }

    await load();
    setEditing(null);
    setCreating(false);
  };

  const remove = async (agent: Agent) => {
    if (agent.scope === "global") {
      return;
    }
    if (!confirm(zh ? `确定删除智能体「${agent.name}」？` : `Delete agent "${agent.name}"?`)) {
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
                    <span>•</span>
                    <span>{agent.skill_ids.length} {zh ? "个技能" : "skills"}</span>
                  </div>
                </div>
              </div>
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
            onCancel={() => {
              setEditing(null);
              setCreating(false);
            }}
            allSkills={availableSkills}
            allModels={availableModels}
            zh={zh}
          />
        ) : selected ? (
          <AgentDetail agent={selected} onEdit={() => startEdit(selected)} onDelete={() => remove(selected)} allSkills={availableSkills} zh={zh} />
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
            <button onClick={onEdit} className="rounded p-1.5 text-neutral-400 hover:bg-white/5 hover:text-cyan-300"><Pencil className="h-3.5 w-3.5" /></button>
            <button onClick={onDelete} className="rounded p-1.5 text-neutral-400 hover:bg-white/5 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {hints.map((hint) => (
          <div key={hint} className="rounded-md border border-white/8 bg-white/[0.02] px-3 py-3 text-xs text-neutral-200">
            {hint}
          </div>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="space-y-3 rounded-md border border-white/8 bg-white/[0.02] p-3">
          <MetaItem label={zh ? "默认模型" : "Default model"} value={agent.model} />
          <MetaItem label={zh ? "上下文" : "Context"} value={zh ? "保留当前会话上下文" : "Keeps current conversation context"} />
          <MetaItem label={zh ? "技能数量" : "Skill count"} value={`${skillNames.length}`} />
          <MetaItem label={zh ? "画布能力" : "Canvas access"} value={agent.canvas_tools ? (zh ? "已开启" : "Enabled") : (zh ? "已关闭" : "Disabled")} />
        </div>

        <div className="space-y-3 rounded-md border border-white/8 bg-white/[0.02] p-3">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">{zh ? "系统提示 / 人设" : "System prompt / persona"}</div>
            <pre className="rounded border border-white/10 bg-black/30 p-3 text-[11px] whitespace-pre-wrap text-neutral-300">{agent.system_prompt}</pre>
          </div>

          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">{zh ? "可调用技能" : "Available skills"}</div>
            {skillNames.length === 0 ? (
              <div className="rounded border border-dashed border-white/10 px-3 py-3 text-xs text-neutral-500">
                {zh ? "暂未绑定技能。这个智能体仍可用当前模型与上下文对话。" : "No skills bound yet. The agent can still talk using its current model and conversation context."}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {skillNames.map((skill) => (
                  <span key={skill.id} className="inline-flex items-center gap-1 rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200">
                    <Sparkles className="h-3 w-3" />
                    {getSkillCommandName(skill)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded border border-cyan-400/15 bg-cyan-500/[0.04] px-3 py-2 text-[11px] text-cyan-100">
        {zh
          ? "这个智能体会使用管理员预配模型，并在当前会话里保留上下文。用户可通过 /技能名 调用已绑定技能。"
          : "This agent uses an admin-configured model, keeps current conversation context, and can invoke bound skills via slash commands."}
      </div>
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
}: {
  value: AgentEditorState;
  onChange: (value: AgentEditorState) => void;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
  allSkills: Skill[];
  allModels: string[];
  zh: boolean;
}) {
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
          onChange={(event) => onChange({ ...value, description: event.target.value, persona: event.target.value })}
          rows={2}
          className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
        />
      </Row>

      <div className="grid grid-cols-2 gap-3">
        <Row label={zh ? "默认模型" : "Default model"}>
          <select
            value={value.model}
            onChange={(event) => onChange({ ...value, model: event.target.value })}
            className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
          >
            {allModels.map((model) => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
        </Row>
        <Row label={zh ? "上下文策略" : "Context strategy"}>
          <div className="rounded border border-white/10 bg-black/30 px-3 py-2 text-xs text-neutral-300">
            {zh ? "当前会话上下文（默认保留）" : "Current conversation context (kept by default)"}
          </div>
        </Row>
      </div>

      <Row label={zh ? "系统提示 / 角色设定" : "System prompt / role setup"}>
        <textarea
          value={value.systemPrompt}
          onChange={(event) => onChange({ ...value, systemPrompt: event.target.value })}
          rows={6}
          className="w-full rounded border border-white/10 bg-black/30 p-2 font-mono text-[11px] text-neutral-200 outline-none"
        />
      </Row>

      <Row label={zh ? "可调用技能" : "Available skills"}>
        <div className="max-h-48 overflow-y-auto rounded border border-white/10 bg-black/20 p-2">
          {allSkills.length === 0 ? (
            <p className="text-[11px] text-neutral-500">{zh ? "暂无可绑定技能模板" : "No prompt-template skills available"}</p>
          ) : allSkills.map((skill) => {
            const checked = value.skillIds.includes(skill.id);
            return (
              <label key={skill.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-2 text-xs text-neutral-200 hover:bg-white/[0.03]">
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
        <button onClick={() => void onSave()} className="rounded bg-cyan-500/20 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/30">
          {zh ? "保存智能体" : "Save agent"}
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
