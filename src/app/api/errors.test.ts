import { describe, expect, it } from "vitest";

import { ApiClientError } from "./client";
import { toAdminErrorSummary, toUserMessage } from "./errors";

function makeError(options: {
  code?: string;
  message?: string;
  status?: number;
  details?: unknown;
  requestId?: string;
  rawBody?: string;
}) {
  return new ApiClientError({
    code: options.code ?? "UNEXPECTED_RESPONSE",
    message: options.message ?? "boom",
    status: options.status ?? 500,
    details: options.details,
    requestId: options.requestId,
    rawBody: options.rawBody,
  });
}

describe("toUserMessage", () => {
  it("maps known error codes to localized messages", () => {
    const error = makeError({ code: "UNAUTHENTICATED", status: 401 });
    expect(toUserMessage(error, "zh")).toBe("账号或密码不正确，请重新输入。");
    expect(toUserMessage(error, "en")).toBe("Incorrect email or password.");
  });

  it("falls back to a generic message for 5xx errors with an unknown code", () => {
    const error = makeError({ code: "SOMETHING_ELSE", status: 503, message: "raw upstream text" });
    expect(toUserMessage(error, "zh")).toBe("服务暂时不可用，请稍后重试。");
    expect(toUserMessage(error, "en")).toBe("The service is temporarily unavailable.");
  });

  it("surfaces the raw message for unknown non-5xx errors when present", () => {
    const error = makeError({ code: "SOMETHING_ELSE", status: 400, message: "field x is required" });
    expect(toUserMessage(error, "en")).toBe("field x is required");
  });

  it("handles non-ApiClientError values", () => {
    expect(toUserMessage(new Error("plain"), "zh")).toBe("请求失败，请稍后重试。");
    expect(toUserMessage("oops", "en")).toBe("Request failed. Please try again.");
  });
});

describe("toAdminErrorSummary", () => {
  it("appends code, status, request id, and details for ApiClientError", () => {
    const error = makeError({
      code: "INVALID_INPUT",
      status: 400,
      requestId: "req-123",
      details: { field: "email" },
    });
    expect(toAdminErrorSummary(error, "en")).toBe(
      'The submitted data is invalid. (INVALID_INPUT | HTTP 400 | request_id=req-123 | {"field":"email"})',
    );
  });

  it("falls back to rawBody (truncated) when details are absent", () => {
    const rawBody = "x".repeat(300);
    const error = makeError({ code: "UNEXPECTED_RESPONSE", status: 500, rawBody });
    const summary = toAdminErrorSummary(error, "en");
    expect(summary).toContain("UNEXPECTED_RESPONSE | HTTP 500");
    expect(summary).toContain("x".repeat(240));
    expect(summary).not.toContain("x".repeat(241));
  });

  it("returns the message for a plain Error and a localized fallback otherwise", () => {
    expect(toAdminErrorSummary(new Error("native failure"), "en")).toBe("native failure");
    expect(toAdminErrorSummary({ weird: true }, "zh")).toBe("未知异常");
    expect(toAdminErrorSummary({ weird: true }, "en")).toBe("Unknown error");
  });
});
