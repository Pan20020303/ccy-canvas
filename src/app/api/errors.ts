import { ApiClientError } from "./client";

const SENSITIVE_KEY = /api[_-]?key|authorization|token|password|secret|cookie|session|credential|signature|sig/i;

function zhMessageForCode(error: ApiClientError) {
  switch (error.code) {
    case "UNAUTHENTICATED": return "登录状态已失效，请重新登录。";
    case "FORBIDDEN": return "你没有权限执行此操作。";
    case "INVALID_INPUT":
    case "VALIDATION_ERROR": return "提交的信息格式不正确，请检查后重试。";
    case "INVITATION_INVALID": return "邀请码无效、已过期，或已被使用完。";
    case "EMAIL_ALREADY_EXISTS": return "该邮箱已经注册，请直接登录。";
    case "INSUFFICIENT_CREDITS": return "可用积分不足，请充值后重试。";
    case "NOT_FOUND": return "请求的资源不存在或已被移除。";
    case "CONFLICT": return "数据已发生变化，请刷新后重试。";
    case "REQUEST_TOO_LARGE": return "提交内容过大，请减少素材后重试。";
    case "RATE_LIMITED": return "请求过于频繁，请稍后再试。";
    case "TIMEOUT": return "请求超时，请稍后重试。";
    default: return error.status >= 500 || error.status === 0 ? "服务暂时不可用，请稍后重试。" : "请求失败，请检查后重试。";
  }
}

function enMessageForCode(error: ApiClientError) {
  switch (error.code) {
    case "UNAUTHENTICATED": return "Your session has expired. Please sign in again.";
    case "FORBIDDEN": return "You do not have permission to perform this action.";
    case "INVALID_INPUT":
    case "VALIDATION_ERROR": return "The submitted data is invalid.";
    case "INVITATION_INVALID": return "The invitation code is invalid, expired, or exhausted.";
    case "EMAIL_ALREADY_EXISTS": return "This email is already registered.";
    case "INSUFFICIENT_CREDITS": return "Insufficient credits.";
    case "NOT_FOUND": return "The requested resource was not found.";
    case "CONFLICT": return "The data changed. Please refresh and try again.";
    case "REQUEST_TOO_LARGE": return "The submitted content is too large.";
    case "RATE_LIMITED": return "Too many requests. Please try again later.";
    case "TIMEOUT": return "The request timed out. Please try again.";
    default: return error.status >= 500 || error.status === 0 ? "The service is temporarily unavailable." : "Request failed. Please try again.";
  }
}

export function toUserMessage(error: unknown, language: "zh" | "en") {
  if (error instanceof ApiClientError) return language === "zh" ? zhMessageForCode(error) : enMessageForCode(error);
  return language === "zh" ? "请求失败，请稍后重试。" : "Request failed. Please try again.";
}

function safeDetails(value: unknown) {
  if (typeof value === "string") return SENSITIVE_KEY.test(value) ? "[已脱敏]" : value.slice(0, 180);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SENSITIVE_KEY.test(key))
    .slice(0, 6)
    .map(([key, detail]) => `${key}=${typeof detail === "string" ? detail.slice(0, 80) : String(detail)}`);
  return entries.join(", ");
}

// Admin pages can provide correlation information and explicitly safe details,
// but never render transport bodies or native exception messages directly.
export function toAdminErrorSummary(error: unknown, language: "zh" | "en") {
  if (!(error instanceof ApiClientError)) {
    return language === "zh" ? "请求失败，请查看服务端日志。" : "Request failed. Check server logs.";
  }
  const parts = [`${error.code}`, `HTTP ${error.status}`];
  if (error.requestId) parts.push(`request_id=${error.requestId}`);
  const details = safeDetails(error.details);
  if (details) parts.push(details);
  return `${toUserMessage(error, language)} (${parts.join(" | ")})`;
}
