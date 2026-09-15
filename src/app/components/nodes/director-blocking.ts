import { getModelTemplate } from '../../model-templates';
import type { AppProviderConfig } from '../../api/providerConfigs';
import { PROP_DEFS } from './director-props';

/**
 * AI 站位识别(director blocking recognition)的纯逻辑:
 *   - 提示词构造:把画面映射到导演台俯视坐标系(与 ReferenceLayerPlane 的
 *     平铺规则一致:长边 = 10 个单位,原点居中);
 *   - 结果解析:剥代码围栏 → JSON → clamp/校验成可直接放置的站位方案;
 *   - 视觉模型挑选:优先模板声明 supportsVision,再按名字启发。
 * 拆成独立文件以便单测(overlay 拖着 three/r3f,测试环境不友好)。
 */

export type BlockingActor = { label: string; x: number; z: number; rotationY: number };
export type BlockingProp = { assetId: string; x: number; z: number; rotationY: number; scale: number };
export type BlockingPlan = { actors: BlockingActor[]; props: BlockingProp[] };

/** 与 ReferenceLayerPlane 相同的平铺尺寸:长边 10,短边按图片宽高比。 */
export function stagePlaneSize(imgW: number, imgH: number): { w: number; h: number } {
  const long = 10;
  const ar = imgW > 0 && imgH > 0 ? imgW / imgH : 16 / 9;
  return ar >= 1 ? { w: long, h: long / ar } : { w: long * ar, h: long };
}

export function buildBlockingPrompt(imgW: number, imgH: number): string {
  const { w, h } = stagePlaneSize(imgW, imgH);
  const propList = PROP_DEFS.map((d) => `${d.id}(${d.zh})`).join('、');
  return [
    '你是舞台调度助手。分析这张画面中的人物与主要物体,把它们的落点映射到一个俯视舞台坐标系。',
    `坐标系:画面平铺在舞台地面,画面中心 = 原点。x 轴向右、z 轴向下(画面下缘为 +z)。画面宽对应 x ∈ [${(-w / 2).toFixed(1)}, ${(w / 2).toFixed(1)}],画面高对应 z ∈ [${(-h / 2).toFixed(1)}, ${(h / 2).toFixed(1)}]。`,
    '每个人物:估计其脚下站位 (x,z)、身体朝向 rotationY(弧度;0 表示面向 +z 即画面下方/镜头,逆时针为正,如面向画面右侧为 -1.57)、给一个简短 label(如"男主"、"穿红衣的人")。',
    `每个主要物体:从道具清单中选最接近的 assetId,并给出 (x,z)、rotationY、相对大小 scale(1 为常规)。清单:${propList}。清单里没有合适的就跳过该物体。`,
    '只输出 JSON,不要任何解释或代码围栏,格式:',
    '{"actors":[{"label":"男主","x":0,"z":1.2,"rotationY":0}],"props":[{"assetId":"chair","x":-2,"z":0.5,"rotationY":0,"scale":1}]}',
    '没有识别到人物或物体时对应数组给 []。',
  ].join('\n');
}

const clampCoord = (v: unknown, lim: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.max(-lim, Math.min(lim, n));
};

/** 解析模型输出为站位方案。宽容:剥围栏、截取首个 {...} 块;失败返回 null。 */
export function parseBlockingPlan(raw: string): BlockingPlan | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const obj = parsed as { actors?: unknown; props?: unknown };
  const validPropIds = new Set(PROP_DEFS.map((d) => d.id));
  const actors: BlockingActor[] = (Array.isArray(obj.actors) ? obj.actors : [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .slice(0, 20)
    .map((a, i) => ({
      label: typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 20) : `角色${i + 1}`,
      x: clampCoord(a.x, 5),
      z: clampCoord(a.z, 5),
      rotationY: clampCoord(a.rotationY, Math.PI * 2),
    }));
  const props: BlockingProp[] = (Array.isArray(obj.props) ? obj.props : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .filter((p) => typeof p.assetId === 'string' && validPropIds.has(p.assetId))
    .slice(0, 30)
    .map((p) => ({
      assetId: p.assetId as string,
      x: clampCoord(p.x, 5),
      z: clampCoord(p.z, 5),
      rotationY: clampCoord(p.rotationY, Math.PI * 2),
      scale: Math.max(0.3, Math.min(3, typeof p.scale === 'number' && Number.isFinite(p.scale) ? p.scale : 1)),
    }));
  if (actors.length === 0 && props.length === 0) return null;
  return { actors, props };
}

/** 从已配置的 provider 里挑一个能"看图"的文本模型。
 *  优先模板声明 supportsVision;其次名字启发(vl/vision/4o/gemini/glm-4v)。 */
export function pickVisionModel(configs: AppProviderConfig[]): string | null {
  const textModels: string[] = [];
  const seen = new Set<string>();
  for (const cfg of configs) {
    if (cfg.service_type !== 'text') continue;
    for (const m of cfg.model_list ?? []) {
      if (m && !seen.has(m)) { seen.add(m); textModels.push(m); }
    }
  }
  const byTemplate = textModels.find((m) => getModelTemplate(m)?.supportsVision);
  if (byTemplate) return byTemplate;
  const heuristic = /(-vl|vl-|vision|4o|gemini|glm-4v|qwen3\.7-plus)/i;
  return textModels.find((m) => heuristic.test(m)) ?? null;
}
