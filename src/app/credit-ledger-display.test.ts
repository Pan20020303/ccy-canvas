import { describe, expect, it } from "vitest";

import { presentCreditReason } from "./credit-ledger-display";

describe("presentCreditReason", () => {
  it("hides node ids behind a compact text-generation label", () => {
    expect(presentCreditReason({
      type: "reserve",
      reason: "reserve: text stream node=node-1785144455031",
    }, "zh")).toEqual({
      summary: "文本生成",
      technicalDetail: "reserve: text stream node=node-1785144455031",
    });
  });

  it("turns a failed generation refund into a user-facing outcome", () => {
    expect(presentCreditReason({
      type: "refund",
      reason: "refund: generation failed 1a19c483-f5b1-47cf-b2ee",
    }, "zh").summary).toBe("生成失败，积分已退回");
  });

  it("keeps short human notes unchanged", () => {
    expect(presentCreditReason({
      type: "admin_adjustment",
      reason: "活动奖励",
    }, "zh")).toEqual({ summary: "活动奖励" });
  });
});
