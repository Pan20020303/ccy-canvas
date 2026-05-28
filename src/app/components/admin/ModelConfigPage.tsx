import { useMemo, useState } from "react";
import { Plus } from "lucide-react";

import type { ConnectionTestResult, ModelConfig } from "../../model-config";
import { probeModelConfigConnection } from "../../model-config";
import { useStore } from "../../store";
import { Button } from "../ui/button";
import { AdminShell } from "./AdminShell";
import { ModelConfigDrawer } from "./ModelConfigDrawer";
import { ModelConfigTable } from "./ModelConfigTable";

export function ModelConfigPage() {
  const modelConfigs = useStore((state) => state.modelConfigs);
  const upsertModelConfig = useStore((state) => state.upsertModelConfig);
  const removeModelConfig = useStore((state) => state.removeModelConfig);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [connectionResults, setConnectionResults] = useState<Record<string, ConnectionTestResult>>({});
  const [testingIds, setTestingIds] = useState<Record<string, boolean>>({});

  const editingConfig = useMemo(
    () => modelConfigs.find((config) => config.id === editingId) ?? null,
    [editingId, modelConfigs],
  );

  const sortedConfigs = useMemo(
    () =>
      [...modelConfigs].sort((left, right) => {
        if (left.serviceType !== right.serviceType) {
          return left.serviceType.localeCompare(right.serviceType);
        }
        if (left.isDefault !== right.isDefault) {
          return left.isDefault ? -1 : 1;
        }
        return left.priority - right.priority;
      }),
    [modelConfigs],
  );

  const openCreate = () => {
    setEditingId(null);
    setDrawerOpen(true);
  };

  const openEdit = (id: string) => {
    setEditingId(id);
    setDrawerOpen(true);
  };

  const toggleEnabled = (config: ModelConfig) => {
    upsertModelConfig({ ...config, enabled: !config.enabled });
  };

  const runConnectionTest = async (config: ModelConfig) => {
    setTestingIds((state) => ({ ...state, [config.id]: true }));
    const result = await probeModelConfigConnection(config);
    setConnectionResults((state) => ({ ...state, [config.id]: result }));
    setTestingIds((state) => ({ ...state, [config.id]: false }));
  };

  return (
    <AdminShell
      title="模型配置"
      description="在这里管理供应商、接口端点、路由优先级和默认模型。工作区现在会读取这套共享配置。"
      action={
        <Button className="rounded-full bg-[#ff6a1f] px-5 text-white hover:bg-[#ff7b35]" onClick={openCreate}>
          <Plus className="h-4 w-4" />
          新增配置
        </Button>
      }
    >
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <StatCard label="配置总数" value={String(modelConfigs.length)} />
        <StatCard label="已启用路由" value={String(modelConfigs.filter((config) => config.enabled).length)} />
        <StatCard label="默认路由" value={String(modelConfigs.filter((config) => config.isDefault).length)} />
      </div>

      <ModelConfigTable
        configs={sortedConfigs}
        onEdit={openEdit}
        onToggleEnabled={toggleEnabled}
        onDelete={removeModelConfig}
        onTestConnection={runConnectionTest}
        connectionResults={connectionResults}
        testingIds={testingIds}
      />

      <ModelConfigDrawer
        open={drawerOpen}
        config={editingConfig}
        onOpenChange={(open) => {
          setDrawerOpen(open);
          if (!open) {
            setEditingId(null);
          }
        }}
        onSave={upsertModelConfig}
      />
    </AdminShell>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[24px] border border-white/[0.08] bg-[#111111] p-5 shadow-[0_25px_70px_-35px_rgba(0,0,0,0.9)]">
      <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">{label}</p>
      <p className="mt-3 text-3xl font-semibold text-white">{value}</p>
    </div>
  );
}
