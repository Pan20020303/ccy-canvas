import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadFileWithProgress } from "./projects";

// Minimal fake XMLHttpRequest so we can drive progress + load/error without a
// real network. Each instance scripts its own outcome via the static `script`.
type Outcome = { status: number; body: string; network?: boolean };

class FakeXHR {
  static script: Outcome = { status: 200, body: "" };
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  withCredentials = false;
  status = 0;
  responseText = "";
  open() {}
  send() {
    if (FakeXHR.script.network) {
      this.onerror?.();
      return;
    }
    this.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
    this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 } as ProgressEvent);
    this.status = FakeXHR.script.status;
    this.responseText = FakeXHR.script.body;
    this.onload?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function useFakeXHR(outcome: Outcome) {
  FakeXHR.script = outcome;
  vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
}

const file = new Blob(["x"], { type: "image/png" });

describe("uploadFileWithProgress", () => {
  it("reports progress and resolves with the upload data on 2xx", async () => {
    useFakeXHR({
      status: 200,
      body: JSON.stringify({ data: { url: "/uploads/x.png", filename: "x.png", content_type: "image/png" }, request_id: "r" }),
    });
    const progress: number[] = [];

    const data = await uploadFileWithProgress(file, "x.png", (p) => progress.push(p));

    expect(progress).toEqual([50, 100]);
    expect(data).toEqual({ url: "/uploads/x.png", filename: "x.png", content_type: "image/png" });
  });

  it("rejects on a non-2xx status", async () => {
    useFakeXHR({ status: 500, body: JSON.stringify({ error: "boom", request_id: "r" }) });
    await expect(uploadFileWithProgress(file, "x.png")).rejects.toThrow(/boom|500/);
  });

  it("rejects on a network error", async () => {
    useFakeXHR({ status: 0, body: "", network: true });
    await expect(uploadFileWithProgress(file, "x.png")).rejects.toThrow(/network/i);
  });
});
