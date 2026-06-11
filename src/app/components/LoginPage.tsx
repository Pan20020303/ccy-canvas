import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowUpRight, Eye, EyeOff, Github, Lock, Mail, ShieldCheck } from "lucide-react";
import { gsap } from "gsap";

import { toUserMessage } from "../api/errors";
import { useAuth } from "../auth/AuthProvider";
import { useStore } from "../store";
import { AuthField, AuthLayout } from "./auth-layout";

export const LoginPage = () => {
  const navigate = useNavigate();
  const language = useStore((state) => state.language);
  const { login } = useAuth();
  const rootRef = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
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
          bindLift("[data-auth-social]", 2);
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
            tagline: "打破边界，连接无限可能。",
            email: "邮箱地址",
            password: "密码",
            remember: "记住我",
            forgot: "忘记密码？",
            submit: "立即登录",
            divider: "或使用以下方式继续",
            registerHint: "还没有账号？",
            register: "立即注册",
            google: "Google",
            github: "GitHub",
            sso: "单点登录",
            mailPlaceholder: "邮箱地址",
            passwordPlaceholder: "密码",
            showPassword: "显示密码",
            hidePassword: "隐藏密码",
            loading: "登录中...",
          }
        : {
            brand: "CCY Dimension",
            tagline: "Break the boundary, connect infinite possibilities.",
            email: "Email",
            password: "Password",
            remember: "Remember me",
            forgot: "Forgot password?",
            submit: "Sign in now",
            divider: "Or continue with",
            registerHint: "No account yet?",
            register: "Register",
            google: "Google",
            github: "GitHub",
            sso: "Single Sign-On",
            mailPlaceholder: "Email",
            passwordPlaceholder: "Password",
            showPassword: "Show password",
            hidePassword: "Hide password",
            loading: "Signing in...",
          },
    [zh],
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const user = await login({ email, password });
      navigate(user.role === "admin" ? "/admin" : "/app", { replace: true });
    } catch (err) {
      setError(toUserMessage(err, zh ? "zh" : "en"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout title={copy.brand} subtitle={copy.tagline}>
      <form ref={rootRef} onSubmit={submit}>
        <div className="space-y-4">
          <AuthField
            type="email"
            value={email}
            onChange={setEmail}
            icon={<Mail className="h-[20px] w-[20px] text-white/45" strokeWidth={1.75} />}
            placeholder={copy.mailPlaceholder}
            label={copy.email}
          />
          <AuthField
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={setPassword}
            icon={<Lock className="h-[20px] w-[20px] text-white/45" strokeWidth={1.75} />}
            placeholder={copy.passwordPlaceholder}
            label={copy.password}
            trailing={
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="text-white/38 transition hover:text-white/64"
                aria-label={showPassword ? copy.hidePassword : copy.showPassword}
              >
                {showPassword ? <Eye className="h-[20px] w-[20px]" strokeWidth={1.75} /> : <EyeOff className="h-[20px] w-[20px]" strokeWidth={1.75} />}
              </button>
            }
          />
        </div>

        <div className="mt-4 flex items-center justify-between gap-4 text-[14px] text-white/52">
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="h-[18px] w-[18px] rounded-[4px] border border-white/22 bg-transparent text-[#ff5d1f] accent-[#ff5d1f]"
            />
            <span>{copy.remember}</span>
          </label>
          <button type="button" className="transition hover:text-white/80">
            {copy.forgot}
          </button>
        </div>

        {error ? <p className="mt-3 text-sm text-[#ff8b61]">{error}</p> : null}

        {/* CTA 按钮按 φ 比例:height 56 = text 16 × ~3.5;角半径 14 = 输入 12 × φ⁰·⁵.
            阴影更含蓄,让透明背景能透出来. */}
        <button
          type="submit"
          data-auth-cta
          disabled={submitting}
          className="group relative mt-6 flex h-[56px] w-full items-center justify-center overflow-hidden rounded-[14px] bg-[linear-gradient(90deg,#ff5b16_0%,#ff6a1f_55%,#ff4d08_100%)] text-[16px] font-semibold tracking-[0.08em] text-white shadow-[0_14px_36px_rgba(255,92,31,0.24)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70"
        >
          <span className="absolute inset-0 bg-[radial-gradient(circle_at_84%_78%,rgba(255,233,201,0.4),transparent_14%),linear-gradient(180deg,rgba(255,255,255,0.08),transparent_55%)] opacity-90" />
          <span className="relative">{submitting ? copy.loading : copy.submit}</span>
          <ArrowUpRight className="absolute right-5 h-5 w-5 text-white" strokeWidth={2} />
          <span className="absolute -right-2 bottom-0 h-14 w-14 rotate-45 bg-[radial-gradient(circle,rgba(255,244,228,0.95)_0%,rgba(255,177,124,0.85)_18%,rgba(255,95,31,0.0)_72%)] opacity-95" />
        </button>

        <div className="mt-9 flex items-center gap-5 text-[14px] text-white/40">
          <div className="h-px flex-1 bg-white/12" />
          <span>{copy.divider}</span>
          <div className="h-px flex-1 bg-white/12" />
        </div>

        <div className="mt-6 grid grid-cols-3 gap-3 sm:gap-3.5" data-auth-socials>
          <SocialButton label={copy.google}>
            <GoogleIcon />
          </SocialButton>
          <SocialButton label={copy.github}>
            <Github className="h-5 w-5 text-white" strokeWidth={1.9} />
          </SocialButton>
          <SocialButton label={copy.sso}>
            <ShieldCheck className="h-5 w-5 text-white" strokeWidth={1.8} />
          </SocialButton>
        </div>

        <p className="mt-7 text-center text-[14.5px] text-white/42">
          {copy.registerHint}
          <Link to="/register" className="ml-2 font-medium text-[#ff661f] transition hover:text-[#ff8a53]">
            {copy.register}
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
};

function SocialButton({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      data-auth-social
      /* 3 列 × 高 64 → 每个按钮 w/h ≈ φ,跟 CTA 内部 padding 节奏一致.
         bg 透明度下调到 0.52/0.58 让卡片整体一致透出背景视频. */
      className="flex h-[64px] items-center justify-center gap-2.5 rounded-[12px] border border-white/12 bg-[linear-gradient(180deg,rgba(17,20,28,0.52),rgba(11,14,20,0.58))] px-3 text-[14px] text-white/90 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition hover:border-white/24 hover:bg-white/[0.06]"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-white">{children}</span>
      <span>{label}</span>
    </button>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24">
      <path
        d="M21.805 12.041c0-.79-.071-1.548-.202-2.273H12v4.303h5.497a4.698 4.698 0 0 1-2.037 3.084v2.56h3.3c1.932-1.779 3.045-4.399 3.045-7.674Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.7 0 4.965-.895 6.62-2.425l-3.3-2.56c-.895.6-2.044.965-3.32.965-2.56 0-4.734-1.728-5.507-4.051H3.082v2.64A9.996 9.996 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.493 13.929A5.996 5.996 0 0 1 6.18 12c0-.67.12-1.318.313-1.929v-2.64H3.082A9.996 9.996 0 0 0 2 12c0 1.61.387 3.128 1.082 4.569l3.411-2.64Z"
        fill="#FBBC05"
      />
      <path
        d="M12 6.02c1.467 0 2.782.506 3.816 1.504l2.84-2.84C16.96 3.118 14.695 2 12 2A9.996 9.996 0 0 0 3.082 7.431l3.411 2.64C7.266 7.748 9.44 6.02 12 6.02Z"
        fill="#EA4335"
      />
    </svg>
  );
}
