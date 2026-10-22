import { useState } from "react";
import { ApiClientError } from "../../api/client";
import { toUserMessage } from "../../api/errors";

export type AuthFieldName = "name" | "email" | "password" | "invitationCode";
type AuthMode = "login" | "register";
export type AuthFailure = { field?: AuthFieldName; message: string };

function validateField(field: AuthFieldName, value: string, mode: AuthMode, zh: boolean): string | undefined {
  if (field === "email") {
    if (!value.trim()) return zh ? "请输入邮箱地址" : "Enter your email address.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return zh ? "请输入有效的邮箱地址" : "Enter a valid email address.";
  }
  if (field === "password") {
    if (!value) return zh ? "请输入密码" : "Enter your password.";
    // Login must still accept passwords belonging to older accounts.
    if (mode === "register" && value.length < 6) return zh ? "密码至少需要 6 位字符" : "Use at least 6 characters for your password.";
  }
  if (field === "name" && !value.trim()) return zh ? "请输入姓名" : "Enter your name.";
  return undefined;
}

export function useAuthFieldValidation(values: Partial<Record<AuthFieldName, string>>, mode: AuthMode, zh: boolean) {
  const [touched, setTouched] = useState<Partial<Record<AuthFieldName, boolean>>>({});
  const fields: AuthFieldName[] = mode === "login" ? ["email", "password"] : ["name", "email", "password"];
  const errors: Partial<Record<AuthFieldName, string>> = {};
  for (const field of fields) {
    if (touched[field]) errors[field] = validateField(field, values[field] ?? "", mode, zh);
  }
  return {
    errors,
    touch(field: AuthFieldName) { setTouched((current) => ({ ...current, [field]: true })); },
    validate() {
      setTouched(Object.fromEntries(fields.map((field) => [field, true])));
      return fields.find((field) => validateField(field, values[field] ?? "", mode, zh));
    },
  };
}

// These messages are specific to submitting credentials, not an expired session
// elsewhere in the app. Never display the server's raw message or rejected values.
export function authFailure(error: unknown, mode: AuthMode, zh: boolean): AuthFailure {
  if (error instanceof ApiClientError) {
    if (mode === "login" && (error.status === 401 || error.code === "UNAUTHENTICATED")) {
      return { field: "password", message: zh ? "邮箱或密码不正确，请检查后重试。" : "Incorrect email or password. Please check and try again." };
    }
    if (error.status === 429 || error.code === "RATE_LIMITED") {
      return { message: zh ? "尝试次数过多，请稍后再试。" : "Too many attempts. Please try again later." };
    }
    if (error.code === "TIMEOUT" || error.status === 408 || error.status === 504) {
      return { message: zh ? "请求超时，请稍后重试。" : "The request timed out. Please try again." };
    }
    if (error.status === 0 || error.code === "NETWORK_ERROR") {
      return { message: zh ? "网络连接失败，请检查网络后重试。" : "Unable to connect. Check your network and try again." };
    }
    if (error.status >= 500) {
      return { message: zh ? "账号服务暂时不可用，请稍后重试。" : "Account services are temporarily unavailable. Please try again later." };
    }
    if (mode === "register" && error.code === "EMAIL_ALREADY_EXISTS") {
      return { field: "email", message: zh ? "该邮箱已经注册，请直接登录。" : "This email is already registered. Please sign in." };
    }
    if (mode === "register" && error.code === "INVITATION_INVALID") {
      return { field: "invitationCode", message: zh ? "邀请码无效、已过期或已用完，请检查或清空后注册。" : "This invitation code is invalid, expired or exhausted. Check it or leave it blank." };
    }
  }
  return { message: toUserMessage(error, zh ? "zh" : "en") };
}
