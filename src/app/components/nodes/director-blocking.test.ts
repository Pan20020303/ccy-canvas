import { describe, expect, it } from 'vitest';

import { buildBlockingPrompt, parseBlockingPlan, pickVisionModel, stagePlaneSize } from './director-blocking';
import type { AppProviderConfig } from '../../api/providerConfigs';

describe('stagePlaneSize', () => {
  it('横图长边=10,短边按宽高比', () => {
    expect(stagePlaneSize(1600, 900)).toEqual({ w: 10, h: 10 / (1600 / 900) });
  });
  it('竖图高=10', () => {
    const { w, h } = stagePlaneSize(900, 1600);
    expect(h).toBe(10);
    expect(w).toBeCloseTo(10 * (900 / 1600));
  });
});

describe('parseBlockingPlan', () => {
  it('解析纯 JSON', () => {
    const plan = parseBlockingPlan('{"actors":[{"label":"男主","x":1,"z":2,"rotationY":0.5}],"props":[{"assetId":"chair","x":-1,"z":0,"rotationY":0,"scale":1.2}]}');
    expect(plan?.actors).toHaveLength(1);
    expect(plan?.actors[0]).toEqual({ label: '男主', x: 1, z: 2, rotationY: 0.5 });
    expect(plan?.props[0].assetId).toBe('chair');
    expect(plan?.props[0].scale).toBe(1.2);
  });

  it('剥代码围栏与前后废话', () => {
    const raw = '好的,分析如下:\n```json\n{"actors":[{"label":"A","x":0,"z":0,"rotationY":0}],"props":[]}\n```\n以上。';
    expect(parseBlockingPlan(raw)?.actors).toHaveLength(1);
  });

  it('过滤清单外道具、clamp 坐标与 scale', () => {
    const plan = parseBlockingPlan(JSON.stringify({
      actors: [{ label: 'B', x: 99, z: -99, rotationY: 0 }],
      props: [
        { assetId: 'ufo', x: 0, z: 0, rotationY: 0, scale: 1 },
        { assetId: 'rock', x: 0, z: 0, rotationY: 0, scale: 99 },
      ],
    }));
    expect(plan?.actors[0].x).toBe(5);
    expect(plan?.actors[0].z).toBe(-5);
    expect(plan?.props).toHaveLength(1);
    expect(plan?.props[0].scale).toBe(3);
  });

  it('空结果 / 非 JSON → null', () => {
    expect(parseBlockingPlan('{"actors":[],"props":[]}')).toBeNull();
    expect(parseBlockingPlan('识别不了')).toBeNull();
  });
});

describe('pickVisionModel', () => {
  const cfg = (models: string[], serviceType = 'text'): AppProviderConfig => ({
    id: 'x', name: 'x', vendor: 'x', service_type: serviceType, base_url: '', status: 'enabled',
    model_list: models, default_model: models[0] ?? '',
  } as unknown as AppProviderConfig);

  it('优先模板声明 supportsVision 的模型', () => {
    expect(pickVisionModel([cfg(['gpt-x', 'qwen3.7-plus'])])).toBe('qwen3.7-plus');
  });
  it('名字启发:-vl / vision / 4o', () => {
    expect(pickVisionModel([cfg(['deepseek-chat', 'qwen-vl-max'])])).toBe('qwen-vl-max');
  });
  it('忽略非 text 通道;无候选 → null', () => {
    expect(pickVisionModel([cfg(['qwen3.7-plus'], 'image'), cfg(['deepseek-chat'])])).toBeNull();
  });
});

describe('buildBlockingPrompt', () => {
  it('包含坐标范围与道具清单', () => {
    const p = buildBlockingPrompt(1600, 900);
    expect(p).toContain('x ∈ [-5.0, 5.0]');
    expect(p).toContain('chair(椅子)');
    expect(p).toContain('"actors"');
  });
});
