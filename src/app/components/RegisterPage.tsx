import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowUpRight, BadgeCheck, KeyRound, Lock, Mail, UserRound } from "lucide-react";
import { gsap } from "gsap";

import { toUserMessage } from "../api/errors";
import { useAuth } from "../auth/AuthProvider";
import { useStore } from "../store";
import { AuthField, AuthLayout } from "./auth-layout";

export function RegisterPage() {
  const language = useStore((state) => state.language);
  const { registerByInvite } = useAuth();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    invitationCode: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zh = language === "zh";

  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    const mm = gsap.matchMedia();
    const cleanup: Array<() => void> = [];
    const ctx = gsap.context(() => {
      mm.add(
        {
          reduceMotion: "(prefers-reduced-motion: reduce)",
          noPreference: "(prefers-reduced-motion: no-preference)",
        },
        ({ conditions }) => {
          if (conditions?.reduceMotion) {
            return;
          }

          const bindLift = (selector: string, y: number) => {
            root.querySelectorAll<HTMLElement>(selector).forEach((node) => {
              const enter = () => gsap.to(node, { y: -y, duration: 0.22, ease: "power2.out" });
              const leave = () => gsap.to(node, { y: 0, scale: 1, duration: 0.18, ease: "power2.out" });
              const down = () => gsap.to(node, { y: -1, scale: 0.992, duration: 0.12, ease: "power2.out" });
              const up = () => gsap.to(node, { y: -y, scale: 1, duration: 0.16, ease: "power2.out" });

              node.addEventListener("pointerenter", enter);
              node.addEventListener("pointerleave", leave);
              node.addEventListener("pointerdown", down);
              node.addEventListener("pointerup", up);

              cleanup.push(() => {
                node.removeEventListener("pointerenter", enter);
                node.removeEventListener("pointerleave", leave);
                node.removeEventListener("pointerdown", down);
                node.removeEventListener("pointerup", up);
              });
            });
          };

          bindLift("[data-auth-cta]", 3);
        },
      );
    }, root);

    return () => {
      cleanup.forEach((fn) => fn());
      ctx.revert();
      mm.revert();
    };
  }, []);

  const copy = useMemo(
    () =>
      zh
        ? {
            brand: "橙次元",
            tagline: "使用邀请码加入工作台，接入同一套智能创作系统。",
            name: "姓名",
            email: "邮箱地址",
            password: "密码",
            code: "邀请码",
            submit: "立即注册",
            submitLoading: "注册中...",
            loginHint: "已有账号？",
            login: "返回登录",
            namePlaceholder: "请输入姓名",
            emailPlaceholder: "邮箱地址",
            passwordPlaceholder: "请设置登录密码",
            codePlaceholder: "请输入邀请码",
          }
        : {
            brand: "CCY Dimension",
            tagline: "Join the workspace with an invite code and enter the shared creative system.",
            name: "Name",
            email: "Email",
            password: "Password",
            code: "Invitation code",
            submit: "Create account",
            submitLoading: "Creating...",
            loginHint: "Already have an account?",
            login: "Back to sign in",
            namePlaceholder: "Enter your name",
            emailPlaceholder: "Email",
            passwordPlaceholder: "Set a password",
            codePlaceholder: "Enter invitation code",
          },
    [zh],
  );

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const user = await registerByInvite(form);
      navigate(user.role === "admin" ? "/admin" : "/app", { replace: true });
    } catch (err) {
      setError(toUserMessage(err, zh ? "zh" : "en"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout title={copy.brand} subtitle={copy.tagline}>
      <form ref={rootRef} onSubmit={onSubmit}>
        <div className="space-y-4">
          <AuthField
            type="text"
            value={form.name}
            onChange={(value) => setForm((current) => ({ ...current, name: value }))}
            icon={<UserRound className="h-[22px] w-[22px] text-white/45" strokeWidth={1.75} />}
            placeholder={copy.namePlaceholder}
            label={copy.name}
          />
          <AuthField
            type="email"
            value={form.email}
            onChange={(value) => setForm((current) => ({ ...current, email: value }))}
            icon={<Mail className="h-[22px] w-[22px] text-white/45" strokeWidth={1.75} />}
            placeholder={copy.emailPlaceholder}
            label={copy.email}
          />
          <AuthField
            type="password"
            value={form.password}
            onChange={(value) => setForm((current) => ({ ...current, password: value }))}
            icon={<Lock className="h-[22px] w-[22px] text-white/45" strokeWidth={1.75} />}
            placeholder={copy.passwordPlaceholder}
            label={copy.password}
          />
          <AuthField
            type="text"
            value={form.invitationCode}
            onChange={(value) => setForm((current) => ({ ...current, invitationCode: value }))}
            icon={<KeyRound className="h-[22px] w-[22px] text-white/45" strokeWidth={1.75} />}
            placeholder={copy.codePlaceholder}
            label={copy.code}
          />
        </div>

        {error ? <p className="mt-4 text-sm text-[#ff8b61]">{error}</p> : null}

        <div data-auth-note className="mt-6 rounded-[16px] border border-white/10 bg-white/[0.03] p-4 text-[14px] text-white/48">
          <div className="flex items-center gap-3 text-white/72">
            <BadgeCheck className="h-5 w-5 text-[#ff6c28]" />
            <span>{zh ? "管理员发放的邀请码会自动绑定初始额度。" : "Admin-issued invite codes bootstrap your initial quota automatically."}</span>
          </div>
        </div>

        <button
          type="submit"
          data-auth-cta
          disabled={submitting}
          className="group relative mt-7 flex h-[74px] w-full items-center justify-center overflow-hidden rounded-[16px] bg-[linear-gradient(90deg,#ff5b16_0%,#ff6a1f_55%,#ff4d08_100%)] text-[18px] font-semibold tracking-[0.08em] text-white shadow-[0_18px_48px_rgba(255,92,31,0.28)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70"
        >
          <span className="absolute inset-0 bg-[radial-gradient(circle_at_84%_78%,rgba(255,233,201,0.4),transparent_14%),linear-gradient(180deg,rgba(255,255,255,0.08),transparent_55%)] opacity-90" />
          <span className="relative">{submitting ? copy.submitLoading : copy.submit}</span>
          <ArrowUpRight className="absolute right-7 h-6 w-6 text-white" strokeWidth={2} />
          <span className="absolute -right-2 bottom-0 h-16 w-16 rotate-45 bg-[radial-gradient(circle,rgba(255,244,228,0.95)_0%,rgba(255,177,124,0.85)_18%,rgba(255,95,31,0.0)_72%)] opacity-95" />
        </button>

        <p className="mt-9 text-center text-[17px] text-white/42">
          {copy.loginHint}
          <Link to="/login" className="ml-2 font-medium text-[#ff661f] transition hover:text-[#ff8a53]">
            {copy.login}
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
