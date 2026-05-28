import { Link2, Pencil, Power, Star, Trash2 } from "lucide-react";

import type { ConnectionTestResult, ModelConfig } from "../../model-config";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

type ModelConfigTableProps = {
  configs: ModelConfig[];
  onEdit: (id: string) => void;
  onToggleEnabled: (config: ModelConfig) => void;
  onDelete: (id: string) => void;
  onTestConnection: (config: ModelConfig) => void;
  connectionResults: Record<string, ConnectionTestResult>;
  testingIds: Record<string, boolean>;
};

const headers = ["服务类型", "厂商", "名称", "Base URL", "默认模型", "优先级", "状态", "操作"];

export function ModelConfigTable({
  configs,
  onEdit,
  onToggleEnabled,
  onDelete,
  onTestConnection,
  connectionResults,
  testingIds,
}: ModelConfigTableProps) {
  return (
    <div className="overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#111111] shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]">
      <Table>
        <TableHeader>
          <TableRow className="border-white/[0.08] hover:bg-transparent">
            {headers.map((label) => (
              <TableHead key={label} className="h-12 px-5 text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-500">
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {configs.map((config) => {
            const result = connectionResults[config.id];
            return (
              <TableRow key={config.id} className="border-white/[0.06] hover:bg-white/[0.025]">
                <TableCell className="px-5 py-4">
                  <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-xs text-neutral-300">
                    {config.serviceType}
                  </span>
                </TableCell>
                <TableCell className="px-5 py-4 text-sm text-neutral-200">{config.vendor}</TableCell>
                <TableCell className="px-5 py-4">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">{config.name}</span>
                    {config.isDefault ? <Star className="h-3.5 w-3.5 fill-[#ff8a4c] text-[#ff8a4c]" /> : null}
                  </div>
                </TableCell>
                <TableCell className="max-w-[280px] px-5 py-4 text-sm text-neutral-400">{config.baseUrl}</TableCell>
                <TableCell className="px-5 py-4 text-sm text-neutral-300">{config.defaultModel || "未设置"}</TableCell>
                <TableCell className="px-5 py-4 text-sm text-neutral-300">{config.priority}</TableCell>
                <TableCell className="px-5 py-4">
                  <div className="space-y-2">
                    <span
                      className={[
                        "inline-flex rounded-full px-2.5 py-1 text-xs",
                        config.enabled ? "bg-emerald-500/12 text-emerald-300" : "bg-white/[0.06] text-neutral-500",
                      ].join(" ")}
                    >
                      {config.enabled ? "已启用" : "已停用"}
                    </span>
                    {result ? (
                      <div className={result.ok ? "text-xs text-emerald-300" : "text-xs text-rose-300"}>
                        {result.message}
                      </div>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-white/10 bg-white/[0.02] text-neutral-200 hover:bg-white/[0.06]"
                      onClick={() => onEdit(config.id)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      编辑
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-white/10 bg-white/[0.02] text-neutral-200 hover:bg-white/[0.06]"
                      onClick={() => onTestConnection(config)}
                      disabled={testingIds[config.id]}
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      {testingIds[config.id] ? "测试中" : "测试连接"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-white/10 bg-white/[0.02] text-neutral-300 hover:bg-white/[0.06]"
                      onClick={() => onToggleEnabled(config)}
                    >
                      <Power className="h-3.5 w-3.5" />
                      {config.enabled ? "停用" : "启用"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-rose-500/20 bg-rose-500/6 text-rose-300 hover:bg-rose-500/12"
                      onClick={() => onDelete(config.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
