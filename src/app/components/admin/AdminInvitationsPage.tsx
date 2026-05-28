import { AdminShell } from "./AdminShell";
import { useStore } from "../../store";

export function AdminInvitationsPage() {
  const invitations = useStore((state) => state.invitations);
  const spaces = useStore((state) => state.spaces);

  return (
    <AdminShell
      title="邀请码"
      description="管理邀请码与默认团队空间归属。后续真实接入后，这里会支持创建、失效和按团队空间筛选。"
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {invitations.map((invitation) => {
          const targetSpace = spaces.find((space) => space.id === invitation.defaultSpaceId);

          return (
            <div
              key={invitation.id}
              className="rounded-[24px] border border-white/[0.08] bg-[#111111] p-5 shadow-[0_25px_70px_-35px_rgba(0,0,0,0.9)]"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs uppercase tracking-[0.18em] text-neutral-500">邀请码</div>
                <span
                  className={[
                    "rounded-full px-2.5 py-1 text-xs",
                    invitation.status === "active"
                      ? "bg-emerald-500/12 text-emerald-300"
                      : invitation.status === "used"
                        ? "bg-cyan-500/12 text-cyan-300"
                        : "bg-white/[0.06] text-neutral-500",
                  ].join(" ")}
                >
                  {invitation.status}
                </span>
              </div>

              <div className="mt-4 text-lg font-semibold text-white">{invitation.code}</div>

              <div className="mt-5 space-y-3 text-sm">
                <InfoRow label="默认团队空间" value={targetSpace?.name ?? invitation.defaultSpaceId} />
                <InfoRow label="已使用次数" value={String(invitation.usageCount)} />
              </div>
            </div>
          );
        })}
      </div>
    </AdminShell>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-neutral-500">{label}</span>
      <span className="text-neutral-200">{value}</span>
    </div>
  );
}
