import { describe, expect, it } from 'vitest';
import { adoptScriptRevision, parseScriptDoctorResult, scriptDoctorApproved, scriptDoctorIssue, scriptDoctorResult } from './film-script-doctor';
import { filmModels, filmTextPayload, newFilmProject, type FilmJob } from './film-project';
import { filmAssetPreparationIssue, filmStepIssue } from './film-workflow';
import { mergeFilmProjects } from './film-merge';

const raw = JSON.stringify({ optimizedScript: '旅人握紧信封，走入雨庭。', summary: '补清动作对象', changes: ['进场：明确握持信封'], questions: [], assetNotes: ['核对信封参考图'] });
const project = () => {
  const p = newFilmProject(); p.script = '旅人走入雨庭。';
  p.assets = [{ id: 'scene', name: '雨庭', type: 'scene', source: 'uploaded', locked: false, history: [], description: '庭院', url: '/scene.png' }];
  return p;
};
const job = (sourceScript: string): FilmJob => ({ id: 'doctor', kind: 'doctor', status: 'running', sourceScript, nodeId: 'd', startedAt: 10, payload: { service_type: 'text', model: 'writer', prompt: '优化' } });
function reviewed() { const p = project(); return { ...p, ...scriptDoctorResult(p, job(p.script), raw) }; }

describe('script doctor review and adoption', () => {
  it('requires a complete screenplay and never silently truncates or adopts a diagnosis', () => {
    expect(parseScriptDoctorResult('```json\n' + raw + '\n```').optimizedScript).toContain('信封');
    for (const text of ['诊断：缺乏因果', '{"optimizedScript":"截断', '{"summary":"只有建议"}', '{"optimizedScript":""}', JSON.stringify({ optimizedScript: '长'.repeat(10001) }), '{"optimizedScript":"剧本","questions":{}}']) expect(() => parseScriptDoctorResult(text)).toThrow();
  });
  it('preserves original text and media until explicit adoption, then uses the edited candidate and requires an asset review', () => {
    const p = reviewed(); expect(p.script).toBe('旅人走入雨庭。'); expect(scriptDoctorIssue(p)).toContain('确认采用');
    p.scriptDoctor!.revisions[0].editedScript = '旅人捏着信封，沿台阶走入雨庭。';
    const adopted = { ...p, ...adoptScriptRevision(p, 'doctor') };
    expect(adopted.script).toContain('沿台阶'); expect(adopted.scriptHistory[0].text).toBe(p.script);
    expect(adopted.scriptDoctor?.revisions[0].sourceScript).toBe(p.script);
    expect(adopted.assets).toBe(p.assets); expect(adopted.shots).toBe(p.shots);
    expect(scriptDoctorApproved(adopted)).toBe(true); expect(filmAssetPreparationIssue(adopted)).toContain('已核对');
    adopted.scriptDoctor!.adopted!.assetsReviewed = true;
    expect(filmStepIssue(adopted, 3)).toBeUndefined();
    adopted.script += '新的情节'; expect(scriptDoctorApproved(adopted)).toBe(false); expect(scriptDoctorIssue(adopted)).toContain('已修改');
  });
  it('retains stale candidates as read-only evidence and refuses adoption over a newer source', () => {
    const p = project(), oldJob = job(p.script); p.script = '新剧情';
    Object.assign(p, scriptDoctorResult(p, oldJob, raw));
    expect(p.script).toBe('新剧情'); expect(p.scriptDoctor?.revisions).toHaveLength(1);
    expect(() => adoptScriptRevision(p, 'doctor')).toThrow('旧优化稿');
    expect(scriptDoctorResult(p, oldJob, raw)).toEqual({});
  });
  it('requires unresolved questions to be acknowledged and never adopts during another text task', () => {
    const p = reviewed(); p.scriptDoctor!.revisions[0].questions = ['角色去向待确认'];
    expect(() => adoptScriptRevision(p, 'doctor')).toThrow('待确认');
    expect(adoptScriptRevision(p, 'doctor', true).script).toContain('信封');
    p.jobs = [job(p.script)]; expect(() => adoptScriptRevision(p, 'doctor', true)).toThrow('处理中');
  });
  it('uses the selected doctor model and retains the whole source and actual project specifications', () => {
    const p = project(); p.settings.doctorModel = 'llm:doctor-model'; p.settings.ratio = '16:9';
    const models = filmModels([{ id: 'llm', service_type: 'text', name: '文字', vendor: 'OpenAI', priority: 1, default_model: 'default-model', model_list: ['doctor-model'] }]);
    const payload = filmTextPayload(p, 'doctor', models, []);
    expect(payload.model).toBe('doctor-model'); expect(payload.prompt).toContain('16:9'); expect(payload.prompt).toContain(p.script); expect(payload.prompt).toContain('optimizedScript');
    p.settings.doctorModel = 'missing'; expect(() => filmTextPayload(p, 'doctor', models, [])).toThrow('不可用');
  });
  it('merges remote doctor results without losing a local script edit, but cannot merge approval of a different version', () => {
    const p = project(), completed = { ...p, ...scriptDoctorResult(p, job(p.script), raw) };
    const merged = mergeFilmProjects(p, { ...p, script: '另一个浏览器的新剧本' }, completed)!;
    expect(merged.script).toContain('新剧本'); expect(merged.scriptDoctor?.revisions).toHaveLength(1);
    expect(() => adoptScriptRevision(merged, 'doctor')).toThrow();
    const base = { ...completed, ...adoptScriptRevision(completed, 'doctor') };
    const local = structuredClone(base), remote = structuredClone(base);
    local.scriptDoctor!.adopted!.assetsReviewed = true;
    remote.scriptDoctor!.adopted!.script = '新采用的正文'; remote.script = '新采用的正文';
    expect(mergeFilmProjects(base, local, remote)).toBeNull();
  });
  it('leaves old storyboards editable but blocks new storyboards until approval', () => {
    const p = project(); expect(filmStepIssue(p, 3)).toContain('剧本医生');
    p.shots = [{ id: 'old', title: '旧镜', description: '旧内容', shot: '全景', duration: '4s', status: 'draft', assetIds: [], history: [] }];
    expect(filmStepIssue(p, 3)).toBeUndefined(); expect(scriptDoctorIssue(p)).toContain('剧本医生');
  });
});
