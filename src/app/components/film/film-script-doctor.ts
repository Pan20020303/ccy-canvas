import { SCRIPT_LIMIT, type FilmJob, type FilmProject } from './film-project';

export type FilmScriptRevision = {
  id: string; sourceScript: string; optimizedScript: string; editedScript?: string;
  summary: string; changes: string[]; questions: string[]; assetNotes: string[]; createdAt: number;
};
export type FilmScriptDoctor = {
  revisions: FilmScriptRevision[];
  adopted?: { revisionId: string; script: string; at: number; assetsReviewed: boolean };
};

// Only accept a complete structured result. A diagnosis alone or a truncated
// screenplay must never silently replace the user's complete original.
export function parseScriptDoctorResult(raw: string) {
  const text = raw.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\s*```$/, '').trim();
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    value = parsed as Record<string, unknown>;
  } catch { throw new Error('剧本医生返回格式不完整，原稿未改动。可在任务中查看原始返回后重试。'); }
  if (typeof value.optimizedScript !== 'string' || !value.optimizedScript.trim()) throw new Error('剧本医生没有返回优化稿，原稿未改动。');
  if (value.optimizedScript.length > SCRIPT_LIMIT) throw new Error(`优化稿超过 ${SCRIPT_LIMIT} 字，未截断或覆盖原稿。请调整后重试。`);
  const list = (key: string): string[] => {
    if (value[key] === undefined) return [];
    if (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(v => typeof v === 'string')) throw new Error(`剧本医生的 ${key} 字段格式错误，原稿未改动。`);
    return (value[key] as string[]).map(v => v.trim()).filter(Boolean);
  };
  return { optimizedScript: value.optimizedScript.trim(), summary: typeof value.summary === 'string' ? value.summary.trim() : '', changes: list('changes'), questions: list('questions'), assetNotes: list('assetNotes') };
}

export function scriptDoctorResult(project: FilmProject, job: FilmJob, raw: string): Partial<FilmProject> {
  const result = parseScriptDoctorResult(raw);
  const revisions = project.scriptDoctor?.revisions || [];
  if (revisions.some(r => r.id === job.id)) return {};
  // Even a stale result remains reviewable, but cannot be adopted over a new script.
  return { scriptDoctor: { ...project.scriptDoctor, revisions: [...revisions, { ...result, id: job.id, sourceScript: job.sourceScript, createdAt: job.startedAt }] } };
}

export function scriptDoctorApproved(p: FilmProject): boolean {
  const adopted = p.scriptDoctor?.adopted;
  return Boolean(p.script.trim() && adopted && adopted.script === p.script && p.scriptDoctor?.revisions.some(r => r.id === adopted.revisionId));
}
export function scriptDoctorIssue(p: FilmProject): string | undefined {
  if (!p.script.trim()) return '请先上传或填写剧本。';
  if (p.jobs.some(j => j.kind === 'doctor' && ['submitting', 'running', 'unknown'].includes(j.status))) return '剧本医生正在优化，请等待并确认采用优化稿后再进行分镜。';
  if (!scriptDoctorApproved(p)) return p.scriptDoctor?.adopted ? '剧本已修改，请重新进行剧本医生优化并确认采用，再生成分镜。' : '分镜前请先使用剧本医生优化剧本，查看并确认采用优化稿。';
}
export function canAdoptScriptRevision(p: FilmProject, revision: FilmScriptRevision): boolean {
  return p.script === revision.sourceScript || (scriptDoctorApproved(p) && p.scriptDoctor?.adopted?.revisionId === revision.id);
}
export function adoptScriptRevision(p: FilmProject, id: string, acknowledgedQuestions = false): Partial<FilmProject> {
  const revision = p.scriptDoctor?.revisions.find(r => r.id === id);
  if (!revision || !canAdoptScriptRevision(p, revision)) throw new Error('当前剧本已改变，不能用旧优化稿覆盖。请基于当前剧本重新优化。');
  if (p.jobs.some(j => ['write', 'doctor', 'extract', 'split', 'describe'].includes(j.kind) && ['submitting', 'running', 'unknown'].includes(j.status))) throw new Error('文字任务仍在处理中，请等待完成后采用优化稿。');
  if (revision.questions.length && !acknowledgedQuestions) throw new Error('请先处理优化稿中的待确认事项。');
  const script = (revision.editedScript ?? revision.optimizedScript).trim();
  if (!script || script.length > SCRIPT_LIMIT) throw new Error(`优化稿不能为空且不能超过 ${SCRIPT_LIMIT} 字。`);
  const unchanged = script === p.script;
  return { script,
    scriptHistory: unchanged ? p.scriptHistory : [...p.scriptHistory, { text: p.script, at: Date.now() }].slice(-20),
    scriptDoctor: { ...p.scriptDoctor!, adopted: { revisionId: id, script, at: Date.now(), assetsReviewed: unchanged ? (p.scriptDoctor?.adopted?.assetsReviewed ?? true) : p.assets.length === 0 } },
  };
}
