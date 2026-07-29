// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { publishRuntimeInvalidation, subscribeRuntimeInvalidation } from "./runtimeInvalidation";

describe("runtime invalidation", () => {
  it("notifies the current tab immediately", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRuntimeInvalidation(listener);

    publishRuntimeInvalidation(["credits", "models"], "user-1");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      scopes: ["credits", "models"],
      targetUserId: "user-1",
    });
    unsubscribe();
  });

  it("accepts cross-tab storage notifications", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRuntimeInvalidation(listener);
    const payload = {
      id: "remote-1",
      scopes: ["identity"],
      targetUserId: "user-2",
      emittedAt: Date.now(),
    };

    window.dispatchEvent(new StorageEvent("storage", {
      key: "ccy.runtime-invalidation",
      newValue: JSON.stringify(payload),
    }));

    expect(listener).toHaveBeenCalledWith(payload);
    unsubscribe();
  });
});
