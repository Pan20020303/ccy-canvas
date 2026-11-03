import { describe, expect, it } from "vitest";

import {
  appendConversationTurn,
  clearAgentConversationHistory,
  completeAgentConversationTurn,
  conversationTurnsFromHistoryItems,
  getAgentConversationHistory,
  imageReferencePreamble,
  videoReferencePreamble,
  isVideoReferenceUrl,
  parseAgentUserInput,
  parsePersistedToolLog,
  presentAgentUserInput,
  recordAgentConversationTurn,
  type AgentConversationTurn,
} from "./agent-conversation";

describe("presentAgentUserInput", () => {
  it('restores only public progress and does not expose its row as raw tool output', () => {
    const tool_log = '✓ read_node({"node_id":"n1"}) → raw result\n✓ public_progress({}) → ' + JSON.stringify({
      plan: { steps: [{id:'read',title:'确认参考素材',status:'completed'},{id:'generate',title:'准备生成参数',status:'in_progress'}], summary:'先核对素材，再确认参数', secret:'private-plan' },
      progress: {id:'generate',label:'等待你确认生成参数',status:'waiting', raw:'private-tool-payload'},
    });
    const turns=conversationTurnsFromHistoryItems([{user_input:'生成视频', final_reply:'请确认参数', tool_log}]);
    expect(turns[1].toolCalls).toHaveLength(1);
    expect(turns[1].progress?.status).toBe('waiting');
    expect(turns[1].progress?.steps).toHaveLength(2);
    expect(JSON.stringify(turns[1].progress)).not.toContain('private');
    expect(conversationTurnsFromHistoryItems([{user_input:'你好',final_reply:'你好',tool_log:'✓ public_progress({}) → broken'}])[1].progress).toBeUndefined();
  });
  it('recovers old video-as-image references without rewriting history', () => {
    const stored='（参考画布节点：15.mp4#node-video）\n（参考图片：https://example.com/hash.mp4）\n分析一下这个视频，反推提示词';
    const turns=conversationTurnsFromHistoryItems([{user_input:stored,final_reply:'收到'}]);
    expect(turns[0]).toEqual({role:'user',content:'分析一下这个视频，反推提示词',editText:'分析一下这个视频，反推提示词',
      videos:[{url:'https://example.com/hash.mp4',name:'15.mp4',nodeId:'node-video'}]});
    expect(turns[0].images).toBeUndefined();
  });
  it('round-trips typed videos, including extensionless URLs, with mixed image references', () => {
    const videos=[{url:'/uploads/opaque-asset',name:'参考（动作）.mov',nodeId:'n1'},{url:'https://example.com/two.webm',name:'second'}];
    const stored=imageReferencePreamble(['/uploads/a.png'])+videoReferencePreamble(videos)+'分析动作';
    expect(parseAgentUserInput(stored)).toEqual({content:'分析动作',images:['/uploads/a.png'],videos,canvasReferences:0});
    expect(conversationTurnsFromHistoryItems([{user_input:stored,final_reply:''}])[0].videos).toEqual(videos);
    expect(appendConversationTurn([], 'user', '分析动作',12,['/uploads/a.png'],videos)[0].videos).toEqual(videos);
  });
  it('recognizes signed and proxied video URLs but never mistakes a JPG for a video', () => {
    const video='https://example.com/15.MP4?signature=abc';
    expect(isVideoReferenceUrl(video)).toBe(true);
    expect(isVideoReferenceUrl('/api/app/proxy-media?url='+encodeURIComponent(video))).toBe(true);
    expect(isVideoReferenceUrl('/uploads/a.jpg?name=video.mp4')).toBe(false);
  });
  it("replaces raw canvas filenames and node ids with a compact reference count", () => {
    expect(presentAgentUserInput(
      "（参考画布节点：2e09f8d05154dd0ebe91aae2eee18f79.jpg#node-1）\n这张图片的人名提取游戏",
    )).toBe("📎 已引用 1 个画布节点\n这张图片的人名提取游戏");
  });
  it("restores uploaded image URLs without exposing routing preambles in the user bubble", () => {
    const stored = `（参考画布节点：角色#node-1）\n${imageReferencePreamble(["/uploads/a.png", "/uploads/b.jpg"])}请保持角色一致`;
    expect(parseAgentUserInput(stored)).toEqual({ content: "请保持角色一致", images: ["/uploads/a.png", "/uploads/b.jpg"], videos: [], canvasReferences: 1 });
    expect(presentAgentUserInput(stored)).toBe("请保持角色一致");
    expect(conversationTurnsFromHistoryItems([{ user_input: stored, final_reply: "收到" }])[0]).toEqual({
      role: "user", content: "请保持角色一致",
      editText: "请保持角色一致", images: ["/uploads/a.png", "/uploads/b.jpg"],
    });
  });
});

describe("agent conversation history", () => {
  it("appends a single turn pair to the conversation history", () => {
    const history = completeAgentConversationTurn([], "Draft a launch headline.", "Here is a sharper launch headline.");

    expect(history).toEqual<AgentConversationTurn[]>([
      { role: "user", content: "Draft a launch headline." },
      { role: "assistant", content: "Here is a sharper launch headline." },
    ]);
  });

  it("keeps only the most recent turns within the history limit", () => {
    const history = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn-${index + 1}`,
    })) as AgentConversationTurn[];

    const next = completeAgentConversationTurn(
      history,
      "Please tighten the CTA.",
      "Here is a tighter CTA.",
      6,
    );

    expect(next).toEqual<AgentConversationTurn[]>([
      { role: "user", content: "turn-3" },
      { role: "assistant", content: "turn-4" },
      { role: "user", content: "turn-5" },
      { role: "assistant", content: "turn-6" },
      { role: "user", content: "Please tighten the CTA." },
      { role: "assistant", content: "Here is a tighter CTA." },
    ]);
  });

  it("ignores blank turn content instead of polluting history", () => {
    expect(appendConversationTurn([], "user", "   ")).toEqual([]);
    expect(completeAgentConversationTurn([], "Rewrite this copy.", "   ")).toEqual([]);
  });

  it("stores conversation history per agent and keeps their turns isolated", () => {
    const byAgent = recordAgentConversationTurn({}, "agent-brand", "Rewrite this headline.", "Here is a warmer version.");
    const next = recordAgentConversationTurn(byAgent, "agent-story", "Outline scene one.", "Scene one is now outlined.");

    expect(getAgentConversationHistory(next, "agent-brand")).toEqual<AgentConversationTurn[]>([
      { role: "user", content: "Rewrite this headline." },
      { role: "assistant", content: "Here is a warmer version." },
    ]);
    expect(getAgentConversationHistory(next, "agent-story")).toEqual<AgentConversationTurn[]>([
      { role: "user", content: "Outline scene one." },
      { role: "assistant", content: "Scene one is now outlined." },
    ]);
  });

  it("can clear the stored history for a specific agent only", () => {
    const byAgent = recordAgentConversationTurn({}, "agent-brand", "Rewrite this headline.", "Here is a warmer version.");
    const next = recordAgentConversationTurn(byAgent, "agent-story", "Outline scene one.", "Scene one is now outlined.");

    expect(clearAgentConversationHistory(next, "agent-brand")).toEqual({
      "agent-story": [
        { role: "user", content: "Outline scene one." },
        { role: "assistant", content: "Scene one is now outlined." },
      ],
    });
  });

  it("hydrates conversation turns from persisted run history items", () => {
    expect(conversationTurnsFromHistoryItems([
      {
        user_input: "Draft a launch headline.",
        final_reply: "Launch brighter with our summer collection.",
        tool_log: "✓ create_node({\"type\":\"textNode\"}) → {\"id\":\"n1\"}",
      },
      {
        user_input: "Make it warmer.",
        final_reply: "Here is a warmer launch headline.",
      },
    ])).toEqual<AgentConversationTurn[]>([
      { role: "user", content: "Draft a launch headline." },
      {
        role: "assistant",
        content: "Launch brighter with our summer collection.",
        toolCalls: [{
          name: "create_node",
          args: "{\"type\":\"textNode\"}",
          output: "{\"id\":\"n1\"}",
          status: "success",
        }],
      },
      { role: "user", content: "Make it warmer." },
      { role: "assistant", content: "Here is a warmer launch headline." },
    ]);
  });

  it("parses multiline persisted tool results without losing their details", () => {
    expect(parsePersistedToolLog(
      "✓ analyze_image({\"node_id\":\"n1\"}) → 第一行分析\n第二行分析\n✕ run_node({\"node_id\":\"n2\"}) → 模型不可用",
    )).toEqual([
      {
        name: "analyze_image",
        args: "{\"node_id\":\"n1\"}",
        output: "第一行分析\n第二行分析",
        status: "success",
      },
      {
        name: "run_node",
        args: "{\"node_id\":\"n2\"}",
        output: "模型不可用",
        status: "error",
      },
    ]);
  });
});
