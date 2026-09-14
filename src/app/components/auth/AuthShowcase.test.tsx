/* @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthShowcase } from "./AuthShowcase";
import { SHOWCASE_INTERVAL_MS } from "./showcase-scenes";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("login showcase", () => {
  let root: Root;
  let host: HTMLDivElement;
  let reduced: boolean;
  let isHidden: boolean;

  const selected = () => host.querySelector("[data-scene-button][aria-pressed='true']")?.getAttribute("aria-label");
  const click = async (label: string) => {
    const button = [...host.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label);
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  };
  const advance = async (ms: number) => { await act(async () => vi.advanceTimersByTime(ms)); };
  const mount = async () => { await act(async () => root.render(<AuthShowcase zh />)); };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    reduced = false;
    isHidden = false;
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.spyOn(document, "hidden", "get").mockImplementation(() => isHidden);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("automatically cycles all three scenes and wraps to the start", async () => {
    await mount();
    expect(selected()).toContain("第 1 个");
    await advance(SHOWCASE_INTERVAL_MS);
    expect(selected()).toContain("第 2 个");
    await advance(SHOWCASE_INTERVAL_MS);
    expect(selected()).toContain("第 3 个");
    await advance(SHOWCASE_INTERVAL_MS);
    expect(selected()).toContain("第 1 个");
  });

  it("keeps the elapsed time when paused and resumes the remaining time", async () => {
    await mount();
    await advance(4_000);
    await click("暂停轮播");
    await advance(30_000);
    expect(selected()).toContain("第 1 个");
    expect(host.querySelector("section")?.dataset.playing).toBe("false");
    await act(async () => host.querySelector<HTMLButtonElement>("button[aria-label='播放轮播']")!.focus());
    await click("播放轮播");
    await advance(5_999);
    expect(selected()).toContain("第 1 个");
    await advance(1);
    expect(selected()).toContain("第 2 个");
  });

  it("manual navigation resets timing, including while paused", async () => {
    await mount();
    await advance(8_000);
    await click("暂停轮播");
    await click("下一个画面");
    expect(selected()).toContain("第 2 个");
    await click("播放轮播");
    await advance(9_999);
    expect(selected()).toContain("第 2 个");
    await advance(1);
    expect(selected()).toContain("第 3 个");
  });

  it("pauses rotation while keyboard focus is within the carousel", async () => {
    await mount();
    await advance(2_000);
    const dot = host.querySelector<HTMLButtonElement>("[data-scene-button]")!;
    await act(async () => dot.focus());
    await advance(30_000);
    expect(selected()).toContain("第 1 个");
    await act(async () => dot.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(selected()).toContain("第 3 个");
    expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => (document.activeElement as HTMLElement).blur());
    await advance(SHOWCASE_INTERVAL_MS);
    expect(selected()).toContain("第 1 个");
  });

  it("pauses in a hidden tab and does not skip scenes when the tab returns", async () => {
    await mount();
    await advance(3_000);
    isHidden = true;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(60_000);
    expect(selected()).toContain("第 1 个");
    isHidden = false;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await advance(7_000);
    expect(selected()).toContain("第 2 个");
  });

  it("honors reduced motion while keeping manual navigation available", async () => {
    reduced = true;
    await mount();
    await advance(60_000);
    expect(selected()).toContain("第 1 个");
    await click("下一个画面");
    await click("下一个画面");
    expect(selected()).toContain("第 3 个");
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(host.querySelector("section")?.dataset.playing).toBe("false");
  });

  it("loads video only when selected and keeps its poster if playback is blocked", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new Error("Autoplay blocked"));
    await mount();
    const video = host.querySelector("video")!;
    expect(video.getAttribute("src")).toBeNull();
    await click("上一个画面");
    expect(video.getAttribute("src")).toContain("origin-loop.mp4");
    expect(video.dataset.ready).toBe("false");
    expect(video.poster).toContain("origin-poster");
    await click("下一个画面");
    expect(video.getAttribute("src")).toBeNull();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });
});
