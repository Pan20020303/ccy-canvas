import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  XCircle,
} from "lucide-react";

import type { GenerationLog } from "../../api/admin";
import { listLogs } from "../../api/admin";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { AdminShell } from "./AdminShell";

const LOG_PAGE_SIZE = 100;

const SERVICE_LABELS: Record<string, string> = {
  text: "文本生成",
  image: "图片生成",
  video: "视频生成",
  audio: "音频生成",
};

const STATUS_LABELS: Record<GenerationLog["status"], string> = {
  pending: "生成中",
  success: "成功",
  error: "失败",
};

type ColumnKey = "user" | "type" | "model" | "prompt" | "status" | "duration" | "time";
type ColumnDef = { key: ColumnKey; label: string };

const COLUMN_DEFS: ColumnDef[] = [
  { key: "user", label: "用户" },
  { key: "type", label: "任务类型" },
  { key: "model", label: "模型" },
  { key: "prompt", label: "提示词" },
  { key: "status", label: "状态" },
  { key: "duration", label: "耗时" },
  { key: "time", label: "时间" },
];

const DEFAULT_VISIBLE: Record<ColumnKey, boolean> = {
  user: true,
  type: false,
  model: true,
  prompt: false,
  status: true,
  duration: false,
  time: true,
};

const STORAGE_KEY = "admin-logs-visible-columns";

function loadVisibility(): Record<ColumnKey, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_VISIBLE;
    }

    const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, boolean>>;
    return { ...DEFAULT_VISIBLE, ...parsed };
  } catch {
    return DEFAULT_VISIBLE;
  }
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(durationMs: number) {
  if (durationMs <= 0) {
    return "未完成";
  }
  if (durationMs < 1000) {
    return `${durationMs} ms`;
  }
  return `${(durationMs / 1000).toFixed(durationMs >= 10000 ? 0 : 1)} s`;
}

function getServiceLabel(serviceType: string) {
  return SERVICE_LABELS[serviceType] ?? serviceType;
}

function getUserLabel(log: GenerationLog) {
  return log.user_name || log.user_email || `${log.user_id.slice(0, 8)}…`;
}

function StatusCell({ log }: { log: GenerationLog }) {
  if (log.status === "success") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {STATUS_LABELS.success}
      </span>
    );
  }

  if (log.status === "pending") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300">
        <Clock className="h-3.5 w-3.5 animate-pulse" />
        {STATUS_LABELS.pending}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400" title={log.error_msg}>
      <XCircle className="h-3.5 w-3.5" />
      {STATUS_LABELS.error}
    </span>
  );
}

function MetricCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "neutral" | "pending" | "success" | "error";
}) {
  const valueClassName =
    tone === "pending"
      ? "text-amber-300"
      : tone === "success"
        ? "text-emerald-400"
        : tone === "error"
          ? "text-red-400"
          : "text-white";

  return (
    <div data-admin-card className="rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4">
      <p className="text-[11px] uppercase tracking-[0.22em] text-neutral-500">{label}</p>
      <p className={`mt-2 text-3xl font-semibold ${valueClassName}`}>{value}</p>
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">{label}</p>
      <p className="mt-2 break-all text-sm leading-6 text-neutral-100">{value || "—"}</p>
    </div>
  );
}

function TaskDetailDrawer({
  log,
  open,
  onOpenChange,
}: {
  log: GenerationLog | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full border-l border-white/10 bg-[#111111] p-0 text-neutral-100 sm:max-w-[720px]">
        <SheetHeader className="border-b border-white/[0.08] px-6 py-5">
          <div className="pr-8">
            <SheetTitle className="text-xl text-white">任务详情</SheetTitle>
            <SheetDescription className="mt-2 text-sm leading-6 text-neutral-400">
              查看这次生成调用的完整提示词、模型、执行状态、错误信息和结果链接。
            </SheetDescription>
          </div>
        </SheetHeader>

        {log ? (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="grid gap-4 md:grid-cols-2">
              <DetailItem label="用户" value={getUserLabel(log)} />
              <DetailItem label="用户邮箱 / ID" value={log.user_email || log.user_id} />
              <DetailItem label="任务类型" value={getServiceLabel(log.service_type)} />
              <DetailItem label="模型" value={log.model} />
              <DetailItem label="状态" value={STATUS_LABELS[log.status]} />
              <DetailItem label="耗时" value={formatDuration(log.duration_ms)} />
              <DetailItem label="创建时间" value={formatDateTime(log.created_at)} />
              <DetailItem label="节点 ID" value={log.node_id || "—"} />
            </div>

            <div className="mt-4 space-y-4">
              <div className="rounded-[24px] border border-white/[0.08] bg-white/[0.03] p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">完整提示词</p>
                  <Badge className="border-white/10 bg-white/[0.06] text-neutral-300">
                    {getServiceLabel(log.service_type)}
                  </Badge>
                </div>
                <pre className="mt-3 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-2xl border border-white/[0.06] bg-[#0d0d0d] p-4 text-sm leading-6 text-neutral-200">
                  {log.prompt || "无提示词"}
                </pre>
              </div>

              {log.error_msg ? (
                <div className="rounded-[24px] border border-red-500/20 bg-red-500/[0.07] p-4">
                  <p className="text-[11px] uppercase tracking-[0.18em] text-red-200/80">错误信息</p>
                  <p className="mt-3 whitespace-pre-wrap break-all text-sm leading-6 text-red-100">{log.error_msg}</p>
                </div>
              ) : null}

              <div className="rounded-[24px] border border-white/[0.08] bg-white/[0.03] p-4">
                <p className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">结果链接</p>
                {log.result_url ? (
                  <a
                    href={log.result_url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex items-center gap-2 text-sm text-cyan-300 transition hover:text-cyan-200"
                  >
                    打开生成结果
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : (
                  <p className="mt-3 text-sm text-neutral-400">当前暂无结果链接。</p>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export function AdminLogsPage() {
  const [logs, setLogs] = useState<GenerationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [totalCount, setTotalCount] = useState(0);
  const [visible, setVisible] = useState<Record<ColumnKey, boolean>>(() => loadVisibility());
  const [statusFilter, setStatusFilter] = useState<"" | "pending" | "success" | "error">("");
  const [userFilter, setUserFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [selectedLog, setSelectedLog] = useState<GenerationLog | null>(null);

  const deferredUserFilter = useDeferredValue(userFilter);
  const deferredModelFilter = useDeferredValue(modelFilter);

  const load = useCallback(async (offset = 0) => {
    if (offset === 0) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError("");

    try {
      const result = await listLogs(LOG_PAGE_SIZE, offset, {
        status: statusFilter,
        user: deferredUserFilter,
        model: deferredModelFilter,
      });
      setLogs((current) => (offset === 0 ? result.data : [...current, ...result.data]));
      setTotalCount(result.total);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载任务日志失败");
    } finally {
      if (offset === 0) {
        setLoading(false);
      } else {
        setLoadingMore(false);
      }
    }
  }, [deferredModelFilter, deferredUserFilter, statusFilter]);

  useEffect(() => {
    void load(0);
  }, [load]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(visible));
    } catch {
      // Ignore persistence failures.
    }
  }, [visible]);

  useEffect(() => {
    if (!logs.some((log) => log.status === "pending")) {
      return;
    }

    const timer = window.setInterval(() => {
      void load(0);
    }, 8000);

    return () => window.clearInterval(timer);
  }, [logs, load]);

  useEffect(() => {
    if (!selectedLog) {
      return;
    }

    const updatedSelection = logs.find((log) => log.id === selectedLog.id);
    if (updatedSelection) {
      setSelectedLog(updatedSelection);
    }
  }, [logs, selectedLog]);

  const visibleColumns = useMemo(() => COLUMN_DEFS.filter((column) => visible[column.key]), [visible]);

  const counts = useMemo(
    () => ({
      total: logs.length,
      pending: logs.filter((log) => log.status === "pending").length,
      success: logs.filter((log) => log.status === "success").length,
      error: logs.filter((log) => log.status === "error").length,
    }),
    [logs],
  );

  return (
    <AdminShell
      title="任务日志"
      description="查看真实生成任务的审计记录，追踪哪个用户调用了什么模型、使用了什么提示词，以及任务当前是否成功、失败或仍在生成中。"
      action={
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 border-white/10 text-neutral-300 hover:bg-white/5">
                <SlidersHorizontal className="h-3.5 w-3.5" />
                显示字段
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-48 border-white/10 bg-[#1a1d22]/98 p-1.5 text-neutral-200 shadow-2xl backdrop-blur-xl">
              <div className="px-2 pb-1 pt-1 text-[10px] uppercase tracking-[0.18em] text-neutral-500">选择列表字段</div>
              {COLUMN_DEFS.map((column) => (
                <button
                  key={column.key}
                  type="button"
                  onClick={() => setVisible((current) => ({ ...current, [column.key]: !current[column.key] }))}
                  className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-sm transition hover:bg-white/5"
                >
                  <span>{column.label}</span>
                  {visible[column.key] ? <Check className="h-3.5 w-3.5 text-cyan-300" /> : null}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            className="gap-1.5 border-white/10 text-neutral-300 hover:bg-white/5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            刷新
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="日志总数" value={totalCount} />
          <MetricCard label="生成中" value={counts.pending} tone="pending" />
          <MetricCard label="成功任务" value={counts.success} tone="success" />
          <MetricCard label="失败任务" value={counts.error} tone="error" />
        </div>

        <div
          data-admin-card
          className="grid gap-3 rounded-[24px] border border-white/[0.08] bg-[#101010]/90 p-4 md:grid-cols-[180px_minmax(0,1fr)_minmax(0,1fr)]"
        >
          <label className="space-y-2">
            <span className="text-xs font-medium text-neutral-400">状态筛选</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as "" | "pending" | "success" | "error")}
              className="h-10 w-full rounded-xl border border-white/10 bg-[#141414] px-3 text-sm text-neutral-100 outline-none transition focus:border-cyan-300/50"
            >
              <option value="">全部状态</option>
              <option value="pending">生成中</option>
              <option value="success">成功</option>
              <option value="error">失败</option>
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-medium text-neutral-400">用户关键词</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
              <Input
                value={userFilter}
                onChange={(event) => setUserFilter(event.target.value)}
                placeholder="搜索用户名或邮箱"
                className="h-10 rounded-xl border-white/10 bg-[#141414] pl-9 text-neutral-100 placeholder:text-neutral-500"
              />
            </div>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-medium text-neutral-400">模型关键词</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
              <Input
                value={modelFilter}
                onChange={(event) => setModelFilter(event.target.value)}
                placeholder="搜索模型名称"
                className="h-10 rounded-xl border-white/10 bg-[#141414] pl-9 text-neutral-100 placeholder:text-neutral-500"
              />
            </div>
          </label>
        </div>

        <div
          data-admin-panel
          className="overflow-hidden rounded-[30px] border border-white/[0.08] bg-[#111111]/95 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-3">
            <div>
              <p className="text-sm font-medium text-white">任务审计列表</p>
              <p className="mt-1 text-xs text-neutral-500">默认展示用户、模型、状态和时间，其他字段可在右上角按需展开。</p>
            </div>
            <Badge className="border-white/10 bg-white/[0.05] text-neutral-300">实时轮询仅在存在生成中任务时启用</Badge>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                  {visibleColumns.map((column) => (
                    <th
                      key={column.key}
                      className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-neutral-500"
                    >
                      {column.label}
                    </th>
                  ))}
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-neutral-500">详情</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {loading ? (
                  <tr>
                    <td colSpan={visibleColumns.length + 1} className="py-16 text-center text-neutral-500">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                    </td>
                  </tr>
                ) : error ? (
                  <tr>
                    <td colSpan={visibleColumns.length + 1} className="px-4 py-16 text-center">
                      <p className="text-sm text-red-300">{error}</p>
                    </td>
                  </tr>
                ) : logs.length === 0 ? (
                  <tr>
                    <td colSpan={visibleColumns.length + 1} className="px-4 py-16 text-center text-sm text-neutral-500">
                      当前筛选条件下暂无任务日志。
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <tr
                      key={log.id}
                      className="cursor-pointer transition hover:bg-white/[0.02]"
                      onClick={() => setSelectedLog(log)}
                    >
                      {visible.user ? (
                        <td className="px-4 py-3">
                          <div className="flex flex-col">
                            <span className="text-sm text-neutral-200">{getUserLabel(log)}</span>
                            <span className="text-[11px] text-neutral-500">{log.user_email || log.user_id.slice(0, 8)}</span>
                          </div>
                        </td>
                      ) : null}
                      {visible.type ? (
                        <td className="px-4 py-3">
                          <Badge className="border-white/10 bg-white/[0.06] text-neutral-300">
                            {getServiceLabel(log.service_type)}
                          </Badge>
                        </td>
                      ) : null}
                      {visible.model ? (
                        <td className="px-4 py-3 font-mono text-xs text-neutral-300">{log.model}</td>
                      ) : null}
                      {visible.prompt ? (
                        <td className="max-w-[320px] px-4 py-3 text-neutral-300">
                          <span className="block truncate" title={log.prompt}>
                            {log.prompt || "无提示词"}
                          </span>
                        </td>
                      ) : null}
                      {visible.status ? (
                        <td className="px-4 py-3">
                          <StatusCell log={log} />
                        </td>
                      ) : null}
                      {visible.duration ? (
                        <td className="px-4 py-3 text-xs text-neutral-400">{formatDuration(log.duration_ms)}</td>
                      ) : null}
                      {visible.time ? (
                        <td className="px-4 py-3 text-xs text-neutral-400">{formatDateTime(log.created_at)}</td>
                      ) : null}
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedLog(log);
                          }}
                          className="text-neutral-300 hover:bg-white/[0.06] hover:text-white"
                        >
                          查看详情
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {!loading && !error && logs.length > 0 ? (
            <div className="border-t border-white/[0.04] bg-white/[0.01] px-4 py-3 text-xs text-neutral-500">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>当前加载 {logs.length} / {totalCount} 条任务记录。</span>
                {logs.length < totalCount ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void load(logs.length)}
                    disabled={loadingMore}
                    className="h-8 border-white/10 text-neutral-300 hover:bg-white/5"
                  >
                    {loadingMore ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    加载更多
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <TaskDetailDrawer log={selectedLog} open={selectedLog !== null} onOpenChange={(open) => !open && setSelectedLog(null)} />
    </AdminShell>
  );
}
