import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowLeft,Upload,Plus,Scissors,Trash2,Undo2,Redo2,Play,Pause,SkipBack,Film,Music,Image as ImageIcon,Download,Copy,ChevronLeft,ChevronRight,Volume2,FolderOpen} from 'lucide-react';
import {toRenderableMediaUrl} from '../../reference-media';
import {appendEditorAsset,alignEditorAudio,activeEditorLayers,editorTrackCount,visualTransform,clipDuration,copyEditorClip,detachEditorAudio,normalizeEditorTimeline,patchEditorClip,projectDuration,snapEditorPosition,splitEditorClip,timelineClips,validateEditorProject,type EditorAsset,type EditorAudio,type VideoEditProject} from '../../video-editor-project';
import './video-editor.css';

type Props={
 initialProject:VideoEditProject; canvasAssets?:EditorAsset[];
 onChange:(p:VideoEditProject)=>void; onClose:()=>void; onExport:(p:VideoEditProject)=>void;
 onImport:(files:File[],progress:(message:string)=>void)=>Promise<EditorAsset[]>;
 onResolveAsset:(a:EditorAsset)=>Promise<EditorAsset>;
};
export default function VideoEditorWorkbench({initialProject,canvasAssets=[],onChange,onClose,onExport,onImport,onResolveAsset}:Props){
 const [project,setProject]=useState(()=>normalizeEditorTimeline(initialProject));
 const projectRef=useRef(project);projectRef.current=project;
 const [selected,setSelected]=useState(initialProject.clips[0]?.id||'');
 const [position,setPosition]=useState(0),[playing,setPlaying]=useState(false);
 const positionRef=useRef(0);positionRef.current=position;
 const [px,setPx]=useState(40),[tab,setTab]=useState<'project'|'canvas'>('project');
 const [snapEnabled,setSnapEnabled]=useState(true),[snapGuide,setSnapGuide]=useState<number|null>(null);
 const [alignTarget,setAlignTarget]=useState('');
 const [activeTrack,setActiveTrack]=useState(0);
 const [message,setMessage]=useState(''),[importing,setImporting]=useState(false),[previewError,setPreviewError]=useState('');
 const [retry,setRetry]=useState(0),[,setHistoryTick]=useState(0);
 const history=useRef<VideoEditProject[]>([]),future=useRef<VideoEditProject[]>([]);
 const videoRefs=useRef(new Map<string,HTMLVideoElement>()),audioRefs=useRef(new Map<string,HTMLAudioElement>());
 const videoBinders=useRef(new Map<string,(el:HTMLVideoElement|null)=>void>());
 const bindVideo=(id:string)=>{
  if(!videoBinders.current.has(id))videoBinders.current.set(id,el=>{
   if(el)videoRefs.current.set(id,el);
   else{videoRefs.current.get(id)?.pause();videoRefs.current.delete(id);}
  });
  return videoBinders.current.get(id)!;
 };
 const audioBinders=useRef(new Map<string,(el:HTMLAudioElement|null)=>void>());
 const bindAudio=(id:string)=>{
  if(!audioBinders.current.has(id))audioBinders.current.set(id,el=>{
   if(el)audioRefs.current.set(id,el);
   else{audioRefs.current.get(id)?.pause();audioRefs.current.delete(id);}
  });
  return audioBinders.current.get(id)!;
 };
 const fileRef=useRef<HTMLInputElement>(null),rootRef=useRef<HTMLDivElement>(null);
 const dragCleanup=useRef<()=>void>(()=>{});
 const total=projectDuration(project),layers=activeEditorLayers(project,position);
 const trackCount=editorTrackCount(project),trackOrder=Array.from({length:trackCount},(_,i)=>trackCount-1-i);
 const selectedTrack=Math.min(activeTrack,trackCount-1);
 const chosen=project.clips.find(c=>c.id===selected)||project.audio.find(c=>c.id===selected);
 const chosenAudio=project.audio.find(c=>c.id===selected);
 const chosenAsset=project.assets.find(a=>a.id===chosen?.assetId);
 const audioDetached=project.audio.some(a=>a.sourceClipId===selected);
 const visuals=timelineClips(project);
 const targetId=visuals.some(c=>c.id===alignTarget)?alignTarget:
  visuals.some(c=>c.id===chosenAudio?.sourceClipId)?chosenAudio!.sourceClipId!:visuals[0]?.id||'';
 const error=validateEditorProject(project);
 const commit=(next:VideoEditProject|((p:VideoEditProject)=>VideoEditProject))=>{
  const current=projectRef.current,p=typeof next==='function'?next(current):next;
  if(p===current)return;
  history.current=[...history.current.slice(-59),current];future.current=[];
  projectRef.current=p;setProject(p);onChange(p);setPlaying(false);setHistoryTick(x=>x+1);
  setPosition(x=>Math.min(x,projectDuration(p)));
 };
 const restore=(direction:'undo'|'redo')=>{
  const source=direction==='undo'?history.current:future.current,target=direction==='undo'?future.current:history.current;
  const p=source.pop();if(!p)return;target.push(projectRef.current);
  projectRef.current=p;setProject(p);onChange(p);setPlaying(false);setHistoryTick(x=>x+1);setPosition(x=>Math.min(x,projectDuration(p)));
 };
 const updateClip=(id:string,patch:Partial<EditorAudio>)=>{try{commit(p=>patchEditorClip(p,id,patch));setMessage('');}catch(e){setMessage(e instanceof Error?e.message:String(e));}};
 const alignAudio=(edge:'start'|'end'|'source')=>{
  try{commit(p=>alignEditorAudio(p,selected,edge==='source'?chosenAudio?.sourceClipId||'':targetId,edge));setMessage('音频已对齐，可继续独立调整');}
  catch(e){setMessage(e instanceof Error?e.message:String(e));}
 };
 const remove=()=>{if(!selected)return;commit(p=>({...p,clips:p.clips.filter(c=>c.id!==selected),audio:p.audio.filter(c=>c.id!==selected)}));setSelected('');};
 const seek=(t:number)=>{setPlaying(false);setPosition(Math.min(total,Math.max(0,t)));};
 const undo=()=>restore('undo'),redo=()=>restore('redo');
 const split=()=>{try{const p=splitEditorClip(projectRef.current,selected,position);if(p===projectRef.current)setMessage('请把播放头放在所选片段中间再分割');else{commit(p);setMessage('');}}catch(e){setMessage(e instanceof Error?e.message:String(e));}};
 const detachAudio=()=>{
  try{
   const p=detachEditorAudio(projectRef.current,selected);if(p===projectRef.current)return;
   commit(p);setSelected(p.audio[p.audio.length-1].id);
   setMessage('已分离音频，原片段已静音；音轨可独立裁剪、分割、移动和调音量（源视频需含音轨）');
  }catch(e){setMessage(e instanceof Error?e.message:String(e));}
 };
 useEffect(()=>{
  const app=document.getElementById('root'),wasInert=app?.inert;
  if(app)app.inert=true;
  rootRef.current?.focus();const old=document.body.style.overflow;document.body.style.overflow='hidden';
  return()=>{if(app)app.inert=!!wasInert;document.body.style.overflow=old;dragCleanup.current();videoRefs.current.forEach(v=>v.pause());audioRefs.current.forEach(a=>a.pause());};
 },[]);
 useEffect(()=>{setPreviewError('');},[layers.map(c=>c.id).join('|'),retry]);
 useEffect(()=>{
  let frame=0,last=performance.now();
  const tick=(now:number)=>{
   const p=projectRef.current,t=positionRef.current;
   const visible=activeEditorLayers(p,t);
   // All visible videos share one timeline clock. Wait for newly mounted
   // decoders so a slow upper layer cannot start late relative to the others.
   const buffering=visible.some(c=>{
    if(p.assets.find(a=>a.id===c.assetId)?.kind!=='video')return false;
    const v=videoRefs.current.get(c.id);
    return !v||v.readyState<2||v.seeking;
   });
   let next=t;
   if(playing&&!buffering){
    const master=visible.find(c=>videoRefs.current.has(c.id));
    const clock=master&&videoRefs.current.get(master.id);
    if(master&&clock){
     next=Math.max(t,master.at+(clock.currentTime-master.start)/master.speed);
     if(clock.ended||clock.currentTime>=master.end-.001)next=master.at+clipDuration(master)+.001;
    }else next=t+Math.min(.1,(now-last)/1000);
    const duration=projectDuration(p);
    if(next>=duration){next=duration;setPlaying(false);}
    positionRef.current=next;setPosition(next);
   }
   for(const c of visible){
    const media=videoRefs.current.get(c.id);if(!media)continue;
    media.volume=c.volume;media.playbackRate=c.speed;
    const target=c.start+Math.max(0,t-c.at)*c.speed;
    if(media.readyState>=1&&!media.seeking&&Math.abs(media.currentTime-target)>(playing?.08:.015))media.currentTime=target;
    if(playing&&!buffering&&!media.ended&&media.paused)void media.play().catch(()=>{setPlaying(false);setPreviewError('视频暂时无法播放，请重试加载');});
    else if((!playing||buffering)&&!media.paused)media.pause();
   }
   for(const track of p.audio){
    const media=audioRefs.current.get(track.id);if(!media)continue;
    const enabled=next>=track.at&&next<track.at+clipDuration(track);
    media.volume=track.volume;media.playbackRate=track.speed;
    if(enabled){
     const target=track.start+(next-track.at)*track.speed;
     if(media.readyState>=1&&!media.seeking&&Math.abs(media.currentTime-target)>(playing?.08:.015))media.currentTime=target;
     if(playing&&!buffering&&media.paused)void media.play().catch(()=>{setMessage('背景音无法播放，请检查音频素材');});
     else if((!playing||buffering)&&!media.paused)media.pause();
    }else if(!media.paused)media.pause();
   }
   last=now;frame=requestAnimationFrame(tick);
  };
  frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
 },[playing]);
 const append=async(asset:EditorAsset,at?:number,track=selectedTrack)=>{
  try{
   if(/^(blob:|data:)/.test(asset.url))throw new Error('画布素材尚未上传完成，请稍后再添加，或使用导入文件');
   const resolved=asset.duration>0?asset:await onResolveAsset(asset);
   commit(p=>appendEditorAsset(p,resolved,at,track));setMessage('');
  }catch(e){setMessage(e instanceof Error?e.message:String(e));}
 };
 const importFiles=async(files:File[])=>{
  if(importing||!files.length)return;setImporting(true);
  try{const assets=await onImport(files,setMessage);commit(p=>({...p,assets:[...p.assets,...assets]}));setTab('project');setMessage('素材已导入，点击 ＋ 或拖到时间线开始剪辑');}
  catch(e){setMessage(e instanceof Error?e.message:String(e));}
  finally{setImporting(false);if(fileRef.current)fileRef.current.value='';}
 };
 const beginTrim=(event:React.PointerEvent,id:string,side:'start'|'end'|'move')=>{
  if(event.button!==0)return;
  event.stopPropagation();event.preventDefault();rootRef.current?.setPointerCapture?.(event.pointerId);
  const base=projectRef.current,clip=base.clips.find(c=>c.id===id)||base.audio.find(c=>c.id===id);
  if(!clip)return;
  const isVisual=base.clips.some(c=>c.id===id);
  setSelected(id);setPlaying(false);if(isVisual)setActiveTrack(clip.track??0);
  const asset=base.assets.find(a=>a.id===clip.assetId)!;const x=event.clientX,y=event.clientY;
  let last=base;
  const move=(e:PointerEvent)=>{
   if(Math.abs(e.clientX-x)<3&&Math.abs(e.clientY-y)<3)return;
   const delta=(e.clientX-x)/px*clip.speed;
   let patch:Partial<EditorAudio>;
   if(side==='move'){
    const snap=snapEditorPosition(base,id,(clip.at??0)+(e.clientX-x)/px,clipDuration(clip),8/px,position,snapEnabled&&!e.altKey);
    patch={at:snap.at};setSnapGuide(snap.guide);
    if(isVisual){
     const lane=Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-video-track]')||[]).find(el=>{
      const r=el.getBoundingClientRect();return r.height>0&&e.clientY>=r.top&&e.clientY<r.bottom;
     });
     if(lane){patch.track=Number(lane.dataset.videoTrack);setActiveTrack(patch.track);}
    }
   }
   else if(side==='start'){
    const start=Math.max(0,clip.start-(clip.at??0)*clip.speed,Math.min(clip.end-.1,clip.start+delta));
    patch={start,at:(clip.at??0)+(start-clip.start)/clip.speed};
   }
   else patch={end:Math.max(clip.start+.1,Math.min(asset.kind==='image'?600:asset.duration,clip.end+delta))};
   try{last=patchEditorClip(base,id,patch);setProject(last);setMessage('');}
   catch(e){setSnapGuide(null);setMessage(e instanceof Error?e.message:String(e));}
  };
  const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);
   projectRef.current=base;commit(last);setSnapGuide(null);};
  const cancel=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);setProject(base);projectRef.current=base;setSnapGuide(null);};
  dragCleanup.current=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);};
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});window.addEventListener('pointercancel',cancel,{once:true});
 };
 const drop=(event:React.DragEvent)=>{
  event.preventDefault();event.stopPropagation();
  const id=event.dataTransfer.getData('application/ccy-asset');
  const asset=[...project.assets,...canvasAssets].find(a=>a.id===id);
  const lane=rootRef.current?.querySelector('.ve-track-content');
  const at=lane?Math.max(0,Math.round((event.clientX-lane.getBoundingClientRect().left)/px*project.fps)/project.fps):undefined;
  const target=(event.target as HTMLElement).closest<HTMLElement>('[data-video-track]');
  if(asset)void append(asset,at,target?Number(target.dataset.videoTrack):selectedTrack);
 };
 const time=(n:number)=>{const safe=Math.max(0,n);return Math.floor(safe/60).toString().padStart(2,'0')+':'+(safe%60).toFixed(2).padStart(5,'0');};
 const assets=tab==='project'?project.assets:canvasAssets;
 const timelineWidth=Math.max(900,(Math.max(total,20)+3)*px);
 const playingToggle=()=>{if(!total||previewError)return;if(position>=total)seek(0);setPlaying(x=>!x);};
 return createPortal(<div ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="剪辑工作台" className="ccy-editor nodrag nopan nowheel"
  onWheel={e=>e.stopPropagation()} onPointerDown={e=>e.stopPropagation()}
  onKeyDown={e=>{
   e.stopPropagation();
   if((e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]'))return;
   if(e.code==='Space'){e.preventDefault();playingToggle();}
   else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();remove();}
   else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}
   else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='b'){e.preventDefault();split();}
   else if(e.key==='Escape')onClose();
  }}>
  <header className="ve-header">
   <button onClick={onClose} title="返回画布"><ArrowLeft size={17}/>返回画布</button><span className="ve-divider"/>
   <Scissors size={19} color="#fb923c"/>
   <input aria-label="工程名称" value={project.name} maxLength={80} onChange={e=>commit(p=>({...p,name:e.target.value}))}/>
   <span className="ve-save">工程随节点保存</span><span className="ve-grow"/>
   <span className="ve-engine">FFmpeg 本地剪辑</span>
   <button className="ve-primary" disabled={!!error||importing} title={error||'导出成片，保留可编辑工程'} onClick={()=>onExport(projectRef.current)}><Download size={15}/>导出成片</button>
  </header>
  <div className="ve-main">
   <aside className="ve-library">
    <div className="ve-tabs"><button className={tab==='project'?'active':''} onClick={()=>setTab('project')}>工程素材</button><button className={tab==='canvas'?'active':''} onClick={()=>setTab('canvas')}>画布素材</button></div>
    <button className="ve-import" disabled={importing} onClick={()=>fileRef.current?.click()}><Upload size={17}/>{importing?'导入中…':'导入视频 / 图片 / 音频'}</button>
    <input ref={fileRef} type="file" multiple accept="video/*,image/png,image/jpeg,image/webp,audio/*" hidden onChange={e=>void importFiles(Array.from(e.target.files||[]))}/>
    <div className="ve-assets" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void importFiles(Array.from(e.dataTransfer.files));}}>
     {!assets.length&&<div className="ve-empty"><FolderOpen size={30}/><p>{tab==='canvas'?'画布中暂无可用素材':'把素材文件拖到这里'}</p><small>视频、图片、背景音</small></div>}
     {assets.map(asset=><div key={asset.id} className="ve-asset" draggable onDragStart={e=>e.dataTransfer.setData('application/ccy-asset',asset.id)}>
      <div className={'ve-asset-thumb '+asset.kind}>
       {asset.kind==='image'?<img loading="lazy" src={toRenderableMediaUrl(asset.url,{thumbWidth:240})} alt=""/>:asset.kind==='audio'?<Music size={25}/>:<Film size={25}/>}
       <span>{asset.kind==='image'?'图片':asset.duration?time(asset.duration):'视频'}</span>
       <button aria-label={'添加 '+asset.name} title="添加到时间线" onClick={()=>void append(asset)}><Plus size={16}/></button>
      </div>
      <p title={asset.name}>{asset.name}</p>
     </div>)}
    </div>
   </aside>
   <main className="ve-viewer">
    <div className="ve-viewer-title"><span>预览</span><span>{project.ratio} · {project.resolution} · {project.fps} fps</span></div>
    <div className="ve-stage">
     <div className="ve-screen" style={{aspectRatio:project.ratio.replace(':','/')}}>
      {!layers.length&&(total>0?<div className="ve-black-gap" aria-label="空隙黑场"/>:<div className="ve-empty"><Film size={42}/><p>将素材加入下方时间线</p><small>多轨叠放 · 画中画 · 自由留白 · 独立音频</small></div>)}
      {layers.map(c=>{
       const asset=project.assets.find(a=>a.id===c.assetId),v=visualTransform(c);
       return <div key={c.id+':'+retry} className="ve-preview-layer" data-preview-track={v.track}
        style={{left:v.x*100+'%',top:v.y*100+'%',width:v.scale*100+'%',height:v.scale*100+'%'}}>
        {asset?.kind==='video'?<video ref={bindVideo(c.id)} src={toRenderableMediaUrl(asset.url)} preload="auto" playsInline onError={()=>{setPlaying(false);setPreviewError('视频加载失败，检查素材地址后重试');}}/>:
         asset?.kind==='image'?<img src={toRenderableMediaUrl(asset.url)} alt={asset.name} onError={()=>{setPlaying(false);setPreviewError('图片加载失败');}}/>:null}
       </div>;
      })}
      {previewError&&<div className="ve-preview-error">{previewError}<button onClick={()=>{setPreviewError('');setRetry(x=>x+1);}}>重新加载</button></div>}
     </div>
    </div>
    <div className="ve-transport"><span>{time(position)} <small>/ {time(total)}</small></span><button title="回到开始" onClick={()=>seek(0)}><SkipBack size={18}/></button><button aria-label={playing?'暂停':'播放工程'} className="ve-play" disabled={!total} onClick={playingToggle}>{playing?<Pause size={20}/>:<Play size={20}/>}</button><span className="ve-shortcut">空格 播放 / 暂停</span></div>
    {project.audio.map(a=><audio key={a.id} ref={bindAudio(a.id)} preload="metadata" src={toRenderableMediaUrl(project.assets.find(x=>x.id===a.assetId)?.url)}/>)}
   </main>
   <aside className="ve-inspector">
    <h3>{chosen?'片段属性':'工程设置'}</h3>
    {chosen&&chosenAsset?<><div className="ve-selected-name">{chosenAsset.name}</div>
     <label>素材入点（秒）<input aria-label="素材入点" type="number" step=".01" min="0" max={chosen.end-.1} value={Number(chosen.start.toFixed(3))} onChange={e=>updateClip(chosen.id,{start:Math.max(0,Math.min(chosen.end-.1,Number(e.target.value)))})}/></label>
     <label>素材出点（秒）<input aria-label="素材出点" type="number" step=".01" min={chosen.start+.1} max={chosenAsset.kind==='image'?600:chosenAsset.duration} value={Number(chosen.end.toFixed(3))} onChange={e=>updateClip(chosen.id,{end:Math.max(chosen.start+.1,Math.min(chosenAsset.kind==='image'?600:chosenAsset.duration,Number(e.target.value)))})}/></label>
     <label>时间线起点（秒）<input aria-label={chosenAudio?'背景音起点':'画面起点'} type="number" min="0" max="600" step={1/project.fps} value={Number((chosen.at??0).toFixed(4))} onChange={e=>updateClip(chosen.id,{at:Math.max(0,Number(e.target.value))})}/></label>
     {!chosenAudio&&<div className="ve-layer-controls">
      <label>画面轨道<select aria-label="画面轨道" value={chosen.track??0} onChange={e=>{updateClip(chosen.id,{track:Number(e.target.value)});setActiveTrack(Number(e.target.value));}}>
       {trackOrder.map(t=><option key={t} value={t}>画面 {t+1}{t===0?'（底层）':''}</option>)}
      </select></label>
      <label>画面缩放（%）<input aria-label="画面缩放" type="number" min="10" max="100" step="1" value={Math.round((chosen.scale??1)*100)} onChange={e=>updateClip(chosen.id,{scale:Number(e.target.value)/100})}/></label>
      <label>水平位置（%）<input aria-label="水平位置" type="range" min="0" max="100" value={(chosen.x??.5)*100} onChange={e=>updateClip(chosen.id,{x:Number(e.target.value)/100})}/></label>
      <label>垂直位置（%）<input aria-label="垂直位置" type="range" min="0" max="100" value={(chosen.y??.5)*100} onChange={e=>updateClip(chosen.id,{y:Number(e.target.value)/100})}/></label>
      <button onClick={()=>updateClip(chosen.id,{scale:.35,x:.78,y:.78})}>右下画中画</button>
      <button onClick={()=>updateClip(chosen.id,{scale:1,x:.5,y:.5})}>还原全画面</button>
     </div>}
     {chosenAudio&&<div className="ve-align-controls">
      <label>对齐到画面<select aria-label="对齐目标画面" value={targetId} onChange={e=>setAlignTarget(e.target.value)}>
       {visuals.map((c,i)=><option key={c.id} value={c.id}>{i+1}. {project.assets.find(a=>a.id===c.assetId)?.name}</option>)}
      </select></label>
      <button disabled={!targetId} onClick={()=>alignAudio('start')}>对齐开头</button>
      <button disabled={!targetId} onClick={()=>alignAudio('end')}>对齐结尾</button>
      <button disabled={!visuals.some(c=>c.id===chosenAudio.sourceClipId)} title="按原视频的素材时间和速度恢复同步" onClick={()=>alignAudio('source')}>对齐原视频</button>
     </div>}
     {chosenAsset.kind!=='image'&&<><label>播放速度<select aria-label="播放速度" value={chosen.speed} onChange={e=>updateClip(chosen.id,{speed:Number(e.target.value)})}>{[.5,.75,1,1.25,1.5,2].map(s=><option key={s} value={s}>{s} ×</option>)}</select></label>
     <label><span><Volume2 size={13}/>音量 {Math.round(chosen.volume*100)}%</span><input aria-label="片段音量" type="range" min="0" max="1" step=".05" value={chosen.volume} onChange={e=>updateClip(chosen.id,{volume:Number(e.target.value)})}/></label></>}
     <p className="ve-hint">片段时长 {clipDuration(chosen).toFixed(2)} 秒</p><button className="ve-danger" onClick={remove}><Trash2 size={14}/>删除此片段</button><hr/></>:<p className="ve-hint">选中时间线片段后，可调整入点、出点、速度和音量。</p>}
    <label>画面比例<select aria-label="工程比例" value={project.ratio} onChange={e=>commit(p=>({...p,ratio:e.target.value as VideoEditProject['ratio']}))}>{['16:9','9:16','1:1'].map(r=><option key={r}>{r}</option>)}</select></label>
    <label>输出分辨率<select aria-label="输出分辨率" value={project.resolution} onChange={e=>commit(p=>({...p,resolution:e.target.value as VideoEditProject['resolution']}))}><option>720p</option><option>1080p</option></select></label>
    <label>输出帧率<select aria-label="输出帧率" value={project.fps} onChange={e=>commit(p=>({...p,fps:Number(e.target.value) as 24|30}))}><option value="24">24 fps</option><option value="30">30 fps</option></select></label>
    <p className="ve-hint">MP4 · H.264 / AAC<br/>上方轨道覆盖下方轨道；缩小可做画中画<br/>最多 8 条画面轨 / 32 画面片段 / 10 分钟</p>
   </aside>
  </div>
  <section className="ve-timeline">
   <div className="ve-editbar"><button aria-label="撤销" disabled={!history.current.length} onClick={undo}><Undo2 size={16}/></button><button aria-label="重做" disabled={!future.current.length} onClick={redo}><Redo2 size={16}/></button><span className="ve-divider"/>
    <button disabled={!chosen} onClick={split}><Scissors size={15}/>分割 <small>Ctrl B</small></button>
    <button disabled={!chosen||!!chosenAudio||chosenAsset?.kind!=='video'||audioDetached||project.audio.length>=8} title={project.audio.length>=8?'最多 8 个音频片段':audioDetached?'此片段已分离音频':'将视频原声分离到独立音轨，原片段静音'} onClick={detachAudio}><Music size={15}/>{audioDetached?'已分离音频':'分离音频'}</button>
    <button disabled={!chosen} onClick={()=>{try{commit(p=>copyEditorClip(p,selected));setMessage('');}catch(e){setMessage(e instanceof Error?e.message:String(e));}}}><Copy size={15}/>复制</button>
    <button disabled={!chosen} onClick={remove}><Trash2 size={15}/>删除</button>
    <button title="左移一帧" disabled={!chosen} onClick={()=>chosen&&updateClip(chosen.id,{at:Math.max(0,(chosen.at??0)-1/project.fps)})}><ChevronLeft size={16}/></button>
    <button title="右移一帧" disabled={!chosen} onClick={()=>chosen&&updateClip(chosen.id,{at:(chosen.at??0)+1/project.fps})}><ChevronRight size={16}/></button>
    <label className="ve-snap-toggle" title="吸附到画面、音频边缘和播放头；按 Alt 临时关闭"><input type="checkbox" aria-label="时间线吸附" checked={snapEnabled} onChange={e=>setSnapEnabled(e.target.checked)}/>吸附</label>
    <button disabled={trackCount>=8} onClick={()=>{commit(p=>({...p,videoTracks:editorTrackCount(p)+1}));setActiveTrack(trackCount);}}><Plus size={15}/>新增画面轨</button>
    <span className="ve-grow"/><label className="ve-zoom">− <input aria-label="时间线缩放" type="range" min="6" max="120" value={px} onChange={e=>setPx(Number(e.target.value))}/> ＋</label>
   </div>
   <div className="ve-tracks" onDragOver={e=>e.preventDefault()} onDrop={e=>drop(e)}>
    <div className="ve-track-labels"><div>时间线</div>{trackOrder.map(t=><div key={t} className={selectedTrack===t?'ve-track-active':''}><button aria-label={'选择画面轨道 '+(t+1)} onClick={()=>setActiveTrack(t)}><Film size={14}/>画面 {t+1}</button></div>)}{project.audio.length?project.audio.map((a,i)=><div key={a.id}><Music size={14}/>音频 {i+1}</div>):<div><Music size={14}/>背景音</div>}</div>
    <div className="ve-track-scroll"><div className="ve-track-content" style={{width:timelineWidth}}>
     <div className="ve-ruler" onPointerDown={e=>seek((e.clientX-e.currentTarget.getBoundingClientRect().left)/px)}>
      {Array.from({length:Math.ceil(timelineWidth/px/(px<20?10:2))},(_,i)=>{const t=i*(px<20?10:2);return <span key={i} style={{left:t*px}}>{time(t)}</span>;})}
     </div>
     {trackOrder.map(track=><div key={track} data-video-track={track} className={'ve-video-lane '+(selectedTrack===track?'ve-track-active':'')} onClick={()=>setActiveTrack(track)}>
      {visuals.filter(c=>(c.track??0)===track).map(c=>{const a=project.assets.find(x=>x.id===c.assetId),at=c.at;return <div key={c.id} role="button" aria-label={'片段 '+a?.name} tabIndex={0}
       className={'ve-clip '+(selected===c.id?'selected ':'')+(a?.kind||'video')} style={{left:at*px,width:clipDuration(c)*px}}
       onPointerDown={e=>beginTrim(e,c.id,'move')} onDragOver={e=>e.preventDefault()} onDrop={drop}
       onClick={()=>{setSelected(c.id);seek(at);}}>
       <button aria-label="拖动入点" className="ve-trim-handle left" onPointerDown={e=>beginTrim(e,c.id,'start')}/>
       {a?.kind==='image'?<ImageIcon size={14}/>:<Film size={14}/>}<span>{a?.name}</span><small>{clipDuration(c).toFixed(1)}s</small>
       <button aria-label="拖动出点" className="ve-trim-handle right" onPointerDown={e=>beginTrim(e,c.id,'end')}/>
      </div>;})}
      {!visuals.some(c=>(c.track??0)===track)&&<div className="ve-lane-empty">拖入视频 / 图片 · 画面 {track+1}{track===0?'（底层）':'（叠加层）'}</div>}
     </div>)}
     {project.audio.length?project.audio.map(a=><div className="ve-audio-lane" key={a.id}><div className={'ve-clip audio '+(selected===a.id?'selected':'')} style={{left:a.at*px,width:clipDuration(a)*px}} onClick={()=>setSelected(a.id)} onPointerDown={e=>beginTrim(e,a.id,'move')}>
      <button aria-label="音频入点" className="ve-trim-handle left" onPointerDown={e=>beginTrim(e,a.id,'start')}/><Music size={14}/><span>{project.assets.find(x=>x.id===a.assetId)?.name}</span>
      <button aria-label="音频出点" className="ve-trim-handle right" onPointerDown={e=>beginTrim(e,a.id,'end')}/>
     </div></div>):<div className="ve-audio-lane"><div className="ve-lane-empty">导入音乐 / 旁白，加入音频轨道</div></div>}
     {snapGuide!==null&&<div className="ve-snap-guide" style={{left:snapGuide*px}}><span>对齐 {time(snapGuide)}</span></div>}
     <div className="ve-playhead" style={{left:position*px}}><div role="slider" aria-label="播放头" aria-valuemin={0} aria-valuemax={total} aria-valuenow={position} tabIndex={0}
      onKeyDown={e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();seek(position+(e.key==='ArrowRight'?1:-1)/project.fps);}}} onPointerDown={e=>{
      e.preventDefault();const x=e.clientX,base=position;e.currentTarget.setPointerCapture(e.pointerId);
      const move=(ev:PointerEvent)=>seek(base+(ev.clientX-x)/px);
      const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);};
      dragCleanup.current=up;
      window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});
     }}/></div>
    </div></div>
   </div>
  </section>
  <footer className="ve-status"><span>{message||error||'上下拖动换轨，左右自由留空 · 上轨叠在下轨之上 · 吸附（Alt 暂停）· Ctrl Z 撤销'}</span><span>{trackCount} 画面轨 · {project.clips.length} 片段 · {project.audio.length} 音轨 · {time(total)}</span></footer>
 </div>,document.body);
}
