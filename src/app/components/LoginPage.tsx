import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Eye, EyeOff, KeyRound, LoaderCircle, Mail } from "lucide-react";

import { resolveApiBrowserUrl } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { useStore } from "../store";
import { AuthField, AuthLayout } from "./auth-layout";
import { authFailure, useAuthFieldValidation, type AuthFailure } from "./auth/auth-validation";

export const LoginPage = () => {
  const navigate = useNavigate();
  const zh = useStore((state) => state.language) === "zh";
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const validation = useAuthFieldValidation({ email, password }, "login", zh);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("auth_error")) {
      setFailure({ message: zh ? "Google 登录失败，请稍后重试或使用邮箱密码登录。" : "Google sign-in failed. Please try again or use your email and password." });
    }
  }, [zh]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setFailure(null);
    const invalidField = validation.validate();
    if (invalidField) {
      (event.currentTarget.elements.namedItem(invalidField) as HTMLInputElement | null)?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const user = await login({ email: email.trim(), password });
      navigate(user.role === "admin" ? "/admin" : "/home", { replace: true });
    } catch (err) {
      setFailure(authFailure(err, "login", zh));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthLayout mode="login" title={zh ? "欢迎登录" : "Welcome back"} subtitle={zh ? "继续你的创作之旅" : "Continue your creative journey"}>
      <form onSubmit={submit} className="auth-form" aria-busy={submitting} noValidate>
        <AuthField
          type="email" name="email" autoComplete="username"
          value={email} onChange={(value) => { setEmail(value); setFailure(null); }} onBlur={() => validation.touch("email")}
          icon={<Mail size={18} strokeWidth={1.5} />}
          placeholder={zh ? "请输入邮箱地址" : "Email address"} label={zh ? "邮箱地址" : "Email address"}
          disabled={submitting} error={validation.errors.email || (failure?.field === "email" ? failure.message : undefined)}
        />
        <AuthField
          type={showPassword ? "text" : "password"} name="password" autoComplete="current-password"
          value={password} onChange={(value) => { setPassword(value); setFailure(null); }} onBlur={() => validation.touch("password")}
          icon={<KeyRound size={18} strokeWidth={1.5} />}
          placeholder={zh ? "请输入密码" : "Password"} label={zh ? "密码" : "Password"}
          disabled={submitting} error={validation.errors.password || (failure?.field === "password" ? failure.message : undefined)}
          trailing={
            <button className="auth-icon-button" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={zh ? (showPassword ? "隐藏密码" : "显示密码") : (showPassword ? "Hide password" : "Show password")} aria-pressed={showPassword}>
              {showPassword ? <Eye size={18} strokeWidth={1.5} /> : <EyeOff size={18} strokeWidth={1.5} />}
            </button>
          }
        />
        {failure && !failure.field && <p className="auth-error" role="alert">{failure.message}</p>}
        <button className="auth-submit" type="submit" disabled={submitting}>
          {submitting && <LoaderCircle className="auth-spinner" size={17} aria-hidden="true" />}
          {zh ? (submitting ? "登录中…" : "开始你的旅程") : (submitting ? "Signing in…" : "Begin your journey")}
        </button>
      </form>
      <div className="auth-divider"><span>{zh ? "或" : "or"}</span></div>
      <button className="auth-google" type="button" disabled={submitting} onClick={() => window.location.assign(resolveApiBrowserUrl("/api/auth/google/start"))}>
        <GoogleIcon />
        {zh ? "使用 Google 继续" : "Continue with Google"}
      </button>
    </AuthLayout>
  );
};

function GoogleIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
      <path d="M21.805 12.041c0-.79-.071-1.548-.202-2.273H12v4.303h5.497a4.698 4.698 0 0 1-2.037 3.084v2.56h3.3c1.932-1.779 3.045-4.399 3.045-7.674Z" fill="#4285F4" />
      <path d="M12 22c2.7 0 4.965-.895 6.62-2.425l-3.3-2.56c-.895.6-2.044.965-3.32.965-2.56 0-4.734-1.728-5.507-4.051H3.082v2.64A9.996 9.996 0 0 0 12 22Z" fill="#34A853" />
      <path d="M6.493 13.929A5.996 5.996 0 0 1 6.18 12c0-.67.12-1.318.313-1.929v-2.64H3.082A9.996 9.996 0 0 0 2 12c0 1.61.387 3.133 1.082 4.569l3.411-2.64Z" fill="#FBBC05" />
      <path d="M12 6.02c1.47 0 2.786.506 3.823 1.497l2.867-2.867A9.6 9.6 0 0 0 12 2a9.996 9.996 0 0 0-8.918 5.431l3.411 2.64C7.266 7.748 9.44 6.02 12 6.02Z" fill="#EA4335" />
    </svg>
  );
}
