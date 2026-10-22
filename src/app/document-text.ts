import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

const MAX_SCRIPT_FILE_SIZE = 50 * 1024 * 1024;

export type ScriptDocumentReadErrorCode =
  | "file_too_large"
  | "unsupported_format"
  | "password_required"
  | "no_text_layer"
  | "empty_document"
  | "parse_failed";

export class ScriptDocumentReadError extends Error {
  constructor(
    readonly code: ScriptDocumentReadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ScriptDocumentReadError";
  }
}

type PdfTextItemLike = {
  str: string;
  hasEOL?: boolean;
  transform?: number[];
};

function fileExtension(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function normalizeExtractedText(value: string) {
  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function hasUsableDocumentText(value: string) {
  const compact = value.replace(/\s/g, "");
  if (!compact) return false;
  const placeholders = compact.match(/[?？\uFFFD]/g)?.length ?? 0;
  const readable = compact.replace(/[?？\uFFFD\p{P}\p{S}]/gu, "");
  return readable.length >= 2 && placeholders / compact.length < 0.35;
}

function needsWordSpace(previous: string, current: string) {
  return /[A-Za-z0-9)]/.test(previous) && /[A-Za-z0-9(]/.test(current);
}

/** Preserve PDF visual lines without inserting spaces between Chinese glyphs. */
export function joinPdfTextItems(items: PdfTextItemLike[]): string {
  let output = "";
  let previousY: number | null = null;

  for (const item of items) {
    const value = item.str ?? "";
    if (!value) continue;

    const y = Array.isArray(item.transform) && item.transform.length > 5
      ? Number(item.transform[5])
      : null;
    const changedLine = previousY !== null && y !== null && Math.abs(y - previousY) > 2.5;

    if (changedLine && output && !output.endsWith("\n")) {
      output += "\n";
    } else if (
      output
      && !output.endsWith("\n")
      && needsWordSpace(output.at(-1) ?? "", value.charAt(0))
    ) {
      output += " ";
    }

    output += value;
    if (item.hasEOL && !output.endsWith("\n")) output += "\n";
    if (y !== null) previousY = y;
  }

  return normalizeExtractedText(output);
}

async function extractPdfText(file: File) {
  try {
    // Keep the sizeable parser in a separate chunk and point it at Vite's
    // emitted worker asset explicitly. This avoids a never-settling fake worker
    // in embedded Chromium/webview environments.
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const document = await loadingTask.promise;
    const pages: string[] = [];

    try {
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const items = content.items.filter((item): item is typeof item & PdfTextItemLike => "str" in item);
        const pageText = joinPdfTextItems(items);
        if (pageText) pages.push(pageText);
        page.cleanup();
      }
    } finally {
      await loadingTask.destroy();
    }

    const text = normalizeExtractedText(pages.join("\n\n"));
    if (!hasUsableDocumentText(text)) {
      throw new ScriptDocumentReadError(
        "no_text_layer",
        "PDF 中没有检测到可识别的文字层，可能是扫描版或字体未嵌入。请先进行 OCR 后重新上传。",
      );
    }
    return text;
  } catch (error) {
    if (error instanceof ScriptDocumentReadError) throw error;
    if (error instanceof Error && /password/i.test(`${error.name} ${error.message}`)) {
      throw new ScriptDocumentReadError(
        "password_required",
        "PDF 已加密或需要密码，请解除密码后重新上传。",
        { cause: error },
      );
    }
    throw new ScriptDocumentReadError(
      "parse_failed",
      "PDF 正文读取失败，请确认文件没有损坏后重试。",
      { cause: error },
    );
  }
}

async function extractDocxText(file: File) {
  try {
    // Mammoth's browser entry accepts ArrayBuffer and ignores visual styling,
    // which is exactly what script asset extraction needs.
    const mammoth = (await import("mammoth")).default;
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    const text = normalizeExtractedText(result.value);
    if (!text) {
      throw new ScriptDocumentReadError("empty_document", "Word 文件中没有读取到正文。");
    }
    return text;
  } catch (error) {
    if (error instanceof ScriptDocumentReadError) throw error;
    throw new ScriptDocumentReadError(
      "parse_failed",
      "Word 正文读取失败，请确认文件是有效的 .docx 文档。",
      { cause: error },
    );
  }
}

export async function extractScriptDocumentText(file: File): Promise<string> {
  if (file.size > MAX_SCRIPT_FILE_SIZE) {
    throw new ScriptDocumentReadError("file_too_large", "剧本文件不能超过 50MB。");
  }

  const extension = fileExtension(file.name);
  if (["txt", "md", "fountain"].includes(extension)) {
    const text = normalizeExtractedText(await file.text());
    if (!text) throw new ScriptDocumentReadError("empty_document", "剧本文件中没有正文。");
    return text;
  }
  if (extension === "pdf") return extractPdfText(file);
  if (extension === "docx") return extractDocxText(file);
  if (extension === "doc") {
    throw new ScriptDocumentReadError(
      "unsupported_format",
      "暂不支持旧版 .doc 文件，请在 Word 中另存为 .docx 后重新上传。",
    );
  }
  throw new ScriptDocumentReadError(
    "unsupported_format",
    "不支持该文件格式，请上传 TXT、Markdown、Fountain、PDF 或 DOCX。",
  );
}
