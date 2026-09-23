import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, Loader2, MapPin, Plus, X } from "lucide-react";
import { toast } from "sonner";

import { uploadFile } from "../api/projects";
import { useAuth } from "../auth/AuthProvider";
import { useStore } from "../store";
import { UserAvatar } from "./UserAvatar";

type ProfileDraft = {
  name: string;
  username: string;
  headline: string;
  bio: string;
  location: string;
  website: string;
  x: string;
  instagram: string;
  avatar: string;
};

const EMPTY_DRAFT: ProfileDraft = {
  name: "",
  username: "",
  headline: "",
  bio: "",
  location: "",
  website: "",
  x: "",
  instagram: "",
  avatar: "",
};

function draftFromUser(user: ReturnType<typeof useAuth>["user"]): ProfileDraft {
  if (!user) return EMPTY_DRAFT;
  return {
    name: user.name ?? "",
    username: user.username ?? "",
    headline: user.headline ?? "",
    bio: user.bio ?? "",
    location: user.location ?? "",
    website: user.socials?.website ?? "",
    x: user.socials?.x ?? "",
    instagram: user.socials?.instagram ?? "",
    avatar: user.avatar ?? "",
  };
}

export function ProfileSettingsModal() {
  const open = useStore((state) => state.isProfileOpen);
  const setOpen = useStore((state) => state.setProfileOpen);
  const language = useStore((state) => state.language);
  const { user, updateProfile } = useAuth();
  const zh = language === "zh";
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(draftFromUser(user));
    setAvatarFile(null);
    setPreviewUrl("");
  }, [open, user]);

  useEffect(() => {
    if (!avatarFile) return;
    const objectUrl = URL.createObjectURL(avatarFile);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [avatarFile]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) setOpen(false);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, saving, setOpen]);

  const avatarSrc = previewUrl || draft.avatar;
  const changed = useMemo(() => {
    if (!user) return false;
    return avatarFile !== null || JSON.stringify(draft) !== JSON.stringify(draftFromUser(user));
  }, [avatarFile, draft, user]);

  if (!open || !user) return null;

  const update = (key: keyof ProfileDraft, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const chooseAvatar = (file?: File) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error(zh ? "请选择 JPG、PNG 或 WebP 图片" : "Choose a JPG, PNG, or WebP image");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error(zh ? "头像图片不能超过 5MB" : "Profile picture must be under 5MB");
      return;
    }
    setAvatarFile(file);
  };

  const save = async () => {
    if (!draft.name.trim()) {
      toast.error(zh ? "请输入姓名或昵称" : "Enter your name");
      return;
    }
    if (draft.username && !/^[a-zA-Z0-9._-]{3,32}$/.test(draft.username)) {
      toast.error(zh ? "用户名需为 3-32 位字母、数字、点、下划线或短横线" : "Username must be 3-32 letters, numbers, dots, underscores, or hyphens");
      return;
    }
    setSaving(true);
    try {
      let avatar = draft.avatar;
      if (avatarFile) {
        const uploaded = await uploadFile(avatarFile, avatarFile.name);
        avatar = uploaded.url;
      }
      await updateProfile({
        name: draft.name,
        username: draft.username,
        headline: draft.headline,
        bio: draft.bio,
        location: draft.location,
        avatar,
        socials: {
          website: draft.website,
          x: draft.x,
          instagram: draft.instagram,
        },
      });
      toast.success(zh ? "个人资料已保存" : "Profile saved");
      setOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/already in use|CONFLICT/i.test(message)) {
        toast.error(zh ? "这个用户名已被使用" : "This username is already in use");
      } else {
        toast.error(zh ? "保存失败，请稍后重试" : "Could not save profile");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 sm:p-8" role="dialog" aria-modal="true" aria-label={zh ? "编辑个人资料" : "Edit profile"}>
      <button className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-md" aria-label={zh ? "关闭" : "Close"} onClick={() => !saving && setOpen(false)} />
      <section className="relative flex max-h-[min(820px,90vh)] w-full max-w-[580px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#191b20] shadow-[0_28px_90px_rgba(0,0,0,.6)]">
        <header className="flex shrink-0 items-center justify-between border-b border-white/8 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-white">{zh ? "编辑个人资料" : "Edit profile"}</h2>
            <p className="mt-0.5 text-xs text-neutral-500">{zh ? "完善资料，让协作成员更容易认出你" : "Help collaborators recognize you"}</p>
          </div>
          <button type="button" disabled={saving} onClick={() => setOpen(false)} className="grid h-8 w-8 place-items-center rounded-full text-neutral-500 transition hover:bg-white/8 hover:text-white disabled:opacity-40">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 [scrollbar-color:#4b4e55_transparent]">
          <div>
            <FieldLabel>{zh ? "头像" : "Profile picture"}</FieldLabel>
            <div className="mt-3 flex items-center gap-4">
              <button type="button" onClick={() => inputRef.current?.click()} className="group relative h-[76px] w-[76px] shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                <UserAvatar
                  avatar={avatarSrc}
                  name={draft.name}
                  className="h-full w-full rounded-full border border-white/15 object-cover text-2xl font-semibold"
                  fallbackClassName="bg-gradient-to-br from-orange-500/80 via-amber-200/30 to-cyan-400/70 text-white"
                />
                <span className="absolute bottom-0 right-0 grid h-7 w-7 place-items-center rounded-lg border border-[#191b20] bg-[#3a3d44] text-white shadow-lg transition group-hover:bg-orange-500">
                  <Plus className="h-4 w-4" />
                </span>
              </button>
              <div className="min-w-0">
                <button type="button" onClick={() => inputRef.current?.click()} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-medium text-neutral-200 transition hover:border-orange-500/40 hover:bg-orange-500/10">
                  <Camera className="h-3.5 w-3.5" />
                  {zh ? "上传新头像" : "Upload new picture"}
                </button>
                <p className="mt-2 text-[11px] text-neutral-500">JPG、PNG、WebP · {zh ? "最大 5MB" : "5MB max"}</p>
              </div>
              <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(event) => { chooseAvatar(event.target.files?.[0]); event.currentTarget.value = ""; }} />
            </div>
          </div>

          <div className="grid gap-5">
            <TextField label={zh ? "姓名 / 昵称" : "Name"} value={draft.name} maxLength={80} placeholder={zh ? "你的姓名或昵称" : "Your name"} onChange={(value) => update("name", value)} />
            <TextField label={zh ? "用户名" : "Username"} value={draft.username} maxLength={32} placeholder="username" prefix="@" hint={zh ? "用于个人标识，可使用字母、数字、点、下划线和短横线" : "Letters, numbers, dots, underscores, and hyphens"} onChange={(value) => update("username", value.toLowerCase())} />
            <TextField label={zh ? "个人头衔" : "Headline"} value={draft.headline} maxLength={120} placeholder={zh ? "例如：导演、编剧、视觉创作者" : "Film Director, Writer, Visual Creator"} onChange={(value) => update("headline", value)} />
            <div>
              <FieldLabel>{zh ? "个人简介" : "Bio"}</FieldLabel>
              <div className="relative mt-2">
                <textarea value={draft.bio} maxLength={300} rows={5} placeholder={zh ? "介绍一下你的创作方向和擅长领域" : "Tell people about your work"} onChange={(event) => update("bio", event.target.value)} className="w-full resize-none rounded-xl border border-transparent bg-[#25272d] px-3.5 py-3 text-sm leading-6 text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-orange-500/55 focus:bg-[#282a30]" />
                <span className="absolute bottom-3 right-3 text-[11px] tabular-nums text-neutral-500">{draft.bio.length} / 300</span>
              </div>
            </div>
            <TextField label={zh ? "所在地" : "Location"} value={draft.location} maxLength={100} placeholder={zh ? "你所在的城市" : "Where are you based?"} icon={<MapPin className="h-4 w-4" />} onChange={(value) => update("location", value)} />
          </div>

          <div className="border-t border-white/8 pt-5">
            <h3 className="text-sm font-medium text-neutral-200">{zh ? "社交链接" : "Socials"}</h3>
            <p className="mt-1 text-[11px] text-neutral-500">{zh ? "选填，仅展示你愿意公开的信息" : "Optional public links"}</p>
            <div className="mt-4 grid gap-3">
              <TextField compact label={zh ? "个人网站" : "Website"} value={draft.website} maxLength={160} placeholder="https://" onChange={(value) => update("website", value)} />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextField compact label="X / Twitter" value={draft.x} maxLength={160} placeholder="@username" onChange={(value) => update("x", value)} />
                <TextField compact label="Instagram" value={draft.instagram} maxLength={160} placeholder="@username" onChange={(value) => update("instagram", value)} />
              </div>
            </div>
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-between border-t border-white/8 bg-[#17191d]/95 px-5 py-3.5 backdrop-blur-xl">
          <span className="text-[11px] text-neutral-500">{changed ? (zh ? "有未保存的修改" : "Unsaved changes") : (zh ? "资料已是最新" : "Profile is up to date")}</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={saving} onClick={() => setOpen(false)} className="rounded-lg bg-white/8 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-white/12 disabled:opacity-40">{zh ? "取消" : "Cancel"}</button>
            <button type="button" disabled={saving || !changed} onClick={() => void save()} className="inline-flex min-w-[76px] items-center justify-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-45">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {zh ? "保存" : "Save"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-sm font-medium text-neutral-200">{children}</label>;
}

function TextField({ label, value, onChange, placeholder, maxLength, hint, prefix, icon, compact = false }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  hint?: string;
  prefix?: string;
  icon?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="relative mt-2">
        {prefix ? <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-sm text-neutral-500">{prefix}</span> : null}
        {icon ? <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-neutral-500">{icon}</span> : null}
        <input value={value} maxLength={maxLength} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className={`w-full rounded-xl border border-transparent bg-[#25272d] ${compact ? "py-2.5" : "py-3"} pr-3.5 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-orange-500/55 focus:bg-[#282a30] ${prefix || icon ? "pl-9" : "pl-3.5"}`} />
      </div>
      {hint ? <p className="mt-1.5 text-[11px] leading-4 text-neutral-500">{hint}</p> : null}
    </div>
  );
}
