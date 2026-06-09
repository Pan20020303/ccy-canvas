import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
  Search,
} from "lucide-react";

import type {
  ProviderConfig,
  ProviderConfigPayload,
  ServiceType,
  VendorTemplate,
} from "../../api/providerConfigs";
import {
  listProviderConfigs,
  createProviderConfig,
  updateProviderConfig,
  deleteProviderConfig,
  toggleProviderConfigStatus,
  VENDOR_TEMPLATES,
  supportsCustomSubmitQueryEndpoints,
} from "../../api/providerConfigs";
import { normalizeModelList } from "../../model-config";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { AdminShell } from "./AdminShell";

// ─── constants ───────────────────────────────────────────────────────────────

const SERVICE_LABELS: Record<string, string> = {
  text: "文本生成",
  image: "图片生成",
  video: "视频生成",
  audio: "音频生成",
};

const SERVICE_BADGE_STYLES: Record<string, string> = {
  text: "bg-blue-500/15 text-blue-400 border-blue-500/20",
  image: "bg-violet-500/15 text-violet-400 border-violet-500/20",
  video: "bg-pink-500/15 text-pink-400 border-pink-500/20",
  audio: "bg-amber-500/15 text-amber-400 border-amber-500/20",
};

const STATUS_DOT: Record<string, string> = {
  enabled: "bg-[#ff6a1f]",
  disabled: "bg-neutral-600",
};

const STATUS_LABEL: Record<string, string> = {
  enabled: "启用",
  disabled: "禁用",
};

// ─── Config Drawer ──────────────────────────────────────────────────────────

type DrawerProps = {
  config: ProviderConfig | null; // null = create mode
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

function ConfigDrawer({ config, open, onClose, onSaved }: DrawerProps) {
  const isEdit = config !== null;

  // Form state
  const [serviceType, setServiceType] = useState<ServiceType>("video");
  const [vendor, setVendor] = useState("");
  const [apiSpec, setApiSpec] = useState("openai");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [submitEndpoint, setSubmitEndpoint] = useState("");
  const [queryEndpoint, setQueryEndpoint] = useState("");
  const [modelListText, setModelListText] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [priority, setPriority] = useState(0);
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Available vendor templates for current service type
  const templates = VENDOR_TEMPLATES[serviceType] || [];

  // Reset form when opening
  useEffect(() => {
    if (!open) return;
    if (config) {
      setServiceType(config.service_type as ServiceType);
      setVendor(config.vendor);
      setApiSpec(config.api_spec);
      setName(config.name);
      setBaseUrl(config.base_url);
      setApiKey("");
      setSubmitEndpoint(config.submit_endpoint);
      setQueryEndpoint(config.query_endpoint);
      setModelListText(config.model_list.join("\n"));
      setDefaultModel(config.default_model);
      setPriority(config.priority);
      setIsDefault(config.is_default);
    } else {
      setServiceType("video");
      setVendor("");
      setApiSpec("openai");
      setName("");
      setBaseUrl("");
      setApiKey("");
      setSubmitEndpoint("");
      setQueryEndpoint("");
      setModelListText("");
      setDefaultModel("");
      setPriority(0);
      setIsDefault(false);
    }
    setError("");
  }, [open, config]);

  // Auto-fill when vendor template selected
  const applyTemplate = (tpl: VendorTemplate) => {
    setVendor(tpl.vendor);
    setName(tpl.label);
    setBaseUrl(tpl.baseURL);
    setApiSpec(tpl.apiSpec);
    setModelListText(tpl.models.join("\n"));
    setDefaultModel(tpl.models[0] ?? "");
    setSubmitEndpoint(tpl.submitEndpoint ?? "");
    setQueryEndpoint(tpl.queryEndpoint ?? "");
  };

  const handleSave = async () => {
    if (!name.trim() || !baseUrl.trim()) {
      setError("名称和 Base URL 不能为空");
      return;
    }
    setSaving(true);
    setError("");
    const modelList = normalizeModelList(modelListText);
    const payload: ProviderConfigPayload = {
      service_type: serviceType,
      vendor: vendor || "自定义",
      name: name.trim(),
      api_spec: apiSpec,
      base_url: baseUrl.trim(),
      api_key: apiKey || undefined,
      submit_endpoint: submitEndpoint.trim(),
      query_endpoint: queryEndpoint.trim(),
      model_list: modelList,
      default_model: defaultModel || modelList[0] || "",
      priority,
      is_default: isDefault,
    };
    try {
      if (isEdit) {
        await updateProviderConfig(config.id, payload);
      } else {
        await createProviderConfig(payload);
      }
      onSaved();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const showSubmitQueryFields = supportsCustomSubmitQueryEndpoints(serviceType);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative z-10 flex w-[480px] flex-col bg-[#141414] border-l border-white/[0.08] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4">
          <h3 className="text-sm font-semibold text-white">
            {isEdit ? "编辑配置" : "添加配置"}
          </h3>
          <button onClick={onClose} className="text-neutral-500 hover:text-white transition">
            <XCircle className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* 服务类型 */}
          <Field label="服务类型" required>
            <select
              value={serviceType}
              onChange={(e) => { setServiceType(e.target.value as ServiceType); setVendor(""); }}
              className="w-full rounded-lg border border-white/[0.08] bg-[#1a1a1a] px-3 py-2 text-sm text-white"
            >
              <option value="text">文本生成</option>
              <option value="image">图片生成</option>
              <option value="video">视频生成</option>
              <option value="audio">音频生成</option>
            </select>
          </Field>

          {/* 厂商 */}
          <Field label="厂商" required>
            <select
              value={vendor}
              onChange={(e) => {
                const v = e.target.value;
                setVendor(v);
                const tpl = templates.find((t) => t.vendor === v);
                if (tpl) applyTemplate(tpl);
              }}
              className="w-full rounded-lg border border-white/[0.08] bg-[#1a1a1a] px-3 py-2 text-sm text-white"
            >
              <option value="">选择预设厂商（自动填充 URL 和模型）</option>
              {templates.map((t) => (
                <option key={t.vendor} value={t.vendor}>{t.label}</option>
              ))}
              <option value="自定义">自定义</option>
            </select>
          </Field>

          {/* 接口规范 */}
          {vendor === "自定义" && (
            <Field label="接口规范">
              <select
                value={apiSpec}
                onChange={(e) => setApiSpec(e.target.value)}
                className="w-full rounded-lg border border-white/[0.08] bg-[#1a1a1a] px-3 py-2 text-sm text-white"
              >
                <option value="openai">OpenAI 兼容</option>
                <option value="custom">自定义接口</option>
              </select>
            </Field>
          )}

          {/* 名称 */}
          <Field label="名称" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：OpenAI 图文，可自动生成"
              className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white"
            />
          </Field>

          {/* Base URL */}
          <Field label="Base URL" required>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="选择预设厂商后自动填充，可修改"
              className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white"
            />
          </Field>

          {/* API Key */}
          <Field label="API Key" hint={isEdit && config.api_key_set ? `已设置 (${config.api_key_hint})，留空不改` : undefined}>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="API 密钥"
              className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white"
            />
          </Field>

          {/* Video endpoints */}
          {showSubmitQueryFields && (
            <>
              <Field label="提交端点" hint="自定义视频厂商必填，如 /v1/videos/generations">
                <Input
                  value={submitEndpoint}
                  onChange={(e) => setSubmitEndpoint(e.target.value)}
                  placeholder="自定义视频厂商必填，如 /v1/videos/generations"
                  className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white"
                />
              </Field>
              <Field label="查询端点" hint="自定义视频厂商必填，如 /v1/videos/tasks/{taskId}">
                <Input
                  value={queryEndpoint}
                  onChange={(e) => setQueryEndpoint(e.target.value)}
                  placeholder="自定义视频厂商必填，如 /v1/videos/tasks/{taskId}"
                  className="border-white/[0.08] bg-[#1a1a1a] text-sm text-white"
                />
              </Field>
            </>
          )}

          {/* 模型列表 */}
          <Field label="模型列表" hint="选择预设厂商后自动填入，可编辑；多个用逗号或换行分隔">
            <textarea
              value={modelListText}
              onChange={(e) => setModelListText(e.target.value)}
              rows={4}
              className="w-full rounded-lg border border-white/[0.08] bg-[#1a1a1a] px-3 py-2 text-sm text-neutral-200 resize-y"
            />
          </Field>

          {/* 默认模型 */}
          <Field label="默认模型" hint="该配置被选为「默认」时，生成故事/图片/视频将使用此处指定的模型。">
            {modelListText.trim() ? (
              <select
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className="w-full rounded-lg border border-white/[0.08] bg-[#1a1a1a] px-3 py-2 text-sm text-white"
              >
                <option value="">请先填写上方模型列表</option>
                {normalizeModelList(modelListText).map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <Input disabled placeholder="请先填写上方模型列表" className="border-white/[0.06] bg-black/30 text-sm text-neutral-500 cursor-not-allowed" />
            )}
          </Field>

          {/* 优先级 */}
          <Field label="优先级">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPriority((v) => Math.max(0, v - 1))}
                className="h-8 w-8 rounded-md border border-white/[0.08] bg-[#1a1a1a] text-neutral-300 hover:bg-white/5 flex items-center justify-center text-sm"
              >
                −
              </button>
              <span className="w-10 text-center text-sm text-white">{priority}</span>
              <button
                onClick={() => setPriority((v) => v + 1)}
                className="h-8 w-8 rounded-md border border-white/[0.08] bg-[#1a1a1a] text-neutral-300 hover:bg-white/5 flex items-center justify-center text-sm"
              >
                +
              </button>
            </div>
          </Field>

          {/* 设为默认 */}
          <Field label="设为默认">
            <button
              onClick={() => setIsDefault(!isDefault)}
              className={`relative h-6 w-11 rounded-full transition ${isDefault ? "bg-[#ff6a1f]" : "bg-neutral-700"}`}
            >
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${isDefault ? "left-[22px]" : "left-0.5"}`} />
            </button>
          </Field>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex gap-3 border-t border-white/[0.06] px-6 py-4">
          <Button
            onClick={onClose}
            variant="outline"
            className="border-white/10 text-neutral-300 hover:bg-white/5 rounded-full px-5"
          >
            取消
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !name.trim() || !baseUrl.trim()}
            className="bg-[#ff6a1f] text-white hover:bg-[#ff7b35] rounded-full px-5"
          >
            {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            保存配置
          </Button>
        </div>
      </div>
    </div>
  );
}

// Small helper for consistent form fields
function Field({ label, required, hint, children }: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1 text-xs font-medium text-neutral-400">
        {required && <span className="text-[#ff6a1f]">*</span>} {label}
      </label>
      {children}
      {hint && <p className="text-xs text-neutral-600">{hint}</p>}
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export function AdminModelCatalogPage() {
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editConfig, setEditConfig] = useState<ProviderConfig | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listProviderConfigs();
      setConfigs(list);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = configs.filter((c) => {
    const q = search.toLowerCase();
    return !q
      || c.name.toLowerCase().includes(q)
      || c.vendor.toLowerCase().includes(q)
      || c.base_url.toLowerCase().includes(q);
  });

  const handleToggle = async (c: ProviderConfig) => {
    setTogglingId(c.id);
    try {
      await toggleProviderConfigStatus(c.id);
      await load();
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (c: ProviderConfig) => {
    setDeletingId(c.id);
    try {
      await deleteProviderConfig(c.id);
      setConfigs((prev) => prev.filter((x) => x.id !== c.id));
    } finally {
      setDeletingId(null);
    }
  };

  const openCreate = () => { setEditConfig(null); setDrawerOpen(true); };
  const openEdit = (c: ProviderConfig) => { setEditConfig(c); setDrawerOpen(true); };
  const closeDrawer = () => { setDrawerOpen(false); setEditConfig(null); };

  const enabledCount = configs.filter((c) => c.status === "enabled").length;

  return (
    <AdminShell
      title="模型配置"
      description="管理 AI 服务模型配置，支持多厂商接入与管理。"
      action={
        <Button
          className="rounded-full bg-[#ff6a1f] px-5 text-white hover:bg-[#ff7b35]"
          onClick={openCreate}
        >
          <Plus className="h-4 w-4 mr-1" />
          新增模型配置
        </Button>
      }
    >
      {/* Toolbar */}
      <div className="space-y-5">
        <div
          data-admin-card
          className="flex flex-wrap items-center gap-4 rounded-[28px] border border-white/[0.08] bg-[#101010]/90 p-4 shadow-[0_24px_60px_-42px_rgba(0,0,0,0.9)]"
        >
          <div className="min-w-[180px] rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.24em] text-neutral-500">配置总数</p>
            <p className="mt-2 text-2xl font-semibold text-white">{configs.length}</p>
          </div>
          <div className="min-w-[180px] rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.24em] text-neutral-500">在线模型</p>
            <p className="mt-2 text-2xl font-semibold text-white">{enabledCount}</p>
          </div>
          <div className="relative min-w-[280px] flex-1">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称、厂商或 Base URL"
            className="h-11 w-full rounded-2xl border border-white/[0.08] bg-white/[0.03] pl-10 pr-3 text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-[#ff6a1f]/40"
          />
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-600" />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={load}
          disabled={loading}
          className="h-11 rounded-2xl border-white/10 px-4 text-neutral-300 hover:bg-white/5 gap-1.5"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
        </div>

        <div
          data-admin-panel
          className="overflow-hidden rounded-[30px] border border-white/[0.08] bg-[#111111]/95 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]"
        >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/[0.06] bg-white/[0.02]">
              {["服务类型", "厂商", "名称", "Base URL", "默认模型", "优先级", "状态", "操作"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-neutral-500">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {loading ? (
              <tr>
                <td colSpan={8} className="py-16 text-center text-neutral-500">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-16 text-center text-sm text-neutral-600">
                  {configs.length === 0 ? "暂无配置，点击「新增模型配置」开始" : "无匹配结果"}
                </td>
              </tr>
            ) : (
              filtered.map((c) => (
                <tr key={c.id} className="group hover:bg-white/[0.02] transition">
                  <td className="px-4 py-3">
                    <Badge className={SERVICE_BADGE_STYLES[c.service_type] ?? "bg-neutral-500/15 text-neutral-400 border-neutral-500/20"}>
                      {SERVICE_LABELS[c.service_type] ?? c.service_type}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-neutral-300">{c.vendor}</td>
                  <td className="px-4 py-3 font-medium text-neutral-200">{c.name}</td>
                  <td className="px-4 py-3 max-w-[200px] truncate font-mono text-xs text-neutral-500" title={c.base_url}>
                    {c.base_url}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-neutral-400">{c.default_model || "—"}</td>
                  <td className="px-4 py-3 text-neutral-400">{c.priority}</td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-1.5 text-xs">
                      <span className={`h-2 w-2 rounded-full ${STATUS_DOT[c.status] ?? "bg-neutral-600"}`} />
                      <span className="text-neutral-300">{STATUS_LABEL[c.status] ?? c.status}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3 opacity-0 transition group-hover:opacity-100">
                      <button onClick={() => openEdit(c)} title="编辑" className="text-neutral-500 hover:text-white transition">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleToggle(c)}
                        disabled={togglingId === c.id}
                        title={c.status === "enabled" ? "禁用" : "启用"}
                        className="text-neutral-500 hover:text-[#ff6a1f] disabled:opacity-30 transition text-xs"
                      >
                        {togglingId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (c.status === "enabled" ? "禁用" : "启用")}
                      </button>
                      <button
                        onClick={() => handleDelete(c)}
                        disabled={deletingId === c.id}
                        title="删除"
                        className="text-neutral-500 hover:text-red-400 disabled:opacity-30 transition"
                      >
                        {deletingId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {!loading && filtered.length > 0 && (
          <div className="border-t border-white/[0.04] bg-white/[0.01] px-4 py-3 text-xs text-neutral-600">
            共 {filtered.length} 条{search ? `（共 ${configs.length} 条中过滤）` : ""}
            {enabledCount > 0 && <span className="ml-3">· {enabledCount} 个已启用</span>}
          </div>
        )}
        </div>
      </div>

      {/* Drawer */}
      <ConfigDrawer
        config={editConfig}
        open={drawerOpen}
        onClose={closeDrawer}
        onSaved={load}
      />
    </AdminShell>
  );
}
