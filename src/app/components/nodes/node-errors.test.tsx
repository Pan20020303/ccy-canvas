// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NodeErrorBanner } from "./NodeErrorBanner";
import { AgentFailureNotice } from "../agent/AgentFailureNotice";
import { getNodeErrorPresentation, nodeFailureReason } from "./node-errors";
import { safeFailureMessage } from "../../api/failure-message";

vi.mock("../../store", () => ({useStore: (selector: (s: unknown) => unknown) => selector({
 language: "zh", nodes: [{id:"video-1",data:{taskId:"task-real-123"}}], updateNodeData: vi.fn(),
})}));

describe("真实错误展示", () => {
 it.each([[401,"E1003"],[403,"E1003"],[404,"E1010"],[429,"E1007"],[422,"E1009"],[504,"E1004"]])("保留上游 HTTP %s 分类", (status, code) => {
   const error = `模型服务响应超时（上游 HTTP ${status}）：unsupported`;
   expect(getNodeErrorPresentation(status === 504 ? error : error.replace("响应超时","拒绝请求")).code).toBe(code);
 });
 it("节点展示原始参数原因、状态和任务编号", () => {
  const error = "模型服务拒绝了请求参数（上游 HTTP 422）：duration must be 5 or 10 [param=duration]";
  const html = renderToStaticMarkup(<NodeErrorBanner nodeId="video-1" error={error}/>);
  expect(html).toContain("duration must be 5 or 10");
  expect(html).toContain("HTTP 422");
  expect(html).toContain("task-real-123");
  expect(html).toContain('role="alert"');
 });
 it("Agent 错误不会只剩通用文案", () => {
  const html = renderToStaticMarkup(<AgentFailureNotice jobId="agent-job-123" message="上游 HTTP 401：invalid api key; token=private-value"/>);
  expect(html).toContain("HTTP 401");
  expect(html).toContain("agent-job-123");
  expect(html).not.toContain("private-value");
 });
 it("不为历史通用错误编造原因", () => {
  expect(nodeFailureReason("Queued task failed: 服务暂时不可用，请稍后重试")).toContain("未记录具体原因");
 });
 it("不泄露 URL、鉴权和原始响应正文", () => {
  const reason=safeFailureMessage("duration unsupported; Authorization: Bearer private-token; https://host/path?sig=signed-secret; api_key='quoted secret'");
  expect(reason).toContain("duration unsupported");
  for(const secret of ["private-token","signed-secret","quoted secret"]) expect(reason).not.toContain(secret);
  expect(safeFailureMessage("<html>private debug</html>")).toBe("");
  expect(safeFailureMessage('HTTP 500: {"error":{"message":"model missing"},"request":{"password":"private"}}')).toBe("model missing");
 });
});
