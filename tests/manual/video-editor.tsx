import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import VideoEditorWorkbench from '../../src/app/components/video-editor/VideoEditorWorkbench';
import {emptyVideoProject,appendEditorAsset,type EditorAsset} from '../../src/app/video-editor-project';
import video from '../../src/imports/login-background.mp4';
const asset:EditorAsset={id:'test-video',name:'测试画面.mp4',url:video,kind:'video',duration:4.435};
function Fixture(){
 const [open,setOpen]=useState(false),[project,setProject]=useState(appendEditorAsset(emptyVideoProject(),asset)),[result,setResult]=useState('');
 return <><button onClick={()=>setOpen(true)}>打开剪辑工作台</button><p>{result}</p>
 {open&&<VideoEditorWorkbench initialProject={project} canvasAssets={[asset]} onChange={setProject} onClose={()=>setOpen(false)}
 onExport={p=>{setResult('导出 '+p.clips.length+' 个片段');setOpen(false);}}
 onImport={async()=>[asset]} onResolveAsset={async a=>a}/>}</>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
