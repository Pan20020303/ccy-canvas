// Local visual regression fixture. No requests, generation jobs or store writes.
import { createRoot } from "react-dom/client";
import { NodeErrorBanner } from "../../../src/app/components/nodes/NodeErrorBanner";
import { AgentFailureNotice } from "../../../src/app/components/agent/AgentFailureNotice";
import "../../../src/styles/index.css";

const reason = "模型服务拒绝了请求参数，请按下方原因调整（上游 HTTP 422）：duration must be 5 or 10 [code=invalid_parameter] [param=duration]";
createRoot(document.getElementById("root")!).render(
  <main style={{minHeight:"100vh",background:"#111",color:"#eee",padding:48,fontFamily:"sans-serif"}}>
    <h1 style={{fontSize:22}}>错误展示验收</h1>
    <p style={{color:"#888",margin:"8px 0 32px"}}>模拟响应 · 使用真实 UI 组件 · 不提交生成任务，不写入生产记录</p>
    <div style={{display:"grid",gridTemplateColumns:"minmax(320px, 1fr) minmax(320px, 1fr)",gap:32,maxWidth:1080}}>
      <section><h2 style={{marginBottom:16}}>视频节点：参数不符合模型要求</h2>
        <div style={{position:"relative",height:280,borderRadius:18}}><NodeErrorBanner error={reason}/></div>
      </section>
      <section style={{background:"#19191b",padding:24,borderRadius:18}}><h2 style={{marginBottom:24}}>Agent 对话</h2>
        <AgentFailureNotice message="模型渠道认证失败，请联系管理员检查 API 密钥（上游 HTTP 401）：Incorrect API key provided: sk-demo-secret [code=invalid_api_key]" jobId="示例任务编号（非真实任务）"/>
        <div style={{height:24}}/>
        <AgentFailureNotice message="服务暂时不可用，请稍后重试"/>
      </section>
      <section><h2 style={{marginBottom:16}}>视频节点：长错误可滚动阅读</h2>
        <div style={{position:"relative",height:240,borderRadius:18}}><NodeErrorBanner error={reason + "；" + "参考素材参数不符合当前模型支持的时长与分辨率，请检查参数后重新提交。".repeat(9)}/></div>
      </section>
    </div>
  </main>,
);
