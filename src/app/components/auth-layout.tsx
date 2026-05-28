import type { ReactNode } from "react";

import logoUrl from "../../imports/logo-login.png";
import loginVisualUrl from "../../imports/login-visual-left.png";

export function AuthLayout({
  children,
  subtitle,
  title,
}: {
  children: ReactNode;
  subtitle: string;
  title: string;
}) {
  return (
    <div className="min-h-screen bg-[#07080c] text-white xl:grid xl:grid-cols-2">
      <div className="relative hidden overflow-hidden xl:block">
        <img
          src={loginVisualUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover object-left"
          draggable={false}
        />
        <div className="absolute inset-y-0 right-0 w-px bg-[#f45a1a] shadow-[0_0_18px_rgba(244,90,26,0.5)]" />
      </div>

      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0d1016] px-5 py-10 sm:px-8">
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 82% 72%, rgba(255,91,22,0.14), transparent 16%), radial-gradient(circle at 28% 18%, rgba(255,255,255,0.03), transparent 18%), linear-gradient(180deg, #161920 0%, #0d1016 100%)",
          }}
        />
        <div className="absolute inset-0 opacity-[0.08] [background-image:linear-gradient(rgba(255,255,255,0.16)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.16)_1px,transparent_1px)] [background-size:96px_96px]" />

        <div className="relative z-10 w-full max-w-[438px]">
          <div className="mb-10 flex flex-col items-center text-center">
            <img src={logoUrl} alt={title} className="h-[88px] w-[88px] object-contain" />
            <h1 className="mt-8 text-[68px] font-semibold leading-none tracking-[0.06em] text-white">
              {title}
            </h1>
            <p className="mt-4 text-[17px] text-white/48 sm:text-[18px]">{subtitle}</p>
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}

export function AuthField({
  icon,
  label,
  onChange,
  placeholder,
  trailing,
  type,
  value,
}: {
  icon: ReactNode;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  trailing?: ReactNode;
  type: string;
  value: string;
}) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <div className="flex h-[62px] items-center rounded-[14px] border border-white/16 bg-[linear-gradient(180deg,rgba(22,26,33,0.94),rgba(15,18,25,0.94))] px-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition focus-within:border-[#ff6d30]/70 focus-within:shadow-[0_0_0_1px_rgba(255,109,48,0.26)]">
        <div className="mr-4 shrink-0">{icon}</div>
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 border-none bg-transparent text-[17px] text-white placeholder:text-white/36 focus:outline-none"
        />
        {trailing ? <div className="ml-4 shrink-0">{trailing}</div> : null}
      </div>
    </label>
  );
}
