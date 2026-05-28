import { useEffect, useMemo, useState } from "react";
import { Minus, Plus, X } from "lucide-react";

import type { ModelConfig, ServiceType } from "../../model-config";
import { normalizeModelList } from "../../model-config";
import { Button } from "../ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "../ui/drawer";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";

type DraftConfig = {
  serviceType: ServiceType;
  vendor: string;
  protocol: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  submitEndpoint: string;
  queryEndpoint: string;
  modelListText: string;
  defaultModel: string;
  priority: number;
  enabled: boolean;
  isDefault: boolean;
};

type ModelConfigDrawerProps = {
  open: boolean;
  config: ModelConfig | null;
  onOpenChange: (open: boolean) => void;
  onSave: (config: ModelConfig) => void;
};

const serviceTypes: ServiceType[] = ["text", "image", "video", "audio"];
const vendors = ["OpenAI", "DeepSeek", "Runway", "Suno", "Custom"];
const protocols = ["openai", "custom", "newapi"];

function createDraft(config: ModelConfig | null): DraftConfig {
  return {
    serviceType: config?.serviceType ?? "text",
    vendor: config?.vendor ?? "OpenAI",
    protocol: config?.protocol ?? "openai",
    name: config?.name ?? "",
    baseUrl: config?.baseUrl ?? "",
    apiKey: config?.apiKey ?? "",
    submitEndpoint: config?.submitEndpoint ?? "",
    queryEndpoint: config?.queryEndpoint ?? "",
    modelListText: config?.modelList.join(", ") ?? "",
    defaultModel: config?.defaultModel ?? "",
    priority: config?.priority ?? 1,
    enabled: config?.enabled ?? true,
    isDefault: config?.isDefault ?? false,
  };
}

const fieldClassName =
  "border-white/10 bg-[#0d0d0d] text-neutral-100 placeholder:text-neutral-500 focus-visible:border-[#ff6a1f]/50 focus-visible:ring-[#ff6a1f]/25";

export function ModelConfigDrawer({ open, config, onOpenChange, onSave }: ModelConfigDrawerProps) {
  const [draft, setDraft] = useState<DraftConfig>(() => createDraft(config));
  const [errors, setErrors] = useState<Partial<Record<keyof DraftConfig, string>>>({});

  useEffect(() => {
    if (open) {
      setDraft(createDraft(config));
      setErrors({});
    }
  }, [config, open]);

  const modelOptions = useMemo(() => normalizeModelList(draft.modelListText), [draft.modelListText]);

  const submit = () => {
    const nextErrors: Partial<Record<keyof DraftConfig, string>> = {};

    if (!draft.name.trim()) nextErrors.name = "请填写名称";
    if (!draft.baseUrl.trim()) nextErrors.baseUrl = "请填写 Base URL";
    if (!draft.apiKey.trim()) nextErrors.apiKey = "请填写 API Key";
    if (modelOptions.length === 0) nextErrors.modelListText = "请至少填写一个模型";
    if (!(draft.defaultModel || modelOptions[0])) nextErrors.defaultModel = "请选择默认模型";

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    const now = Date.now();
    const modelList = normalizeModelList(draft.modelListText);
    const nextConfig: ModelConfig = {
      id: config?.id ?? `cfg-${now}`,
      serviceType: draft.serviceType,
      vendor: draft.vendor,
      protocol: draft.protocol,
      name: draft.name.trim() || `${draft.vendor} ${draft.serviceType}`,
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      submitEndpoint: draft.submitEndpoint.trim(),
      queryEndpoint: draft.queryEndpoint.trim(),
      modelList,
      defaultModel: draft.defaultModel || modelList[0] || "",
      priority: draft.priority,
      enabled: draft.enabled,
      isDefault: draft.isDefault,
      createdAt: config?.createdAt ?? now,
      updatedAt: now,
    };

    setErrors({});
    onSave(nextConfig);
    onOpenChange(false);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} direction="right">
      <DrawerContent className="border-l border-white/10 bg-[#111111] text-neutral-100 sm:max-w-[620px]">
        <DrawerHeader className="border-b border-white/[0.08] px-6 py-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <DrawerTitle className="text-xl text-white">{config ? "编辑配置" : "新增配置"}</DrawerTitle>
              <DrawerDescription className="mt-2 max-w-lg text-sm leading-6 text-neutral-400">
                配置服务类型、厂商、接口协议、请求端点和默认模型路由，让工作区按这套设置进行调用。
              </DrawerDescription>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-full border border-white/10 bg-white/[0.03] p-2 text-neutral-400 transition hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </DrawerHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
          <div className="grid grid-cols-2 gap-4">
            <Field label="服务类型" required>
              <Select
                value={draft.serviceType}
                onValueChange={(value) =>
                  setDraft((state) => ({ ...state, serviceType: value as ServiceType }))
                }
              >
                <SelectTrigger className={fieldClassName}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#151515] text-neutral-100">
                  {serviceTypes.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="厂商" required>
              <Select
                value={draft.vendor}
                onValueChange={(value) => setDraft((state) => ({ ...state, vendor: value }))}
              >
                <SelectTrigger className={fieldClassName}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#151515] text-neutral-100">
                  {vendors.map((vendor) => (
                    <SelectItem key={vendor} value={vendor}>
                      {vendor}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="接口协议">
            <Select
              value={draft.protocol}
              onValueChange={(value) => setDraft((state) => ({ ...state, protocol: value }))}
            >
              <SelectTrigger className={fieldClassName}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-[#151515] text-neutral-100">
                {protocols.map((protocol) => (
                  <SelectItem key={protocol} value={protocol}>
                    {protocol}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="名称" required>
            <Input
              value={draft.name}
              onChange={(event) => setDraft((state) => ({ ...state, name: event.target.value }))}
              className={fieldClassName}
              placeholder="OpenAI 文本配置"
            />
            {errors.name ? <FieldError message={errors.name} /> : null}
          </Field>

          <Field label="Base URL" required>
            <Input
              value={draft.baseUrl}
              onChange={(event) => setDraft((state) => ({ ...state, baseUrl: event.target.value }))}
              className={fieldClassName}
              placeholder="https://api.openai.com/v1"
            />
            {errors.baseUrl ? <FieldError message={errors.baseUrl} /> : null}
          </Field>

          <Field label="API Key" required>
            <Input
              value={draft.apiKey}
              onChange={(event) => setDraft((state) => ({ ...state, apiKey: event.target.value }))}
              className={fieldClassName}
              placeholder="sk-..."
              type="password"
            />
            {errors.apiKey ? <FieldError message={errors.apiKey} /> : null}
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label="提交端点">
              <Input
                value={draft.submitEndpoint}
                onChange={(event) =>
                  setDraft((state) => ({ ...state, submitEndpoint: event.target.value }))
                }
                className={fieldClassName}
                placeholder="/chat/completions"
              />
            </Field>
            <Field label="查询端点">
              <Input
                value={draft.queryEndpoint}
                onChange={(event) =>
                  setDraft((state) => ({ ...state, queryEndpoint: event.target.value }))
                }
                className={fieldClassName}
                placeholder="/tasks/{id}"
              />
            </Field>
          </div>

          <Field label="模型列表" required>
            <Textarea
              value={draft.modelListText}
              onChange={(event) =>
                setDraft((state) => ({
                  ...state,
                  modelListText: event.target.value,
                  defaultModel: state.defaultModel || normalizeModelList(event.target.value)[0] || "",
                }))
              }
              className={`${fieldClassName} min-h-[110px]`}
              placeholder="gpt-4.1-mini, gpt-4.1"
            />
            {errors.modelListText ? <FieldError message={errors.modelListText} /> : null}
          </Field>

          <div className="grid grid-cols-[1.2fr_0.8fr] gap-4">
            <Field label="默认模型" required>
              <Select
                value={draft.defaultModel}
                onValueChange={(value) => setDraft((state) => ({ ...state, defaultModel: value }))}
              >
                <SelectTrigger className={fieldClassName}>
                  <SelectValue placeholder={modelOptions.length ? "选择默认模型" : "请先填写模型列表"} />
                </SelectTrigger>
                <SelectContent className="border-white/10 bg-[#151515] text-neutral-100">
                  {modelOptions.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.defaultModel ? <FieldError message={errors.defaultModel} /> : null}
            </Field>

            <Field label="优先级">
              <div className="flex h-10 items-center overflow-hidden rounded-xl border border-white/10 bg-[#0d0d0d]">
                <button
                  type="button"
                  className="flex h-full w-12 items-center justify-center text-neutral-400 transition hover:bg-white/[0.06] hover:text-white"
                  onClick={() =>
                    setDraft((state) => ({ ...state, priority: Math.max(0, state.priority - 1) }))
                  }
                >
                  <Minus className="h-4 w-4" />
                </button>
                <div className="flex-1 text-center text-sm text-white">{draft.priority}</div>
                <button
                  type="button"
                  className="flex h-full w-12 items-center justify-center text-neutral-400 transition hover:bg-white/[0.06] hover:text-white"
                  onClick={() => setDraft((state) => ({ ...state, priority: state.priority + 1 }))}
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <ToggleField
              label="启用配置"
              description="启用后，这条配置才会参与工作区的模型调用。"
              checked={draft.enabled}
              onCheckedChange={(checked) => setDraft((state) => ({ ...state, enabled: checked }))}
            />
            <ToggleField
              label="设为默认"
              description="设为当前服务类型的默认调用配置。"
              checked={draft.isDefault}
              onCheckedChange={(checked) =>
                setDraft((state) => ({ ...state, isDefault: checked }))
              }
            />
          </div>
        </div>

        <DrawerFooter className="border-t border-white/[0.08] px-6 py-5">
          <div className="flex items-center justify-end gap-3">
            <Button
              variant="outline"
              className="border-white/10 bg-white/[0.02] text-neutral-200 hover:bg-white/[0.06]"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button className="bg-[#ff6a1f] text-white hover:bg-[#ff7b35]" onClick={submit}>
              保存配置
            </Button>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-neutral-200">
        <span>{label}</span>
        {required ? <span className="text-[#ff9b68]">*</span> : null}
      </div>
      {children}
    </label>
  );
}

function ToggleField({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0d0d0d] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-white">{label}</p>
          <p className="mt-1 text-xs leading-5 text-neutral-500">{description}</p>
        </div>
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          className="data-[state=checked]:bg-[#ff6a1f]"
        />
      </div>
    </div>
  );
}

function FieldError({ message }: { message: string }) {
  return <p className="text-xs text-rose-300">{message}</p>;
}
