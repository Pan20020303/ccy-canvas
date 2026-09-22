import { useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleX, Download, LoaderCircle, X } from 'lucide-react';
import { activeFilmJob } from './film-store';
import type { FilmJob, FilmJobPhase } from './film-project';
import { creativeContextTitles } from './film-skill-context';

const names: Record<FilmJob['kind'], string> = { write: 'AI编写剧本', doctor: '剧本医生优化', extract: '提取场景角色道具', split: '生成分镜脚本', describe: '完善资产描述', asset: '生成资产图片', image: '生成分镜图', video: '生成分镜视频' };
const phases: Record<FilmJobPhase, string> = { preparing: '准备并保存请求', submitted: '提交后台任务', queued: '后台排队', generating: '模型正在处理', received: '收到模型结果', parsing: '解析与校验内容', applied: '结果写入项目', error: '任务需要处理' };
function downloadResult(job: FilmJob) {
  const url = URL.createObjectURL(new Blob([job.rawResult || ''], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `${names[job.kind]}-${job.id}.txt`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function JobCard({ job, preparing, onRetry, onRecover }: { job: FilmJob; preparing: boolean; onRetry: (job: FilmJob) => Promise<void>; onRecover: (job: FilmJob) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const active = activeFilmJob(job), partial = job.status === 'partial';
  const contextTitles = creativeContextTitles(job.payload.prompt);
  const recoverable = job.status === 'error' && (job.kind === 'split' || job.kind === 'extract' || job.kind === 'doctor');
  const action = async (fn: (job: FilmJob) => Promise<void>) => { setBusy(true); try { await fn(job); } finally { setBusy(false); } };
  return <article className="film-job">
    {active ? <LoaderCircle size={16} className="film-spin" aria-label="任务处理中" /> : job.status === 'error' ? <CircleX size={16} className="film-job-error-icon" aria-label="生成失败" /> : partial ? <AlertTriangle size={16} className="film-job-warning" aria-label="部分恢复" /> : <CheckCircle2 size={16} aria-label="生成成功" />}
    <div><strong>{names[job.kind]}</strong><small className="film-muted film-job-model">{job.payload.model}</small>
      <p className={job.status === 'error' ? 'film-error' : partial ? 'film-job-warning' : 'film-muted'}>{job.warning || job.error || (job.phase ? phases[job.phase] : active ? '正在接入后台任务…' : '已完成')}</p>
      {!!contextTitles.length && <details className="film-job-details"><summary>已使用 {contextTitles.length} 个技能章节</summary><ul>{contextTitles.map(title => <li key={title}>{title}</li>)}</ul></details>}
      {job.kind === 'doctor' && job.status === 'success' && <p className="film-muted">优化稿已单独保存，请打开“剧本医生”查看并确认采用；生成成功不代表已替换原稿。</p>}
      {job.connectionLostAt && active && <p className="film-job-warning" role="status">连接中断，已保留任务记录。后台任务不受影响，恢复连接后自动接入；不会重复提交。</p>}
      {job.phase === 'generating' && active && <p className="film-muted">正在{job.kind === 'extract' ? '分析剧本中的场景、角色和道具' : job.kind === 'split' ? '编排分镜与提示词' : '生成内容'}。模型未提供精确百分比，请等待返回。</p>}
      {job.lastSyncedAt && <small className="film-muted">上次同步 {new Date(job.lastSyncedAt).toLocaleTimeString('zh-CN', { hour12: false })}</small>}
      {!!job.steps?.length && <details className="film-job-details" open={active || partial || undefined}><summary>执行步骤</summary><ol className="film-job-steps">{job.steps.map((step, index) => <li key={`${step.at}-${index}`} className={index === job.steps!.length - 1 ? 'is-current' : ''}><span>{phases[step.phase]}</span><time>{new Date(step.at).toLocaleTimeString('zh-CN', { hour12: false })}</time></li>)}</ol></details>}
      {job.resultCount !== undefined && <p className="film-job-result">已写入 {job.resultCount} 个{job.kind === 'split' ? '分镜' : '资产'}{partial ? '（部分结果）' : ''}</p>}
      <div className="film-job-actions">
        {recoverable && <button className="film-button" disabled={busy || preparing} onClick={() => void action(onRecover)} title="只读取后台已保存的内容，不调用模型，不重复扣费">{busy ? '正在处理…' : '恢复已有结果'}</button>}
        {(job.status === 'error' || job.status === 'unknown') && <button className="film-button" disabled={busy || preparing} onClick={() => void action(onRetry)} title={job.status === 'unknown' ? '查询原任务；必要时用相同请求号确认提交' : '重新调用模型，会按当前模型计费'}>{job.status === 'unknown' ? '重新接入' : '重试'}</button>}
        {job.rawResult && <button className="film-plain" onClick={() => downloadResult(job)}><Download size={12} />原始返回</button>}
      </div>
      {recoverable && <small className="film-muted">恢复不扣费；“重试”会重新调用模型。</small>}
    </div>
  </article>;
}
export function FilmTaskPanel({ jobs, preparing, syncStatus, onClose, onRetry, onRecover }: { jobs: FilmJob[]; preparing: boolean; syncStatus?: string; onClose: () => void; onRetry: (job: FilmJob) => Promise<void>; onRecover: (job: FilmJob) => Promise<void> }) {
  return <aside className="film-jobs-panel" aria-label="生成任务与执行步骤"><div className="film-jobs-heading"><div className="film-jobs-title"><strong>生成任务</strong><button className="film-icon" aria-label="收起任务面板" onClick={onClose}><X size={17} /></button></div><span className="film-muted film-small">后台异步执行，离开或断线后可重新接入。</span><span className="film-muted film-small">{syncStatus === 'saved' ? '任务与项目已保存到数据库' : syncStatus === 'error' || syncStatus === 'conflict' ? '项目待同步，请处理页面上方的保存提示' : syncStatus ? '任务记录正在同步到数据库…' : '任务记录随项目缓存'}</span></div>
    <div className="film-jobs-scroll">{preparing && <p role="status" className="film-task-preparing"><LoaderCircle size={15} className="film-spin" />正在检查模型、技能和剧本…</p>}{!jobs.length && !preparing && <p className="film-muted">暂无生成任务</p>}{[...jobs].reverse().map(job => <JobCard key={job.id} job={job} preparing={preparing} onRetry={onRetry} onRecover={onRecover} />)}</div>
  </aside>;
}
