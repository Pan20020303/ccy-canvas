import { useEffect, useRef, useState, type ChangeEvent } from "react";
import Editor, { loader, type BeforeMount, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { Loader2, Undo2, Upload, X } from "lucide-react";

type MonacoWorkerGlobal = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_workerId: string, label: string) => Worker;
  };
};

(globalThis as MonacoWorkerGlobal).MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

export type ProviderCodeEditorModalProps = {
  open: boolean;
  title?: string;
  description?: string;
  initialCode: string;
  saving?: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: (code: string) => void;
};

const CREATOR_SUITE_MONACO_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  fontSize: 14,
  automaticLayout: true,
  tabSize: 2,
  scrollBeyondLastLine: false,
  formatOnPaste: true,
  formatOnType: true,
  lineNumbers: "on",
  glyphMargin: false,
  folding: true,
  wordWrap: "off",
  minimap: {
    enabled: true,
    renderCharacters: true,
    side: "right",
    showSlider: "mouseover",
    size: "fit",
    maxColumn: 80,
  },
  overviewRulerBorder: false,
  renderLineHighlight: "none",
  bracketPairColorization: { enabled: true },
  matchBrackets: "always",
  smoothScrolling: true,
  cursorBlinking: "smooth",
  cursorSmoothCaretAnimation: "on",
  padding: { top: 6, bottom: 6 },
  fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, 'Courier New', monospace",
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
    useShadows: false,
  },
};

const handleMonacoBeforeMount: BeforeMount = (monacoInstance) => {
  monacoInstance.editor.defineTheme("creator-suite-vs-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6A9955" },
      { token: "keyword", foreground: "569CD6" },
      { token: "string", foreground: "CE9178" },
      { token: "number", foreground: "B5CEA8" },
      { token: "type", foreground: "4EC9B0" },
      { token: "identifier", foreground: "9CDCFE" },
    ],
    colors: {
      "editor.background": "#1e1e1e",
      "editor.foreground": "#d4d4d4",
      "editorGutter.background": "#1e1e1e",
      "editorLineNumber.foreground": "#858585",
      "editorLineNumber.activeForeground": "#c6c6c6",
      "editor.selectionBackground": "#264f78",
      "editor.inactiveSelectionBackground": "#3a3d41",
      "editorCursor.foreground": "#ffffff",
      "editorIndentGuide.background1": "#404040",
      "editorIndentGuide.activeBackground1": "#707070",
      "editorWidget.background": "#252526",
      "minimap.background": "#1e1e1e",
      "scrollbarSlider.background": "#79797966",
      "scrollbarSlider.hoverBackground": "#646464b3",
      "scrollbarSlider.activeBackground": "#bfbfbf66",
    },
  });
  monacoInstance.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monacoInstance.languages.typescript.ScriptTarget.ESNext,
    allowNonTsExtensions: true,
    moduleResolution: monacoInstance.languages.typescript.ModuleResolutionKind.NodeJs,
    module: monacoInstance.languages.typescript.ModuleKind.ESNext,
    noEmit: true,
    esModuleInterop: true,
    allowJs: true,
  });
};

export default function ProviderCodeEditorModal({
  open,
  title = "代码",
  description = "请编写 TypeScript 代码配置供应商信息",
  initialCode,
  saving,
  error,
  onClose,
  onConfirm,
}: ProviderCodeEditorModalProps) {
  const [draft, setDraft] = useState(initialCode);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) setDraft(initialCode);
  }, [initialCode, open]);

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setDraft(await file.text());
    event.target.value = "";
  };

  const handleEditorMount: OnMount = (editor) => {
    editor.focus();
    requestAnimationFrame(() => editor.layout());
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/72 px-5 backdrop-blur-sm">
      <div className="flex h-[78vh] w-full max-w-[1344px] flex-col rounded-2xl border border-white/[0.08] bg-[#111111] text-neutral-100 shadow-[0_28px_90px_rgba(0,0,0,0.45)]">
        <header className="flex items-start justify-between px-7 pb-4 pt-7">
          <div>
            <h3 className="text-base font-semibold">{title}</h3>
            <p className="mt-5 flex items-center gap-2 text-xs text-neutral-500">
              <span className="grid h-4 w-4 place-items-center rounded-full border border-white/[0.18] text-[10px]">i</span>
              {description}
            </p>
          </div>
          <button className="rounded-full p-1 text-neutral-500 transition hover:bg-white/[0.08] hover:text-white" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex items-center justify-end gap-2 px-7 pb-3">
          <button
            type="button"
            onClick={() => setDraft(initialCode)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs text-neutral-400 transition hover:bg-white/[0.08] hover:text-white"
          >
            <Undo2 className="h-3.5 w-3.5" />
            重置
          </button>
          <input ref={fileInputRef} type="file" accept=".ts,.tsx,.js,.mjs,.txt" className="hidden" onChange={handleImportFile} />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.045] px-3 text-xs text-neutral-200 transition hover:border-white/[0.16] hover:bg-white/[0.075] hover:text-white"
          >
            <Upload className="h-3.5 w-3.5" />
            导入文件
          </button>
        </div>

        <div className="mx-7 min-h-0 flex-1 overflow-hidden rounded-lg border border-white/[0.08] bg-[#1e1e1e]">
          <Editor
            value={draft}
            language="typescript"
            theme="creator-suite-vs-dark"
            beforeMount={handleMonacoBeforeMount}
            onMount={handleEditorMount}
            onChange={(value) => setDraft(value ?? "")}
            options={CREATOR_SUITE_MONACO_OPTIONS}
            loading={<div className="grid h-full place-items-center bg-[#1e1e1e] text-sm text-neutral-400">加载代码编辑器...</div>}
          />
        </div>

        {error ? <div className="mx-7 mt-3 rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div> : null}

        <footer className="flex items-center justify-end gap-3 px-7 py-5">
          <button type="button" onClick={onClose} className="h-9 rounded border border-white/[0.08] bg-white/[0.045] px-5 text-sm text-neutral-200 transition hover:border-white/[0.16] hover:bg-white/[0.075] hover:text-white">
            取消
          </button>
          <button
            type="button"
            onClick={() => onConfirm(draft)}
            disabled={saving}
            className="inline-flex h-9 items-center rounded border border-white/[0.10] bg-white/[0.075] px-5 text-sm font-medium text-white transition hover:border-white/[0.18] hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            确认
          </button>
        </footer>
      </div>
    </div>
  );
}
