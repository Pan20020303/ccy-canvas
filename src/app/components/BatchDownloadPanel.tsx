import {useEffect,useRef,useState} from 'react';
import {Download,X} from 'lucide-react';
import {buildDownloadZip,saveDownloadBlob,type DownloadItem,type DownloadProgress,type DownloadFailure} from '../batch-download';

export default function BatchDownloadPanel({items,zh,onClose}:{items:DownloadItem[];zh:boolean;onClose:()=>void}){
 const [progress,setProgress]=useState<DownloadProgress>({phase:'fetch',done:0,total:items.length,bytes:0,percent:0});
 const [phase,setPhase]=useState<'running'|'done'|'error'|'cancelled'>('running');
 const [error,setError]=useState(''),[failed,setFailed]=useState<DownloadFailure[]>([]),[count,setCount]=useState(0);
 const [attempt,setAttempt]=useState(0);
 const pending=useRef(items),controller=useRef<AbortController|null>(null);
 const result=useRef<{blob:Blob;filename:string}|null>(null);
 useEffect(()=>{
  let active=true;const abort=new AbortController();controller.current=abort;
  result.current=null;setPhase('running');setError('');setFailed([]);
  void buildDownloadZip(pending.current,{signal:abort.signal,onProgress:p=>{if(active)setProgress(p);}}).then(r=>{
   if(!active)return;
   setFailed(r.failed);setCount(r.succeeded);setPhase(r.succeeded?'done':'error');
   if(r.blob){
    const filename='CCY-Canvas-'+new Date().toISOString().replace(/[:.]/g,'-')+'.zip';
    result.current={blob:r.blob,filename};saveDownloadBlob(r.blob,filename);
   }else setError(zh?'所有素材下载失败，可重试。':'All downloads failed. Please retry.');
  }).catch(e=>{
   if(!active)return;
   if(abort.signal.aborted)setPhase('cancelled');
   else {setError(e instanceof Error?e.message:String(e));setPhase('error');}
  });
  return()=>{active=false;abort.abort();result.current=null;};
 },[attempt]);
 const running=phase==='running';
 return <section role="region" aria-label={zh?'批量下载任务':'Batch download'} className="nodrag nopan nowheel absolute bottom-20 right-5 z-50 w-80 max-w-[calc(100%_-_40px)] rounded-2xl border border-white/15 bg-[#171a20] p-4 text-xs text-neutral-200 shadow-2xl"
  onKeyDown={e=>e.stopPropagation()} onPointerDown={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()}>
  <div className="flex items-center justify-between"><strong className="flex items-center gap-2"><Download size={15}/>{zh?'批量下载 ZIP':'Download ZIP'}</strong>
   <button aria-label={zh?'关闭下载面板':'Close downloads'} onClick={()=>{controller.current?.abort();onClose();}}><X size={16}/></button></div>
  <p className="my-3" role="status" aria-live="polite">{running
   ?(progress.phase==='fetch'?(zh?'正在读取原始素材':'Downloading originals')+' '+progress.done+'/'+progress.total:(zh?'正在打包':'Packing')+' '+Math.round(progress.percent)+'%')
   :phase==='cancelled'?(zh?'已取消下载':'Download cancelled')
   :phase==='done'?(zh?'ZIP 已准备，成功 ':'ZIP ready: ')+count+(zh?' 项':' files'):error}</p>
  {running&&<><progress aria-label={zh?'批量下载进度':'Download progress'} max={100} value={progress.percent} className="w-full accent-orange-400"/>
   <p className="mt-2 text-neutral-400">{(progress.bytes/1024/1024).toFixed(1)} MB · {zh?'每批最多 500 项 / 512 MB':'Up to 500 files / 512 MB'}</p></>}
  {failed.length>0&&<details className="my-3 max-h-32 overflow-auto"><summary>{zh?'失败':'Failed'} {failed.length} {zh?(phase==='done'?'项（已放入 ZIP 清单）':'项'):'files'}</summary>
   <ul>{failed.map((f,i)=><li key={i} className="mt-1 break-words">{f.item.name}：{f.reason}</li>)}</ul></details>}
  <div className="mt-3 flex gap-3">
   {running?<button onClick={()=>controller.current?.abort()} className="rounded-lg border border-white/20 px-3 py-2">{zh?'取消':'Cancel'}</button>:
    <>{result.current&&<button className="rounded-lg bg-orange-500 px-3 py-2 text-white" onClick={()=>{const r=result.current;if(r)saveDownloadBlob(r.blob,r.filename);}}>{zh?'再次保存 ZIP':'Save ZIP again'}</button>}
     {(failed.length>0||phase==='cancelled')&&<button className="rounded-lg border border-white/20 px-3 py-2" onClick={()=>{pending.current=failed.length?failed.map(f=>f.item):items;setAttempt(n=>n+1);}}>{failed.length?(zh?'仅重试失败项':'Retry failed'):(zh?'重新下载':'Retry')}</button>}</>}
  </div>
  {!running&&phase==='done'&&<p className="mt-3 text-neutral-400">{zh?'未弹出下载时，可点击“再次保存 ZIP”。':'If no download appeared, click Save ZIP again.'}</p>}
 </section>;
}
