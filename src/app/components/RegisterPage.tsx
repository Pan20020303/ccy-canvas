import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Eye, EyeOff, Gift, KeyRound, LoaderCircle, Mail, UserRound } from "lucide-react";

import { useAuth } from "../auth/AuthProvider";
import { useStore } from "../store";
import { AuthField, AuthLayout } from "./auth-layout";
import { authFailure, useAuthFieldValidation, type AuthFailure, type AuthFieldName } from "./auth/auth-validation";

export function RegisterPage() {
  const zh = useStore((state) => state.language) === "zh";
  const { registerByInvite } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", email: "", password: "", invitationCode: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const validation = useAuthFieldValidation(form, "register", zh);
  const update = (field: AuthFieldName, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFailure(null);
  };
  const fieldError = (field: AuthFieldName) => validation.errors[field] || (failure?.field === field ? failure.message : undefined);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
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
      const user = await registerByInvite({ ...form, email: form.email.trim(), name: form.name.trim() });
      navigate(user.role === "admin" ? "/admin" : "/home", { replace: true });
    } catch (err) {
      setFailure(authFailure(err, "register", zh));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout mode="register" title={zh ? "开启创作" : "Start creating"} subtitle={zh ? "你的下一个灵感，从这里开始" : "Your next great idea starts here"}>
      <form onSubmit={onSubmit} className="auth-form" aria-busy={submitting} noValidate>
        <AuthField
          type="text" name="name" autoComplete="name" value={form.name}
          onChange={(value) => update("name", value)} onBlur={() => validation.touch("name")} error={fieldError("name")}
          icon={<UserRound size={18} strokeWidth={1.5} />}
          placeholder={zh ? "请输入姓名" : "Your name"} label={zh ? "姓名" : "Name"} disabled={submitting}
        />
        <AuthField
          type="email" name="email" autoComplete="username" value={form.email}
          onChange={(value) => update("email", value)} onBlur={() => validation.touch("email")} error={fieldError("email")}
          icon={<Mail size={18} strokeWidth={1.5} />}
          placeholder={zh ? "请输入邮箱地址" : "Email address"} label={zh ? "邮箱地址" : "Email address"} disabled={submitting}
        />
        <AuthField
          type={showPassword ? "text" : "password"} name="password" autoComplete="new-password" value={form.password} minLength={6}
          onChange={(value) => update("password", value)} onBlur={() => validation.touch("password")} error={fieldError("password")}
          icon={<KeyRound size={18} strokeWidth={1.5} />}
          placeholder={zh ? "设置密码（至少 6 位）" : "Create a password (6+ characters)"} label={zh ? "密码" : "Password"} disabled={submitting}
          trailing={
            <button className="auth-icon-button" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={zh ? (showPassword ? "隐藏密码" : "显示密码") : (showPassword ? "Hide password" : "Show password")} aria-pressed={showPassword}>
              {showPassword ? <Eye size={18} strokeWidth={1.5} /> : <EyeOff size={18} strokeWidth={1.5} />}
            </button>
          }
        />
        <AuthField
          type="text" name="invitation-code" autoComplete="off" value={form.invitationCode} required={false}
          onChange={(value) => update("invitationCode", value)} error={fieldError("invitationCode")}
          icon={<Gift size={18} strokeWidth={1.5} />}
          placeholder={zh ? "邀请码（选填）" : "Invitation code (optional)"} label={zh ? "邀请码（选填）" : "Invitation code (optional)"} disabled={submitting}
          describedBy="invite-hint"
        />
        <p className="auth-form-note" id="invite-hint">{zh ? "填写有效邀请码，即可领取额外创作额度。" : "A valid invitation code unlocks bonus creation credits."}</p>
        {failure && !failure.field && <p className="auth-error" role="alert">{failure.message}</p>}
        <button className="auth-submit" type="submit" disabled={submitting}>
          {submitting && <LoaderCircle className="auth-spinner" size={17} aria-hidden="true" />}
          {zh ? (submitting ? "注册中…" : "开启你的创作之旅") : (submitting ? "Creating account…" : "Start your creative journey")}
        </button>
      </form>
    </AuthLayout>
  );
}
