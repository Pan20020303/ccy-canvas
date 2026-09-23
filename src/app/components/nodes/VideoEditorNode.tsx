import {Handle,Position,type NodeProps} from '@xyflow/react';
import {Scissors,Clapperboard,Maximize2,Loader2,Plus} from 'lucide-react';
import {useStore,useActiveProjectReadOnly} from '../../store';
import {projectDuration,type VideoEditProject} from '../../video-editor-project';
import {toRenderableMediaUrl} from '../../reference-media';

export function VideoEditorNode({id,data,selected}:NodeProps){
 const open=useStore(s=>s.openVideoEditor);
 const readonly=useActiveProjectReadOnly();
 const dragging=useStore(s=>s.isConnectionDragging);
 const dragType=useStore(s=>s.connectionDragType);
 const p=data.editProject as VideoEditProject|undefined;
 const output=useStore(s=>s.nodes.find(n=>n.id===data.lastExportNodeId));
 const busy=output?.data.status==='generating'||output?.data.status==='running';
 return <div className="group w-[320px]" onDoubleClick={e=>{e.stopPropagation();if(!readonly)open(id);}}>
  <div className="mb-2 flex items-center gap-2 text-xs text-neutral-200"><Scissors className="h-4 w-4 text-orange-400"/>{p?.name||'剪辑工作台'}</div>
  <div className="relative">
   {/* Canvas normalizes saved wires to these flush anchors, including older null handles. */}
   <Handle id="edge-target-left" type="target" position={Position.Left} isConnectable={!readonly} className="!h-px !w-px !min-h-0 !min-w-0 !border-0 !opacity-0" style={{ pointerEvents:'none' }}/>
   <Handle id="edge-source-right" type="source" position={Position.Right} isConnectable={!readonly} className="!h-px !w-px !min-h-0 !min-w-0 !border-0 !opacity-0" style={{ pointerEvents:'none' }}/>
   <Handle type="target" position={Position.Left} isConnectable={!readonly} className="!left-0 !top-0 !h-full !w-full !rounded-2xl !border-0 !opacity-0" style={{ transform:'none',pointerEvents:!readonly&&dragging&&dragType!=='target'?'auto':'none' }}/>
   <Handle id="edge-source-full" type="source" position={Position.Right} isConnectable={!readonly} className="!left-0 !top-0 !h-full !w-full !rounded-2xl !border-0 !opacity-0" style={{ transform:'none',pointerEvents:!readonly&&dragging&&dragType==='target'?'auto':'none' }}/>
   {/* Keep the actual + handles outside the clipped card. */}
   <Handle id="qc-target-left" type="target" position={Position.Left} isConnectable={!readonly} aria-label="剪辑素材输入连接点" title="连接画布素材" className="!left-[-20px] !z-10 !flex !h-6 !w-6 !items-center !justify-center !rounded-full !border-white/50 !bg-[#1a1d22] !text-white shadow-[0_0_10px_rgba(226,232,240,0.4)]"><Plus className="pointer-events-none h-3 w-3"/></Handle>
   <Handle id="qc-source-right" type="source" position={Position.Right} isConnectable={!readonly} aria-label="剪辑成片输出连接点" title="连接下游节点" className="!right-[-20px] !z-10 !flex !h-6 !w-6 !items-center !justify-center !rounded-full !border-white/50 !bg-[#1a1d22] !text-white shadow-[0_0_10px_rgba(226,232,240,0.4)]"><Plus className="pointer-events-none h-3 w-3"/></Handle>
  <div className={'overflow-hidden rounded-2xl border bg-[#161a22] '+(selected?'border-orange-400':'border-white/15')}>
   <div className="flex h-36 items-center justify-center bg-gradient-to-br from-[#272a35] to-[#12141a]">
    {data.url?<video src={toRenderableMediaUrl(String(data.url))} preload="metadata" muted className="h-full w-full object-contain"/>:<Clapperboard className="h-12 w-12 text-orange-300/70"/>}
   </div>
   <div className="space-y-3 p-4">
    <div className="flex gap-1">{(p?.clips.length?p.clips.slice(0,8):[1,2,3]).map((_,i)=><div key={i} className="h-5 flex-1 rounded-sm border border-orange-300/20 bg-orange-400/25"/>)}</div>
    <div className="flex justify-between text-xs text-neutral-400"><span>{p?.assets.length||0} 个素材 · {p?.clips.length||0} 个片段</span><span>{p?projectDuration(p).toFixed(1):'0.0'} s</span></div>
    <button disabled={readonly} onClick={e=>{e.stopPropagation();open(id);}} className="nodrag flex w-full items-center justify-center gap-2 rounded-lg bg-orange-500 py-2 text-xs text-white hover:bg-orange-600 disabled:opacity-40"><Maximize2 className="h-3.5 w-3.5"/>打开全屏剪辑工作台</button>
    {busy&&<p className="flex items-center gap-2 text-xs text-orange-300"><Loader2 className="h-3 w-3 animate-spin"/>成片导出中，可继续编辑</p>}
    {output?.data.status==='error'&&<p className="text-xs text-red-400">上次导出失败，请查看结果节点</p>}
   </div>
  </div>
  </div>
 </div>;
}
