import {extractOriginalMediaUrl,getReferencePayloadValue,toRenderableMediaUrl} from './reference-media';

export type DownloadItem={id:string;name:string;url:string;kind:'image'|'video'|'audio'};
export type DownloadProgress={phase:'fetch'|'zip';done:number;total:number;bytes:number;percent:number};
export type DownloadFailure={item:DownloadItem;reason:string};
export const MAX_BATCH_FILES=500;
export const MAX_BATCH_BYTES=512*1024*1024;
type MediaNode={id:string;type?:string;data:Record<string,unknown>};
const kinds:Record<string,DownloadItem['kind']>={
 imageNode:'image',referenceImageNode:'image',layerEditorNode:'image',
 videoNode:'video',referenceVideoNode:'video',videoEditorNode:'video',
 audioNode:'audio',referenceAudioNode:'audio',
};
export function collectDownloadItems(nodes:MediaNode[]):DownloadItem[]{
 return nodes.flatMap(node=>{
  const kind=kinds[node.type||''];if(!kind)return [];
  const raw=node.type?.startsWith('reference')?getReferencePayloadValue(node.id,node.data):node.data.url;
  if(typeof raw!=='string'||!raw.trim())return [];
  const url=extractOriginalMediaUrl(raw.trim());
  if(!/^(https?:\/\/|\/(?!\/)|blob:|data:(?:image|video|audio)\/)/i.test(url))return [];
  return [{id:node.id,kind,url,name:String(node.data.customTitle||node.data.sourceName||node.id)}];
 });
}
const extensions:Record<string,string>={
 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif',
 'image/svg+xml':'svg','image/bmp':'bmp','image/tiff':'tif',
 'video/mp4':'mp4','video/webm':'webm','video/quicktime':'mov','video/x-matroska':'mkv',
 'audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav','audio/x-wav':'wav',
 'audio/ogg':'ogg','audio/flac':'flac','audio/x-flac':'flac','audio/aac':'aac','audio/mp4':'m4a',
};
export function downloadEntryName(item:DownloadItem,index:number,mime:string){
 const path=(()=>{try{return new URL(item.url,'http://local').pathname;}catch{return '';}})();
 const suffix=path.match(/\.(png|jpe?g|webp|gif|avif|svg|bmp|tiff?|mp4|webm|mov|mkv|mp3|wav|ogg|flac|aac|m4a)$/i)?.[1].toLowerCase();
 const ext=extensions[mime]||suffix||{image:'png',video:'mp4',audio:'mp3'}[item.kind];
 const base=item.name.replace(/\.(png|jpe?g|webp|gif|avif|svg|bmp|tiff?|mp4|webm|mov|mkv|mp3|wav|ogg|flac|aac|m4a)$/i,'')
  .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'-').replace(/^\.+|\.+$/g,'').trim().slice(0,90)||item.kind;
 return item.kind+'/'+String(index+1).padStart(3,'0')+'-'+base+'.'+ext;
}
export class BatchSizeError extends Error {
 constructor(){super('所选文件合计超过 512 MB，请减少选中素材后分批下载。');this.name='BatchSizeError';}
}
export async function buildDownloadZip(items:DownloadItem[],options:{
 signal:AbortSignal;onProgress:(p:DownloadProgress)=>void;maxBytes?:number;
}):Promise<{blob:Blob|null;failed:DownloadFailure[];succeeded:number}>{
 if(!items.length)throw new Error('没有可下载的素材');
 if(items.length>MAX_BATCH_FILES)throw new Error('每批最多下载 500 个素材，请缩小框选范围。');
 const {signal,onProgress}=options,maxBytes=options.maxBytes??MAX_BATCH_BYTES;
 signal.throwIfAborted();
 const master=new AbortController();
 const stop=()=>master.abort(signal.reason);
 signal.addEventListener('abort',stop,{once:true});
 const failed:DownloadFailure[]=[];
 const files:Array<{name:string;bytes:Uint8Array}|undefined>=new Array(items.length);
 let cursor=0,done=0,bytes=0,fatal:Error|undefined,lastProgress=0;
 const report=(force=false)=>{
  const now=Date.now();if(force||now-lastProgress>100){lastProgress=now;onProgress({phase:'fetch',done,total:items.length,bytes,percent:done/items.length*100});}
 };
 const worker=async()=>{
  while(cursor<items.length&&!master.signal.aborted){
   const index=cursor++,item=items[index];let ownedBytes=0;
   const controller=new AbortController(),abort=()=>controller.abort(master.signal.reason);
   master.signal.addEventListener('abort',abort,{once:true});
   const timer=setTimeout(()=>controller.abort(new Error('下载超时')),120000);
   try{
    const response=await fetch(toRenderableMediaUrl(item.url),{credentials:'include',signal:controller.signal});
    if(!response.ok){void response.body?.cancel();throw new Error('HTTP '+response.status);}
    const mime=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
    if(mime&&mime!=='application/octet-stream'&&!/^(image|video|audio)\//.test(mime)){
     void response.body?.cancel();throw new Error('服务器返回的不是媒体文件');
    }
    if(Number(response.headers.get('content-length'))>maxBytes-bytes){void response.body?.cancel();throw new BatchSizeError();}
    if(!response.body)throw new Error('下载内容为空');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];
    try{
     while(true){
      controller.signal.throwIfAborted();
      const chunk=await reader.read();if(chunk.done)break;
      if(bytes+chunk.value.byteLength>maxBytes)throw new BatchSizeError();
      ownedBytes+=chunk.value.byteLength;bytes+=chunk.value.byteLength;chunks.push(chunk.value);report();
     }
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(!ownedBytes)throw new Error('下载内容为空');
    const content=new Uint8Array(ownedBytes);let offset=0;
    for(const chunk of chunks){content.set(chunk,offset);offset+=chunk.byteLength;}
    files[index]={name:downloadEntryName(item,index,mime),bytes:content};
   }catch(error){
    bytes-=ownedBytes;
    if(error instanceof BatchSizeError){fatal=error;master.abort(error);}
    else if(!master.signal.aborted)failed.push({item,reason:controller.signal.aborted?'下载超时':error instanceof Error?error.message:'下载失败'});
   }finally{
    clearTimeout(timer);master.signal.removeEventListener('abort',abort);done++;report(true);
   }
  }
 };
 try{
  report(true);
  await Promise.all(Array.from({length:Math.min(3,items.length)},worker));
  signal.throwIfAborted();if(fatal)throw fatal;
  const succeeded=files.filter(Boolean).length;
  if(!succeeded)return {blob:null,failed,succeeded:0};
  const {default:JSZip}=await import('jszip');
  signal.throwIfAborted();
  const zip=new JSZip();
  for(let i=0;i<files.length;i++){const file=files[i];if(file){zip.file(file.name,file.bytes);files[i]=undefined;}}
  if(failed.length)zip.file('下载失败清单.txt',failed.map(f=>f.item.name+'：'+f.reason).join('\n'));
  // Media is already compressed. STORE preserves the original bytes and
  // avoids expensive recompression of large videos on the UI thread.
  const blob=await zip.generateAsync({type:'blob',compression:'STORE',streamFiles:true},meta=>{
   if(!signal.aborted)onProgress({phase:'zip',done,total:items.length,bytes,percent:meta.percent});
  });
  signal.throwIfAborted();
  return {blob,failed,succeeded};
 }finally{signal.removeEventListener('abort',stop);master.abort();}
}
export function saveDownloadBlob(blob:Blob,filename:string){
 const url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();
 setTimeout(()=>URL.revokeObjectURL(url),60000);
}
