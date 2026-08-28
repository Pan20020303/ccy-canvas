import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/styles/index.css';
import {PendingRunCard} from '../../src/app/components/AgentRunPanel';
import {GenerationBatch} from '../../src/app/components/agent/generation-batch';
function Test(){
 const model='doubao-seedream-5-0-260128';
 const [count,setCount]=useState(0);
 const [status,setStatus]=useState<'pending'|'confirmed'|'skipped'>('pending');
 const [later,setLater]=useState('');
 const [batch]=useState(()=>{
  const b=new GenerationBatch(async()=>{setCount(n=>n+1);},()=>{});
  for(let n=0;n<50;n++)b.register({id:String(n),nodeId:'node-'+n,serviceType:'image',prompt:'测试画面 '+n,model},false);
  return b;
 });
 return <main className="mx-auto max-w-xl p-8"><h1>50 张图片批量授权测试</h1>
  <p className="my-4">模拟提交数：{count}。本页不调用模型，不扣费。</p>
  <PendingRunCard zh modelDisplayName={m=>m}
   step={{kind:'pending_run',id:'0',nodeId:'node-0',nodeType:'imageNode',serviceType:'image',prompt:'本轮生成 50 个不同画面。',availableModels:[model],chosenModel:model,status}}
   onConfirm={()=>{batch.approve('0',model);setStatus('confirmed');}} onSkip={()=>{batch.skip('0');setStatus('skipped');}} onPickModel={()=>{}}/>
  <button className="mt-5 rounded border p-3" onClick={()=>setLater(batch.register({id:'50',nodeId:'node-50',serviceType:'image',prompt:'同轮后续画面',model},false))}>新增同批节点</button><p>后续节点状态：{later}</p>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Test/>);
