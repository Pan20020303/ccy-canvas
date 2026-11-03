// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelAgentJob, getActiveAgentJob } from './agent-run';

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
describe('cancel durable Agent job', () => {
 const job={agentId:'agent-a',jobId:'run-a',conversationId:'chat-a',after:5,message:'hello'};
 it('sends a server cancellation before clearing the resumable observer', async () => {
  localStorage.setItem('ccy:agent-job:agent-a',JSON.stringify(job));
  const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:{ok:true}}),{status:200}));
  vi.stubGlobal('fetch',fetchMock);
  await cancelAgentJob(job);
  expect(fetchMock.mock.calls[0][0]).toContain('/api/app/agent-jobs/run-a/cancel');
  expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  expect(getActiveAgentJob('agent-a')).toBeNull();
 });
 it('keeps the saved observer when cancellation is rejected', async () => {
  localStorage.setItem('ccy:agent-job:agent-a',JSON.stringify(job));
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{}',{status:503})));
  await expect(cancelAgentJob(job)).rejects.toThrow();
  expect(getActiveAgentJob('agent-a')?.jobId).toBe('run-a');
 });
});
