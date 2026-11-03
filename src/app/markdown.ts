import { marked } from "marked";
import DOMPurify from "dompurify";

// 文本节点的内容基准格式是 Markdown（LLM 产出基本就是 Markdown）。这里把它渲染
// 成排版好的 HTML 用于「只读展示 / 预览」，编辑仍改 Markdown 源。
//   - gfm=true：表格、删除线、任务列表等 GitHub 风格。
//   - breaks=true：单个换行也当 <br>，贴合 LLM 输出的断行习惯。
// 渲染结果一律过 DOMPurify 消毒，杜绝 content 里夹带的脚本/事件属性（内容虽出自
// 用户自己的模型，但仍走 innerHTML，必须消毒）。旧节点里残留的 HTML 内容会被
// marked 原样透传、再由 DOMPurify 清洗，所以老数据也能正常显示。
marked.setOptions({ gfm: true, breaks: true });

let hookInstalled = false;
function ensureLinkHook(): void {
  if (hookInstalled) return;
  try {
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      const el = node as Element;
      if (el.tagName === "A") {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer nofollow");
      }
    });
    hookInstalled = true;
  } catch {
    // 构建期无 window —— 首次在浏览器渲染时会再装一次钩子。
  }
}

/** Render Markdown（或旧的 HTML）源为消毒后的展示 HTML。失败时返回空串。 */
export function renderMarkdown(src: string): string {
  if (!src) return "";
  try {
    ensureLinkHook();
    const html = marked.parse(src, { async: false }) as string;
    // FORBID_ATTR style：DOMPurify 默认会保留 inline style，而 style 里的
    // background:url(...) 会在渲染时零点击发起外链请求（追踪/回执信标、数据外泄）。
    // Markdown 本身从不产出 inline style，禁掉它不影响任何排版。
    return DOMPurify.sanitize(html, { FORBID_ATTR: ["style"] });
  } catch {
    return "";
  }
}
