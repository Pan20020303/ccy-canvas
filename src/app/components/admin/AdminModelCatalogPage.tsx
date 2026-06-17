import { useEffect, useMemo, useState } from "react";
import { FileCode2, Loader2, Pencil, Plus, Power, RefreshCw, RotateCcw, Search, Trash2, X, Zap } from "lucide-react";

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
import { normalizeModelList } from "../../model-config";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ModelBrandIcon } from "../ModelBrandIcon";
import { AdminShell } from "./AdminShell";
import { ChannelHealthBadge } from "./ChannelHealthBadge";

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
  "w-full rounded-2xl border border-white/[0.08] bg-black/20 px-4 py-2.5 text-sm text-white outline-none transition placeholder:text-neutral-600 focus:border-[#ff6a1f]/55";
const FIELD_SELECT = `${FIELD_INPUT} appearance-none`;

function serviceCapabilities(serviceType: ServiceType) {
  return [serviceType];
}

type DrawerProps = {
  config: ProviderConfig | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

function ConfigDrawer({ config, open, onClose, onSaved }: DrawerProps) {
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
    <div className="fixed inset-0 z-50 flex justify-end">
      <button className="absolute inset-0 cursor-default bg-black/55" aria-label="关闭配置面板" onClick={onClose} />
      <aside className="relative z-10 flex h-full w-full max-w-[540px] flex-col border-l border-white/[0.08] bg-[#121212]/98 shadow-2xl backdrop-blur-xl">
        <header className="flex items-center justify-between border-b border-white/[0.07] px-6 py-5">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-[#ff9b68]">{isEdit ? "编辑配置" : "新增配置"}</p>
            <h3 className="mt-1 text-lg font-semibold text-white">{isEdit ? config?.name : "模型服务配置"}</h3>
          </div>
          <button className="rounded-full p-2 text-neutral-400 transition hover:bg-white/8 hover:text-white" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
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
                  className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.035] px-3 py-2 text-left text-xs text-neutral-300 transition hover:border-[#ff6a1f]/40 hover:bg-white/[0.06] hover:text-white"
                >
                  <ModelBrandIcon model={tpl.models[0]} vendor={tpl.vendor} providerName={tpl.label} size={18} />
                  <span className="min-w-0 flex-1 truncate">{tpl.label}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="供应商 TS 脚本">
            <div className="space-y-3 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-xs text-neutral-400">
                  <FileCode2 className="h-4 w-4 text-[#ff9b68]" />
                  粘贴 Toonflow 风格供应商 TS，按当前服务类型解析模型、输入项和图标。
                </span>
                <Button type="button" variant="secondary" onClick={handlePreviewTSImport} disabled={previewingTS || !adapterCode.trim()}>
                  {previewingTS ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  解析导入
                </Button>
              </div>
              <textarea
                value={adapterCode}
                onChange={(event) => {
                  setAdapterCode(event.target.value);
                  if (event.target.value.trim()) setAdapterRuntime("ts");
                }}
                spellCheck={false}
                placeholder="exports.vendor = vendor; exports.imageRequest = imageRequest; exports.videoRequest = videoRequest;"
                className={`${FIELD_INPUT} min-h-36 resize-y py-3 font-mono text-xs`}
              />
            </div>
          </Field>

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

          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-xs text-neutral-400">
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
            <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} className="accent-[#ff6a1f]" />
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

          {error ? <div className="rounded-xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</div> : null}
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-white/[0.07] px-6 py-4">
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}保存配置</Button>
        </footer>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm text-neutral-300">
      <span className="mb-2 block text-xs font-medium uppercase tracking-[0.16em] text-neutral-500">{label}</span>
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
      className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.035] text-neutral-400 transition hover:border-[#ff6a1f]/35 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
    >
      {children}
    </button>
  );
}

export function AdminModelCatalogPage() {
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);

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

  const openCreate = () => {
    setEditing(null);
    setDrawerOpen(true);
  };

  const openEdit = (config: ProviderConfig) => {
    setEditing(config);
    setDrawerOpen(true);
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
                className="h-11 w-full rounded-full border border-white/[0.08] bg-black/20 pl-11 pr-4 text-sm text-white outline-none transition focus:border-[#ff6a1f]/55"
                placeholder="搜索名称、厂商、Base URL、协议或模型"
              />
            </div>
            <Button variant="secondary" onClick={loadConfigs} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              刷新
            </Button>
          </div>
        </section>

        <section className="overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#101010]/85 shadow-2xl shadow-black/35">
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
                        <span className={["h-2 w-2 rounded-full", config.status === "enabled" ? "bg-[#ff6a1f]" : "bg-neutral-600"].join(" ")} />
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

      <ConfigDrawer config={editing} open={drawerOpen} onClose={() => setDrawerOpen(false)} onSaved={loadConfigs} />
    </AdminShell>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-36 rounded-2xl border border-white/[0.08] bg-white/[0.035] px-4 py-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-white">{value}</p>
    </div>
  );
}
