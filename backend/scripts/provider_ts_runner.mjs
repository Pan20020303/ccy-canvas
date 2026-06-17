import vm from "node:vm";

async function main() {
  const payload = JSON.parse((await readStdin()).replace(/^\uFEFF/, ""));
  const context = payload.context || {};
  const exports = await loadAdapter(payload.code || "");

  if (payload.operation === "inspect") {
    const vendor = normalizeVendor(exports.vendor || exports.default?.vendor || exports.default, requestedServiceType(context));
    return writeJSON({ ok: true, vendor });
  }

  if (payload.operation === "run") {
    injectVendorRuntime(exports, context);
    const fnName = resolveFunctionName(exports, payload.function, requestedServiceType(context));
    const fn = exports[fnName];
    if (typeof fn !== "function") {
      throw new Error(`TS provider does not export ${fnName}`);
    }
    const selectedModel = findSelectedModel(exports, context);
    const input = normalizeProviderInput(payload.input || {}, context, fnName);
    const secondArg = { ...context, ...(selectedModel || {}) };
    const timeoutMs = Number(payload.timeout_ms || 0);
    const result = await withOptionalTimeout(
      Promise.resolve(callProviderFunction(fnName, fn, input, selectedModel, secondArg, context)),
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
    axios: createAxiosCompat(),
    logger: (...args) => console.error("[provider-ts]", ...args),
    pollTask,
    urlToBase64,
    zipImage,
    zipImageResolution,
    mergeImages,
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

function normalizeVendor(raw, desiredServiceType = "") {
  if (!raw || typeof raw !== "object") {
    throw new Error("TS provider must export a vendor object");
  }
  const rawModels = Array.isArray(raw.models || raw.modelList || raw.model_list)
    ? raw.models || raw.modelList || raw.model_list
    : [];
  const capabilities = inferCapabilities(raw.capabilities, rawModels);
  const requestedType = normalizeServiceType(desiredServiceType);
  const serviceType =
    normalizeServiceType(raw.serviceType || raw.service_type || raw.type) ||
    requestedType ||
    capabilities[0] ||
    "";
  const selectedModels = filterModelsForService(rawModels, serviceType);
  const effectiveModels = selectedModels.length ? selectedModels : requestedType ? [] : rawModels;
  const models = normalizeModels(effectiveModels);
  const icon = normalizeIcon(raw.icon || raw.iconKey || raw.icon_key || raw.iconURL || raw.icon_url || "");
  if (!icon.key && !icon.url) {
    icon.key = stringValue(raw.iconKey || raw.id || raw.vendor || raw.provider || raw.name);
  }
  return {
    id: stringValue(raw.id),
    service_type: serviceType,
    vendor: stringValue(raw.vendor || raw.provider || raw.name),
    name: stringValue(raw.name || raw.label || raw.vendor),
    api_spec: stringValue(raw.apiSpec || raw.api_spec || "custom"),
    protocol: stringValue(raw.protocol || "openai_compatible"),
    base_url: stringValue(raw.baseURL || raw.base_url || raw.baseUrl || raw.inputValues?.baseUrl || raw.inputValues?.baseURL),
    submit_endpoint: stringValue(raw.submitEndpoint || raw.submit_endpoint),
    query_endpoint: stringValue(raw.queryEndpoint || raw.query_endpoint),
    model_list: models,
    default_model: stringValue(raw.defaultModel || raw.default_model || models[0]),
    capabilities,
    parameter_schema: normalizeParameterSchema(raw, rawModels, effectiveModels, serviceType),
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
        return item.modelName || item.model_name || item.model || item.id || item.name || "";
      }
      return "";
    })
    .map((item) => String(item).trim())
    .filter(Boolean);
}

function normalizeStringList(raw) {
  return Array.isArray(raw) ? raw.map((item) => String(item).trim()).filter(Boolean) : [];
}

function normalizeServiceType(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "tts") return "audio";
  if (["text", "image", "video", "audio"].includes(v)) return v;
  return "";
}

function inferCapabilities(rawCapabilities, rawModels) {
  const fromRaw = normalizeStringList(rawCapabilities).map(normalizeServiceType).filter(Boolean);
  const fromModels = Array.isArray(rawModels)
    ? rawModels.map((model) => normalizeServiceType(model?.type)).filter(Boolean)
    : [];
  return [...new Set([...fromRaw, ...fromModels])];
}

function filterModelsForService(rawModels, serviceType) {
  if (!Array.isArray(rawModels) || !serviceType) return [];
  return rawModels.filter((model) => {
    if (typeof model === "string") return true;
    const type = normalizeServiceType(model?.type);
    return !type || type === serviceType;
  });
}

function normalizeParameterSchema(raw, rawModels, selectedModels, serviceType) {
  const base = isPlainObject(raw.parameterSchema)
    ? { ...raw.parameterSchema }
    : isPlainObject(raw.parameter_schema)
      ? { ...raw.parameter_schema }
      : {};
  return {
    ...base,
    vendor_id: stringValue(raw.id),
    vendor_version: stringValue(raw.version),
    vendor_author: stringValue(raw.author),
    vendor_description: stringValue(raw.description),
    vendor_service_type: serviceType,
    vendor_inputs: Array.isArray(raw.inputs) ? raw.inputs : [],
    vendor_input_values: redactSensitiveValues(raw.inputValues || {}),
    vendor_models: selectedModels,
    vendor_all_models: rawModels,
  };
}

function redactSensitiveValues(values) {
  if (!isPlainObject(values)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(values)) {
    if (/api.?key|secret|token|password|credential/i.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
    if (looksLikeURL(raw)) return { type: "url", content: raw };
    if (looksLikeBase64Image(raw)) return { type: "url", content: `data:image/png;base64,${raw}` };
    return { type: "text", content: raw };
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

function looksLikeBase64Image(value) {
  const text = String(value || "").trim();
  return text.length > 128 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function stringValue(value) {
  return value == null ? "" : String(value).trim();
}

function requestedServiceType(context) {
  return normalizeServiceType(context.serviceType || context.service_type || context.requestedServiceType);
}

function injectVendorRuntime(exports, context) {
  const vendor = exports.vendor || exports.default?.vendor;
  if (!isPlainObject(vendor)) return;
  const baseURL = stringValue(context.baseURL || context.baseUrl);
  const inputValues = {
    ...(isPlainObject(vendor.inputValues) ? vendor.inputValues : {}),
    ...(isPlainObject(context.inputValues) ? context.inputValues : {}),
  };
  if (context.apiKey) inputValues.apiKey = context.apiKey;
  if (baseURL) {
    inputValues.baseUrl = baseURL;
    inputValues.baseURL = baseURL;
  }
  vendor.inputValues = inputValues;
}

function resolveFunctionName(exports, requested, serviceType) {
  const candidates = [];
  if (requested) candidates.push(requested);
  if (serviceType === "audio") candidates.push("ttsRequest", "audioRequest");
  if (serviceType === "image") candidates.push("imageRequest");
  if (serviceType === "video") candidates.push("videoRequest");
  if (serviceType === "text") candidates.push("textRequest");
  for (const name of [...new Set(candidates)]) {
    if (typeof exports[name] === "function") return name;
  }
  return requested || `${serviceType}Request`;
}

function callProviderFunction(fnName, fn, input, selectedModel, secondArg, context) {
  if (fnName === "textRequest" && selectedModel) {
    const think = Boolean(input.think ?? selectedModel.think);
    const thinkLevel = Number(input.thinkLevel ?? input.think_level ?? 0);
    return fn(selectedModel, think, thinkLevel);
  }
  return fn(input, secondArg, context);
}

function findSelectedModel(exports, context) {
  const modelName = stringValue(context.model);
  const vendor = exports.vendor || exports.default?.vendor || {};
  const schema = context.parameterSchema || context.parameter_schema || {};
  const candidates = [
    ...(Array.isArray(vendor.models) ? vendor.models : []),
    ...(Array.isArray(schema.vendor_models) ? schema.vendor_models : []),
    ...(Array.isArray(schema.vendor_all_models) ? schema.vendor_all_models : []),
  ];
  const lower = modelName.toLowerCase();
  for (const model of candidates) {
    if (!model || typeof model !== "object") continue;
    const ids = [
      model.modelName,
      model.model_name,
      model.model,
      model.id,
      model.name,
    ].map((item) => stringValue(item).toLowerCase());
    if (ids.includes(lower)) return model;
  }
  if (!modelName) return null;
  return { name: modelName, modelName, model: modelName };
}

function normalizeProviderInput(input, context, fnName) {
  const out = { ...input };
  const prompt = input.prompt || input.text || "";
  const aspectRatio = input.aspectRatio || input.aspect_ratio || ratioFromSize(input.size) || "1:1";
  out.prompt = prompt;
  out.model = input.model || context.model;
  out.aspectRatio = aspectRatio;
  out.aspect_ratio = aspectRatio;
  out.size = fnName === "imageRequest" ? toToonflowImageSize(input.resolution || input.output_resolution || input.quality) : input.size;
  out.resolution = input.resolution || input.output_resolution || input.quality || input.size || "720p";
  out.duration = Number(input.duration || 5);
  out.referenceList = input.referenceList || buildReferenceList(input);
  out.referenceImages = input.referenceImages || input.reference_images || [];
  out.reference_images = input.reference_images || input.referenceImages || [];
  return out;
}

function ratioFromSize(size) {
  const text = stringValue(size);
  return /^\d+\s*:\s*\d+$/.test(text) ? text.replace(/\s+/g, "") : "";
}

function toToonflowImageSize(value) {
  const text = stringValue(value).toUpperCase();
  if (["1K", "2K", "4K"].includes(text)) return text;
  if (["STANDARD", "LOW", "MEDIUM", "AUTO"].includes(text)) return "1K";
  if (["HD", "HIGH", "2K"].includes(text)) return "2K";
  if (["ULTRA", "4K"].includes(text)) return "4K";
  return "1K";
}

function buildReferenceList(input) {
  const result = [];
  for (const value of asArray(input.reference_images || input.referenceImages)) {
    result.push(referenceItem("image", value));
  }
  for (const value of asArray(input.reference_videos || input.referenceVideos || input.reference_video || input.referenceVideo)) {
    result.push(referenceItem("video", value));
  }
  for (const value of asArray(input.reference_audios || input.referenceAudios || input.reference_audio || input.referenceAudio)) {
    result.push(referenceItem("audio", value));
  }
  return result;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function referenceItem(type, value) {
  if (value && typeof value === "object") return { type, sourceType: value.sourceType || value.source_type || "base64", ...value };
  const text = stringValue(value);
  return {
    type,
    sourceType: /^https?:\/\//i.test(text) ? "url" : "base64",
    base64: text,
    url: text,
  };
}

function createAxiosCompat() {
  const request = async (method, url, dataOrConfig, maybeConfig) => {
    const hasBody = !["GET", "HEAD"].includes(method);
    const config = hasBody ? maybeConfig || {} : dataOrConfig || {};
    const body = hasBody ? dataOrConfig : undefined;
    const headers = { ...(config.headers || {}) };
    let requestBody = body;
    if (body !== undefined && !(body instanceof FormData) && typeof body !== "string" && !(body instanceof Uint8Array)) {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      requestBody = JSON.stringify(body);
    }
    const response = await fetch(url, { method, headers, body: requestBody });
    const arrayBuffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(arrayBuffer);
    const text = buffer.toString("utf8");
    let data = text;
    if (config.responseType === "arraybuffer") {
      data = buffer;
    } else if (contentType.includes("application/json")) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const err = new Error(`Request failed with status code ${response.status}`);
      err.response = { status: response.status, data, headers: Object.fromEntries(response.headers.entries()) };
      throw err;
    }
    return { data, status: response.status, headers: Object.fromEntries(response.headers.entries()) };
  };
  return {
    request: (config) => request(String(config.method || "GET").toUpperCase(), config.url, config.data, config),
    get: (url, config) => request("GET", url, config),
    post: (url, data, config) => request("POST", url, data, config),
  };
}

async function urlToBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`urlToBase64 failed: ${response.status}`);
  const mime = response.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await response.arrayBuffer());
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function pollTask(fn, interval = 3000, timeout = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result?.completed || result?.error) return result;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return { completed: false, error: "timeout" };
}

async function zipImage(base64) {
  return base64;
}

async function zipImageResolution(base64) {
  return base64;
}

async function mergeImages(base64Arr) {
  if (!Array.isArray(base64Arr) || base64Arr.length === 0) {
    throw new Error("image list cannot be empty");
  }
  return base64Arr[0];
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
