import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowUpRight, Eye, EyeOff, Github, Lock, Mail, ShieldCheck } from "lucide-react";

import { toUserMessage } from "../api/errors";
import { useAuth } from "../auth/AuthProvider";
import { useStore } from "../store";
import { AuthField, AuthLayout } from "./auth-layout";

export const LoginPage = () => {
  const navigate = useNavigate();
  const language = useStore((state) => state.language);
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zh = language === "zh";

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
      <form onSubmit={submit}>
        <div className="space-y-4">
          <AuthField
            type="email"
            value={email}
            onChange={setEmail}
            icon={<Mail className="h-[22px] w-[22px] text-white/45" strokeWidth={1.75} />}
            placeholder={copy.mailPlaceholder}
            label={copy.email}
          />
          <AuthField
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={setPassword}
            icon={<Lock className="h-[22px] w-[22px] text-white/45" strokeWidth={1.75} />}
            placeholder={copy.passwordPlaceholder}
            label={copy.password}
            trailing={
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                className="text-white/38 transition hover:text-white/64"
                aria-label={showPassword ? copy.hidePassword : copy.showPassword}
              >
                {showPassword ? <Eye className="h-[22px] w-[22px]" strokeWidth={1.75} /> : <EyeOff className="h-[22px] w-[22px]" strokeWidth={1.75} />}
              </button>
            }
          />
        </div>

        <div className="mt-5 flex items-center justify-between gap-4 text-[15px] text-white/52">
          <label className="flex cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="h-5 w-5 rounded-[4px] border border-white/22 bg-transparent text-[#ff5d1f] accent-[#ff5d1f]"
            />
            <span>{copy.remember}</span>
          </label>
          <button type="button" className="transition hover:text-white/80">
            {copy.forgot}
          </button>
        </div>

        {error ? <p className="mt-4 text-sm text-[#ff8b61]">{error}</p> : null}

        <button
          type="submit"
          disabled={submitting}
          className="group relative mt-7 flex h-[74px] w-full items-center justify-center overflow-hidden rounded-[16px] bg-[linear-gradient(90deg,#ff5b16_0%,#ff6a1f_55%,#ff4d08_100%)] text-[18px] font-semibold tracking-[0.08em] text-white shadow-[0_18px_48px_rgba(255,92,31,0.28)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70"
        >
          <span className="absolute inset-0 bg-[radial-gradient(circle_at_84%_78%,rgba(255,233,201,0.4),transparent_14%),linear-gradient(180deg,rgba(255,255,255,0.08),transparent_55%)] opacity-90" />
          <span className="relative">{submitting ? copy.loading : copy.submit}</span>
          <ArrowUpRight className="absolute right-7 h-6 w-6 text-white" strokeWidth={2} />
          <span className="absolute -right-2 bottom-0 h-16 w-16 rotate-45 bg-[radial-gradient(circle,rgba(255,244,228,0.95)_0%,rgba(255,177,124,0.85)_18%,rgba(255,95,31,0.0)_72%)] opacity-95" />
        </button>

        <div className="mt-12 flex items-center gap-5 text-[15px] text-white/40">
          <div className="h-px flex-1 bg-white/14" />
          <span>{copy.divider}</span>
          <div className="h-px flex-1 bg-white/14" />
        </div>

        <div className="mt-7 grid grid-cols-3 gap-3 sm:gap-4">
          <SocialButton label={copy.google}>
            <GoogleIcon />
          </SocialButton>
          <SocialButton label={copy.github}>
            <Github className="h-6 w-6 text-white" strokeWidth={1.9} />
          </SocialButton>
          <SocialButton label={copy.sso}>
            <ShieldCheck className="h-6 w-6 text-white" strokeWidth={1.8} />
          </SocialButton>
        </div>

        <p className="mt-9 text-center text-[17px] text-white/42">
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
      className="flex h-[86px] items-center justify-center gap-3 rounded-[14px] border border-white/14 bg-[linear-gradient(180deg,rgba(17,20,28,0.92),rgba(11,14,20,0.92))] px-4 text-[17px] text-white/92 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition hover:border-white/24 hover:bg-white/[0.04]"
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" className="h-6 w-6" viewBox="0 0 24 24">
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
