import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { X } from "lucide-react";

import logoUrl from "../../imports/logo-login.png";
import { useStore } from "../store";
import { AuthShowcase } from "./auth/AuthShowcase";
import "./auth/auth.css";

export function AuthLayout({ children, subtitle, title, mode }: {
  children: ReactNode;
  subtitle: string;
  title: string;
  mode: "login" | "register";
}) {
  const zh = useStore((state) => state.language) === "zh";
  const [panelOpen, setPanelOpen] = useState(true);

  return (
    <main className="auth-page" data-panel-open={panelOpen}>
      <AuthShowcase zh={zh} />
      {panelOpen ? (
        <button className="auth-close" type="button" onClick={() => setPanelOpen(false)} aria-label={zh ? "收起登录面板，浏览创作画面" : "Hide sign-in panel and explore the showcase"}>
          <X size={20} strokeWidth={1.5} />
        </button>
      ) : (
        <button className="auth-reopen" type="button" onClick={() => setPanelOpen(true)}>
          {zh ? "登录 / 注册" : "Sign in / Sign up"}
        </button>
      )}
      <aside className="auth-panel" hidden={!panelOpen} aria-label={zh ? "账号登录与注册" : "Account access"}>
        <div className="auth-panel-content" data-auth-shell>
          <div className="auth-brand" aria-label={zh ? "橙次元 CCY Canvas" : "CCY Canvas"}>
            <img src={logoUrl} alt="" width={54} height={54} />
            <span>{zh ? "橙次元" : "CCY Canvas"}</span>
          </div>
          <header className="auth-heading">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </header>
          <nav className="auth-tabs" aria-label={zh ? "账号入口" : "Account access"}>
            <Link to="/login" className="auth-tab" aria-current={mode === "login" ? "page" : undefined}>
              {zh ? "登录" : "Sign in"}
            </Link>
            <Link to="/register" className="auth-tab" aria-current={mode === "register" ? "page" : undefined}>
              {zh ? "注册" : "Sign up"}
            </Link>
          </nav>
          {children}
          <footer className="auth-footer">
            <p>{zh ? "让想象发生，让创作无限。" : "Bring your imagination to life."}</p>
            <span>CCY CANVAS · {zh ? "橙次元" : "CREATE WITHOUT LIMITS"}</span>
          </footer>
        </div>
      </aside>
    </main>
  );
}

export function AuthField({ icon, label, onChange, onBlur, placeholder, trailing, type, value, autoComplete, name, required = true, minLength, disabled, invalid, describedBy, error }: {
  icon: ReactNode;
  label: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder: string;
  trailing?: ReactNode;
  type: string;
  value: string;
  autoComplete?: string;
  name?: string;
  required?: boolean;
  minLength?: number;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  error?: string;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="auth-field-block">
      <div className="auth-field" data-invalid={Boolean(error) || invalid || undefined}>
        <label className="auth-sr-only" htmlFor={id}>{label}</label>
        <span className="auth-field-icon" aria-hidden="true">{icon}</span>
        <input
          id={id} name={name} type={type} value={value}
          onChange={(event) => onChange(event.target.value)} onBlur={onBlur}
          placeholder={placeholder} autoComplete={autoComplete}
          required={required} minLength={minLength} disabled={disabled}
          aria-invalid={Boolean(error) || invalid || undefined}
          aria-describedby={[describedBy, error ? errorId : undefined].filter(Boolean).join(" ") || undefined}
        />
        {trailing && <span className="auth-field-trailing">{trailing}</span>}
      </div>
      {error && <p className="auth-field-error" id={errorId} role="alert">{error}</p>}
    </div>
  );
}
