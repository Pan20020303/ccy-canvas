/* @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginPage } from "../LoginPage";
import { RegisterPage } from "../RegisterPage";
import { ApiClientError } from "../../api/client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const auth = vi.hoisted(() => ({ login: vi.fn(), registerByInvite: vi.fn(), navigate: vi.fn() }));
vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => auth }));
vi.mock("../../store", () => ({ useStore: (select: (state: { language: string }) => unknown) => select({ language: "zh" }) }));
vi.mock("react-router", async () => ({ ...await vi.importActual("react-router"), useNavigate: () => auth.navigate }));

describe("auth page contracts", () => {
  let host: HTMLDivElement;
  let root: Root;
  const field = (name: string) => host.querySelector<HTMLInputElement>(`input[name='${name}']`)!;
  const fill = async (name: string, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field(name), value);
      field(name).dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async () => { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); };
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([["admin", "/admin"], ["member", "/home"]])("keeps the %s login destination", async (role, destination) => {
    auth.login.mockResolvedValue({ role });
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    expect(host.querySelector("form")!.checkValidity()).toBe(false);
    await fill("email", "preview@example.com");
    await fill("password", "test-password");
    await submit();
    expect(auth.login).toHaveBeenCalledWith({ email: "preview@example.com", password: "test-password" });
    expect(auth.navigate).toHaveBeenCalledWith(destination, { replace: true });
  });

  it("preserves typed credentials across scene changes and hiding the panel", async () => {
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    await fill("email", "preview@example.com");
    await fill("password", "test-password");
    await act(async () => host.querySelector<HTMLButtonElement>("[data-scene-button]:nth-child(2)")!.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".auth-close")!.click());
    expect(host.querySelector("aside")!.hidden).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>(".auth-reopen")!.click());
    expect(field("email").value).toBe("preview@example.com");
    expect(field("password").value).toBe("test-password");
    await act(async () => host.querySelector<HTMLButtonElement>(".auth-icon-button")!.click());
    expect(field("password").type).toBe("text");
    expect(auth.login).not.toHaveBeenCalled();
  });

  it("keeps the form usable after a rejected login", async () => {
    auth.login.mockRejectedValue(new Error("Login unavailable"));
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    await fill("email", "preview@example.com");
    await fill("password", "test-password");
    await submit();
    expect(host.querySelector("[role='alert']")?.textContent).toBeTruthy();
    expect(host.querySelector<HTMLButtonElement>("[type='submit']")!.disabled).toBe(false);
    expect(auth.navigate).not.toHaveBeenCalled();
  });

  it("shows required errors below the appropriate fields before sending a request", async () => {
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    await submit();
    expect(field("email").closest(".auth-field-block")?.textContent).toContain("请输入邮箱地址");
    expect(field("password").closest(".auth-field-block")?.textContent).toContain("请输入密码");
    expect(field("password").getAttribute("aria-invalid")).toBe("true");
    expect(field("password").getAttribute("aria-describedby")).toBe(host.querySelectorAll(".auth-field-error")[1].id);
    expect(document.activeElement).toBe(field("email"));
    expect(auth.login).not.toHaveBeenCalled();
  });

  it("validates email format and clears a field's message as the user corrects it", async () => {
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    await fill("email", "121");
    await fill("password", "test-password");
    await submit();
    expect(host.querySelector(".auth-field-error")?.textContent).toBe("请输入有效的邮箱地址");
    expect(auth.login).not.toHaveBeenCalled();
    await fill("email", "preview@example.com");
    expect(host.querySelector(".auth-field-error")).toBeNull();
    expect(field("email").hasAttribute("aria-invalid")).toBe(false);
  });

  it("shows a credential error under the password instead of a session-expired message", async () => {
    auth.login.mockRejectedValue(new ApiClientError({ code: "UNAUTHENTICATED", status: 401, message: "Invalid email or password" }));
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    await fill("email", "preview@example.com");
    await fill("password", "wrong-password");
    await submit();
    expect(field("password").closest(".auth-field-block")?.textContent).toContain("邮箱或密码不正确，请检查后重试。");
    expect(host.textContent).not.toContain("登录状态已失效");
    expect(field("email").hasAttribute("aria-invalid")).toBe(false);
    await fill("password", "corrected-password");
    expect(host.querySelector(".auth-field-error")).toBeNull();
  });

  it.each([
    ["NETWORK_ERROR", 0, "网络连接失败，请检查网络后重试。"],
    ["RATE_LIMITED", 429, "尝试次数过多，请稍后再试。"],
    ["INTERNAL", 500, "账号服务暂时不可用，请稍后重试。"],
  ])("does not label %s as a password error", async (code, status, message) => {
    auth.login.mockRejectedValue(new ApiClientError({ code, status, message: "Raw transport message must not be shown" }));
    await act(async () => root.render(<MemoryRouter><LoginPage /></MemoryRouter>));
    await fill("email", "preview@example.com");
    await fill("password", "test-password");
    await submit();
    expect(host.querySelector(".auth-error")?.textContent).toBe(message);
    expect(field("password").hasAttribute("aria-invalid")).toBe(false);
  });

  it("explains the registration password length and blocks submission until corrected", async () => {
    await act(async () => root.render(<MemoryRouter initialEntries={["/register"]}><RegisterPage /></MemoryRouter>));
    await fill("name", "Preview");
    await fill("email", "preview@example.com");
    await fill("password", "12");
    await submit();
    expect(field("password").closest(".auth-field-block")?.textContent).toContain("密码至少需要 6 位字符");
    expect(auth.registerByInvite).not.toHaveBeenCalled();
    await fill("password", "test-password");
    expect(host.querySelector(".auth-field-error")).toBeNull();
  });

  it("retains optional invitation codes and the existing registration payload", async () => {
    auth.registerByInvite.mockResolvedValue({ role: "member" });
    await act(async () => root.render(<MemoryRouter initialEntries={["/register"]}><RegisterPage /></MemoryRouter>));
    await fill("name", "Preview");
    await fill("email", "preview@example.com");
    await fill("password", "test-password");
    expect(field("invitation-code").required).toBe(false);
    expect(host.querySelector("form")!.checkValidity()).toBe(true);
    await submit();
    expect(auth.registerByInvite).toHaveBeenCalledWith({ name: "Preview", email: "preview@example.com", password: "test-password", invitationCode: "" });
    expect(auth.navigate).toHaveBeenCalledWith("/home", { replace: true });
  });
});
