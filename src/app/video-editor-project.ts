export type EditorAsset = {
 id: string; name: string; url: string; kind: 'video' | 'image' | 'audio';
 duration: number; width?: number; height?: number;
};
export type EditorClip = {
 id: string; assetId: string; start: number; end: number; speed: number; volume: number; at?: number;
 track?:number; scale?:number; x?:number; y?:number;
};
export type EditorAudio = EditorClip & { at: number; sourceClipId?: string };
export type VideoEditProject = {
 version: 1; name: string; assets: EditorAsset[]; clips: EditorClip[]; audio: EditorAudio[];
 videoTracks?:number;
 ratio: '16:9' | '9:16' | '1:1'; resolution: '720p' | '1080p'; fps: 24 | 30;
};
export const emptyVideoProject = (): VideoEditProject => ({
 version:1, name:'未命名剪辑',assets:[],clips:[],audio:[],ratio:'16:9',resolution:'1080p',fps:30,
});
// randomUUID is only exposed in secure contexts; LAN HTTP still has getRandomValues.
// These IDs identify editable assets/clips, never authentication credentials.
let fallbackIdSequence = 0;
export function editorId(): string {
 const cryptoApi = globalThis.crypto;
 if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
 if (typeof cryptoApi?.getRandomValues === 'function') {
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
 }
 return `editor-${Date.now().toString(36)}-${(++fallbackIdSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
}
export const clipDuration = (c: EditorClip) => (c.end-c.start)/c.speed;
export const editorTrackCount=(p:VideoEditProject)=>Math.min(8,Math.max(p.videoTracks??3,1,...p.clips.map(c=>(c.track??0)+1)));
export const visualTransform=(c:EditorClip)=>({track:c.track??0,scale:c.scale??1,x:c.x??.5,y:c.y??.5});
export function activeEditorLayers(p:VideoEditProject,position:number){
 return timelineClips(p).filter(c=>position>=c.at&&position<c.at+clipDuration(c)).sort((a,b)=>(a.track??0)-(b.track??0));
}
// Missing positions belong to legacy gapless projects. Resolve them without
// changing the original project; once edited, all positions are explicit.
export function timelineClips(p:VideoEditProject):Array<EditorClip & {at:number}> {
 let end=0;
 return p.clips.map(c=>{const at=c.at??end;end=at+clipDuration(c);return {...c,at};});
}
export function normalizeEditorTimeline(p:VideoEditProject):VideoEditProject {
 return p.clips.every(c=>c.at!==undefined)?p:{...p,clips:timelineClips(p)};
}
export const projectDuration = (p: VideoEditProject) => Math.max(0,...timelineClips(p).map(c=>c.at+clipDuration(c)),...p.audio.map(c=>c.at+clipDuration(c)));
export function clipAt(p: VideoEditProject, position: number) {
 const clips=timelineClips(p);
 for(let i=0;i<clips.length;i++){
  const clip=clips[i],at=clip.at,duration=clipDuration(clip);
  if(position>=at && position<at+duration)return {clip,index:i,at,local:position-at};
 }
 return null;
}
export function appendEditorAsset(p: VideoEditProject,asset: EditorAsset,at?:number,track=0): VideoEditProject {
 p=normalizeEditorTimeline(p);
 const assets=p.assets.some(a=>a.id===asset.id)?p.assets:[...p.assets,asset];
 const clip={id:editorId(),assetId:asset.id,start:0,end:asset.kind==='image'?3:Math.min(asset.duration,600),speed:1,volume:1,track,at:at??(asset.kind==='audio'?0:Math.max(0,...timelineClips(p).filter(c=>(c.track??0)===track).map(c=>c.at+clipDuration(c))))};
 if(!Number.isFinite(clip.at)||clip.at<0||clip.at+clipDuration(clip)>600)throw new Error('素材位置须在 0–600 秒内');
 if((asset.kind==='audio'?p.audio.length:p.clips.length)>=(asset.kind==='audio'?8:32))throw new Error('最多 32 个画面片段、8 个音频片段');
 if(asset.kind!=='audio'&&!canPlaceVisual(p,clip))throw new Error('这个轨道的位置已有画面，请换一条轨道或空白位置');
 return asset.kind==='audio'
  ? {...p,assets,audio:[...p.audio,clip]}
  : {...p,assets,clips:[...p.clips,clip]};
}
export function splitEditorClip(p: VideoEditProject, id: string, globalTime: number): VideoEditProject {
 const audioIndex=p.audio.findIndex(c=>c.id===id);
 if(audioIndex>=0){
  const c=p.audio[audioIndex],point=c.start+(globalTime-c.at)*c.speed;
  if(point-c.start<0.1 || c.end-point<0.1)return p;
  if(p.audio.length>=8)throw new Error('最多 8 个音频片段，请先删除不需要的音轨');
  return {...p,audio:[...p.audio.slice(0,audioIndex),{...c,end:point},{...c,id:editorId(),start:point,at:globalTime},...p.audio.slice(audioIndex+1)]};
 }
 const index=p.clips.findIndex(c=>c.id===id);if(index<0)return p;
 const clips=timelineClips(p),c=clips[index],offset=c.at;
 const point=c.start+(globalTime-offset)*c.speed;
 if(point-c.start<0.1 || c.end-point<0.1)return p;
 if(p.clips.length>=32)throw new Error('最多 32 个画面片段');
 return {...p,clips:[...clips.slice(0,index),{...c,end:point},{...c,id:editorId(),start:point,at:globalTime},...clips.slice(index+1)]};
}
export function moveEditorClip(p:VideoEditProject,id:string,beforeId?:string):VideoEditProject {
 const c=p.clips.find(c=>c.id===id);if(!c || id===beforeId)return p;
 const clips=p.clips.filter(c=>c.id!==id),i=beforeId?clips.findIndex(c=>c.id===beforeId):-1;
 clips.splice(i<0?clips.length:i,0,c);return {...p,clips};
}
// Non-destructive separation: preview and FFmpeg read the audio stream of the
// original container; no upload, re-encoding, or mutation of the source file.
export function detachEditorAudio(p:VideoEditProject,id:string):VideoEditProject {
 const index=p.clips.findIndex(c=>c.id===id),clip=p.clips[index];
 const source=p.assets.find(a=>a.id===clip?.assetId);
 if(!clip||source?.kind!=='video'||p.audio.some(a=>a.sourceClipId===id))return p;
 if(p.audio.length>=8)throw new Error('最多 8 个音频片段，请先删除不需要的音轨');
 const asset:EditorAsset={id:editorId(),name:source.name+' · 分离音频',url:source.url,kind:'audio',duration:source.duration};
 const at=timelineClips(p)[index].at;
 return {...p,assets:[...p.assets,asset],
  clips:p.clips.map(c=>c.id===id?{...c,volume:0}:c),
  audio:[...p.audio,{...clip,id:editorId(),assetId:asset.id,at,sourceClipId:id}]};
}
export function validateEditorProject(p: VideoEditProject): string {
 if(!p.clips.length)return '先将视频或图片加入主轨道';
 if(p.clips.length>32 || p.audio.length>8)return '最多 32 个画面片段、8 个音频片段';
 const duration=projectDuration(p);if(!Number.isFinite(duration)||duration<.1||duration>600)return '成片时长须在 0.1–600 秒之间';
 for(const c of [...p.clips,...p.audio]){
  const a=p.assets.find(a=>a.id===c.assetId);
  if(!a || !a.url || /^(blob:|data:)/.test(a.url))return '有素材尚未上传完成';
  if(![c.start,c.end,c.speed,c.volume].every(Number.isFinite)||c.start<0||c.end-c.start<.099999||c.speed<.5||c.speed>2||c.volume<0||c.volume>1)return '片段参数无效';
  if(a.kind!=='image' && c.end>a.duration+.1)return '片段超过素材原始时长';
 }
 for(const a of p.audio)if(!Number.isFinite(a.at)||a.at<0||a.at>=duration)return '背景音起点需要位于画面时间线内';
 for(const c of timelineClips(p))if(!canPlaceVisual(p,c))return '同一画面轨道不能重叠，或画中画参数无效';
 return '';
}
export function editorOutputSize(p:VideoEditProject) {
 const h=p.resolution==='1080p'?1080:720;
 return p.ratio==='9:16'?{width:h,height:Math.round(h*16/9)}:p.ratio==='1:1'?{width:h,height:h}:{width:Math.round(h*16/9),height:h};
}
export function editorExportPayload(p:VideoEditProject,nodeID:string) {
 const item=(c:EditorClip)=>{
  const a=p.assets.find(a=>a.id===c.assetId)!;
  return {media_url:a.url,kind:a.kind,start:c.start,end:c.end,speed:c.speed,volume:c.volume};
 };
 return {node_id:nodeID,free_timeline:true,multi_track:true,clips:timelineClips(p).map(c=>({...item(c),at:c.at,...visualTransform(c)})),audio:p.audio.map(a=>({...item(a),at:a.at})),...editorOutputSize(p),fps:p.fps};
}
export function canPlaceVisual(p:VideoEditProject,c:EditorClip & {at:number}) {
 const end=c.at+clipDuration(c);
 const {track,scale,x,y}=visualTransform(c);
 if(!Number.isInteger(track)||track<0||track>7||![scale,x,y].every(Number.isFinite)||scale<.1||scale>1||x<0||x>1||y<0||y>1)return false;
 return Number.isFinite(c.at)&&c.at>=0&&Number.isFinite(end)&&end<=600&&
  timelineClips(p).every(other=>other.id===c.id||(other.track??0)!==track||c.at>=other.at+clipDuration(other)-1e-6||end<=other.at+1e-6);
}
export function patchEditorClip(p:VideoEditProject,id:string,patch:Partial<EditorClip>):VideoEditProject {
 p=normalizeEditorTimeline(p);
 const visual=timelineClips(p).find(c=>c.id===id);
 if(visual&&!canPlaceVisual(p,{...visual,...patch} as EditorClip & {at:number}))throw new Error('同轨画面不能重叠，位置需在 10 分钟内，缩放为 10–100%');
 const audio=p.audio.find(c=>c.id===id);
 if(audio){const c={...audio,...patch};if(!Number.isFinite(c.at)||c.at<0||c.at+clipDuration(c)>600)throw new Error('音频位置须在 0–600 秒内');}
 return {...p,clips:p.clips.map(c=>c.id===id?{...c,...patch}:c),audio:p.audio.map(c=>c.id===id?{...c,...patch}:c)};
}
export function snapEditorPosition(p:VideoEditProject,id:string,at:number,duration:number,threshold:number,playhead:number,enabled=true) {
 let result=Math.max(0,Math.min(600-duration,Math.round(at*p.fps)/p.fps)),guide:number|null=null;
 if(enabled){
  const edges=[0,playhead,...[...timelineClips(p),...p.audio].filter(c=>c.id!==id).flatMap(c=>[c.at,c.at+clipDuration(c)])];
  let distance=threshold,best=result;
  for(const edge of edges)for(const offset of [0,duration]){
   const candidate=edge-offset,d=Math.abs(candidate-result);
   if(candidate>=0&&candidate+duration<=600&&d<=distance){distance=d;guide=edge;best=candidate;}
  }
  result=best;
 }
 return {at:Math.max(0,Math.min(600-duration,result)),guide};
}
export function alignEditorAudio(p:VideoEditProject,id:string,targetId:string,edge:'start'|'end'|'source'):VideoEditProject {
 const audio=p.audio.find(c=>c.id===id),target=timelineClips(p).find(c=>c.id===targetId);
 if(!audio||!target)return p;
 const speed=edge==='source'?target.speed:audio.speed;
 const at=edge==='source'?target.at+(audio.start-target.start)/speed:
  edge==='end'?target.at+clipDuration(target)-(audio.end-audio.start)/speed:target.at;
 return patchEditorClip(p,id,{at,speed});
}
export function copyEditorClip(p:VideoEditProject,id:string):VideoEditProject {
 p=normalizeEditorTimeline(p);
 const audio=p.audio.find(c=>c.id===id);
 if(audio){
  if(p.audio.length>=8)throw new Error('最多 8 个音频片段');
  const c={...audio,id:editorId(),at:audio.at+clipDuration(audio)};
  if(c.at+clipDuration(c)>600)throw new Error('复制后超过 10 分钟');
  return {...p,audio:[...p.audio,c]};
 }
 const original=timelineClips(p).find(c=>c.id===id);if(!original)return p;
 if(p.clips.length>=32)throw new Error('最多 32 个画面片段');
 const copy={...original,id:editorId(),at:original.at+clipDuration(original)};
 for(const other of timelineClips(p).filter(c=>(c.track??0)===(copy.track??0)).sort((a,b)=>a.at-b.at)){
  if(copy.at<other.at+clipDuration(other)&&copy.at+clipDuration(copy)>other.at)copy.at=other.at+clipDuration(other);
 }
 if(!canPlaceVisual(p,copy))throw new Error('复制后超过 10 分钟');
 return {...p,clips:[...p.clips,copy]};
}
export async function inspectEditorAsset(url:string,kind:EditorAsset['kind']):Promise<{duration:number;width?:number;height?:number}>{
 if(kind==='image')return new Promise((resolve,reject)=>{
  const image=new Image();const timer=setTimeout(()=>reject(new Error('图片读取超时')),20000);
  image.onload=()=>{clearTimeout(timer);resolve({duration:3,width:image.naturalWidth,height:image.naturalHeight});};
  image.onerror=()=>{clearTimeout(timer);reject(new Error('图片无法读取'));};image.src=url;
 });
 return new Promise((resolve,reject)=>{
  const media=document.createElement(kind);const cleanup=()=>{clearTimeout(timer);media.removeAttribute('src');media.load();};
  const timer=setTimeout(()=>{cleanup();reject(new Error('素材读取超时'));},20000);
  media.preload='metadata';media.onloadedmetadata=()=>{
   const duration=media.duration,width=kind==='video'?(media as HTMLVideoElement).videoWidth:undefined,height=kind==='video'?(media as HTMLVideoElement).videoHeight:undefined;
   cleanup();Number.isFinite(duration)&&duration>.1?resolve({duration,width,height}):reject(new Error('素材时长无效'));
  };
  media.onerror=()=>{cleanup();reject(new Error('素材无法解码，请使用 MP4/H.264、MP3/WAV 或 PNG/JPG'));};
  media.src=url;
 });
}
