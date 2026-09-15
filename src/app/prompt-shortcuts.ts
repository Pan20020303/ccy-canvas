import { listSkills, type Skill } from './api/skills';
import { getAllInvokableSlashSkills } from './components/agent-skill-commands';

// 「快捷提示词」= 管理端「提示词管理」维护的 prompt 模板技能(kind='prompt',全局
// 可见)。这里做一个模块级缓存,让所有文本节点对话框共享同一次拉取,而不是每次选中
// 节点都打一次接口。返回的是「已启用的 prompt 模板」子集(复用 Agent 那套筛选)。
let cache: Skill[] | null = null;
let inflight: Promise<Skill[]> | null = null;

/** 同步读取当前缓存(可能为空);用于组件初始 state,避免首帧闪烁。 */
export function cachedPromptShortcuts(): Skill[] {
  return cache ?? [];
}

/** 是否已完成过一次加载(区分「未加载」与「加载完但为空」,用于选择器的加载态)。 */
export function promptShortcutsLoaded(): boolean {
  return cache !== null;
}

/** 异步加载 prompt 模板;命中缓存直接返回,并发调用共享同一个 in-flight 请求。
 *  失败时静默降级为空列表(快捷提示词是增强项,不该打断输入)。 */
export async function loadPromptShortcuts(force = false): Promise<Skill[]> {
  if (!force && cache) return cache;
  if (!inflight) {
    inflight = listSkills()
      .then((all) => {
        cache = getAllInvokableSlashSkills(all);
        return cache;
      })
      .catch(() => cache ?? [])
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** 手动失效缓存(如管理端改动后想让画布立即刷新,可调用 loadPromptShortcuts(true))。 */
export function invalidatePromptShortcuts(): void {
  cache = null;
}
