import { useEffect, useState } from 'react';
import { CheckCircle2, Sparkles } from 'lucide-react';
import { FilmDialog } from './FilmControls';
import { SCRIPT_LIMIT, type FilmProject } from './film-project';
import { canAdoptScriptRevision, scriptDoctorApproved } from './film-script-doctor';
import './film-script-doctor.css';

export function FilmScriptDoctor({ project, busy, canGenerate, onGenerate, onEdit, onAdopt, onClose, onTasks, onSettings }: {
  project: FilmProject; busy: boolean; canGenerate: boolean;
  onGenerate: () => Promise<void>; onEdit: (id: string, text: string) => void;
  onAdopt: (id: string, acknowledged: boolean) => Promise<void>;
  onClose: () => void; onTasks: () => void; onSettings: () => void;
}) {
  const [selected, setSelected] = useState(''), [error, setError] = useState(''), [acknowledged, setAcknowledged] = useState(false), [saving, setSaving] = useState(false);
  const revisions = project.scriptDoctor?.revisions || [];
  const revision = revisions.find(r => r.id === selected) || revisions.at(-1);
  const draft = revision ? revision.editedScript ?? revision.optimizedScript : '';
  const questions = JSON.stringify(revision?.questions);
  useEffect(() => { setAcknowledged(false); }, [revision?.id, draft, questions]);
  const approved = scriptDoctorApproved(project);
  const latestJob = [...project.jobs].reverse().find(j => j.kind === 'doctor');
  const stale = revision && !canAdoptScriptRevision(project, revision);
  const perform = async (fn: () => Promise<void>) => { setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试。'); } };
  return <FilmDialog title="剧本医生 · 分镜前优化" className="film-doctor-dialog" onClose={onClose}>
    <div className="film-doctor-intro"><p>检查剧情因果、人物动机、节奏及情绪动作。优化稿单独保存；核对、编辑并确认采用后，才用于生成分镜。</p><button className="film-button" onClick={onSettings}>医生模型设置</button></div>
    <p className="film-muted film-small">不会自动改写当前剧本、替换素材或重新生成已有分镜。调用文字模型按所选渠道计费，关闭窗口不会中断后台任务。</p>
    <div className="film-doctor-actions"><button className="film-primary" disabled={busy || saving || !canGenerate || !project.script.trim()} onClick={() => void perform(async () => { setSelected(''); setAcknowledged(false); await onGenerate(); })}><Sparkles size={15} />{busy ? '正在处理文字任务…' : revisions.length ? '基于当前剧本重新优化' : '开始诊断并优化'}</button><button className="film-button" onClick={onTasks}>查看执行步骤</button>{approved && <span className="film-doctor-approved"><CheckCircle2 size={15} />当前剧本已确认采用</span>}</div>
    {latestJob?.status === 'error' && <p className="film-error" role="alert">本次优化未完成：{latestJob.error} 原稿及已有优化稿均已保留，可在执行步骤中查看原始返回或重试。</p>}
    {latestJob && ['submitting', 'running', 'unknown'].includes(latestJob.status) && <p className="film-muted" role="status">{latestJob.connectionLostAt ? '连接暂时中断，任务记录已保留，恢复后接入原任务。' : '正在后台诊断并优化剧本，完成后在此显示优化稿。'}</p>}
    {!!revisions.length && <label className="film-form-field">优化记录<select className="film-select" aria-label="优化记录" value={revision?.id || ''} onChange={e => { setSelected(e.target.value); setAcknowledged(false); setError(''); }}>{[...revisions].reverse().map((r, index) => <option key={r.id} value={r.id}>第 {revisions.length - index} 版 · {new Date(r.createdAt).toLocaleString()}</option>)}</select></label>}
    {stale && <p className="film-workflow-notice" role="status">当前剧本已修改，这份优化稿仅供对照，不能覆盖新内容。请基于当前剧本重新优化。</p>}
    <div className="film-doctor-columns"><label className="film-form-field">{revision ? '本次优化的原稿（只读保留）' : '当前原稿（只读）'}<textarea aria-label="剧本医生原稿" value={revision?.sourceScript ?? project.script} readOnly /></label><label className="film-form-field">优化稿（可继续编辑）<textarea aria-label="剧本医生优化稿" placeholder="点击开始诊断并优化，完成后在此核对优化稿。" value={draft} disabled={!revision || busy || saving || stale} maxLength={SCRIPT_LIMIT} onChange={e => { if (revision) { onEdit(revision.id, e.target.value); setAcknowledged(false); } }} /><small className="film-muted">{draft.length.toLocaleString()} / {SCRIPT_LIMIT.toLocaleString()} 字 · 修改随项目保存</small></label></div>
    {revision && <div className="film-doctor-report"><h3>诊断与修改说明</h3><p>{revision.summary || '请对照原稿核查修改。'}</p>{([{ key: 'changes', title: '已优化的内容' }, { key: 'questions', title: '待确认事项' }, { key: 'assetNotes', title: '资产与连续性核对' }] as const).map(({ key, title }) => revision[key].length > 0 && <section key={key}><strong>{title}</strong><ul>{revision[key].map((item, i) => <li key={i}>{item}</li>)}</ul></section>)}</div>}
    {revision && <p className="film-muted film-small">采用时保留原稿及现有资产、分镜。若剧本发生变化且已有资产，需重新核对资产覆盖情况；已有分镜不会自动更新。</p>}
    {!!revision?.questions.length && <label className="film-checkbox"><input type="checkbox" checked={acknowledged} disabled={busy || saving || stale} onChange={e => setAcknowledged(e.target.checked)} />我已处理待确认事项，并在优化稿中确定本次采用的内容</label>}
    {error && <p role="alert" className="film-error">{error}</p>}
    <footer className="film-dialog-footer"><button className="film-button" onClick={onClose}>暂不采用，保留草稿</button><button className="film-primary" disabled={!revision || !draft.trim() || busy || saving || stale || (!!revision.questions.length && !acknowledged)} onClick={() => void perform(async () => { if (!revision) return; setSaving(true); try { await onAdopt(revision.id, acknowledged); } finally { setSaving(false); } })}>{saving ? '正在保存…' : '确认采用优化稿'}</button></footer>
  </FilmDialog>;
}
