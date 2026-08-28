/* @vitest-environment jsdom */

import React, { useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import gsap from "gsap";

import { useMountFadeIn } from "./use-motion";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function TestHarness() {
  const [count, setCount] = useState(0);
  const ref = useMountFadeIn<HTMLDivElement>({ opacity: 0, y: 8 }, { duration: 0.2 });

  return (
    <div>
      <div ref={ref}>animated</div>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        rerender {count}
      </button>
    </div>
  );
}

describe("useMountFadeIn", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("plays the enter animation only once across rerenders", () => {
    const fromSpy = vi.spyOn(gsap, "from").mockReturnValue({ kill: vi.fn() } as never);
    const contextSpy = vi.spyOn(gsap, "context");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(<TestHarness />);
    });
    expect(fromSpy).toHaveBeenCalledTimes(1);

    const button = host.querySelector("button");
    expect(button).not.toBeNull();

    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(fromSpy).toHaveBeenCalledTimes(1);
    expect(contextSpy).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });
});
