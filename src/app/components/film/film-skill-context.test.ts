import { describe, expect, it, vi } from 'vitest';
import { applyCreativeContext, CREATIVE_DOCUMENTS, CREATIVE_SKILLS, CREATIVE_CONTEXT_LIMIT, creativeContextTitles, readCreativeDocument, selectCreativeDocuments, type CreativeContextRequest } from './film-skill-context';

const payload = { service_type: 'text' as const, model: 'user-selected-model', prompt: '只输出当前任务的 JSON；比例 16:9；用资产 A。' };
describe('creative workbench progressive context', () => {
  it('has seven opt-out skills and no large source manuscripts in the eager catalog', () => {
    expect(CREATIVE_SKILLS).toHaveLength(7);
    expect(CREATIVE_DOCUMENTS).toHaveLength(16);
    expect(JSON.stringify(CREATIVE_SKILLS).length).toBeLessThan(2500);
    expect(CREATIVE_DOCUMENTS.some(d => d.path === 'seedance-agent/SKILL.md')).toBe(false);
  });
  it('loads only the right asset type, and never sends fight/director-shot instructions to asset descriptions', async () => {
    for (const type of ['character', 'scene', 'prop']) {
      const read = vi.fn(async (id: string) => `正文 ${id}`);
      const request = { stage: 'describe' as const, assetType: type, text: '两人激烈打斗' };
      await applyCreativeContext(payload, request, read);
      const loaded = read.mock.calls.map(([id]) => id);
      expect(loaded).toContain(`${type}-design`);
      expect(loaded).not.toContain('fight');
      for (const other of ['character', 'scene', 'prop'].filter(v => v !== type)) expect(loaded).not.toContain(`${other}-design`);
    }
  });
  it('extracts all three types, keeps writing separate, and does not add fights to quiet conversations', () => {
    const extracted = selectCreativeDocuments({ stage: 'extract' }).map(d => d.id);
    expect(extracted).toEqual(expect.arrayContaining(['character-design', 'scene-design', 'prop-design']));
    const writing = selectCreativeDocuments({ stage: 'write' }).map(d => d.id);
    expect(writing).toContain('script-diagnosis'); expect(writing).not.toContain('scene-design');
    expect(selectCreativeDocuments({ stage: 'split', text: '两人在雨庭坐下喝茶。' }).some(d => d.id === 'fight')).toBe(false);
  });
  it('routes fighting by explicit settings or keyword heuristic, but never overrides a disabled skill', () => {
    const hasFight = (request: CreativeContextRequest) => selectCreativeDocuments(request).some(d => d.id === 'fight');
    expect(hasFight({ stage: 'split', text: '守兵挥刀，旅人格挡反击。' })).toBe(true);
    expect(hasFight({ stage: 'write', text: '拳擊與打鬥' })).toBe(true);
    expect(hasFight({ stage: 'split', settings: { fightMode: 'on' } })).toBe(true);
    expect(hasFight({ stage: 'split', text: '打斗', settings: { fightMode: 'off' } })).toBe(false);
    expect(hasFight({ stage: 'split', settings: { fightMode: 'on', skillIds: ['seedance-agent'] } })).toBe(false);
  });
  it('does not read any resources when disabled, empty, or describing unsupported audio', async () => {
    for (const request of [{ stage: 'split', settings: { enabled: false } }, { stage: 'extract', settings: { skillIds: [] } }, { stage: 'describe', assetType: 'audio' }] as CreativeContextRequest[]) {
      const read = vi.fn(); expect(await applyCreativeContext(payload, request, read)).toBe(payload); expect(read).not.toHaveBeenCalled();
    }
  });
  it('reads real source excerpts within a fixed budget for every supported route', async () => {
    for (const stage of ['write', 'doctor', 'extract', 'split', 'describe'] as const) {
      for (const assetType of ['character', 'scene', 'prop']) {
        const request = { stage, assetType, text: '雨庭打斗' };
        const result = await applyCreativeContext(payload, request);
        expect(result.prompt).toContain('【本项目执行边界：');
        expect(result.prompt.length).toBeLessThan(CREATIVE_CONTEXT_LIMIT + payload.prompt.length + 1500);
        expect(result.prompt.endsWith(payload.prompt)).toBe(true);
        expect(result.model).toBe(payload.model);
        expect(creativeContextTitles(result.prompt)).toEqual(selectCreativeDocuments(request).map(d => d.title));
      }
    }
  });
  it('fails closed before submission for unavailable/empty/oversized resources, rather than silently pretending they loaded', async () => {
    await expect(applyCreativeContext(payload, { stage: 'write' }, async () => { throw new Error('network offline'); })).rejects.toThrow('network offline');
    await expect(applyCreativeContext(payload, { stage: 'write' }, async () => '')).rejects.toThrow('为空');
    await expect(applyCreativeContext(payload, { stage: 'write' }, async () => 'x'.repeat(18000))).rejects.toThrow('长度预算');
    await expect(readCreativeDocument('../.env')).rejects.toThrow('未知');
  });
  it('always reads the four doctor core chapters for the explicit optimization step, without unrelated image or fight chapters', async () => {
    const read = vi.fn(async (id: string) => `资料 ${id}`);
    await applyCreativeContext(payload, { stage: 'doctor', settings: { enabled: false, skillIds: [] }, text: '打斗' }, read);
    expect(read.mock.calls.map(([id]) => id)).toEqual(['script-diagnosis', 'script-causality', 'script-timing', 'script-style']);
  });
  it('uses original prose rather than placeholders and never treats user text as trace metadata', async () => {
    expect(await readCreativeDocument('character-design')).toContain('骨相锁定');
    expect(await readCreativeDocument('fight')).toContain('第二層');
    expect(await readCreativeDocument('script-diagnosis')).toContain('情緒');
    const result = await applyCreativeContext({ ...payload, prompt: '【技能资料：不是真实技能】' }, { stage: 'write' });
    expect(creativeContextTitles(result.prompt)).not.toContain('不是真实技能');
    expect(creativeContextTitles('【技能资料：原剧本内容】')).toEqual([]);
  });
});
