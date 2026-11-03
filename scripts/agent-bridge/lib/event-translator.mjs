/**
 * 事件翻译器的运行时入口（薄转发）。
 *
 * ⚠️ 实现只有一份，在 src/app/dsh-event-translator.ts（TypeScript，可类型检查 + 20 个单测）。
 * 这个文件只负责把它以 ESM 暴露给 Node 侧 bridge，本身不含任何翻译逻辑 ——
 * 如果你在这里看到被复制过来的逻辑，那是 bug，请删掉并改成 import。
 *
 * 为什么能直接 import .ts：Node ≥ 23 原生支持 type stripping，本仓库用 Node 24。
 * 所以 bridge 不需要额外的编译产物/构建步骤（少一个构建环节就少一处漂移）。
 * 若在更老的 Node 上运行，会在 import 处直接报错，而不是静默跑一份旧逻辑 ——
 * 这是刻意的失败方式。
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// lib/ → agent-bridge/ → scripts/ → 仓库根
const REPO_ROOT = join(HERE, "..", "..", "..");
const SOURCE = join(REPO_ROOT, "src", "app", "dsh-event-translator.ts");

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < 23) {
  throw new Error(
    `agent bridge 需要 Node ≥ 23（当前 ${process.versions.node}）以直接加载 TypeScript 翻译器；` +
      `请升级 Node，或为 src/app/dsh-event-translator.ts 增加一个编译步骤。`,
  );
}

const module_ = await import(pathToFileURL(SOURCE).href);

export const normalizeToolName = module_.normalizeToolName;
export const textFromBlocks = module_.textFromBlocks;
export const flattenStreamChunks = module_.flattenStreamChunks;
export const translateSessionEvent = module_.translateSessionEvent;
export const createSessionEventTranslator = module_.createSessionEventTranslator;

/** 供 /health 暴露，便于排查"跑的是哪份实现"。 */
export const TRANSLATOR_SOURCE = `src/app/dsh-event-translator.ts (node ${process.versions.node}, type-stripping)`;
