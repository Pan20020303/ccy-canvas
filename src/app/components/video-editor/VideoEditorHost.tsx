import {useEffect} from 'react';
import {toast} from 'sonner';
import {useStore,useActiveProjectReadOnly} from '../../store';
import {uploadFileWithProgress} from '../../api/projects';
import {apiClient} from '../../api/client';
import {extractOriginalMediaUrl,toRenderableMediaUrl} from '../../reference-media';
import {emptyVideoProject,editorId,editorExportPayload,inspectEditorAsset,validateEditorProject,type EditorAsset,type VideoEditProject} from '../../video-editor-project';
import VideoEditorWorkbench from './VideoEditorWorkbench';
import type {LocalVideoTrimResult} from '../../api/video-edit';

export async function importEditorFiles(files:File[],progress:(message:string)=>void):Promise<EditorAsset[]>{
 if(files.length>32)throw new Error('每次最多导入 32 个素材');
 const assets:EditorAsset[]=[];
 for(const file of files){
  if(file.size>512*1024*1024)throw new Error(file.name+' 超过 512 MB');
  const kind=file.type.startsWith('video/')?'video':file.type.startsWith('audio/')?'audio':/^image\/(png|jpeg|webp)$/.test(file.type)?'image':null;
  if(!kind)throw new Error('不支持的素材：'+file.name);
  const objectUrl=URL.createObjectURL(file);
  try{
   const info=await inspectEditorAsset(objectUrl,kind);
   progress('正在上传 '+file.name);
   const uploaded=await uploadFileWithProgress(file,file.name,n=>progress('上传 '+file.name+' '+n+'%'));
   assets.push({id:editorId(),name:file.name,url:uploaded.url,kind,...info});
  }finally{URL.revokeObjectURL(objectUrl);}
 }
 return assets;
}
export function createVideoEditorNode(sourceID?:string){
 const state=useStore.getState(),source=state.nodes.find(n=>n.id===sourceID),d=source?.data as Record<string,any>|undefined;
 if(d?.url && /^(blob:|data:)/.test(String(d.url))){toast.error('视频尚未上传完成，请稍后再打开剪辑工作台');return;}
 const id='video-editor-'+editorId(),p=emptyVideoProject();
 if(d?.url){
  const asset:EditorAsset={id:editorId(),name:d.customTitle||d.sourceName||'画布视频',url:extractOriginalMediaUrl(String(d.url)),kind:'video',duration:Number(d.mediaDuration||d.durationSeconds||d.duration||0)};
  p.name='视频剪辑';p.assets=[asset];
  if(asset.duration>.1)p.clips=[{id:editorId(),assetId:asset.id,start:0,end:Math.min(asset.duration,600),speed:1,volume:1}];
 }
 state.addNode({id,type:'videoEditorNode',position:{x:(source?.position.x||0)+380,y:source?.position.y||0},data:{editProject:p,customTitle:'剪辑工作台'}});
 if(source)state.onConnect({source:source.id,target:id,sourceHandle:null,targetHandle:null});
 state.openVideoEditor(id);
}
export function VideoEditorHost(){
 const id=useStore(s=>s.videoEditorNodeId),nodes=useStore(s=>s.nodes),close=useStore(s=>s.closeVideoEditor);
 const readonly=useActiveProjectReadOnly();
 const node=nodes.find(n=>n.id===id);
 useEffect(()=>{if(!node||readonly)close();},[node?.id,readonly,close]);
 if(!node||!id||readonly)return null;
 const canvasAssets:EditorAsset[]=nodes.flatMap(n=>{
  const d=n.data as Record<string,any>;if(!d.url||n.id===id)return [];
  const kind=['imageNode','referenceImageNode','layerEditorNode'].includes(n.type||'')?'image':
   ['videoNode','referenceVideoNode','videoEditorNode'].includes(n.type||'')?'video':['audioNode','referenceAudioNode'].includes(n.type||'')?'audio':null;
  if(!kind)return [];
  return [{id:'canvas-'+n.id,name:d.customTitle||d.sourceName||(kind==='video'?'画布视频':kind==='audio'?'画布音频':'画布图片'),url:extractOriginalMediaUrl(String(d.url)),kind,duration:kind==='image'?3:Number(d.mediaDuration||d.durationSeconds||d.duration||0)}];
 });
 const save=(p:VideoEditProject)=>useStore.getState().updateNodeData(id,{editProject:p,customTitle:p.name});
 const exportProject=(project:VideoEditProject)=>{
  const error=validateEditorProject(project);if(error){toast.error(error);return;}
  save(project);
  const state=useStore.getState(),resultID='video-edit-export-'+editorId(),sourceID=id;
  state.addNode({id:resultID,type:'videoNode',position:{x:node.position.x+390,y:node.position.y},data:{
   customTitle:project.name+' · 成片',status:'generating',taskPhase:'generating',runningStartedAt:Date.now(),
   sourceKind:'derived',derivedFromNodeId:sourceID,derivationAction:'video_edit',
   generationParams:{model:'ffmpeg-local-editor'},editingProject:project,
  }});
  state.onConnect({source:sourceID,target:resultID,sourceHandle:null,targetHandle:null});
  state.updateNodeData(sourceID,{lastExportNodeId:resultID});
  close();
  void apiClient.post<LocalVideoTrimResult>('/api/app/video/edit',editorExportPayload(project,resultID),AbortSignal.timeout(510000)).then(result=>{
   useStore.getState().updateNodeData(resultID,{url:result.url,output:result.url,status:'done',taskPhase:undefined,runningStartedAt:undefined,error:undefined,mediaDuration:result.duration});
   useStore.getState().updateNodeData(sourceID,{url:result.url,output:result.url});
  }).catch(e=>{
   const message=e instanceof Error?e.message:String(e);
   useStore.getState().updateNodeData(resultID,{status:'error',taskPhase:undefined,runningStartedAt:undefined,error:message});
   toast.error('成片导出失败：'+message);
  });
 };
 return <VideoEditorWorkbench key={id} initialProject={(node.data.editProject as VideoEditProject)||emptyVideoProject()}
  canvasAssets={canvasAssets} onChange={save} onClose={close} onExport={exportProject}
  onImport={importEditorFiles} onResolveAsset={async asset=>({...asset,...await inspectEditorAsset(toRenderableMediaUrl(asset.url),asset.kind)})}/>;
}
