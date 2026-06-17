import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  Bot,
  BrainCircuit,
  Database,
  FileCode2,
  FileText,
  FolderOpen,
  Globe2,
  Languages,
  Loader2,
  LogOut,
  Monitor,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCog,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";

import { toAdminErrorSummary } from "../../api/errors";
import type { AdapterRuntime, GatewayProtocol, ProviderConfig, ProviderConfigPayload, ServiceType, VendorTemplate } from "../../api/providerConfigs";
import {
  createProviderConfig,
  deleteProviderConfig,
  getEndpointPreview,
  listProviderConfigs,
  previewProviderConfigTSImport,
  resetChannelHealth,
  supportsCustomSubmitQueryEndpoints,
  testChannelConnectivity,
  toggleProviderConfigStatus,
  updateProviderConfig,
  VENDOR_TEMPLATES,
} from "../../api/providerConfigs";
import {
  adminCreateAgent,
  adminCreateSkill,
  adminListAgents,
  adminListSkills,
  adminUpdateAgent,
  adminUpdateSkill,
  type Agent,
  type AgentUpsert,
  type Skill,
  type SkillUpsert,
} from "../../api/skills";
import { normalizeModelList } from "../../model-config";
import { getSkillCommandName, getSkillTemplateBody, isPromptTemplateSkill } from "../settings/skill-agent-presenters";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ModelBrandIcon } from "../ModelBrandIcon";
import { AdminShell } from "./AdminShell";
import { ChannelHealthBadge } from "./ChannelHealthBadge";

const ProviderCodeEditorModal = lazy(() => import("./ProviderCodeEditorModal"));

const SERVICE_LABELS: Record<ServiceType, string> = {
  text: "文本生成",
  image: "图片生成",
  video: "视频生成",
  audio: "音频生成",
};

const SERVICE_BADGE_STYLES: Record<ServiceType, string> = {
  text: "border-blue-400/20 bg-blue-500/12 text-blue-300",
  image: "border-violet-400/20 bg-violet-500/12 text-violet-300",
  video: "border-pink-400/20 bg-pink-500/12 text-pink-300",
  audio: "border-amber-400/20 bg-amber-500/12 text-amber-300",
};

const STATUS_LABEL: Record<ProviderConfig["status"], string> = {
  enabled: "启用",
  disabled: "禁用",
};

const FIELD_INPUT =
  "w-full rounded-md border border-white/[0.08] bg-white/[0.045] px-3 py-2.5 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-500 focus:border-white/[0.18] focus:bg-white/[0.065] focus:ring-2 focus:ring-white/[0.04]";
const FIELD_SELECT = `${FIELD_INPUT} appearance-none`;
const SETTINGS_INPUT =
  "w-full rounded-md border border-white/[0.08] bg-white/[0.045] px-3 py-2.5 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-500 focus:border-white/[0.18] focus:bg-white/[0.065] focus:ring-2 focus:ring-white/[0.04]";
const SETTINGS_SELECT = `${SETTINGS_INPUT} appearance-none`;
const SETTINGS_BADGE = "rounded-full border border-white/[0.08] bg-white/[0.045] px-2.5 py-1 text-xs text-neutral-300";
const SETTINGS_PANEL_BUTTON =
  "border-white/[0.08] bg-white/[0.045] text-neutral-200 hover:border-white/[0.16] hover:bg-white/[0.075] hover:text-white";
const SETTINGS_PRIMARY_BUTTON =
  "border border-white/[0.10] bg-white/[0.075] text-white hover:border-white/[0.18] hover:bg-white/[0.12]";

type SettingsPanelKey = "model-service" | "agent-config" | "prompt-manage" | "skill-management" | "memory-config";
type SettingsMenuItem = {
  key: SettingsPanelKey | "ui" | "language" | "login" | "database" | "files" | "other" | "request" | "developer" | "update" | "logout";
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
};

const SETTINGS_MENU: SettingsMenuItem[] = [
  { key: "ui", label: "界面设置", icon: Settings2, disabled: true },
  { key: "language", label: "语言设置", icon: Languages, disabled: true },
  { key: "model-service", label: "模型服务", icon: Monitor },
  { key: "agent-config", label: "Agent配置", icon: UserCog },
  { key: "prompt-manage", label: "提示词管理", icon: FileText },
  { key: "skill-management", label: "Skills技能管理", icon: WandSparkles },
  { key: "memory-config", label: "Agent记忆配置", icon: BrainCircuit },
  { key: "login", label: "登录配置", icon: ShieldCheck, disabled: true },
  { key: "database", label: "数据库操作", icon: Database, disabled: true },
  { key: "files", label: "文件管理", icon: FolderOpen, disabled: true },
  { key: "other", label: "其他配置", icon: Settings2, disabled: true },
  { key: "request", label: "请求地址", icon: Globe2, disabled: true },
  { key: "developer", label: "开发者选项", icon: FileCode2, disabled: true },
  { key: "update", label: "检查更新", icon: RefreshCw, disabled: true },
  { key: "logout", label: "退出登录", icon: LogOut, disabled: true },
];

type AgentEditorDraft = {
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  skillIds: string[];
  canvasTools: boolean;
  enabled: boolean;
  strategy: AgentUpsert["strategy"];
};

type MemoryConfigForm = {
  messagesPerSummary: number;
  shortTermLimit: number;
  summaryMaxLength: number;
  summaryLimit: number;
  ragLimit: number;
  deepRetrieveSummaryLimit: number;
  modelOnnxFile: string;
  modelDtype: string;
};

const MEMORY_CONFIG_KEY = "ccy-admin-agent-memory-config";
const DEFAULT_MEMORY_CONFIG: MemoryConfigForm = {
  messagesPerSummary: 3,
  shortTermLimit: 5,
  summaryMaxLength: 500,
  summaryLimit: 10,
  ragLimit: 3,
  deepRetrieveSummaryLimit: 5,
  modelOnnxFile: "all-MiniLM-L6-v2/onnx/model_fp16.onnx",
  modelDtype: "fp16",
};

function ProviderCodeEditorFallback() {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/72 px-5 backdrop-blur-sm">
      <div className="grid h-[78vh] w-full max-w-[1344px] place-items-center rounded-lg bg-white text-sm text-neutral-500 shadow-[0_28px_90px_rgba(0,0,0,0.35)]">
        正在加载代码编辑器...
      </div>
    </div>
  );
}

function serviceCapabilities(serviceType: ServiceType) {
  return [serviceType];
}

type ConfigModalProps = {
  config: ProviderConfig | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

function ConfigModal({ config, open, onClose, onSaved }: ConfigModalProps) {
  const isEdit = Boolean(config);
  const [serviceType, setServiceType] = useState<ServiceType>("image");
  const [vendor, setVendor] = useState("");
  const [apiSpec, setApiSpec] = useState("openai");
  const [protocol, setProtocol] = useState<GatewayProtocol>("openai_compatible");
  const [adapterRuntime, setAdapterRuntime] = useState<AdapterRuntime>("go");
  const [adapterCode, setAdapterCode] = useState("");
  const [iconKey, setIconKey] = useState("");
  const [iconUrl, setIconUrl] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [submitEndpoint, setSubmitEndpoint] = useState("");
  const [queryEndpoint, setQueryEndpoint] = useState("");
  const [modelListText, setModelListText] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [priority, setPriority] = useState(0);
  const [isDefault, setIsDefault] = useState(false);
  const [parameterSchemaText, setParameterSchemaText] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [previewingTS, setPreviewingTS] = useState(false);
  const [error, setError] = useState("");
  const [codeEditorOpen, setCodeEditorOpen] = useState(false);

  const templates = VENDOR_TEMPLATES[serviceType] ?? [];
  const showCustomEndpoints = supportsCustomSubmitQueryEndpoints(apiSpec);
  const endpointPreview = getEndpointPreview(serviceType, apiSpec, submitEndpoint, queryEndpoint, baseUrl);

  useEffect(() => {
    if (!open) return;
    if (config) {
      setServiceType(config.service_type);
      setVendor(config.vendor);
      setApiSpec(config.api_spec || "openai");
      setProtocol(config.protocol || "openai_compatible");
      setAdapterRuntime(config.adapter_runtime || "go");
      setAdapterCode(config.adapter_code || "");
      setIconKey(config.icon_key || "");
      setIconUrl(config.icon_url || "");
      setName(config.name);
      setBaseUrl(config.base_url);
      setApiKey("");
      setSubmitEndpoint(config.submit_endpoint || "");
      setQueryEndpoint(config.query_endpoint || "");
      setModelListText((config.model_list ?? []).join("\n"));
      setDefaultModel(config.default_model || "");
      setPriority(config.priority || 0);
      setIsDefault(Boolean(config.is_default));
      setParameterSchemaText(JSON.stringify(config.parameter_schema ?? {}, null, 2));
    } else {
      setServiceType("image");
      setVendor("");
      setApiSpec("openai");
      setProtocol("openai_compatible");
      setAdapterRuntime("go");
      setAdapterCode("");
      setIconKey("");
      setIconUrl("");
      setName("");
      setBaseUrl("");
      setApiKey("");
      setSubmitEndpoint("");
      setQueryEndpoint("");
      setModelListText("");
      setDefaultModel("");
      setPriority(0);
      setIsDefault(false);
      setParameterSchemaText("{}");
    }
    setError("");
    setCodeEditorOpen(false);
  }, [config, open]);

  const applyTemplate = (tpl: VendorTemplate) => {
    setVendor(tpl.vendor);
    setName(tpl.label);
    setBaseUrl(tpl.baseURL);
    setApiSpec(tpl.apiSpec);
    setProtocol(tpl.protocol || "openai_compatible");
    setAdapterRuntime("go");
    setAdapterCode("");
    setIconKey("");
    setIconUrl("");
    setModelListText(tpl.models.join("\n"));
    setDefaultModel(tpl.models[0] ?? "");
    setSubmitEndpoint(tpl.submitEndpoint ?? "");
    setQueryEndpoint(tpl.queryEndpoint ?? "");
    setParameterSchemaText(JSON.stringify(tpl.parameterSchema ?? {}, null, 2));
  };

  const handlePreviewTSImport = async () => {
    if (!adapterCode.trim()) {
      setError("Please paste TS adapter code first.");
      return;
    }
    setPreviewingTS(true);
    setError("");
    try {
      const preview = await previewProviderConfigTSImport(adapterCode, serviceType);
      setAdapterRuntime("ts");
      setServiceType(preview.service_type);
      setVendor(preview.vendor || "Custom");
      setName(preview.name || preview.vendor || "TS Provider");
      setApiSpec(preview.api_spec || "custom");
      setProtocol(preview.protocol || "openai_compatible");
      setBaseUrl(preview.base_url || "");
      setSubmitEndpoint(preview.submit_endpoint || "");
      setQueryEndpoint(preview.query_endpoint || "");
      setModelListText((preview.model_list ?? []).join("\n"));
      setDefaultModel(preview.default_model || preview.model_list?.[0] || "");
      setParameterSchemaText(JSON.stringify(preview.parameter_schema ?? {}, null, 2));
      setIconKey(preview.icon?.key || "");
      setIconUrl(preview.icon?.url || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse TS adapter.");
    } finally {
      setPreviewingTS(false);
    }
  };

  const handleSave = async () => {
    const modelList = normalizeModelList(modelListText);
    if (!name.trim() || (adapterRuntime !== "ts" && !baseUrl.trim())) {
      setError("名称和 Base URL 不能为空");
      return;
    }
    if (modelList.length === 0) {
      setError("至少填写一个模型名称");
      return;
    }

    if (adapterRuntime === "ts" && !adapterCode.trim()) {
      setError("TS adapter code is required.");
      return;
    }

    let parameterSchema: ProviderConfigPayload["parameter_schema"] = {};
    try {
      parameterSchema = JSON.parse(parameterSchemaText || "{}");
    } catch {
      setError("参数 Schema 必须是合法 JSON");
      return;
    }

    setSaving(true);
    setError("");
    const payload: ProviderConfigPayload = {
      service_type: serviceType,
      vendor: vendor.trim() || "自定义",
      name: name.trim(),
      api_spec: apiSpec,
      protocol,
      base_url: baseUrl.trim(),
      api_key: apiKey.trim() || undefined,
      submit_endpoint: showCustomEndpoints ? submitEndpoint.trim() : "",
      query_endpoint: showCustomEndpoints ? queryEndpoint.trim() : "",
      model_list: modelList,
      default_model: defaultModel.trim() || modelList[0],
      priority,
      is_default: isDefault,
      capabilities: serviceCapabilities(serviceType),
      parameter_schema: parameterSchema,
      adapter_runtime: adapterRuntime,
      adapter_code: adapterRuntime === "ts" ? adapterCode : "",
      icon_key: iconKey.trim() || undefined,
      icon_url: iconUrl.trim() || undefined,
    };
    if (config) {
      payload.status = config.status;
    }

    try {
      if (config) await updateProviderConfig(config.id, payload);
      else await createProviderConfig(payload);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div
      data-testid="provider-config-modal"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 py-[6vh] backdrop-blur-sm"
    >
      <button className="absolute inset-0 cursor-default" aria-label="关闭配置面板" onClick={onClose} />
      <section
        role="dialog"
        aria-modal="true"
        className="relative z-10 flex max-h-[88vh] w-full max-w-[1120px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#111111] text-neutral-100 shadow-[0_28px_90px_rgba(0,0,0,0.45)]"
      >
        <header className="flex items-center justify-between border-b border-white/[0.08] px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-neutral-500">{isEdit ? "编辑配置" : "新增配置"}</p>
            <h3 className="mt-1 text-lg font-semibold text-neutral-100">{isEdit ? config?.name : "模型服务配置"}</h3>
          </div>
          <button className="rounded-full p-2 text-neutral-500 transition hover:bg-white/[0.08] hover:text-white" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
            <aside className="space-y-5 rounded-lg border border-white/[0.08] bg-white/[0.025] p-4">
          <Field label="服务类型">
            <select value={serviceType} onChange={(event) => setServiceType(event.target.value as ServiceType)} className={FIELD_SELECT}>
              {Object.entries(SERVICE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </Field>

          <Field label="中转站模板">
            <div className="grid grid-cols-2 gap-2">
              {templates.slice(0, 8).map((tpl) => (
                <button
                  key={`${tpl.vendor}-${tpl.label}`}
                  type="button"
                  onClick={() => applyTemplate(tpl)}
                  className="flex items-center gap-2 rounded-md border border-white/[0.08] bg-white/[0.045] px-3 py-2 text-left text-xs text-neutral-300 transition hover:border-white/[0.16] hover:bg-white/[0.075] hover:text-white"
                >
                  <ModelBrandIcon model={tpl.models[0]} vendor={tpl.vendor} providerName={tpl.label} size={18} />
                  <span className="min-w-0 flex-1 truncate">{tpl.label}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="供应商 TS 脚本">
            <div className="space-y-3 rounded-md border border-white/[0.08] bg-white/[0.025] p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-xs text-neutral-500">
                  <FileCode2 className="h-4 w-4 text-neutral-400" />
                  粘贴 Toonflow 风格供应商 TS，按当前服务类型解析模型、输入项和图标。
                </span>
                <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={() => setCodeEditorOpen(true)}>
                  <FileCode2 className="mr-2 h-4 w-4" />
                  编辑代码
                </Button>
                <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={handlePreviewTSImport} disabled={previewingTS || !adapterCode.trim()}>
                  {previewingTS ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  解析导入
                </Button>
              </div>
              <button
                type="button"
                onClick={() => setCodeEditorOpen(true)}
                className="flex w-full items-center justify-between rounded-md border border-white/[0.08] bg-white/[0.045] px-4 py-3 text-left transition hover:border-white/[0.16] hover:bg-white/[0.075]"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-neutral-100">{adapterCode.trim() ? "已载入 TS 供应商代码" : "尚未填写 TS 供应商代码"}</span>
                  <span className="mt-1 block text-xs text-neutral-500">
                    {adapterCode.trim()
                      ? `${adapterCode.split(/\r?\n/).length} 行 · ${adapterCode.length} 字符 · 运行时将使用 TypeScript 供应商脚本`
                      : "点击打开大编辑器，可粘贴代码或导入 .ts 文件"}
                  </span>
                </span>
                <FileCode2 className="h-5 w-5 text-neutral-400" />
              </button>
            </div>
          </Field>

            </aside>
            <div className="space-y-5">

          <div className="grid grid-cols-2 gap-3">
            <Field label="厂商"><input value={vendor} onChange={(event) => setVendor(event.target.value)} className={FIELD_INPUT} /></Field>
            <Field label="显示名称"><input value={name} onChange={(event) => setName(event.target.value)} className={FIELD_INPUT} /></Field>
          </div>

          <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
            <Field label="图标 Key"><input value={iconKey} onChange={(event) => setIconKey(event.target.value)} placeholder="openai / gemini / volcengine" className={FIELD_INPUT} /></Field>
            <Field label="图标 URL"><input value={iconUrl} onChange={(event) => setIconUrl(event.target.value)} placeholder="https://... or data:image/..." className={FIELD_INPUT} /></Field>
            <div className="pb-3">
              <ModelBrandIcon model={defaultModel || modelListText.split(/\n/)[0]} vendor={vendor} providerName={name} iconKey={iconKey} iconUrl={iconUrl} size={24} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="协议">
              <select value={protocol} onChange={(event) => setProtocol(event.target.value as GatewayProtocol)} className={FIELD_SELECT}>
                <option value="openai_compatible">OpenAI-compatible</option>
                <option value="newapi">NewAPI</option>
                <option value="native">Native</option>
              </select>
            </Field>
            <Field label="适配器">
              <select value={apiSpec} onChange={(event) => setApiSpec(event.target.value)} className={FIELD_SELECT}>
                <option value="openai">OpenAI</option>
                <option value="custom">Custom</option>
                <option value="ark">Volcengine Ark</option>
              </select>
            </Field>
          </div>

          <Field label="运行时">
            <select value={adapterRuntime} onChange={(event) => setAdapterRuntime(event.target.value as AdapterRuntime)} className={FIELD_SELECT}>
              <option value="go">Go 内置适配器</option>
              <option value="ts">TypeScript 供应商脚本</option>
            </select>
          </Field>

          <Field label="Base URL">
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://example-newapi.com/v1" className={FIELD_INPUT} />
            <p className="mt-2 text-xs text-neutral-500">建议填写到 /v1；后端会对普通根域名自动补 /v1。</p>
          </Field>

          <Field label={isEdit ? "API Key（留空保持不变）" : "API Key"}>
            <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" className={FIELD_INPUT} />
          </Field>

          {showCustomEndpoints ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="提交端点"><input value={submitEndpoint} onChange={(event) => setSubmitEndpoint(event.target.value)} className={FIELD_INPUT} /></Field>
              <Field label="查询端点"><input value={queryEndpoint} onChange={(event) => setQueryEndpoint(event.target.value)} className={FIELD_INPUT} /></Field>
            </div>
          ) : null}

          <div className="rounded-md border border-white/[0.08] bg-white/[0.035] px-4 py-3 text-xs text-neutral-500">
            最终端点：{endpointPreview}
          </div>

          <Field label="模型列表（每行一个）">
            <textarea value={modelListText} onChange={(event) => setModelListText(event.target.value)} className={`${FIELD_INPUT} min-h-28 resize-none py-3`} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="默认模型"><input value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} className={FIELD_INPUT} /></Field>
            <Field label="优先级"><input value={priority} onChange={(event) => setPriority(Number(event.target.value) || 0)} type="number" className={FIELD_INPUT} /></Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} className="accent-neutral-300" />
            设为默认配置
          </label>

          <Field label="参数 Schema JSON">
            <textarea
              value={parameterSchemaText}
              onChange={(event) => setParameterSchemaText(event.target.value)}
              spellCheck={false}
              className={`${FIELD_INPUT} min-h-36 resize-y py-3 font-mono text-xs`}
            />
            <p className="mt-2 text-xs text-neutral-500">控制前端参数按钮和后端允许透传字段，例如 quality_options、size_options、output_format_options、allowed_parameters、defaults。</p>
          </Field>

          {error ? <div className="rounded-md border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-white/[0.08] bg-white/[0.025] px-6 py-4">
          <Button variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={onClose}>取消</Button>
          <Button className={SETTINGS_PRIMARY_BUTTON} onClick={handleSave} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}保存配置</Button>
        </footer>
        {codeEditorOpen ? (
          <Suspense fallback={<ProviderCodeEditorFallback />}>
            <ProviderCodeEditorModal
              open={codeEditorOpen}
              initialCode={adapterCode}
              onClose={() => setCodeEditorOpen(false)}
              onConfirm={(code) => {
                setAdapterCode(code);
                if (code.trim()) setAdapterRuntime("ts");
                setCodeEditorOpen(false);
              }}
            />
          </Suspense>
        ) : null}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm text-neutral-300">
      <span className="mb-2 block text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function SettingsField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm text-neutral-300">
      <span className="mb-2 block text-xs font-medium text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

function ActionIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.035] text-neutral-400 transition hover:border-white/[0.16] hover:bg-white/[0.07] hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
    </button>
  );
}

export function AdminModelCatalogPage() {
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [codeEditingConfig, setCodeEditingConfig] = useState<ProviderConfig | null>(null);
  const [codeSaving, setCodeSaving] = useState(false);
  const [codeError, setCodeError] = useState("");
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanelKey>("model-service");

  const loadConfigs = async () => {
    setLoading(true);
    try {
      setConfigs(await listProviderConfigs());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConfigs();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return configs;
    return configs.filter((config) =>
      [config.name, config.vendor, config.base_url, config.default_model, config.protocol]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(q)),
    );
  }, [configs, query]);

  const enabledCount = configs.filter((item) => item.status === "enabled").length;
  const selectedConfig = filtered.find((config) => config.id === selectedId) ?? filtered[0] ?? null;
  const availableTextModels = useMemo(() => {
    const seen = new Set<string>();
    const models: string[] = [];
    configs
      .filter((config) => config.service_type === "text" && config.status === "enabled")
      .sort((a, b) => a.priority - b.priority)
      .forEach((config) => {
        config.model_list.forEach((model) => {
          const clean = model.trim();
          if (clean && !seen.has(clean)) {
            seen.add(clean);
            models.push(clean);
          }
        });
      });
    return models;
  }, [configs]);

  useEffect(() => {
    if (!filtered.length) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !filtered.some((config) => config.id === selectedId)) {
      setSelectedId(filtered[0].id);
    }
  }, [filtered, selectedId]);

  const openCreate = () => {
    setEditing(null);
    setConfigModalOpen(true);
  };

  const openEdit = (config: ProviderConfig) => {
    setEditing(config);
    setConfigModalOpen(true);
  };

  const replaceConfig = (updated: ProviderConfig) => {
    setConfigs((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  };

  const handleToggle = async (config: ProviderConfig) => {
    replaceConfig(await toggleProviderConfigStatus(config.id));
  };

  const handleResetHealth = async (config: ProviderConfig) => {
    setResettingId(config.id);
    try {
      replaceConfig(await resetChannelHealth(config.id));
    } finally {
      setResettingId(null);
    }
  };

  const handleTestConnectivity = async (config: ProviderConfig) => {
    setTestingId(config.id);
    try {
      const result = await testChannelConnectivity(config.id);
      alert(result.ok ? `连接成功：HTTP ${result.http_status || "OK"}，${result.latency_ms}ms` : `连接失败：${result.error_msg || result.http_status}`);
      await loadConfigs();
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async (config: ProviderConfig) => {
    if (!confirm(`确认删除「${config.name}」？`)) return;
    await deleteProviderConfig(config.id);
    setConfigs((prev) => prev.filter((item) => item.id !== config.id));
  };

  const providerPayloadFromConfig = (config: ProviderConfig): ProviderConfigPayload => ({
    service_type: config.service_type,
    vendor: config.vendor,
    name: config.name,
    api_spec: config.api_spec,
    protocol: config.protocol,
    base_url: config.base_url,
    submit_endpoint: config.submit_endpoint,
    query_endpoint: config.query_endpoint,
    model_list: config.model_list,
    default_model: config.default_model,
    priority: config.priority,
    is_default: config.is_default,
    status: config.status,
    capabilities: config.capabilities,
    parameter_schema: config.parameter_schema,
    adapter_runtime: config.adapter_runtime,
    adapter_code: config.adapter_code || "",
    icon_key: config.icon_key,
    icon_url: config.icon_url,
  });

  const handleSaveCode = async (config: ProviderConfig, code: string) => {
    if (!code.trim()) {
      setCodeError("TS 代码不能为空");
      return;
    }
    setCodeSaving(true);
    setCodeError("");
    try {
      const preview = await previewProviderConfigTSImport(code, config.service_type);
      const payload: ProviderConfigPayload = {
        ...providerPayloadFromConfig(config),
        service_type: preview.service_type || config.service_type,
        vendor: preview.vendor || config.vendor,
        name: preview.name || config.name,
        api_spec: preview.api_spec || config.api_spec,
        protocol: preview.protocol || config.protocol,
        base_url: preview.base_url || config.base_url,
        submit_endpoint: preview.submit_endpoint ?? config.submit_endpoint,
        query_endpoint: preview.query_endpoint ?? config.query_endpoint,
        model_list: preview.model_list?.length ? preview.model_list : config.model_list,
        default_model: preview.default_model || preview.model_list?.[0] || config.default_model,
        capabilities: preview.capabilities?.length ? preview.capabilities : config.capabilities,
        parameter_schema: preview.parameter_schema ?? config.parameter_schema,
        adapter_runtime: "ts",
        adapter_code: code,
        icon_key: preview.icon?.key || config.icon_key,
        icon_url: preview.icon?.url || config.icon_url,
      };
      replaceConfig(await updateProviderConfig(config.id, payload));
      setCodeEditingConfig(null);
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : "TS 代码保存失败");
    } finally {
      setCodeSaving(false);
    }
  };

  const handleDeleteModel = async (config: ProviderConfig, model: string) => {
    const nextModels = (config.model_list ?? []).filter((item) => item !== model);
    if (nextModels.length === config.model_list.length) return;
    replaceConfig(await updateProviderConfig(config.id, {
      ...providerPayloadFromConfig(config),
      model_list: nextModels,
      default_model: config.default_model === model ? nextModels[0] || "" : config.default_model,
    }));
  };

  return (
    <AdminShell
      title="模型配置"
      description="管理 AI 服务模型配置，支持自建 NewAPI、第三方 OpenAI-compatible 中转站和原生厂商。失败只报警，不会自动切换或锁定渠道。"
      action={<Button onClick={openCreate}><Plus className="mr-1 h-4 w-4" />新增模型配置</Button>}
    >
      <div className="space-y-5">
        <section className="rounded-[28px] border border-white/[0.08] bg-white/[0.035] p-4 shadow-2xl shadow-black/30">
          <div className="flex flex-wrap items-center gap-4">
            <StatCard label="配置总数" value={configs.length} />
            <StatCard label="在线模型" value={enabledCount} />
            <div className="relative min-w-[280px] flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-11 w-full rounded-full border border-white/[0.08] bg-black/20 pl-11 pr-4 text-sm text-white outline-none transition focus:border-white/[0.18] focus:ring-2 focus:ring-white/[0.04]"
                placeholder="搜索名称、厂商、Base URL、协议或模型"
              />
            </div>
            <Button variant="secondary" onClick={loadConfigs} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              刷新
            </Button>
          </div>
        </section>

        <section className="overflow-hidden rounded-[28px] border border-white/[0.10] bg-[#101010]/95 text-neutral-100 shadow-2xl shadow-black/35">
          <div className="grid min-h-[680px] grid-cols-[250px_1fr]">
            <SettingsSidebar activeKey={settingsPanel} onSelect={setSettingsPanel} />

            <div className="min-w-0 bg-[#101010]/80 p-5">
              {settingsPanel === "model-service" ? (
                <div data-testid="settings-panel-model-service" className="grid min-h-[620px] grid-cols-[260px_1fr] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#111111]/95">
            <aside className="border-r border-white/[0.06] bg-white/[0.025] p-4">
              <Button onClick={openCreate} className={`mb-3 h-10 w-full rounded-full ${SETTINGS_PRIMARY_BUTTON}`}>
                <Plus className="mr-2 h-4 w-4" />
                添加供应商
              </Button>
              <div className="space-y-1">
                {loading ? (
                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.035] px-4 py-6 text-center text-sm text-neutral-500">加载中...</div>
                ) : filtered.length === 0 ? (
                  <div className="rounded-xl border border-white/[0.08] bg-white/[0.035] px-4 py-6 text-center text-sm text-neutral-500">暂无供应商</div>
                ) : (
                  filtered.map((config) => (
                    <button
                      key={config.id}
                      type="button"
                      onClick={() => setSelectedId(config.id)}
                      className={[
                        "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition",
                        selectedConfig?.id === config.id ? "border-white/[0.14] bg-white/[0.08] text-white shadow-sm" : "border-transparent text-neutral-400 hover:border-white/[0.08] hover:bg-white/[0.045] hover:text-neutral-100",
                      ].join(" ")}
                    >
                      <ModelBrandIcon model={config.default_model || config.model_list?.[0]} vendor={config.vendor} providerName={config.name} iconKey={config.icon_key} iconUrl={config.icon_url} size={18} />
                      <span className="min-w-0 flex-1 truncate">{config.vendor || config.name}</span>
                      <span
                        className={[
                          "relative h-5 w-9 rounded-full transition",
                          config.status === "enabled" ? "bg-emerald-500/70" : "bg-neutral-700",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition",
                            config.status === "enabled" ? "left-[18px]" : "left-0.5",
                          ].join(" ")}
                        />
                      </span>
                    </button>
                  ))
                )}
              </div>
            </aside>

            <div className="flex min-w-0 flex-col bg-[#111111] p-5">
              {selectedConfig ? (
                <>
                  <div className="flex items-center justify-between border-b border-white/[0.08] pb-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <ModelBrandIcon model={selectedConfig.default_model || selectedConfig.model_list?.[0]} vendor={selectedConfig.vendor} providerName={selectedConfig.name} iconKey={selectedConfig.icon_key} iconUrl={selectedConfig.icon_url} size={28} />
                        <div className="min-w-0">
                          <h3 className="truncate text-lg font-semibold text-neutral-100">{selectedConfig.name}</h3>
                          <p className="mt-1 truncate text-xs text-neutral-500">{selectedConfig.vendor} · {selectedConfig.base_url || "TS 供应商脚本"}</p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span className={SETTINGS_BADGE}>{SERVICE_LABELS[selectedConfig.service_type]}</span>
                        <span className={SETTINGS_BADGE}>{selectedConfig.protocol || "openai_compatible"}</span>
                        {selectedConfig.adapter_runtime === "ts" ? <span className={SETTINGS_BADGE}>TS 脚本</span> : null}
                        <span className={SETTINGS_BADGE}>模型 ×{selectedConfig.model_list.length}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="secondary" onClick={() => handleToggle(selectedConfig)}>
                        <Power className="mr-2 h-4 w-4" />
                        {STATUS_LABEL[selectedConfig.status]}
                      </Button>
                      <Button variant="secondary" onClick={() => openEdit(selectedConfig)}>
                        <Pencil className="mr-2 h-4 w-4" />
                        编辑配置
                      </Button>
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto py-4">
                    <div className="space-y-3">
                      {selectedConfig.model_list.length === 0 ? (
                        <div className="rounded-xl border border-dashed border-white/[0.12] bg-white/[0.035] px-4 py-10 text-center text-sm text-neutral-500">该供应商还没有模型</div>
                      ) : (
                        selectedConfig.model_list.map((model) => (
                          <div key={model} className="rounded-xl border border-white/[0.08] bg-white/[0.035] px-5 py-4 shadow-sm transition hover:border-white/[0.16] hover:bg-white/[0.055]">
                            <div className="flex items-start justify-between gap-4">
                              <div className="min-w-0">
                                <div className="flex items-center gap-3">
                                  <ModelBrandIcon model={model} vendor={selectedConfig.vendor} providerName={selectedConfig.name} iconKey={selectedConfig.icon_key} iconUrl={selectedConfig.icon_url} size={22} />
                                  <h4 className="truncate text-base font-semibold text-neutral-100">{model}</h4>
                                </div>
                                <div className="mt-3 flex flex-wrap gap-2">
                                  <span className={SETTINGS_BADGE}>{SERVICE_LABELS[selectedConfig.service_type]}</span>
                                  {selectedConfig.default_model === model ? <span className={SETTINGS_BADGE}>默认模型</span> : null}
                                  {selectedConfig.service_type === "image" ? <span className={SETTINGS_BADGE}>图片 ×9</span> : null}
                                  {selectedConfig.service_type === "video" ? <span className={SETTINGS_BADGE}>视频 ×3</span> : null}
                                  {selectedConfig.service_type === "audio" ? <span className={SETTINGS_BADGE}>音频 ×3</span> : null}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-3 text-xs">
                                <button type="button" onClick={() => handleTestConnectivity(selectedConfig)} className="font-medium text-neutral-400 transition hover:text-white">测试</button>
                                <button type="button" onClick={() => openEdit(selectedConfig)} className="font-medium text-neutral-400 transition hover:text-white">编辑</button>
                                <button type="button" onClick={() => handleDeleteModel(selectedConfig, model)} className="font-medium text-red-500 transition hover:text-red-600">删除</button>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="flex justify-end gap-3 border-t border-white/[0.08] pt-4">
                    <button
                      type="button"
                      onClick={() => handleDelete(selectedConfig)}
                      className="h-10 rounded bg-red-500 px-5 text-sm font-medium text-white transition hover:bg-red-600"
                    >
                      删除供应商
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCodeError("");
                        setCodeEditingConfig(selectedConfig);
                      }}
                      className="h-10 rounded-full border border-white/[0.10] bg-white/[0.035] px-5 text-sm font-medium text-neutral-200 transition hover:border-white/[0.18] hover:bg-white/[0.075] hover:text-white"
                    >
                      编辑代码
                    </button>
                  </div>
                </>
              ) : (
                <div className="grid h-full place-items-center rounded-xl border border-dashed border-white/[0.12] bg-white/[0.035] text-sm text-neutral-500">选择或新增一个供应商</div>
              )}
            </div>
                </div>
              ) : null}

              {settingsPanel === "agent-config" ? (
                <AdminAgentConfigPanel availableModels={availableTextModels} />
              ) : null}

              {settingsPanel === "prompt-manage" ? (
                <PromptManagePanel />
              ) : null}

              {settingsPanel === "skill-management" ? (
                <SkillManagementPanel />
              ) : null}

              {settingsPanel === "memory-config" ? (
                <MemoryConfigPanel />
              ) : null}
            </div>
          </div>
        </section>

        <section className="hidden overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#101010]/85 shadow-2xl shadow-black/35">
          <table className="w-full text-left text-sm">
            <thead className="bg-white/[0.035] text-xs uppercase tracking-[0.12em] text-neutral-500">
              <tr>
                <th className="px-4 py-3">服务类型</th>
                <th className="px-4 py-3">厂商</th>
                <th className="px-4 py-3">名称</th>
                <th className="px-4 py-3">Base URL</th>
                <th className="px-4 py-3">协议</th>
                <th className="px-4 py-3">默认模型</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">健康</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {loading ? (
                <tr><td colSpan={9} className="py-16 text-center text-neutral-500">加载中...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9} className="py-16 text-center text-neutral-600">{configs.length === 0 ? "暂无配置，点击「新增模型配置」开始" : "无匹配结果"}</td></tr>
              ) : (
                filtered.map((config) => (
                  <tr key={config.id} className="group transition hover:bg-white/[0.025]">
                    <td className="px-4 py-3"><Badge className={SERVICE_BADGE_STYLES[config.service_type]}>{SERVICE_LABELS[config.service_type]}</Badge></td>
                    <td className="px-4 py-3 text-neutral-300">
                      <span className="inline-flex items-center gap-2">
                        <ModelBrandIcon model={config.default_model || config.model_list?.[0]} vendor={config.vendor} providerName={config.name} iconKey={config.icon_key} iconUrl={config.icon_url} size={20} />
                        <span>{config.vendor}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium text-neutral-100">
                      <span className="inline-flex max-w-[220px] items-center gap-2">
                        <span className="truncate">{config.name}</span>
                      </span>
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-3 font-mono text-xs text-neutral-500" title={config.base_url}>{config.base_url}</td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-400">{config.protocol || "openai_compatible"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-neutral-400">
                      <span className="inline-flex items-center gap-2">
                        <ModelBrandIcon model={config.default_model || config.model_list?.[0]} vendor={config.vendor} providerName={config.name} iconKey={config.icon_key} iconUrl={config.icon_url} size={18} />
                        <span>{config.default_model || "-"}</span>
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-2 text-xs text-neutral-300">
                        <span className={["h-2 w-2 rounded-full", config.status === "enabled" ? "bg-emerald-400" : "bg-neutral-600"].join(" ")} />
                        {STATUS_LABEL[config.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3"><ChannelHealthBadge config={config} /></td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5 opacity-80 transition group-hover:opacity-100">
                        <ActionIconButton label="编辑" onClick={() => openEdit(config)}><Pencil className="h-3.5 w-3.5" /></ActionIconButton>
                        <ActionIconButton label="重置健康" disabled={resettingId === config.id} onClick={() => handleResetHealth(config)}>
                          {resettingId === config.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                        </ActionIconButton>
                        <ActionIconButton label="测试连通" disabled={testingId === config.id} onClick={() => handleTestConnectivity(config)}>
                          {testingId === config.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                        </ActionIconButton>
                        <ActionIconButton label={config.status === "enabled" ? "禁用" : "启用"} onClick={() => handleToggle(config)}><Power className="h-3.5 w-3.5" /></ActionIconButton>
                        <ActionIconButton label="删除" onClick={() => handleDelete(config)}><Trash2 className="h-3.5 w-3.5" /></ActionIconButton>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div className="border-t border-white/[0.06] px-4 py-3 text-xs text-neutral-500">共 {configs.length} 条 · {enabledCount} 个已启用</div>
        </section>
      </div>

      <ConfigModal config={editing} open={configModalOpen} onClose={() => setConfigModalOpen(false)} onSaved={loadConfigs} />
      {codeEditingConfig ? (
        <Suspense fallback={<ProviderCodeEditorFallback />}>
          <ProviderCodeEditorModal
            open={Boolean(codeEditingConfig)}
            initialCode={codeEditingConfig.adapter_code || ""}
            saving={codeSaving}
            error={codeError}
            onClose={() => {
              if (!codeSaving) setCodeEditingConfig(null);
            }}
            onConfirm={(code) => {
              if (codeEditingConfig) void handleSaveCode(codeEditingConfig, code);
            }}
          />
        </Suspense>
      ) : null}
    </AdminShell>
  );
}

function SettingsSidebar({ activeKey, onSelect }: { activeKey: SettingsPanelKey; onSelect: (key: SettingsPanelKey) => void }) {
  return (
    <aside className="border-r border-white/[0.06] bg-white/[0.025] px-7 py-7">
      <h2 className="mb-6 text-lg font-semibold text-neutral-100">模原力设置</h2>
      <nav className="space-y-1">
        {SETTINGS_MENU.map((item) => {
          const Icon = item.icon;
          const active = item.key === activeKey;
          const canSelect = !item.disabled;
          return (
            <button
              key={item.key}
              type="button"
              disabled={!canSelect}
              onClick={() => {
                if (canSelect) onSelect(item.key as SettingsPanelKey);
              }}
              className={[
                "flex h-10 w-full items-center gap-3 rounded-xl border px-3 text-left text-sm transition",
                active ? "border-white/[0.14] bg-white/[0.085] font-medium text-white shadow-sm" : "border-transparent text-neutral-400 hover:border-white/[0.08] hover:bg-white/[0.045] hover:text-neutral-100",
                !canSelect ? "cursor-not-allowed opacity-35 hover:border-transparent hover:bg-transparent hover:text-neutral-400" : "",
              ].join(" ")}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function AdminAgentConfigPanel({ availableModels }: { availableModels: string[] }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"ordinary" | "advanced">("ordinary");
  const [editor, setEditor] = useState<{ agent: Agent | null; draft: AgentEditorDraft } | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [nextAgents, nextSkills] = await Promise.all([adminListAgents(), adminListSkills()]);
      setAgents(nextAgents);
      setSkills(nextSkills);
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const promptSkills = useMemo(() => skills.filter(isPromptTemplateSkill), [skills]);
  const models = availableModels.length ? availableModels : ["gpt-4.1-mini"];
  const visibleAgents = tab === "ordinary" ? agents.filter((agent) => agent.strategy !== "scripted") : agents;

  const openEditor = (agent: Agent | null) => {
    setError("");
    setEditor({
      agent,
      draft: agent
        ? {
          name: agent.name,
          description: agent.description,
          systemPrompt: agent.system_prompt,
          model: agent.model || models[0],
          skillIds: agent.skill_ids,
          canvasTools: agent.canvas_tools,
          enabled: agent.enabled,
          strategy: agent.strategy,
        }
        : {
          name: "新智能体",
          description: "参考当前画布、上下文和可调用技能完成任务。",
          systemPrompt: "你是 CCY Canvas 中的创作型智能体。优先理解当前画布节点、用户输入和绑定技能，再给出可执行的下一步。",
          model: models[0],
          skillIds: [],
          canvasTools: true,
          enabled: true,
          strategy: "reactive",
        },
    });
  };

  const saveEditor = async () => {
    if (!editor) return;
    if (!editor.draft.name.trim() || !editor.draft.systemPrompt.trim() || !editor.draft.model.trim()) {
      setError("请填写 Agent 名称、模型和系统提示词。");
      return;
    }
    const payload: AgentUpsert = {
      name: editor.draft.name.trim(),
      description: editor.draft.description.trim(),
      avatar: editor.agent?.avatar || "",
      system_prompt: editor.draft.systemPrompt.trim(),
      model: editor.draft.model.trim(),
      skill_ids: editor.draft.skillIds,
      canvas_tools: editor.draft.canvasTools,
      strategy: editor.draft.strategy,
      enabled: editor.draft.enabled,
    };
    setSaving(true);
    setError("");
    try {
      if (editor.agent) await adminUpdateAgent(editor.agent.id, payload);
      else await adminCreateAgent(payload);
      setEditor(null);
      await load();
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="settings-panel-agent-config" className="flex h-full min-h-[620px] flex-col">
      <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-full border border-white/[0.08] bg-white/[0.045] text-neutral-200">
              <Bot className="h-5 w-5" />
            </span>
            <div>
              <h3 className="text-lg font-semibold text-neutral-100">Agent配置</h3>
              <p className="mt-1 text-sm text-neutral-500">给不同创作角色指定模型、系统提示词和可调用 Skills。</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => void load()} disabled={loading} className={SETTINGS_PANEL_BUTTON}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              刷新
            </Button>
            <Button type="button" onClick={() => openEditor(null)} className={SETTINGS_PRIMARY_BUTTON}>
              <Plus className="mr-2 h-4 w-4" />
              新增 Agent
            </Button>
          </div>
        </div>
      </div>

      {error ? <div className="mt-4 rounded-md border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}

      <div className="mt-4 flex gap-2 border-b border-white/[0.08]">
        {[
          ["ordinary", "普通"] as const,
          ["advanced", "高级"] as const,
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={[
              "border-b-2 px-4 py-2 text-sm transition",
              tab === value ? "border-white font-medium text-white" : "border-transparent text-neutral-500 hover:text-neutral-200",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {loading ? (
          <div className="col-span-full rounded-lg border border-white/[0.08] bg-white/[0.035] px-5 py-12 text-center text-sm text-neutral-500">Agent 加载中...</div>
        ) : visibleAgents.length === 0 ? (
          <button
            type="button"
            onClick={() => openEditor(null)}
            className="col-span-full rounded-lg border border-dashed border-white/[0.12] bg-white/[0.035] px-5 py-12 text-center text-sm text-neutral-500 transition hover:border-white/[0.18] hover:bg-white/[0.055] hover:text-neutral-300"
          >
            暂无 Agent，点击创建一个可配置的创作角色。
          </button>
        ) : (
          visibleAgents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => openEditor(agent)}
              className="rounded-lg border border-white/[0.08] bg-white/[0.035] p-4 text-left shadow-sm transition hover:border-white/[0.16] hover:bg-white/[0.055]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/[0.08] bg-white/[0.045] text-neutral-300">
                    <Bot className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <h4 className="truncate text-sm font-semibold text-neutral-100">{agent.name}</h4>
                    <p className="mt-1 truncate text-xs text-neutral-500">{agent.description || "暂无描述"}</p>
                  </div>
                </div>
                <span className={agent.enabled ? "rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300" : "rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-0.5 text-xs text-neutral-500"}>
                  {agent.enabled ? "已启用" : "未启用"}
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className={SETTINGS_BADGE}>{agent.model || "未配置模型"}</span>
                <span className={SETTINGS_BADGE}>Skills ×{agent.skill_ids.length}</span>
                <span className={SETTINGS_BADGE}>{agent.canvas_tools ? "画布工具" : "纯对话"}</span>
              </div>
              {tab === "advanced" ? (
                <p className="mt-3 line-clamp-2 text-xs leading-5 text-neutral-500">{agent.system_prompt}</p>
              ) : null}
            </button>
          ))
        )}
      </div>

      {editor ? (
        <AgentConfigModal
          editor={editor}
          models={models}
          skills={promptSkills}
          saving={saving}
          onChange={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          onClose={() => {
            if (!saving) setEditor(null);
          }}
          onSave={() => void saveEditor()}
        />
      ) : null}
    </section>
  );
}

function PromptManagePanel() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{
    skill: Skill | null;
    name: string;
    commandName: string;
    modelHint: string;
    content: string;
  } | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setSkills(await adminListSkills());
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const prompts = skills.filter(isPromptTemplateSkill);

  const openEditor = (skill: Skill | null) => {
    const spec = (skill?.spec ?? {}) as Record<string, unknown>;
    setEditor({
      skill,
      name: skill?.name || "新提示词模板",
      commandName: skill ? getSkillCommandName(skill) : "/new-prompt",
      modelHint: typeof spec.model_hint === "string" ? spec.model_hint : "",
      content: skill ? getSkillTemplateBody(skill) : "请基于当前画布上下文，输出清晰、可执行的创作建议。",
    });
  };

  const savePrompt = async () => {
    if (!editor) return;
    if (!editor.name.trim() || !editor.content.trim()) {
      setError("请填写提示词名称和内容。");
      return;
    }
    const spec = {
      ...(editor.skill?.spec ?? {}),
      slash_command: editor.commandName.trim().replace(/^\/+/, ""),
      content_md: editor.content,
      user_template: editor.content,
      model_hint: editor.modelHint,
      trigger_mode: "slash",
    };
    const payload: SkillUpsert = editor.skill
      ? skillToUpsert(editor.skill, { name: editor.name.trim(), kind: "prompt", spec })
      : {
        name: editor.name.trim(),
        description: "后台提示词模板",
        category: "prompt",
        icon: "file-text",
        kind: "prompt",
        spec,
        input_schema: {},
        output_schema: {},
        enabled: true,
      };
    setSaving(true);
    setError("");
    try {
      if (editor.skill) await adminUpdateSkill(editor.skill.id, payload);
      else await adminCreateSkill(payload);
      setEditor(null);
      await load();
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="settings-panel-prompt-manage" className="flex h-full min-h-[620px] flex-col">
      <PanelHeader
        icon={<FileText className="h-5 w-5" />}
        title="提示词管理"
        description="管理可被 Agent 或 Slash 命令调用的提示词模板。"
        action={<Button onClick={() => openEditor(null)} className={SETTINGS_PRIMARY_BUTTON}><Plus className="mr-2 h-4 w-4" />新增提示词</Button>}
      />
      {error ? <div className="mt-4 rounded-md border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {loading ? (
          <div className="col-span-full rounded-lg border border-white/[0.08] bg-white/[0.035] px-5 py-12 text-center text-sm text-neutral-500">提示词加载中...</div>
        ) : prompts.length === 0 ? (
          <button
            type="button"
            onClick={() => openEditor(null)}
            className="col-span-full rounded-lg border border-dashed border-white/[0.12] bg-white/[0.035] px-5 py-12 text-center text-sm text-neutral-500 transition hover:border-white/[0.18] hover:bg-white/[0.055] hover:text-neutral-300"
          >
            暂无提示词模板，点击创建一个。
          </button>
        ) : (
          prompts.map((skill) => (
            <button
              key={skill.id}
              type="button"
              onClick={() => openEditor(skill)}
              className="rounded-lg border border-white/[0.08] bg-white/[0.035] p-4 text-left shadow-sm transition hover:border-white/[0.16] hover:bg-white/[0.055]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold text-neutral-100">{skill.name}</h4>
                  <p className="mt-1 text-xs text-neutral-500">{getSkillCommandName(skill)} · {skill.category || "prompt"}</p>
                </div>
                <Badge className="border-white/[0.08] bg-white/[0.045] text-neutral-300">prompt</Badge>
              </div>
              <p className="mt-3 line-clamp-2 text-xs leading-5 text-neutral-500">{getSkillTemplateBody(skill) || skill.description || "暂无提示词内容"}</p>
            </button>
          ))
        )}
      </div>
      {editor ? (
        <PromptEditorModal
          editor={editor}
          saving={saving}
          onChange={setEditor}
          onClose={() => {
            if (!saving) setEditor(null);
          }}
          onSave={() => void savePrompt()}
        />
      ) : null}
    </section>
  );
}

function SkillManagementPanel() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await adminListSkills();
      setSkills(next);
      setActiveId((current) => current && next.some((skill) => skill.id === current) ? current : next[0]?.id ?? null);
    } catch (err) {
      setError(toAdminErrorSummary(err, "zh"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = skills.filter((skill) => {
    const q = keyword.trim().toLowerCase();
    if (!q) return true;
    return [skill.name, skill.category, skill.kind, skill.description].some((value) => value.toLowerCase().includes(q));
  });
  const active = filtered.find((skill) => skill.id === activeId) ?? filtered[0] ?? null;

  const saveSpec = async () => {
    if (!active || draft === null) return;
    setSaving(true);
    setError("");
    try {
      const parsed = JSON.parse(draft || "{}");
      await adminUpdateSkill(active.id, skillToUpsert(active, { spec: parsed }));
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof SyntaxError ? `JSON 格式错误：${err.message}` : toAdminErrorSummary(err, "zh"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="settings-panel-skill-management" className="flex h-full min-h-[620px] flex-col">
      <PanelHeader
        icon={<Sparkles className="h-5 w-5" />}
        title="Skills技能管理"
        description="按左侧列表和右侧预览方式查看技能，支持搜索和编辑 Skill spec。"
        action={<Button variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={() => void load()} disabled={loading}>{loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}刷新</Button>}
      />
      {error ? <div className="mt-4 rounded-md border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
      <div className="mt-4 grid min-h-0 flex-1 gap-3 lg:grid-cols-[300px_1fr]">
        <aside className="flex min-h-0 flex-col rounded-lg border border-white/[0.08] bg-white/[0.025] p-3">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索 Skill"
            className={SETTINGS_INPUT}
          />
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="px-3 py-8 text-center text-sm text-neutral-500">加载中...</div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-neutral-500">暂无 Skill</div>
            ) : (
              filtered.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => setActiveId(skill.id)}
                  className={[
                    "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition",
                    active?.id === skill.id ? "border-white/[0.14] bg-white/[0.08] text-white" : "border-transparent text-neutral-400 hover:border-white/[0.08] hover:bg-white/[0.045] hover:text-neutral-100",
                  ].join(" ")}
                >
                  <FileText className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                </button>
              ))
            )}
          </div>
        </aside>
        <div className="flex min-h-0 flex-col rounded-lg border border-white/[0.08] bg-white/[0.025]">
          {active ? (
            <>
              <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-3">
                <div>
                  <h4 className="text-sm font-semibold text-neutral-100">{active.name}</h4>
                  <p className="mt-1 text-xs text-neutral-500">{active.kind} · {active.category || "未分类"} · {active.enabled ? "已启用" : "未启用"}</p>
                </div>
                <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={() => setDraft(JSON.stringify(active.spec ?? {}, null, 2))}>
                  <Pencil className="mr-2 h-4 w-4" />
                  编辑
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <div className="mb-4 rounded-lg border border-white/[0.08] bg-white/[0.035] p-4 text-sm leading-6 text-neutral-400">
                  {active.description || "暂无描述。"}
                </div>
                <pre className="whitespace-pre-wrap rounded-lg bg-[#191919] p-4 text-xs leading-5 text-neutral-100">
                  {JSON.stringify(active.spec ?? {}, null, 2)}
                </pre>
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center text-sm text-neutral-500">选择左侧 Skill 查看内容</div>
          )}
        </div>
      </div>
      {draft !== null && active ? (
        <SkillSpecEditorModal
          title={`编辑 ${active.name}`}
          draft={draft}
          saving={saving}
          onChange={setDraft}
          onClose={() => {
            if (!saving) setDraft(null);
          }}
          onSave={() => void saveSpec()}
        />
      ) : null}
    </section>
  );
}

function MemoryConfigPanel() {
  const [form, setForm] = useState<MemoryConfigForm>(DEFAULT_MEMORY_CONFIG);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(MEMORY_CONFIG_KEY);
      if (raw) setForm({ ...DEFAULT_MEMORY_CONFIG, ...JSON.parse(raw) });
    } catch {
      setForm(DEFAULT_MEMORY_CONFIG);
    }
  }, []);

  const save = (next = form) => {
    window.localStorage.setItem(MEMORY_CONFIG_KEY, JSON.stringify(next));
    setNotice("配置已保存到本地后台设置草案。");
  };

  const restore = () => {
    setForm(DEFAULT_MEMORY_CONFIG);
    save(DEFAULT_MEMORY_CONFIG);
  };

  const clear = () => {
    window.localStorage.removeItem(MEMORY_CONFIG_KEY);
    setNotice("本地记忆配置草案已清空，后端会话记忆不会被删除。");
  };

  return (
    <section data-testid="settings-panel-memory-config" className="flex h-full min-h-[620px] flex-col">
      <PanelHeader
        icon={<BrainCircuit className="h-5 w-5" />}
        title="Agent记忆配置"
        description="沉淀本项目 Agent 记忆策略的后台配置入口。"
      />
      <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-200">
        当前项目还没有 Toonflow 同名的服务端记忆配置接口；这里会保存后台本地草案，后续接入后端即可直接复用这些字段。
      </div>
      {notice ? <div className="mt-4 rounded-md border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">{notice}</div> : null}
      <div className="mt-4 space-y-4">
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.025] p-4">
          <h4 className="text-sm font-semibold text-neutral-100">向量模型配置</h4>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <SettingsField label="模型文件路径">
              <input
                value={form.modelOnnxFile}
                onChange={(event) => setForm({ ...form, modelOnnxFile: event.target.value })}
                className={SETTINGS_INPUT}
              />
              <p className="mt-2 text-xs text-neutral-500">data/models/{form.modelOnnxFile}</p>
            </SettingsField>
            <SettingsField label="量化类型">
              <select value={form.modelDtype} onChange={(event) => setForm({ ...form, modelDtype: event.target.value })} className={SETTINGS_SELECT}>
                {["fp16", "auto", "fp32", "q8", "int8", "uint8", "q4", "bnb4", "q4f16"].map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </SettingsField>
          </div>
        </div>
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.025] p-4">
          <h4 className="text-sm font-semibold text-neutral-100">记忆参数</h4>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <MemoryNumberField label="多少条消息触发摘要" value={form.messagesPerSummary} onChange={(value) => setForm({ ...form, messagesPerSummary: value })} />
            <MemoryNumberField label="短期记忆条数" value={form.shortTermLimit} onChange={(value) => setForm({ ...form, shortTermLimit: value })} />
            <MemoryNumberField label="摘要最大长度" value={form.summaryMaxLength} onChange={(value) => setForm({ ...form, summaryMaxLength: value })} />
            <MemoryNumberField label="摘要召回数量" value={form.summaryLimit} onChange={(value) => setForm({ ...form, summaryLimit: value })} />
            <MemoryNumberField label="RAG 召回数量" value={form.ragLimit} onChange={(value) => setForm({ ...form, ragLimit: value })} />
            <MemoryNumberField label="深度检索摘要数" value={form.deepRetrieveSummaryLimit} onChange={(value) => setForm({ ...form, deepRetrieveSummaryLimit: value })} />
          </div>
        </div>
      </div>
      <div className="mt-auto flex justify-end gap-3 border-t border-white/[0.08] pt-4">
        <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={clear}>清空本地配置</Button>
        <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={restore}>恢复默认</Button>
        <Button type="button" onClick={() => save()} className={SETTINGS_PRIMARY_BUTTON}>保存配置</Button>
      </div>
    </section>
  );
}

function PanelHeader({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] pb-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/[0.08] bg-white/[0.045] text-neutral-200">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-neutral-100">{title}</h3>
          <p className="mt-1 text-sm text-neutral-500">{description}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function AgentConfigModal({
  editor,
  models,
  skills,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  editor: { agent: Agent | null; draft: AgentEditorDraft };
  models: string[];
  skills: Skill[];
  saving: boolean;
  onChange: (draft: AgentEditorDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { draft } = editor;
  const toggleSkill = (id: string) => {
    const set = new Set(draft.skillIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    onChange({ ...draft, skillIds: Array.from(set) });
  };

  return (
    <CenterModal title={editor.agent ? `${editor.agent.name} 模型配置` : "新增 Agent"} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <SettingsField label="Agent 名称"><input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} className={SETTINGS_INPUT} /></SettingsField>
          <SettingsField label="选择模型">
            {models.length ? (
              <select value={draft.model} onChange={(event) => onChange({ ...draft, model: event.target.value })} className={SETTINGS_SELECT}>
                {models.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            ) : (
              <input value={draft.model} onChange={(event) => onChange({ ...draft, model: event.target.value })} className={SETTINGS_INPUT} />
            )}
          </SettingsField>
        </div>
        <SettingsField label="描述"><textarea value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} rows={2} className={`${SETTINGS_INPUT} resize-none`} /></SettingsField>
        <SettingsField label="系统提示词"><textarea value={draft.systemPrompt} onChange={(event) => onChange({ ...draft, systemPrompt: event.target.value })} rows={7} className={`${SETTINGS_INPUT} resize-y font-mono text-xs`} /></SettingsField>
        <SettingsField label="可调用 Skills">
          <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto rounded-md border border-white/[0.08] bg-white/[0.035] p-3">
            {skills.length === 0 ? <span className="text-xs text-neutral-500">暂无提示词型 Skill。</span> : null}
            {skills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => toggleSkill(skill.id)}
                className={[
                  "rounded-full border px-3 py-1 text-xs transition",
                  draft.skillIds.includes(skill.id) ? "border-white/[0.18] bg-white/[0.10] text-white" : "border-white/[0.08] bg-white/[0.045] text-neutral-400 hover:border-white/[0.16] hover:text-neutral-100",
                ].join(" ")}
              >
                {getSkillCommandName(skill)}
              </button>
            ))}
          </div>
        </SettingsField>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input type="checkbox" checked={draft.canvasTools} onChange={(event) => onChange({ ...draft, canvasTools: event.target.checked })} className="accent-neutral-300" />
            允许画布工具
          </label>
          <label className="flex items-center gap-2 text-sm text-neutral-300">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} className="accent-neutral-300" />
            启用
          </label>
          <SettingsField label="策略">
            <select value={draft.strategy} onChange={(event) => onChange({ ...draft, strategy: event.target.value as AgentUpsert["strategy"] })} className={SETTINGS_SELECT}>
              <option value="reactive">reactive</option>
              <option value="scripted">scripted</option>
            </select>
          </SettingsField>
        </div>
      </div>
      <ModalFooter saving={saving} onClose={onClose} onSave={onSave} />
    </CenterModal>
  );
}

function PromptEditorModal({
  editor,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  editor: { skill: Skill | null; name: string; commandName: string; modelHint: string; content: string };
  saving: boolean;
  onChange: (editor: { skill: Skill | null; name: string; commandName: string; modelHint: string; content: string }) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <CenterModal title="提示词编辑器" onClose={onClose} widthClass="max-w-[980px]">
      <div className="grid gap-3 md:grid-cols-3">
        <SettingsField label="名称"><input value={editor.name} onChange={(event) => onChange({ ...editor, name: event.target.value })} className={SETTINGS_INPUT} /></SettingsField>
        <SettingsField label="Slash 命令"><input value={editor.commandName} onChange={(event) => onChange({ ...editor, commandName: event.target.value })} className={SETTINGS_INPUT} /></SettingsField>
        <SettingsField label="模型提示"><input value={editor.modelHint} onChange={(event) => onChange({ ...editor, modelHint: event.target.value })} className={SETTINGS_INPUT} /></SettingsField>
      </div>
      <div className="mt-4">
        <SettingsField label="Markdown 提示词">
          <textarea
            value={editor.content}
            onChange={(event) => onChange({ ...editor, content: event.target.value })}
            rows={18}
            className={`${SETTINGS_INPUT} resize-y font-mono text-xs leading-5`}
          />
        </SettingsField>
      </div>
      <ModalFooter saving={saving} onClose={onClose} onSave={onSave} />
    </CenterModal>
  );
}

function SkillSpecEditorModal({
  title,
  draft,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  title: string;
  draft: string;
  saving: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <CenterModal title={title} onClose={onClose} widthClass="max-w-[900px]">
      <textarea
        value={draft}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        rows={22}
        className="w-full rounded-md border border-white/[0.08] bg-[#1e1e1e] px-4 py-3 font-mono text-xs leading-5 text-neutral-100 outline-none focus:border-white/[0.18]"
      />
      <ModalFooter saving={saving} onClose={onClose} onSave={onSave} />
    </CenterModal>
  );
}

function CenterModal({
  title,
  onClose,
  children,
  widthClass = "max-w-[640px]",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  widthClass?: string;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/55 px-4 py-[8vh] backdrop-blur-sm">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="关闭弹窗" onClick={onClose} />
      <section className={`relative z-10 max-h-[84vh] w-full ${widthClass} overflow-y-auto rounded-2xl border border-white/[0.08] bg-[#111111] p-5 text-neutral-100 shadow-[0_28px_90px_rgba(0,0,0,0.45)]`}>
        <div className="mb-4 flex items-center justify-between border-b border-white/[0.08] pb-3">
          <h3 className="text-base font-semibold">{title}</h3>
          <button type="button" onClick={onClose} className="rounded-full p-1.5 text-neutral-500 transition hover:bg-white/[0.08] hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function ModalFooter({ saving, onClose, onSave }: { saving: boolean; onClose: () => void; onSave: () => void }) {
  return (
    <div className="mt-5 flex justify-end gap-3 border-t border-white/[0.08] pt-4">
      <Button type="button" variant="secondary" className={SETTINGS_PANEL_BUTTON} onClick={onClose} disabled={saving}>取消</Button>
      <Button type="button" onClick={onSave} disabled={saving} className={SETTINGS_PRIMARY_BUTTON}>
        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        保存
      </Button>
    </div>
  );
}

function MemoryNumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <SettingsField label={label}>
      <input value={value} onChange={(event) => onChange(Number(event.target.value) || 0)} type="number" min={0} className={SETTINGS_INPUT} />
    </SettingsField>
  );
}

function skillToUpsert(skill: Skill, overrides: Partial<SkillUpsert> = {}): SkillUpsert {
  return {
    name: skill.name,
    description: skill.description,
    category: skill.category,
    icon: skill.icon,
    kind: skill.kind,
    spec: skill.spec ?? {},
    input_schema: skill.input_schema ?? {},
    output_schema: skill.output_schema ?? {},
    enabled: skill.enabled,
    ...overrides,
  };
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-36 rounded-2xl border border-white/[0.08] bg-white/[0.035] px-4 py-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-white">{value}</p>
    </div>
  );
}
