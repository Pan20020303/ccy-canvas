import vm from "node:vm";

async function main() {
  const payload = JSON.parse((await readStdin()).replace(/^\uFEFF/, ""));
  const exports = await loadAdapter(payload.code || "");

  if (payload.operation === "inspect") {
    const vendor = normalizeVendor(exports.vendor || exports.default?.vendor || exports.default);
    return writeJSON({ ok: true, vendor });
  }

  if (payload.operation === "run") {
    const fn = exports[payload.function];
    if (typeof fn !== "function") {
      throw new Error(`TS provider does not export ${payload.function}`);
    }
    const timeoutMs = Number(payload.timeout_ms || 0);
    const result = await withOptionalTimeout(
      Promise.resolve(fn(payload.input || {}, payload.context || {})),
      timeoutMs,
    );
    return writeJSON({ ok: true, result: normalizeResult(result) });
  }

  throw new Error(`Unknown TS provider runner operation: ${payload.operation}`);
}

async function loadAdapter(code) {
  if (!code.trim()) {
    throw new Error("TS provider code is empty");
  }
  const js = await transpileTypeScript(code);
  const module = { exports: {} };
  const sandbox = {
    exports: module.exports,
    module,
    console: {
      log: (...args) => console.error("[provider-ts]", ...args),
      warn: (...args) => console.error("[provider-ts:warn]", ...args),
      error: (...args) => console.error("[provider-ts:error]", ...args),
    },
    fetch,
    Headers,
    Request,
    Response,
    FormData,
    Blob,
    File: globalThis.File,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    Buffer,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox, {
    name: "ccy-canvas-provider-ts",
    codeGeneration: { strings: false, wasm: false },
  });
  const script = new vm.Script(js, { filename: "provider.ts" });
  script.runInContext(context, { timeout: 5000 });
  return module.exports;
}

async function transpileTypeScript(code) {
  try {
    const ts = await import("typescript");
    return ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      },
      reportDiagnostics: false,
    }).outputText;
  } catch {
    // Plain JS with ESM-style exports is still common for provider snippets.
    return code
      .replace(/export\s+default\s+/g, "module.exports.default = ")
      .replace(/export\s+const\s+(\w+)\s*=/g, "exports.$1 =")
      .replace(/export\s+async\s+function\s+(\w+)\s*\(/g, "exports.$1 = async function $1(")
      .replace(/export\s+function\s+(\w+)\s*\(/g, "exports.$1 = function $1(");
  }
}

function normalizeVendor(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("TS provider must export a vendor object");
  }
  const models = normalizeModels(raw.models || raw.modelList || raw.model_list || []);
  const serviceType = String(raw.serviceType || raw.service_type || raw.type || "").trim().toLowerCase();
  const icon = normalizeIcon(raw.icon || raw.iconKey || raw.icon_key || raw.iconURL || raw.icon_url || "");
  return {
    id: stringValue(raw.id),
    service_type: serviceType,
    vendor: stringValue(raw.vendor || raw.provider || raw.name),
    name: stringValue(raw.name || raw.label || raw.vendor),
    api_spec: stringValue(raw.apiSpec || raw.api_spec || "custom"),
    protocol: stringValue(raw.protocol || "openai_compatible"),
    base_url: stringValue(raw.baseURL || raw.base_url || raw.baseUrl),
    submit_endpoint: stringValue(raw.submitEndpoint || raw.submit_endpoint),
    query_endpoint: stringValue(raw.queryEndpoint || raw.query_endpoint),
    model_list: models,
    default_model: stringValue(raw.defaultModel || raw.default_model || models[0]),
    capabilities: normalizeStringList(raw.capabilities || (serviceType ? [serviceType] : [])),
    parameter_schema: raw.parameterSchema || raw.parameter_schema || {},
    icon,
  };
}

function normalizeModels(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        return item.model || item.name || item.id || item.modelName || item.model_name || "";
      }
      return "";
    })
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function normalizeStringList(raw) {
  return Array.isArray(raw) ? raw.map((item) => String(item).trim()).filter(Boolean) : [];
}

function normalizeIcon(raw) {
  if (typeof raw === "string") {
    const value = raw.trim();
    if (/^(https?:\/\/|data:image\/)/i.test(value)) return { url: value };
    return { key: value };
  }
  if (raw && typeof raw === "object") {
    return {
      key: stringValue(raw.key || raw.name || raw.brand),
      url: stringValue(raw.url || raw.src),
    };
  }
  return {};
}

function normalizeResult(raw) {
  if (typeof raw === "string") {
    return looksLikeURL(raw) ? { type: "url", content: raw } : { type: "text", content: raw };
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("TS provider returned empty result");
  }
  if (raw.error) {
    throw new Error(String(raw.error));
  }
  const url = raw.url || raw.imageUrl || raw.image_url || raw.resultURL || raw.result_url;
  const text = raw.text || raw.message;
  const content = raw.content || url || text;
  const type = raw.type || raw.contentType || raw.content_type || (url ? "url" : "text");
  if (!content) {
    throw new Error("TS provider returned empty result content");
  }
  return {
    type: String(type).includes("url") || looksLikeURL(content) ? "url" : "text",
    content: String(content),
  };
}

function looksLikeURL(value) {
  return /^(https?:\/\/|data:image\/|\/uploads\/)/i.test(String(value || ""));
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

function withOptionalTimeout(promise, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`TS provider timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function writeJSON(value) {
  process.stdout.write(JSON.stringify(value));
}

main().catch((error) => {
  writeJSON({ ok: false, error: error instanceof Error ? error.message : String(error) });
});
