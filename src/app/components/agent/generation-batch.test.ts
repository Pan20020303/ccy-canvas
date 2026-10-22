import {describe,it,expect,vi} from 'vitest';
import {GenerationBatch,type BatchGeneration} from './generation-batch';
const request=(n:number,model='doubao-seedream-5-0-260128'):BatchGeneration=>({
 id:String(n),nodeId:'node-'+n,serviceType:'image',prompt:'画面 '+n,model,
});
const flush=async()=>{for(let n=0;n<80;n++)await Promise.resolve();};
describe('agent generation batch',()=>{
 it('one approval covers 50 distinct images and later streamed nodes; submits at most 3 at a time',async()=>{
  let active=0,peak=0;
  const sent:BatchGeneration[]=[];
  const submit=vi.fn(async r=>{active++;peak=Math.max(peak,active);sent.push(r);await Promise.resolve();active--;});
  const batch=new GenerationBatch(submit,vi.fn());
  for(let n=0;n<20;n++)expect(batch.register(request(n),false)).toBe('pending');
  expect(submit).not.toHaveBeenCalled();
  expect(batch.approve('0',request(0).model)).toHaveLength(20);
  for(let n=20;n<50;n++)expect(batch.register(request(n),false)).toBe('confirmed');
  await flush();
  expect(sent).toEqual(Array.from({length:50},(_,n)=>request(n)));
  expect(peak).toBe(3);
 });
 it('does not transfer approval to another model, media type or user turn',async()=>{
  const submit=vi.fn(async(_request:BatchGeneration)=>{}),batch=new GenerationBatch(submit,vi.fn());
  batch.register(request(0),false);batch.approve('0',request(0).model);
  expect(batch.register(request(1,'gpt-image-2'),false)).toBe('pending');
  expect(batch.register({...request(2),serviceType:'video'},false)).toBe('pending');
  const next=new GenerationBatch(submit,vi.fn());
  expect(next.register(request(3),false)).toBe('pending');
  await flush();expect(submit).toHaveBeenCalledTimes(1);
 });
 it('applies the selected model to this batch, ignores duplicate clicks and repeated patches',async()=>{
  const submit=vi.fn(async(_request:BatchGeneration)=>{}),batch=new GenerationBatch(submit,vi.fn());
  batch.register(request(0),false);batch.register(request(1),false);
  batch.approve('0','chosen-model');
  expect(batch.approve('0','chosen-model')).toEqual([]);
  expect(batch.register({...request(0),id:'replayed'},true)).toBe('duplicate');
  batch.register(request(2),false);
  await flush();
  expect(submit.mock.calls.map(c=>(c[0] as BatchGeneration).model)).toEqual(['chosen-model','chosen-model','chosen-model']);
 });
 it('skips excluded requests and never automatically retries a failed submission',async()=>{
  const onError=vi.fn(),submit=vi.fn(async r=>{if(r.nodeId==='node-0')throw new Error('failed');});
  const batch=new GenerationBatch(submit,onError);
  for(let n=0;n<4;n++)batch.register(request(n),false);
  batch.skip('1');batch.approve('0',request(0).model);
  await flush();
  expect(submit).toHaveBeenCalledTimes(3);expect(onError).toHaveBeenCalledTimes(1);
 });
 it('stops not-yet-submitted requests without interrupting already accepted jobs',async()=>{
  let release!:()=>void;
  const submit=vi.fn(()=>new Promise<void>(r=>{release=r;}));
  const onError=vi.fn(),batch=new GenerationBatch(submit,onError,1);
  for(let n=0;n<5;n++)batch.register(request(n),true);
  await Promise.resolve();batch.stop();release();await flush();
  expect(submit).toHaveBeenCalledTimes(1);expect(onError).toHaveBeenCalledTimes(4);
  expect(batch.register(request(6),true)).toBe('duplicate');
 });
});
