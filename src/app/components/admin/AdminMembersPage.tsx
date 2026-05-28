import { AdminShell } from "./AdminShell";
import { useStore } from "../../store";

export function AdminMembersPage() {
  const spaceMembers = useStore((state) => state.spaceMembers);
  const spaces = useStore((state) => state.spaces);

  return (
    <AdminShell
      title="成员"
      description="查看成员的全局角色、所属团队空间，以及在不同空间里的权限级别。后续会在这里补充空间分配和权限调整操作。"
    >
      <div className="overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#111111] shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]">
        <div className="grid grid-cols-[1.1fr_1.3fr_0.8fr_1fr_0.8fr] gap-4 border-b border-white/[0.08] px-6 py-4 text-[11px] uppercase tracking-[0.18em] text-neutral-500">
          <div>成员名</div>
          <div>邮箱</div>
          <div>全局角色</div>
          <div>所属空间</div>
          <div>空间权限</div>
        </div>
        <div className="divide-y divide-white/[0.06]">
          {spaceMembers.map((member) => {
            const space = spaces.find((item) => item.id === member.spaceId);

            return (
              <div key={`${member.userId}-${member.spaceId}`} className="grid grid-cols-[1.1fr_1.3fr_0.8fr_1fr_0.8fr] gap-4 px-6 py-4 text-sm">
                <div className="font-medium text-white">{member.name}</div>
                <div className="text-neutral-400">{member.email}</div>
                <div>
                  <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-neutral-300">
                    {member.globalRole}
                  </span>
                </div>
                <div className="text-neutral-300">{space?.name ?? member.spaceId}</div>
                <div>
                  <span className="rounded-full bg-[#ff6a1f]/12 px-2.5 py-1 text-xs text-[#ff9b68]">
                    {member.role}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AdminShell>
  );
}
