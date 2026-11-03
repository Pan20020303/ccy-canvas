/**
 * 检视页的浏览器入口 —— 把共享的时间线实现暴露到 window。
 *
 * 这是"呈现逻辑只有一份"的关键：页面与将来 ccy 的 React 面板都消费
 * src/app/agent-timeline.ts，不各自重写一套合并/配对规则。
 * 构建由 agent-bridge/server.mjs 用 esbuild 现打（见 timelineBundle）。
 */

import { buildTimeline, finalReplyOf, previewText } from "../../src/app/agent-timeline.ts";

globalThis.CcyTimeline = { buildTimeline, finalReplyOf, previewText };
