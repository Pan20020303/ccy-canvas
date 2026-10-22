// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { agentRunStatusLabel, describeAgentEvent, isActiveAgentRun } from './AdminAgentRunsPage';
import { effectiveAgentModel } from './AgentTopology';
import type { Agent, AgentRun } from '../../api/skills';

describe('real Agent runtime presentation', () => {
 it('does not count unfinished legacy records as current scheduling', () => {
  const legacy = { status:'pending', durable:false } as AgentRun;
  expect(isActiveAgentRun(legacy)).toBe(false);
  expect(agentRunStatusLabel(legacy)).toBe('历史未闭合');
  expect(isActiveAgentRun({...legacy, durable:true, status:'queued'})).toBe(true);
  expect(agentRunStatusLabel({...legacy, status:'success'})).toBe('已完成');
 });
 it('shows observed tool outcomes without dumping arguments', () => {
  expect(describeAgentEvent({id:1,type:'tool_result',created_at:'',data:{name:'save_memory',ok:false,result:'private'}})).toBe('save_memory · 失败');
  expect(describeAgentEvent({id:2,type:'canvas_patch',created_at:'',data:{op:'move_nodes',moved_nodes:8}})).toBe('自动布局建议 · 8 个节点');
 });
 it('resolves configured inheritance, independent models and empty fallback', () => {
  const parent={id:'parent',deploy_key:'root',model:'display',model_name:'provider:parent-model'} as Agent;
  const child={id:'child',parent_deploy_key:'root',model:'child-model'} as Agent;
  expect(effectiveAgentModel(child,[parent,child],0)).toBe('parent-model');
  expect(effectiveAgentModel(child,[parent,child],1)).toBe('child-model');
  expect(effectiveAgentModel({...child,model:''},[parent,child],1)).toBe('parent-model');
  const standalone={id:'solo',model:'solo-model'} as Agent;
  expect(effectiveAgentModel(parent,[standalone,parent,child],0)).toBe('parent-model');
 });
});
