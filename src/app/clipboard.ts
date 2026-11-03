import { toast } from "sonner";

/** 复制文本到剪贴板，兼容非安全上下文。
 *  navigator.clipboard 只在 HTTPS/localhost 存在 —— 协作用户经 http://IP:端口
 *  访问时它是 undefined，原先的 `navigator.clipboard?.writeText` 会静默失败
 *  (「点了复制没反应」)。这里降级到 execCommand('copy')，并返回是否成功。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 安全上下文里也可能因权限被拒 — 落到 execCommand 兜底。
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 复制并 toast 反馈（成功/失败都有提示，不再无声）。 */
export async function copyWithToast(text: string, zh: boolean): Promise<void> {
  const ok = await copyTextToClipboard(text);
  if (ok) toast.success(zh ? "已复制" : "Copied");
  else toast.error(zh ? "复制失败，请手动选择文本复制" : "Copy failed — select the text manually");
}
