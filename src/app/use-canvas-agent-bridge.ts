/**
 * 画布 dev 回灌 —— 让"磁盘上的智能体改动"实时出现在浏览器画布上（仅 dev）。
 *
 * 为什么需要它：C3 阶段智能体通过 CLI/MCP 改的是工作区里的 canvas.json + patches.jsonl，
 * 浏览器并不知道。这个 hook 把 patches 拉回来，复用与线上完全相同的 patch 应用器
 * （`createCanvasPatchApplier`）落到 store —— 于是"画布真的动了"，且线上链路零改动。
 *
 * 行为：
 *   - 首次挂载若磁盘画布为空 → 用浏览器当前画布 seed（让智能体看到真实画布）
 *   - 之后按 index 拉取 pending patches，逐条应用并回 ack
 *   - revision 冲突不硬塞：停下来把原因写到 console，等待人工/重新 seed
 *
 * 安全：只在 import.meta.env.DEV 且开关打开时工作；生产构建里整个模块被静态裁掉。
 */

import { useEffect, useRef } from "react";

import { createCanvasPatchApplier } from "./canvas-patch-apply";
import type { CanvasPatch } from "./api/agent-run";
import { useStore } from "./store";

const STATE_URL = "/__canvas-cli/state";
const ACK_URL = "/__canvas-cli/ack";
const SEED_URL = "/__canvas-cli/seed";
const POLL_INTERVAL_MS = 900;
const ENDPOINT_PROBE_TIMEOUT_MS = 1500;
const CONFLICT_LIMIT = 3;

type BridgeState = {
  revision: number;
  browser_revision: number;
  pending: CanvasPatch[];
};

function enabled() {
  // 默认开启（dev 下没有桥也无害：探测失败即静默退出）；
  // 显式关闭：localStorage.setItem('ccy:canvas-bridge','off')
  try {
    return localStorage.getItem("ccy:canvas-bridge") !== "off";
  } catch {
    return true;
  }
}

async function probe(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENDPOINT_PROBE_TIMEOUT_MS);
    const response = await fetch(STATE_URL, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 挂载画布 dev 回灌。幂等：重复渲染不会起第二个轮询。
 * 在 Canvas 组件里调用一次即可。
 */
export function useCanvasAgentBridge() {
  const started = useRef(false);

  useEffect(() => {
    if (!import.meta.env.DEV || started.current || !enabled()) return;
    started.current = true;

    let disposed = false;
    let timer: number | null = null;
    let conflicts = 0;
    let seeded = false;

    const applier = createCanvasPatchApplier(
      {
        addNode: (node) => useStore.getState().addNode(node),
        onConnect: (connection) =>
          useStore.getState().onConnect({
            source: connection.source,
            target: connection.target,
            sourceHandle: connection.sourceHandle ?? null,
            targetHandle: connection.targetHandle ?? null,
          }),
        updateNodeData: (nodeId, patch) => useStore.getState().updateNodeData(nodeId, patch),
        moveNodeTo: (nodeId, position) => useStore.getState().moveNodeTo(nodeId, position),
        deleteNodes: (nodeIds) => useStore.getState().deleteNodes(nodeIds),
        createGroup: (nodeIds, name) => useStore.getState().createGroup(nodeIds, name),
        runNode: (nodeId, payload) => useStore.getState().runNode(nodeId, payload),
        getNode: (nodeId) => useStore.getState().nodes.find((node) => node.id === nodeId),
        backendModels: useStore.getState().backendModels,
      },
      {
        onRejected: (reason) => {
          conflicts += 1;
          console.warn(`[canvas-bridge] patch 被拒绝：${reason}`);
        },
      },
    );

    /** 用浏览器当前画布初始化工作区，使两侧 revision 对齐。 */
    async function seedFromBrowser() {
      const state = useStore.getState();
      const response = await fetch(SEED_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision: state.canvasRevision,
          nodes: state.nodes,
          edges: state.edges,
          groups: state.groups,
        }),
      });
      if (!response.ok) throw new Error(`seed 失败 HTTP ${response.status}`);
      applier.reset(state.canvasRevision);
      seeded = true;
      console.info(`[canvas-bridge] 已把浏览器画布交给工作区（revision=${state.canvasRevision}）`);
    }

    async function tick() {
      if (disposed) return;
      try {
        const response = await fetch(STATE_URL, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as BridgeState;

        if (!seeded) {
          const isEmpty = (data.revision ?? 0) === 0;
          const browserHasContent = useStore.getState().nodes.length > 0;
          if (isEmpty && browserHasContent) {
            await seedFromBrowser();
          } else {
            seeded = true;
          }
          applier.reset(useStore.getState().canvasRevision);
        }

        let appliedAny = false;
        for (const patch of data.pending ?? []) {
          if (disposed || conflicts >= CONFLICT_LIMIT) break;
          const result = applier.applyPatch(patch);
          if (result.applied) appliedAny = true;
        }

        // 回 ack：无论是否应用成功，都把"浏览器当前真实 revision"告知桥，
        // 避免桥继续按错误的基线发 patch。
        const current = useStore.getState().canvasRevision;
        await fetch(ACK_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: current }),
        }).catch(() => {});

        if (appliedAny) {
          conflicts = 0;
        }
      } catch (err) {
        // 桥没起（没改 vite.config）是正常情况：静默重试。
        if (conflicts === 0) console.debug("[canvas-bridge] 未连接:", String((err as Error)?.message ?? err));
      }
      if (!disposed) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    }

    void probe().then((reachable) => {
      if (disposed) return;
      if (!reachable) {
        console.debug("[canvas-bridge] 未检测到画布桥，跳过（dev 桥需要 vite-canvas-dev 插件）");
        return;
      }
      console.info("[canvas-bridge] 已连接画布工作区，智能体的画布改动会实时回灌");
      void tick();
    });

    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);
}
