/* @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdminModelCatalogPage } from "./AdminModelCatalogPage";

vi.mock("./useAdminWorkbenchMotion", () => ({
  useAdminWorkbenchMotion: () => undefined,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function apiResponse(data: unknown) {
  return new Response(JSON.stringify({ data, request_id: "req_test" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeProviderConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "provider-1",
    service_type: "image",
    vendor: "ManjuAPI",
    name: "ManjuAPI / Chat 图片生成",
    api_spec: "openai",
    protocol: "openai_compatible",
    base_url: "https://manjuapi.com/v1",
    api_key_set: true,
    api_key_hint: "sk-***",
    submit_endpoint: "",
    query_endpoint: "",
    model_list: ["gpt-image-2", "gemini-2.5-flash-image"],
    default_model: "gpt-image-2",
    priority: 0,
    is_default: true,
    status: "enabled",
    capabilities: ["image"],
    parameter_schema: {
      vendor_models: [
        { name: "GPT Image 2", modelName: "gpt-image-2", type: "image", mode: ["text", "multiReference"] },
        { name: "Gemini Image", modelName: "gemini-2.5-flash-image", type: "image", mode: ["text"] },
      ],
    },
    adapter_runtime: "ts",
    adapter_code: "exports.vendor = {};",
    adapter_checksum: "abc",
    icon_key: "openai",
    icon_url: "",
    created_at: "2026-06-17T00:00:00Z",
    updated_at: "2026-06-17T00:00:00Z",
    failure_count: 0,
    consecutive_cooldowns: 0,
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function stubAdminApis(providerConfigs: Array<Record<string, unknown>> = [], options: { testResponse?: unknown; rejectTest?: boolean } = {}) {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, body });
      if (url.includes("/api/admin/alerts/unread-count")) return apiResponse({ count: 0 });
      if (url.includes("/api/admin/alerts?")) return apiResponse([]);
      if (url.endsWith("/api/admin/agents")) return apiResponse([]);
      if (url.endsWith("/api/admin/skills")) return apiResponse([]);
      if (method === "POST" && url.includes("/api/admin/provider-configs/") && url.endsWith("/test")) {
        if (options.rejectTest) {
          return new Response(JSON.stringify({ error: { code: "UPSTREAM_ERROR", message: "network timeout" }, request_id: "req_test" }), {
            status: 502,
            headers: { "content-type": "application/json" },
          });
        }
        return apiResponse(options.testResponse ?? { ok: true, http_status: 200, latency_ms: 18 });
      }
      if (method === "PUT" && url.includes("/api/admin/provider-configs/")) {
        return apiResponse({ ...providerConfigs[0], ...body, id: "provider-1" });
      }
      if (url.endsWith("/api/admin/provider-configs")) return apiResponse(providerConfigs);
      return apiResponse({});
    }),
  );
  return requests;
}

type TestPanel = "model-service" | "agent-config" | "prompt-manage" | "skill-management" | "memory-config";

async function renderPage(panel: TestPanel = "model-service") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(
      <MemoryRouter>
        <AdminModelCatalogPage panel={panel} />
      </MemoryRouter>,
    );
  });

  return { host, root };
}

describe("AdminModelCatalogPage provider config editor", () => {
  let root: Root | undefined;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = undefined;
    }
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens the provider config editor as a centered modal instead of a side drawer", async () => {
    stubAdminApis();
    const rendered = await renderPage();
    root = rendered.root;

    const createButton = rendered.host.querySelector("main [data-admin-hero] button");
    expect(createButton).not.toBeNull();

    await act(async () => {
      createButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(rendered.host.querySelector("[data-testid='provider-config-modal']")).not.toBeNull();
    expect(rendered.host.querySelector("[data-testid='provider-config-drawer']")).toBeNull();
  });

  it("renders Toonflow-style settings sections as primary admin pages", async () => {
    stubAdminApis();

    const rendered = await renderPage("agent-config");
    root = rendered.root;
    expect(rendered.host.querySelector("[data-testid='settings-panel-agent-config']")).not.toBeNull();
    expect(rendered.host.querySelector("[data-testid='settings-panel-model-service']")).toBeNull();
    expect(rendered.host.textContent).not.toContain("界面设置");

    await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";

    const promptRendered = await renderPage("prompt-manage");
    root = promptRendered.root;
    expect(promptRendered.host.querySelector("[data-testid='settings-panel-prompt-manage']")).not.toBeNull();

    await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";

    const skillRendered = await renderPage("skill-management");
    root = skillRendered.root;
    expect(skillRendered.host.querySelector("[data-testid='settings-panel-skill-management']")).not.toBeNull();

    await act(async () => root?.unmount());
    root = undefined;
    document.body.innerHTML = "";

    const memoryRendered = await renderPage("memory-config");
    root = memoryRendered.root;
    expect(memoryRendered.host.querySelector("[data-testid='settings-panel-memory-config']")).not.toBeNull();
  });

  it("edits a Toonflow-style model row and persists vendor model metadata", async () => {
    const requests = stubAdminApis([makeProviderConfig()]);
    const rendered = await renderPage();
    root = rendered.root;

    expect(rendered.host.textContent).toContain("GPT Image 2");

    const editButton = Array.from(rendered.host.querySelectorAll("button")).find((item) =>
      item.textContent?.trim() === "编辑",
    );
    expect(editButton).not.toBeNull();

    await act(async () => {
      editButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const inputs = Array.from(document.body.querySelectorAll("input")) as HTMLInputElement[];
    const nameInput = inputs.find((item) => item.value === "GPT Image 2");
    const modelInput = inputs.find((item) => item.value === "gpt-image-2");
    expect(nameInput).not.toBeNull();
    expect(modelInput).not.toBeNull();

    await act(async () => {
      setInputValue(nameInput!, "GPT Image 2 Pro");
      setInputValue(modelInput!, "gpt-image-2-pro");
    });

    const saveButton = Array.from(document.body.querySelectorAll("button")).find((item) =>
      item.textContent?.trim() === "保存",
    );
    expect(saveButton).not.toBeNull();

    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const update = requests.find((request) => request.method === "PUT" && request.url.includes("/api/admin/provider-configs/provider-1"));
    expect(update?.body).toMatchObject({
      model_list: ["gpt-image-2-pro", "gemini-2.5-flash-image"],
      default_model: "gpt-image-2-pro",
      parameter_schema: {
        vendor_models: [
          { name: "GPT Image 2 Pro", modelName: "gpt-image-2-pro", type: "image" },
          { name: "Gemini Image", modelName: "gemini-2.5-flash-image", type: "image" },
        ],
      },
    });
  });

  it("shows visible feedback when testing a Toonflow-style model fails", async () => {
    const requests = stubAdminApis([makeProviderConfig()], {
      testResponse: { ok: false, http_status: 0, latency_ms: 12, error_msg: "network timeout" },
    });
    const rendered = await renderPage();
    root = rendered.root;

    const testButton = Array.from(rendered.host.querySelectorAll("button")).find((item) =>
      item.textContent?.trim() === "测试",
    );
    expect(testButton).not.toBeNull();

    await act(async () => {
      testButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(document.body.textContent).toContain("连接失败");
    expect(document.body.textContent).toContain("network timeout");
    expect(requests.some((request) => request.method === "POST" && request.url.endsWith("/test"))).toBe(true);
  });
});
