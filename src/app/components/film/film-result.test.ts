import { describe, expect, it } from 'vitest';
import { completeArrayPrefix, prepareFilmResult } from './film-result';

const shot = { title: '镜头1', description: '人物走入车站', videoPrompt: '0–4秒：对白“到站了”。画面里有 { 门 } 和 [招牌]，\\逆光。', assetIds: [] };
describe('durable film result parsing', () => {
  it('keeps valid fenced JSON and natural language video prompts intact', () => {
    const raw = '```json\n' + JSON.stringify({ shots: [shot] }) + '\n```';
    expect(prepareFilmResult('split', raw, [])).toEqual({ content: raw, count: 1, warning: undefined });
  });
  it('recovers 12 complete shots when the 13th ends inside a string', () => {
    const completed = Array.from({ length: 12 }, (_, i) => ({ ...shot, title: `镜头${i + 1}` }));
    const raw = '```json\n{"shots":[' + completed.map(s => JSON.stringify(s)).join(',') + ',{"title":"镜头13","videoPrompt":"100mm，特写，';
    const result = prepareFilmResult('split', raw, []);
    expect(result.count).toBe(12); expect(result.warning).toContain('截断');
    expect(JSON.parse(result.content).shots).toEqual(completed);
  });
  it('does not fabricate a shot if no complete object was returned', () => {
    expect(() => prepareFilmResult('split', '{"shots":[{"description":"开始', [])).toThrow();
    expect(() => prepareFilmResult('split', '模型拒绝了请求', [])).toThrow();
  });
  it('does not recover an unrelated object or delimiter hidden in a prompt', () => {
    expect(completeArrayPrefix('{"message":"这里有 \\"shots\\":[]"}', 'shots')).toEqual([]);
    expect(completeArrayPrefix('{"shots":[{"description":"完整","nested":[{"note":"} ]"}]},{oops}]', 'shots')).toHaveLength(1);
    expect(completeArrayPrefix('{"shots":[{"bad":oops},{"description":"不越过坏记录"}]}', 'shots')).toEqual([]);
  });
  it('recovers completed assets without treating the unfinished character as real', () => {
    const raw = '{"assetsList":[{"name":"车站","type":"scene","desc":"清晨车站","prompt":"安静的车站"},{"name":"旅人';
    expect(prepareFilmResult('extract', raw, [])).toMatchObject({ count: 1, warning: expect.stringContaining('完整资产') });
  });
});
