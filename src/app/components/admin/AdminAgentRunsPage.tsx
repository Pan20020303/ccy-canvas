import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Bot, RefreshCw, Search, Workflow, X } from 'lucide-react';
import { Link } from 'react-router';
import { adminListAgentRuns, adminAgentRunEvents, type AgentRun, type AgentAuditEvent } from '../../api/skills';
import { AdminShell } from './AdminShell';
import './agent-runtime.css';
import { safeFailureMessage } from '../../api/failure-message';

export const runStatus: Record<AgentRun['status'], string> = { pending: '待执行', queued: '排队中', running: '运行中', waiting: '等待中', success: '已完成', error: '失败', cancelled: '已取消' };
const activeStatuses = new Set(['pending','queued','running','waiting']);
export const isActiveAgentRun = (run: AgentRun) => run.durable !== false && activeStatuses.has(run.status);
export const agentRunStatusLabel = (run: AgentRun) => run.durable === false && activeStatuses.has(run.status) ? '历史未闭合' : runStatus[run.status] || run.status;
const eventLabels: Record<string,string> = { lifecycle:'调度状态', runtime:'生效配置', context_policy:'上下文策略', delegation:'子 Agent', delegation_event:'子任务事件', tool_call:'调用工具', tool_result:'工具返回', canvas_patch:'画布操作建议', usage:'本轮用量', usage_total:'主任务累计用量', done:'任务结束', error:'执行失败', ask_user:'请求用户补充', conversation:'关联会话' };
const text = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
export function describeAgentEvent(event: AgentAuditEvent) {
 const d = event.data;
 if (event.type === 'runtime') return text(d.agent_name) + ' · ' + text(d.model);
 if (event.type === 'delegation') return text(d.agent_name) + ' · ' + (runStatus[text(d.status) as AgentRun['status']] || text(d.status));
 if (event.type === 'delegation_event') { const nested = d.data as Record<string,unknown> | undefined; return (eventLabels[text(d.event)] || text(d.event)) + ' · ' + (safeFailureMessage(nested?.message) || text(nested?.name) || text(nested?.agent_name) || text(d.id).slice(0,8)); }
 if (event.type === 'tool_result') return text(d.name) + ' · ' + (d.ok ? '成功' : safeFailureMessage(d.message) || '失败');
 if (event.type === 'error') return safeFailureMessage(d.message) || '此事件未记录可展示的错误详情，请查看任务结果。';
 if (event.type === 'tool_call') return text(d.name);
 if (event.type === 'lifecycle') return runStatus[text(d.status) as AgentRun['status']] || text(d.status);
 if (event.type === 'usage' || event.type === 'usage_total') return (text(d.total_tokens) || '0') + ' tokens';
 if (event.type === 'canvas_patch') return d.op === 'move_nodes' ? '自动布局建议 · ' + text(d.moved_nodes) + ' 个节点' : text(d.op) + ' · ' + text(d.node_id);
 if (event.type === 'context_policy') return '最近 ' + text(d.history_turn_limit) + ' 轮 · 关键词检索 · 用户 / Agent / 项目隔离';
 return '';
}

function RunDetail({run}: {run: AgentRun}) {
 const [events, setEvents] = useState<AgentAuditEvent[]>([]);
 const [error, setError] = useState(''); const [more, setMore] = useState(false);
 const cursor = useRef(0); const busy = useRef(false); const alive = useRef(true);
 const load = useCallback(async () => {
  if (busy.current) return; busy.current = true;
  try { const page = await adminAgentRunEvents(run.id, cursor.current); if (!alive.current) return;
   cursor.current = page.cursor; setMore(page.has_more); setError('');
   setEvents(previous => [...new Map([...previous, ...page.events].map(e => [e.id,e])).values()]);
  } catch { if (alive.current) setError('运行事件加载失败，请重试。'); } finally { busy.current = false; }
 }, [run.id]);
 useEffect(() => { alive.current = true; void load(); const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 3000); return () => { alive.current = false; window.clearInterval(timer); }; }, [load]);
 const config = events.find(e => e.type === 'runtime')?.data;
 const children = [...new Map(events.filter(e => e.type === 'delegation').map(e => [text(e.data.id),e])).values()];
 return <div className="agent-run-detail">
  <div className="agent-runtime-kicker">RUN / {run.id.slice(0,8)}</div><h3>{run.agent_name || 'Agent'} <span className={'run-status is-' + run.status}>{agentRunStatusLabel(run)}</span></h3>
  <p className="agent-run-request">{run.user_input}</p>
  <section><h4>本次生效配置</h4>{config ? <><dl className="runtime-properties"><dt>实际模型</dt><dd>{text(config.model)}</dd><dt>配置模型</dt><dd>{text(config.configured_model)}</dd><dt>温度 / 输出上限</dt><dd>{text(config.temperature)} / {Number(config.max_output_tokens) > 0 ? text(config.max_output_tokens) : '模型默认'}</dd><dt>配置版本</dt><dd>{text(config.config_updated_at)}</dd><dt>执行策略</dt><dd>{text(config.policy)} · {text(config.strategy)}</dd></dl><details><summary>可用工具（{Array.isArray(config.tools) ? config.tools.length : 0}）</summary><div className="runtime-tools">{Array.isArray(config.tools) && config.tools.map(name => <span key={text(name)}>{text(name)}</span>)}</div></details><p className="runtime-muted">已加载技能：{Array.isArray(config.skills) ? config.skills.map(s => text((s as Record<string,unknown>).name)).join('、') || '无绑定技能' : '无'}</p></> : <p className="runtime-muted">{isActiveAgentRun(run) ? '任务尚未进入模型执行，等待配置快照。' : '此历史任务未记录配置快照，不使用当前配置冒充历史配置。'}</p>}</section>
  <section><h4>主 / 子任务 <span>{children.length} 个子任务</span></h4><div className="runtime-child"><Bot size={15}/><strong>{run.agent_name}</strong><small>主 Agent</small></div>{children.map(child => <div className="runtime-child is-child" key={text(child.data.id)}><Workflow size={14}/><span><strong>{text(child.data.agent_name)}</strong><small>{text(child.data.model)}</small></span><span className={'run-status is-' + text(child.data.status)}>{runStatus[text(child.data.status) as AgentRun['status']] || text(child.data.status)}</span></div>)}{!children.length && <p className="runtime-muted">本次没有已记录的子 Agent 调度。</p>}</section>
  <section><h4>执行时间线 <span>每 3 秒同步 · {events.length} 条</span></h4>{error && <p role="alert">{error} <button onClick={() => void load()}>重试</button></p>}<ol className="runtime-timeline">{events.map(event => <li key={event.id}><i/><div><strong>{eventLabels[event.type] || event.type}</strong><time>{new Date(event.created_at).toLocaleTimeString('zh-CN')}</time><p>{describeAgentEvent(event)}</p></div></li>)}</ol>{!events.length && !error && <p className="runtime-muted">暂无可回放事件。</p>}{more && <button onClick={() => void load()}>加载后续事件</button>}</section>
  {run.error_msg && <p className="runtime-error" role="alert">{run.error_msg}</p>}
  {run.final_reply && <details><summary>最终回复</summary><p className="agent-run-request">{run.final_reply}</p></details>}
  <p className="runtime-muted">时间线隐藏工具参数、结果正文和密钥；“画布操作建议”不代表媒体已经生成。子任务用量单独计入子任务事件。</p>
 </div>;
}

export function AdminAgentRunsPage() {
 const [runs,setRuns] = useState<AgentRun[]>([]); const [loading,setLoading] = useState(true); const [error,setError] = useState('');
 const [selected,setSelected] = useState<string|null>(null); const [query,setQuery] = useState(''); const [filter,setFilter] = useState('all');
 useEffect(() => { let active = true; let busy = false; const load = async () => { if (busy) return; busy = true; try { const rows = await adminListAgentRuns(200); if (active) {setRuns(rows);setError('');} } catch {if(active)setError('调度记录加载失败，当前显示的是上次同步结果。');} finally {busy=false;if(active)setLoading(false);} }; void load(); const timer=window.setInterval(()=>{if(!document.hidden)void load();},3000);return()=>{active=false;window.clearInterval(timer);}; },[]);
 const refresh = async () => {setLoading(true);try{setRuns(await adminListAgentRuns(200));setError('');}catch{setError('刷新失败，请稍后重试。');}finally{setLoading(false);}};
 const visible = runs.filter(r => (filter === 'all' || filter === 'active' && isActiveAgentRun(r) || r.status === filter) && (r.agent_name+' '+r.user_name+' '+r.user_input+' '+r.id).toLowerCase().includes(query.toLowerCase()));
 const run = runs.find(r => r.id === selected);
 return <AdminShell title="Agent 调度台" description="从真实任务与持久化事件查看执行过程。主任务串行、子任务隔离，不展示模拟调度。" action={<Link to="/admin/agents" className="runtime-link">配置 Agent <ArrowUpRight size={14}/></Link>}>
  <div className="agent-runtime-summary">{[['最近任务',runs.length],['排队 / 执行中',runs.filter(r=>isActiveAgentRun(r)).length],['已完成',runs.filter(r=>r.status==='success').length],['失败',runs.filter(r=>r.status==='error').length]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}<p><Activity size={14}/>最近 200 条 · 每 3 秒同步</p></div>
  {error && <p className="runtime-error" role="alert">{error}</p>}
  <div className={'agent-runtime-workspace ' + (run ? 'has-detail':'')}>
   <section className="agent-runtime-list"><div className="runtime-toolbar"><div>{[['all','全部'],['active','进行中'],['error','失败']].map(([value,label])=><button key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div><label><Search size={14}/><input aria-label="搜索调度任务" placeholder="搜索任务 / Agent…" value={query} onChange={e=>setQuery(e.target.value)}/></label><button onClick={()=>void refresh()} disabled={loading} aria-label="刷新智能体记录"><RefreshCw size={15} className={loading?'animate-spin':''}/></button></div>
    <div className="runtime-table-scroll"><table><thead><tr><th>任务 / 用户</th><th>Agent</th><th>状态</th><th>工具 / 步数</th><th>时间</th></tr></thead><tbody>{visible.map(r=><tr key={r.id} className={r.id===selected?'is-selected':''}><td><button onClick={()=>setSelected(r.id)} className="runtime-task-link">{r.user_input || '未命名任务'}</button><small>{r.user_name || r.user_id.slice(0,8)} · {r.id.slice(0,8)}</small></td><td>{r.agent_name || '已移除 Agent'}</td><td><span className={'run-status is-' + r.status}>{agentRunStatusLabel(r)}</span></td><td>{isActiveAgentRun(r)?'见时间线':r.tool_calls+' / '+r.steps}</td><td>{new Date(r.created_at).toLocaleString('zh-CN')}</td></tr>)}</tbody></table>{!visible.length && <div className="runtime-empty"><Workflow size={30}/><h3>{loading?'正在读取调度记录…':'暂无匹配的任务'}</h3><p>画布中的真实 Agent 任务会显示在这里。</p></div>}</div>
   </section>
   {run && <aside className="agent-runtime-inspector"><button className="runtime-close" aria-label="关闭任务详情" onClick={()=>setSelected(null)}><X size={17}/></button><RunDetail key={run.id} run={run}/></aside>}
  </div>
 </AdminShell>;
}
