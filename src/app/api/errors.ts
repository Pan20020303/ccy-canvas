import { ApiClientError } from "./client";

function zhMessageForCode(error: ApiClientError) {
  switch (error.code) {
    case "UNAUTHENTICATED":
      return "账号或密码不正确，请重新输入。";
    case "FORBIDDEN":
      return "你当前没有权限执行这个操作。";
    case "INVALID_INPUT":
      return "提交的信息格式不正确，请检查后重试。";
    case "INVITATION_INVALID":
      return "邀请码无效、已过期，或已被使用完。";
    case "EMAIL_ALREADY_EXISTS":
      return "该邮箱已经注册，请直接登录。";
    case "UNEXPECTED_RESPONSE":
      return "服务返回异常，请稍后重试。";
    default:
      return error.status >= 500 ? "服务暂时不可用，请稍后重试。" : error.message || "请求失败，请稍后重试。";
  }
}

function enMessageForCode(error: ApiClientError) {
  switch (error.code) {
    case "UNAUTHENTICATED":
      return "Incorrect email or password.";
    case "FORBIDDEN":
      return "You do not have permission to perform this action.";
    case "INVALID_INPUT":
      return "The submitted data is invalid.";
    case "INVITATION_INVALID":
      return "The invitation code is invalid, expired, or already exhausted.";
    case "EMAIL_ALREADY_EXISTS":
      return "This email is already registered.";
    case "UNEXPECTED_RESPONSE":
      return "The service returned an unexpected response.";
    default:
      return error.status >= 500 ? "The service is temporarily unavailable." : error.message || "Request failed.";
  }
}

export function toUserMessage(error: unknown, language: "zh" | "en") {
  if (error instanceof ApiClientError) {
    return language === "zh" ? zhMessageForCode(error) : enMessageForCode(error);
  }

  return language === "zh" ? "请求失败，请稍后重试。" : "Request failed. Please try again.";
}

export function toAdminErrorSummary(error: unknown, language: "zh" | "en") {
  if (error instanceof ApiClientError) {
    const userMessage = toUserMessage(error, language);
    const parts = [`${error.code}`, `HTTP ${error.status}`];
    if (error.requestId) {
      parts.push(`request_id=${error.requestId}`);
    }
    if (error.details) {
      parts.push(typeof error.details === "string" ? error.details : JSON.stringify(error.details));
    } else if (error.rawBody) {
      parts.push(error.rawBody.slice(0, 240));
    }
    return `${userMessage} (${parts.join(" | ")})`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return language === "zh" ? "未知异常" : "Unknown error";
}
