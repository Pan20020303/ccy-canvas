import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronRight,
  FileUp,
  Layers3,
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
  UserRound,
  X,
} from "lucide-react";

import { createSkill, type Skill } from "../api/skills";
import {
  filterSkillLibrary,
  getSkillCategoryLabel,
  getSkillCategoryOptions,
  getSkillDisplayName,
  type SkillSourceFilter,
} from "../skill-display";
import { getSkillCommandName } from "./settings/skill-agent-presenters";
import { parseSkillMarkdown } from "./settings/skill-import";

export type SkillQuickPickerProps = {
  anchorRef: RefObject<HTMLButtonElement | null>;
  skills: Skill[];
  onPick: (skill: Skill) => void;
  onOpenAll: () => void;
  onClose: () => void;
  zh: boolean;
};

export type SkillLibraryDialogProps = {
  open: boolean;
  skills: Skill[];
  onClose: () => void;
  onPick: (skill: Skill) => void;
  onSkillsChanged?: (nextSkills?: Skill[]) => void | Promise<void>;
  zh: boolean;
};

const SOURCE_TABS: Array<{
  key: SkillSourceFilter;
  zh: string;
  en: string;
  icon: typeof ShieldCheck;
}> = [
  { key: "official", zh: "官方 Skills", en: "Official", icon: ShieldCheck },
  { key: "personal", zh: "个人上传", en: "My uploads", icon: UserRound },
  { key: "all", zh: "全部 Skills", en: "All skills", icon: Layers3 },
];

const CARD_ACCENTS = [
  "bg-orange-500/[0.08] text-orange-200",
  "bg-cyan-500/[0.08] text-cyan-200",
  "bg-violet-500/[0.08] text-violet-200",
  "bg-emerald-500/[0.08] text-emerald-200",
  "bg-rose-500/[0.08] text-rose-200",
];

function openLibrary(
  onOpenAll: SkillQuickPickerProps["onOpenAll"],
  onClose: SkillQuickPickerProps["onClose"],
) {
  onClose();
  onOpenAll();
}

/**
 * Compact composer popover. It intentionally renders no more than five skills;
 * the complete searchable library lives in SkillLibraryDialog.
 */
export function SkillQuickPicker({
  anchorRef,
  skills,
  onPick,
  onOpenAll,
  onClose,
  zh,
}: SkillQuickPickerProps) {
  const quickSkills = skills.filter((skill) => skill.enabled).slice(0, 5);
  const [position, setPosition] = useState<{
    bottom?: number;
    left: number;
    maxHeight: number;
    top?: number;
    width: number;
  } | null>(null);

  useLayoutEffect(() => {
    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const viewportPadding = 12;
      const gap = 8;
      const width = Math.min(340, window.innerWidth - viewportPadding * 2);
      const left = Math.min(
        Math.max(viewportPadding, rect.left),
        window.innerWidth - width - viewportPadding,
      );
      const availableAbove = rect.top - gap - viewportPadding;
      const availableBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
      const placeAbove = availableAbove >= 240 || availableAbove >= availableBelow;

      setPosition({
        bottom: placeAbove ? window.innerHeight - rect.top + gap : undefined,
        left,
        maxHeight: Math.max(96, placeAbove ? availableAbove : availableBelow),
        top: placeAbove ? undefined : rect.bottom + gap,
        width,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef]);

  const pick = (skill: Skill) => {
    onPick(skill);
    onClose();
  };

  if (!position || typeof document === "undefined") return null;

  return createPortal(
    <>
      <button
        type="button"
        aria-label={zh ? "关闭技能选择" : "Close skill picker"}
        className="fixed inset-0 z-[120] cursor-default bg-transparent"
        onClick={onClose}
      />
      <section
        role="menu"
        aria-label={zh ? "常用技能" : "Common skills"}
        className="fixed z-[130] overflow-y-auto rounded-2xl border border-white/[0.10] bg-[#17191e]/98 p-2 shadow-[0_24px_70px_rgba(0,0,0,0.55)] backdrop-blur-xl"
        style={position}
      >
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-orange-500/12 text-orange-300">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <div>
              <div className="text-xs font-semibold text-neutral-100">
                {zh ? "常用 Skills" : "Common skills"}
              </div>
              <div className="text-[10px] text-neutral-500">
                {zh ? "选择一个技能开始创作" : "Pick a skill to get started"}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => openLibrary(onOpenAll, onClose)}
            className="inline-flex items-center gap-0.5 rounded-full px-2 py-1 text-[10px] text-neutral-400 transition hover:bg-white/[0.06] hover:text-white"
          >
            {zh ? "全部" : "All"}
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>

        <div className="space-y-1">
          {quickSkills.map((skill) => (
            <button
              key={skill.id}
              type="button"
              role="menuitem"
              onClick={() => pick(skill)}
              className="group flex w-full items-center gap-2.5 rounded-xl border border-transparent px-2.5 py-2 text-left transition hover:border-white/[0.08] hover:bg-white/[0.055]"
              title={skill.description || getSkillDisplayName(skill)}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.035] text-orange-300 transition group-hover:bg-orange-500/10">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-neutral-200">
                  {getSkillDisplayName(skill)}
                </span>
                <span className="mt-0.5 block truncate text-[10px] text-neutral-500">
                  {getSkillCommandName(skill)} · {getSkillCategoryLabel(skill)}
                </span>
              </span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-700 transition group-hover:translate-x-0.5 group-hover:text-neutral-400" />
            </button>
          ))}
          {quickSkills.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/[0.08] px-3 py-6 text-center text-[11px] text-neutral-500">
              {zh ? "暂无可用 Skill" : "No skills available"}
            </div>
          ) : null}
        </div>

        <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-white/[0.06] pt-2">
          <button
            type="button"
            onClick={() => openLibrary(onOpenAll, onClose)}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-[11px] text-neutral-300 transition hover:bg-white/[0.065] hover:text-white"
          >
            <Upload className="h-3.5 w-3.5" />
            {zh ? "上传 Skill" : "Upload skill"}
          </button>
          <button
            type="button"
            onClick={() => openLibrary(onOpenAll, onClose)}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-orange-500/12 px-3 py-2 text-[11px] text-orange-200 transition hover:bg-orange-500/20"
          >
            <Layers3 className="h-3.5 w-3.5" />
            {zh ? "浏览全部" : "Browse all"}
          </button>
        </div>
      </section>
    </>,
    document.body,
  );
}

export function SkillLibraryDialog({
  open,
  skills,
  onClose,
  onPick,
  onSkillsChanged,
  zh,
}: SkillLibraryDialogProps) {
  const [source, setSource] = useState<SkillSourceFilter>("all");
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [localSkills, setLocalSkills] = useState(skills);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setLocalSkills(skills), [skills]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !uploading) onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open, uploading]);

  useEffect(() => {
    setCategory("");
  }, [source]);

  const sourceSkills = useMemo(
    () => filterSkillLibrary(
      localSkills.filter((skill) => skill.enabled),
      { source },
    ),
    [localSkills, source],
  );
  const categories = useMemo(
    () => getSkillCategoryOptions(sourceSkills),
    [sourceSkills],
  );
  const visibleSkills = useMemo(
    () => filterSkillLibrary(
      sourceSkills,
      { keyword, category },
    ),
    [category, keyword, sourceSkills],
  );

  const choose = (skill: Skill) => {
    onPick(skill);
    onClose();
  };

  const importSkill = async (file: File) => {
    setUploading(true);
    setUploadError("");
    try {
      if (file.size > 2 * 1024 * 1024) {
        throw new Error(zh ? "文件不能超过 2MB" : "The file must be 2MB or smaller");
      }
      const text = await file.text();
      if (!text.trim()) {
        throw new Error(zh ? "Skill 文件不能为空" : "The skill file is empty");
      }
      const fallbackName = file.name.replace(/\.(md|markdown|txt)$/i, "");
      const created = await createSkill(parseSkillMarkdown(text, fallbackName));
      const next = [
        ...localSkills.filter((skill) => skill.id !== created.id),
        created,
      ];
      setLocalSkills(next);
      setSource("personal");
      setCategory("");
      setKeyword("");
      await onSkillsChanged?.(next);
    } catch (error) {
      setUploadError(
        `${zh ? "上传失败：" : "Upload failed: "}${(error as Error).message}`,
      );
    } finally {
      setUploading(false);
    }
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        aria-label={zh ? "关闭技能库" : "Close skill library"}
        className="absolute inset-0 cursor-default bg-black/75 backdrop-blur-sm"
        onClick={() => {
          if (!uploading) onClose();
        }}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-library-title"
        className="relative z-10 flex h-[min(760px,90vh)] w-full max-w-[1120px] flex-col overflow-hidden rounded-2xl border border-white/[0.11] bg-[#15171b] text-neutral-100 shadow-[0_34px_120px_rgba(0,0,0,0.68)]"
      >
        <header className="border-b border-white/[0.07] px-5 pb-3 pt-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-orange-500/13 text-orange-300">
                  <Sparkles className="h-4 w-4" />
                </span>
                <div>
                  <h2 id="skill-library-title" className="text-base font-semibold tracking-tight text-white">
                    {zh ? "Skill 技能库" : "Skill library"}
                  </h2>
                  <p className="mt-0.5 text-[11px] text-neutral-500">
                    {zh ? "选择适合当前创作任务的技能" : "Choose a skill for the current creative task"}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="inline-flex items-center gap-1.5 rounded-full border border-orange-400/25 bg-orange-500/10 px-3 py-1.5 text-[11px] text-orange-200 transition hover:bg-orange-500/18 disabled:cursor-wait disabled:opacity-60"
              >
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}
                {uploading
                  ? (zh ? "正在上传" : "Uploading")
                  : (zh ? "上传自己的 Skill" : "Upload your skill")}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importSkill(file);
                }}
              />
              <button
                type="button"
                onClick={onClose}
                disabled={uploading}
                className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-500 transition hover:bg-white/[0.06] hover:text-white disabled:opacity-40"
                title={zh ? "关闭" : "Close"}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto pb-0.5">
              {SOURCE_TABS.map((tab) => {
                const Icon = tab.icon;
                const active = source === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setSource(tab.key)}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] transition ${
                      active
                        ? "bg-white text-black shadow-sm"
                        : "border border-white/[0.08] bg-white/[0.025] text-neutral-400 hover:bg-white/[0.06] hover:text-neutral-100"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {zh ? tab.zh : tab.en}
                  </button>
                );
              })}
            </div>
            <label className="flex h-9 w-full items-center gap-2 rounded-full border border-white/[0.09] bg-black/25 px-3 text-neutral-500 transition focus-within:border-orange-400/30 focus-within:text-neutral-300 lg:w-[300px]">
              <Search className="h-3.5 w-3.5 shrink-0" />
              <input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder={zh ? "搜索中文名称、描述或命令" : "Search skills"}
                className="min-w-0 flex-1 bg-transparent text-xs text-neutral-100 outline-none placeholder:text-neutral-600"
              />
              {keyword ? (
                <button
                  type="button"
                  onClick={() => setKeyword("")}
                  className="rounded-full p-0.5 text-neutral-600 hover:text-neutral-300"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </label>
          </div>

          <div className="mt-3 flex items-center gap-1.5 overflow-x-auto pb-0.5">
            <button
              type="button"
              onClick={() => setCategory("")}
              className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] transition ${
                !category
                  ? "bg-orange-500/16 text-orange-200"
                  : "bg-white/[0.035] text-neutral-500 hover:text-neutral-200"
              }`}
            >
              {zh ? "全部分类" : "All categories"} · {sourceSkills.length}
            </button>
            {categories.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setCategory(item.label)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] transition ${
                  category === item.label
                    ? "bg-orange-500/16 text-orange-200"
                    : "bg-white/[0.035] text-neutral-500 hover:text-neutral-200"
                }`}
              >
                {item.label} · {item.count}
              </button>
            ))}
          </div>
          {uploadError ? (
            <div className="mt-3 rounded-lg border border-rose-400/20 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-200">
              {uploadError}
            </div>
          ) : null}
        </header>

        <div className="prompt-editor-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          {visibleSkills.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {visibleSkills.map((skill, index) => {
                const official = skill.scope === "global";
                const displayName = getSkillDisplayName(skill);
                return (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => choose(skill)}
                    className="group grid min-h-[126px] grid-cols-[104px_minmax(0,1fr)] overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.025] text-left transition hover:-translate-y-0.5 hover:border-orange-300/25 hover:bg-white/[0.045] hover:shadow-[0_16px_34px_rgba(0,0,0,0.24)]"
                  >
                    <span className={`flex min-h-full items-center justify-center border-r border-white/[0.06] ${CARD_ACCENTS[index % CARD_ACCENTS.length]}`}>
                      <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-black/15">
                        <Sparkles className="h-5 w-5" />
                      </span>
                    </span>
                    <span className="flex min-w-0 flex-col p-3.5">
                      <span className="flex items-start gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-neutral-100 group-hover:text-white">
                            {displayName}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[9.5px] text-neutral-600">
                            {getSkillCommandName(skill)}
                          </span>
                        </span>
                        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] ${
                          official
                            ? "bg-orange-500/12 text-orange-300"
                            : "bg-cyan-500/12 text-cyan-300"
                        }`}>
                          {official ? <ShieldCheck className="h-2.5 w-2.5" /> : <UserRound className="h-2.5 w-2.5" />}
                          {official ? (zh ? "官方" : "Official") : (zh ? "我的" : "Mine")}
                        </span>
                      </span>
                      <span className="mt-2 line-clamp-2 text-[11px] leading-[1.55] text-neutral-500">
                        {skill.description || (zh ? "选择此技能辅助完成当前创作任务。" : "Use this skill for the current task.")}
                      </span>
                      <span className="mt-auto flex items-center justify-between pt-2 text-[10px]">
                        <span className="truncate rounded-full bg-white/[0.045] px-2 py-0.5 text-neutral-500">
                          {getSkillCategoryLabel(skill)}
                        </span>
                        <span className="inline-flex items-center gap-1 text-neutral-600 transition group-hover:text-orange-300">
                          {zh ? "使用" : "Use"}
                          <ChevronRight className="h-3 w-3" />
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="grid min-h-[320px] place-items-center">
              <div className="max-w-sm text-center">
                <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-dashed border-white/[0.10] text-neutral-600">
                  <Search className="h-5 w-5" />
                </span>
                <div className="mt-3 text-sm font-medium text-neutral-300">
                  {zh ? "没有找到匹配的 Skill" : "No matching skills"}
                </div>
                <div className="mt-1 text-[11px] leading-5 text-neutral-600">
                  {zh ? "尝试更换关键词或分类，也可以上传自己的 Skill。" : "Try another keyword or upload your own skill."}
                </div>
              </div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-white/[0.07] px-5 py-3 text-[10px] text-neutral-600 sm:px-6">
          <span>
            {zh ? `共 ${visibleSkills.length} 个可选 Skill` : `${visibleSkills.length} skills`}
          </span>
          <span className="inline-flex items-center gap-1">
            <Check className="h-3 w-3" />
            {zh ? "选择后会插入当前对话" : "Selection is inserted into the conversation"}
          </span>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
