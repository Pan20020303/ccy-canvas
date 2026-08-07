/* @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DestructiveConfirmDialog } from "./destructive-confirm-dialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DestructiveConfirmDialog", () => {
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";
  });

  it("renders an in-project confirmation and only confirms from its destructive button", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const onConfirm = vi.fn();
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    await act(async () => {
      root?.render(
        <DestructiveConfirmDialog
          open
          title="删除项目？"
          description="项目和画布内容将被永久删除，且无法恢复。"
          confirmLabel="删除项目"
          cancelLabel="取消"
          onOpenChange={() => undefined}
          onConfirm={onConfirm}
        />,
      );
    });

    const dialog = document.body.querySelector("[data-testid='destructive-confirm-dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("无法恢复");
    expect(nativeConfirm).not.toHaveBeenCalled();

    const confirmButton = Array.from(dialog?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("删除项目"),
    );
    expect(confirmButton).not.toBeNull();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
