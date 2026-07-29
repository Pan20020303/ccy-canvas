import { describe, expect, it } from "vitest";

import { ApiClientError } from "./client";
import { toAdminErrorSummary, toUserMessage } from "./errors";

function makeError(options: Partial<ConstructorParameters<typeof ApiClientError>[0]> = {}) {
  return new ApiClientError({ code: "UNEXPECTED_RESPONSE", message: "boom", status: 500, ...options });
}

describe("toUserMessage", () => {
  it("maps known codes to safe localized messages", () => {
    expect(toUserMessage(makeError({ code: "UNAUTHENTICATED", status: 401 }), "en")).toBe("Your session has expired. Please sign in again.");
    expect(toUserMessage(makeError({ code: "INSUFFICIENT_CREDITS", status: 402 }), "en")).toBe("Insufficient credits.");
  });

  it("does not surface an unknown backend message", () => {
    const error = makeError({ code: "SOMETHING_ELSE", status: 400, message: "password=super-secret" });
    expect(toUserMessage(error, "en")).toBe("Request failed. Please try again.");
  });
});

describe("toAdminErrorSummary", () => {
  it("keeps request correlation and safe detail fields", () => {
    const error = makeError({ code: "INVALID_INPUT", status: 400, requestId: "req-123", details: { field: "email" } });
    const summary = toAdminErrorSummary(error, "en");
    expect(summary).toContain("INVALID_INPUT | HTTP 400 | request_id=req-123 | field=email");
  });

  it("redacts sensitive detail fields and omits raw response bodies", () => {
    const error = makeError({ status: 500, details: { token: "secret", reason: "timeout" }, rawBody: "password=hunter2" });
    const summary = toAdminErrorSummary(error, "en");
    expect(summary).toContain("reason=timeout");
    expect(summary).not.toContain("secret");
    expect(summary).not.toContain("hunter2");
  });
});
