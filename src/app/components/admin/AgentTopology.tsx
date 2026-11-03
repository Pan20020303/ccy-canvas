import { Bot, Workflow } from 'lucide-react';
import { Link } from 'react-router';
import type { Agent, Skill, AgentUseMode } from '../../api/skills';
import './agent-runtime.css';

export function effectiveAgentModel(agent: Agent, agents: Agent[], mode: AgentUseMode) {
 const parent = agent.parent_deploy_key ? agents.find(a=>a.deploy_key===agent.parent_deploy_key) : undefined;
 const source = parent && mode===0 && (parent.model_name || parent.model) ? parent : agent;
 const raw = source.model_name || source.model || parent?.model_name || parent?.model || '';
 return raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw || '未配置模型';
}
export function AgentTopology({agents,skills,mode,onEdit}: {agents: Agent[];skills:Skill[];mode:AgentUseMode;onEdit:(agent:Agent)=>void}) {
 const roots = agents.filter(a=>!a.parent_deploy_key);
 const orphans = agents.filter(a=>a.parent_deploy_key&&!agents.some(p=>p.deploy_key===a.parent_deploy_key));
 const boundNames = (a:Agent) => skills.filter(s=>a.skill_ids.includes(s.id)&&s.enabled).map(s=>s.name).join('、');
 return <section className="agent-topology"><div className="agent-topology-head"><div><h3>实际 Agent 与调度关系</h3><p>来自已保存的 Agent 配置。子 Agent 按任务需要调用，不会每轮全部启动。</p></div><Link to="/admin/agent-runs" className="runtime-link">查看真实调度</Link></div>
 <div className="agent-topology-grid">{roots.map(agent=><article className="agent-topology-card" key={agent.id}><header><Bot size={23}/><div><h4>{agent.name}</h4><small>{agent.enabled?'已启用':'已停用'} · {agent.deploy_key || '独立 Agent'}</small></div><button onClick={()=>onEdit(agent)}>配置</button></header><p>{agent.description || '暂无职责说明'}</p><dl className="runtime-properties"><dt>生效模型</dt><dd>{effectiveAgentModel(agent,agents,mode)}</dd><dt>画布工具</dt><dd>{agent.canvas_tools?'允许主 Agent 操作':'关闭'}</dd><dt>可用技能</dt><dd>{boundNames(agent)||'未绑定（仍可显式选择可见技能）'}</dd></dl>
 {agents.filter(a=>a.parent_deploy_key===agent.deploy_key&&Boolean(agent.deploy_key)).map(child=><button key={child.id} className="agent-topology-child" onClick={()=>onEdit(child)}><Workflow size={14}/><span>{child.name}<small>{effectiveAgentModel(child,agents,mode)}</small></span><span>{child.enabled?'隔离顾问':'已停用'}</span></button>)}
 </article>)}</div>{!roots.length&&<p className="runtime-muted">暂无主 Agent，请先创建并配置真实模型与技能。</p>}{orphans.length>0&&<p className="runtime-error">{orphans.length} 个子 Agent 的父级不存在，无法被调度。请在下方详细配置中修正。</p>}<p className="runtime-muted">运行时读取最新配置并保存快照；已开始的任务不随编辑变更。子任务最多 4 次，每次最长 2 分钟、6 轮工具循环，仅可读取方法论技能。主任务最多 12 轮、10 分钟；媒体生成仍需在画布确认。</p></section>;
}
