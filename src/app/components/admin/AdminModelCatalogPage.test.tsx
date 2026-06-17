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

function stubAdminApis() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/admin/alerts/unread-count")) return apiResponse({ count: 0 });
      if (url.includes("/api/admin/alerts?")) return apiResponse([]);
      if (url.endsWith("/api/admin/provider-configs")) return apiResponse([]);
      return apiResponse({});
    }),
  );
}

async function renderPage() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(
      <MemoryRouter>
        <AdminModelCatalogPage />
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
});
