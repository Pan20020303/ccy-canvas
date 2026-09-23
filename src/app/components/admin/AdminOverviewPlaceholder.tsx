export function AdminOverviewPlaceholder({ title }: { title: string }) {
  return (
    <div className="rounded-[28px] border border-white/[0.08] bg-[#111111] p-6 text-neutral-300 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]">
      <p className="text-xs uppercase tracking-[0.24em] text-[#ff9b68]">开发中</p>
      <h2 className="mt-3 text-2xl font-semibold text-white">{title}</h2>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-neutral-400">
        这个管理模块已经进入开发范围。当前阶段优先完成团队空间、成员权限和模型配置，后续会继续补齐这里的真实业务能力。
      </p>
    </div>
  );
}
