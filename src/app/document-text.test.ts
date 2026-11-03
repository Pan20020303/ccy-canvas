import { describe, expect, it } from "vitest";

import {
  ScriptDocumentReadError,
  extractScriptDocumentText,
  hasUsableDocumentText,
  joinPdfTextItems,
} from "./document-text";

describe("script document text extraction", () => {
  it("reads and normalizes plain-text scripts", async () => {
    const file = new File(["第一场\r\n\r\n人物：李清颜\u0000"], "script.txt", { type: "text/plain" });
    await expect(extractScriptDocumentText(file)).resolves.toBe("第一场\n\n人物：李清颜");
  });

  it("preserves PDF lines without adding spaces between Chinese glyphs", () => {
    expect(joinPdfTextItems([
      { str: "李清", transform: [1, 0, 0, 1, 10, 100] },
      { str: "颜", transform: [1, 0, 0, 1, 30, 100], hasEOL: true },
      { str: "Hello", transform: [1, 0, 0, 1, 10, 80] },
      { str: "world", transform: [1, 0, 0, 1, 50, 80] },
    ])).toBe("李清颜\nHello world");
  });

  it("explains how to handle legacy Word files", async () => {
    const file = new File(["legacy"], "script.doc", { type: "application/msword" });
    await expect(extractScriptDocumentText(file)).rejects.toMatchObject({
      code: "unsupported_format",
    } satisfies Partial<ScriptDocumentReadError>);
  });

  it("rejects placeholder-only PDF text as an unreadable text layer", () => {
    expect(hasUsableDocumentText("? ? ? ? ? ?")).toBe(false);
    expect(hasUsableDocumentText("第十二集 天空 日 外")).toBe(true);
  });
});
