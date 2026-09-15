/** Public error text only: never render transport objects, HTML or stack traces. */
export function safeFailureMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  let text = value.trim().replace(/^Queued task failed:\s*/i, "");
  if (!text || /<html|<!doctype|Traceback \(|SELECT .* FROM |panic:|goroutine \d+| at .*\.(?:js|go|ts):\d+/i.test(text)) return "";
  if (text.includes('{"')) {
    try {
      const payload = JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
      const selected = payload.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : payload;
      text = typeof selected.message === "string" ? selected.message : "";
    } catch { return ""; }
  }
  return text
    .replace(/\b(?:Bearer|Basic)\s+[a-zA-Z0-9._~+/=-]+/gi, "[已脱敏]")
    .replace(/(["']?(?:api[_ -]?key|authorization|access[_ -]?token|refresh[_ -]?token|token|password|secret|cookie|session|credential|signature|prompt|messages|input)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;|}]+)/gi, "$1[已脱敏]")
    .replace(/((?:api[_ -]?key|token|password|secret)(?:\s+(?:provided|is|was|value))?\s*:\s*)[^\s,;|]+/gi, "$1[已脱敏]")
    .replace(/\b(?:sk-|sk_|sess-)[a-zA-Z0-9_*.-]+|\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[已脱敏]")
    .replace(/(?:https?|postgres(?:ql)?|redis):\/\/[^\s<>"']+|data:[^\s]+/gi, "[地址已隐藏]")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[账户已隐藏]")
    .replace(/[A-Z]:\\[^\r\n|]+|\/(?:home|users|var|etc|app)\/[^\s]+/gi, "[路径已隐藏]")
    .replace(/\s+/g, " ")
    .slice(0, 800);
}
