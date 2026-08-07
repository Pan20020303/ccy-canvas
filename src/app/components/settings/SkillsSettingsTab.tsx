import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link as LinkIcon, Loader2, Lock, Pencil, Play, Plus, RefreshCw, Slash, Trash2, Upload } from "lucide-react";

import { fetchSkillMarkdown, parseSkillMarkdown } from "./skill-import";

import {
  createSkill,
  deleteSkill,
  invokeSkill,
  listSkills,
  updateSkill,
  type Skill,
  type SkillUpsert,
} from "../../api/skills";
import { useStore } from "../../store";
import {
  buildPromptSkillSpec,
  getSkillCommandName,
  getSkillTemplateBody,
  isPromptTemplateSkill,
} from "./skill-agent-presenters";

type PromptSkillEditorState = {
  name: string;
  description: string;
  category: string;
  commandName: string;
  content: string;
  systemPrompt: string;
  modelHint: string;
  enabled: boolean;
};

const EMPTY_PROMPT_TEMPLATE = {
  zh: "请基于当前上下文完成这项技能。\n\n输入内容：\n{{input}}",
  en: "Use the current conversation context to complete this skill.\n\nUser input:\n{{input}}",
};

export function SkillsSettingsTab() {
  const language = useStore((s) => s.language);
  const zh = language === "zh";

  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PromptSkillEditorState | null>(null);
  const [creating, setCreating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSkills(await listSkills());
    } catch {
      // Keep the current view stable if the fetch fails.
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => skills.find((s) => s.id === selectedId) ?? null,
    [skills, selectedId],
  );

  const visibleSkills = useMemo(
    () => skills.filter((skill) => skill.kind === "prompt"),
    [skills],
  );

  // Import a Markdown skill file (Claude SKILL.md / plain prompt template).
  // Creates the skill server-side, then selects it for review.
  const importFromFile = async (file: File) => {
    try {
      const text = await file.text();
      const fallbackName = file.name.replace(/\.(md|markdown|txt)$/i, "");
      const payload = parseSkillMarkdown(text, fallbackName);
      const created = await createSkill(payload);
      await load();
      setSelectedId(created.id);
      setEditing(null);
      setCreating(false);
    } catch (err) {
      alert((zh ? "导入失败：" : "Import failed: ") + (err as Error).message);
    }
  };

  const importFromURL = async () => {
    const url = window.prompt(zh ? "输入 .md 文件 URL（建议 raw GitHub / gist）" : "Enter URL of a .md skill file (raw GitHub / gist recommended)");
    if (!url) return;
    try {
      const text = await fetchSkillMarkdown(url.trim());
      const fallback = url.split("/").pop()?.replace(/\.(md|markdown)$/i, "") || "imported-skill";
      const payload = parseSkillMarkdown(text, fallback);
      const created = await createSkill(payload);
      await load();
      setSelectedId(created.id);
      setEditing(null);
      setCreating(false);
    } catch (err) {
      alert((zh ? "URL 拉取失败（可能是 CORS）：" : "URL fetch failed (likely CORS): ") + (err as Error).message);
    }
  };

  const startCreate = () => {
    setCreating(true);
    setSelectedId(null);
    setEditing({
      name: zh ? "新技能" : "New skill",
      description: "",
      category: "workflow",
      commandName: "new-skill",
      content: zh ? EMPTY_PROMPT_TEMPLATE.zh : EMPTY_PROMPT_TEMPLATE.en,
      systemPrompt: "",
      modelHint: "",
      enabled: true,
    });
  };

  const startEdit = (skill: Skill) => {
    if (skill.scope === "global") {
      return;
    }

    const spec = skill.spec as Record<string, unknown>;
    setCreating(false);
    setSelectedId(skill.id);
    setEditing({
      name: skill.name,
      description: skill.description,
      category: skill.category,
      commandName: getSkillCommandName(skill).replace(/^\/+/, ""),
      content: getSkillTemplateBody(skill),
      systemPrompt: typeof spec.system_prompt === "string" ? spec.system_prompt : "",
      modelHint: typeof spec.model_hint === "string" ? spec.model_hint : "",
      enabled: skill.enabled,
    });
  };

  const save = async () => {
    if (!editing) {
      return;
    }

    const payload: SkillUpsert = {
      name: editing.name.trim(),
      description: editing.description,
      category: editing.category,
      icon: "",
      kind: "prompt",
      spec: buildPromptSkillSpec({
        commandName: editing.commandName,
        content: editing.content,
        systemPrompt: editing.systemPrompt,
        modelHint: editing.modelHint,
      }),
      input_schema: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
      },
      output_schema: {},
      enabled: editing.enabled,
    };

    if (creating) {
      const created = await createSkill(payload);
      await load();
      setSelectedId(created.id);
    } else if (selectedId) {
      await updateSkill(selectedId, payload);
      await load();
    }

    setEditing(null);
    setCreating(false);
  };

  const remove = async (skill: Skill) => {
    if (skill.scope === "global") {
      return;
    }
    if (!confirm(zh ? `确定删除技能「${skill.name}」？` : `Delete skill "${skill.name}"?`)) {
      return;
    }
    await deleteSkill(skill.id);
    if (selectedId === skill.id) {
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
              {zh ? "技能模板" : "Skill templates"}
            </div>
            <div className="mt-1 text-[10px] text-neutral-500">
              {zh ? "用 /技能名 调用可复用提示词" : "Reusable prompts invoked with /command"}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={load} title={zh ? "刷新" : "Refresh"} className="rounded p-1 text-neutral-500 hover:bg-white/5 hover:text-neutral-200">
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button onClick={() => fileInputRef.current?.click()} title={zh ? "从本地 .md 导入" : "Import .md file"} className="rounded p-1 text-neutral-400 hover:bg-white/5 hover:text-cyan-200">
              <Upload className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => void importFromURL()} title={zh ? "从 URL 导入" : "Import from URL"} className="rounded p-1 text-neutral-400 hover:bg-white/5 hover:text-cyan-200">
              <LinkIcon className="h-3.5 w-3.5" />
            </button>
            <button onClick={startCreate} title={zh ? "新建技能" : "New skill"} className="rounded p-1 text-cyan-300 hover:bg-cyan-500/10">
              <Plus className="h-3.5 w-3.5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,text/markdown,text/plain"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importFromFile(file);
              }}
            />
          </div>
        </div>
        <div className="prompt-editor-scroll flex-1 overflow-y-auto">
          {visibleSkills.length === 0 && !loading ? (
            <div className="px-4 py-8 text-center text-xs text-neutral-500">
              {zh ? "暂无技能模板。点击右上角 + 新建一个 slash 技能。" : "No skill templates yet. Click + to create a slash skill."}
            </div>
          ) : null}
          {visibleSkills.map((skill) => (
            <button
              key={skill.id}
              onClick={() => {
                setSelectedId(skill.id);
                setEditing(null);
                setCreating(false);
              }}
              className={`w-full border-b border-white/5 px-3 py-3 text-left transition ${
                selectedId === skill.id ? "bg-cyan-500/10" : "hover:bg-white/[0.03]"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`truncate rounded-md px-2 py-0.5 font-mono text-[11px] ${
                  selectedId === skill.id ? "bg-cyan-500/30 text-cyan-100" : "bg-cyan-500/10 text-cyan-300"
                }`}>
                  {getSkillCommandName(skill)}
                </span>
                {skill.scope === "global" ? <Lock className="h-3 w-3 shrink-0 text-amber-300/70" /> : null}
              </div>
              <div className="mt-1.5 truncate text-[11px] text-neutral-300">{skill.name}</div>
              {skill.description ? (
                <div className="mt-0.5 truncate text-[10px] text-neutral-500">{skill.description}</div>
              ) : null}
            </button>
          ))}
        </div>
      </div>

      <div className="prompt-editor-scroll flex-1 overflow-y-auto rounded-xl border border-white/10 px-5 py-4">
        {editing ? (
          <SkillEditor
            value={editing}
            onChange={setEditing}
            onSave={save}
            onCancel={() => {
              setEditing(null);
              setCreating(false);
            }}
            zh={zh}
          />
        ) : selected ? (
          <SkillDetail skill={selected} onEdit={() => startEdit(selected)} onDelete={() => remove(selected)} zh={zh} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            {zh ? "选择左侧技能模板查看，或点击右上角 + 新建。" : "Select a skill template on the left, or click + to create one."}
          </div>
        )}
      </div>
    </div>
  );
}

function SkillDetail({
  skill,
  onEdit,
  onDelete,
  zh,
}: {
  skill: Skill;
  onEdit: () => void;
  onDelete: () => void;
  zh: boolean;
}) {
  const [inputs, setInputs] = useState('{"input":"Rewrite this paragraph in a warmer tone."}');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState("");
  const commandName = getSkillCommandName(skill);
  const templateBody = getSkillTemplateBody(skill);

  const run = async () => {
    setRunning(true);
    setResult("");
    try {
      const parsed = JSON.parse(inputs || "{}");
      const response = await invokeSkill(skill.id, parsed);
      setResult(`OK ${response.duration_ms}ms\n\n${response.content}`);
    } catch (error: unknown) {
      setResult(`ERR ${(error as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-medium text-neutral-100">{skill.name}</h3>
            <span className="inline-flex items-center gap-1 rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] text-cyan-300">
              <Slash className="h-2.5 w-2.5" />
              {commandName}
            </span>
            {skill.scope === "global" ? (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                <Lock className="h-2.5 w-2.5" />
                {zh ? "管理员提供" : "Admin-provided"}
              </span>
            ) : (
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-neutral-400">
                {zh ? "我的模板" : "My template"}
              </span>
            )}
          </div>
          {skill.description ? <p className="mt-1 text-xs leading-5 text-neutral-400">{skill.description}</p> : null}
        </div>
        {skill.scope !== "global" ? (
          <div className="flex items-center gap-1">
            <button onClick={onEdit} className="rounded p-1.5 text-neutral-400 hover:bg-white/5 hover:text-cyan-300">
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button onClick={onDelete} className="rounded p-1.5 text-neutral-400 hover:bg-white/5 hover:text-rose-300">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>

      {/* Inline meta row — same idea as AgentDetail, no rigid 2-column grid
          that breaks under the modal's narrow width. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-white/8 bg-white/[0.02] px-3 py-2.5 text-xs">
        <MetaInlineSkill label={zh ? "调用方式" : "Invoke as"} value={commandName} />
        <MetaInlineSkill label={zh ? "分类" : "Category"} value={skill.category || (zh ? "未分类" : "Uncategorized")} />
        <MetaInlineSkill
          label={zh ? "类型" : "Type"}
          value={isPromptTemplateSkill(skill) ? (zh ? "提示词模板" : "Prompt template") : skill.kind}
        />
      </div>

      <div className="rounded-md border border-white/8 bg-white/[0.02] p-3">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-neutral-400">
          {zh ? "模板内容（Markdown / Prompt）" : "Template content (Markdown / Prompt)"}
        </div>
        <pre className="prompt-editor-scroll max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-3 text-[11px] leading-6 text-neutral-200">
          {templateBody || (zh ? "暂无模板内容" : "No template content")}
        </pre>
      </div>

      <div className="rounded border border-cyan-400/15 bg-cyan-500/[0.04] px-3 py-2 text-[11px] leading-5 text-cyan-100">
        {zh
          ? "这个技能会作为可复用模板供用户或智能体通过 /命令 调用。"
          : "This skill is exposed as a reusable template that users or agents can invoke via slash command."}
      </div>
      <div className="rounded-md border border-cyan-400/15 bg-cyan-500/[0.04] p-3">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-cyan-200">
          {zh ? "试运行（兼容现有执行器）" : "Test run (compatible with current executor)"}
        </div>
        <textarea
          value={inputs}
          onChange={(event) => setInputs(event.target.value)}
          rows={5}
          spellCheck={false}
          className="w-full rounded border border-white/10 bg-black/30 p-2 font-mono text-[11px] text-neutral-200 outline-none focus:border-cyan-400/40"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            onClick={run}
            disabled={running}
            className="flex items-center gap-1 rounded-md bg-cyan-500/15 px-3 py-1.5 text-xs text-cyan-200 transition hover:bg-cyan-500/25 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
            {zh ? "用当前模板运行" : "Run template"}
          </button>
        </div>
        {result ? (
          <pre className="prompt-editor-scroll mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-black/40 p-2 font-mono text-[11px] text-neutral-200">{result}</pre>
        ) : null}
      </div>
    </div>
  );
}

function SkillEditor({
  value,
  onChange,
  onSave,
  onCancel,
  zh,
}: {
  value: PromptSkillEditorState;
  onChange: (value: PromptSkillEditorState) => void;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
  zh: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-cyan-400/15 bg-cyan-500/[0.04] px-3 py-2 text-[11px] leading-5 text-cyan-100">
        {zh
          ? "技能是可复用的提示词模板。用户或智能体可以通过 /命令 调用它。"
          : "Skills are reusable prompt templates. Users or agents can invoke them with a slash command."}
      </div>

      <Row label={zh ? "技能名称" : "Skill name"}>
        <input
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
          className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
        />
      </Row>

      <div className="grid grid-cols-2 gap-3">
        <Row label={zh ? "Slash 命令" : "Slash command"}>
          <div className="flex items-center rounded border border-white/10 bg-black/30 px-2">
            <span className="text-xs text-neutral-500">/</span>
            <input
              value={value.commandName}
              onChange={(event) => onChange({ ...value, commandName: event.target.value.replace(/^\/+/, "") })}
              className="w-full bg-transparent p-2 text-xs text-neutral-100 outline-none"
            />
          </div>
        </Row>
        <Row label={zh ? "分类" : "Category"}>
          <input
            value={value.category}
            onChange={(event) => onChange({ ...value, category: event.target.value })}
            className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
          />
        </Row>
      </div>

      <Row label={zh ? "描述" : "Description"}>
        <textarea
          value={value.description}
          onChange={(event) => onChange({ ...value, description: event.target.value })}
          rows={2}
          className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
        />
      </Row>

      <Row label={zh ? "模板内容（Markdown / Prompt）" : "Template content (Markdown / Prompt)"}>
        <textarea
          value={value.content}
          onChange={(event) => onChange({ ...value, content: event.target.value })}
          rows={10}
          spellCheck={false}
          className="w-full rounded border border-white/10 bg-black/30 p-2 font-mono text-[11px] text-neutral-200 outline-none"
        />
        <p className="mt-1 text-[10px] text-neutral-500">
          {zh ? "建议在内容中使用当前上下文，必要时可写 {{input}} 占位。" : "Use conversation context directly; add {{input}} when you want an explicit placeholder."}
        </p>
      </Row>

      <div className="grid grid-cols-2 gap-3">
        <Row label={zh ? "系统提示（可选）" : "System prompt (optional)"}>
          <textarea
            value={value.systemPrompt}
            onChange={(event) => onChange({ ...value, systemPrompt: event.target.value })}
            rows={4}
            className="w-full rounded border border-white/10 bg-black/30 p-2 font-mono text-[11px] text-neutral-200 outline-none"
          />
        </Row>
        <Row label={zh ? "模型提示（可选）" : "Model hint (optional)"}>
          <input
            value={value.modelHint}
            onChange={(event) => onChange({ ...value, modelHint: event.target.value })}
            placeholder={zh ? "例如：gpt-4.1-mini" : "For example: gpt-4.1-mini"}
            className="w-full rounded border border-white/10 bg-black/30 p-2 text-xs text-neutral-100 outline-none"
          />
        </Row>
      </div>

      <Row label={zh ? "启用" : "Enabled"}>
        <label className="flex items-center gap-2 text-xs text-neutral-200">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          />
          {zh ? "允许用户和智能体调用" : "Allow users and agents to invoke this skill"}
        </label>
      </Row>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-neutral-400 hover:bg-white/5 hover:text-neutral-200">
          {zh ? "取消" : "Cancel"}
        </button>
        <button onClick={() => void onSave()} className="rounded bg-cyan-500/20 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/30">
          {zh ? "保存技能" : "Save skill"}
        </button>
      </div>
    </div>
  );
}

function MetaInlineSkill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</span>
      <span className="text-xs font-medium text-neutral-200">{value}</span>
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
