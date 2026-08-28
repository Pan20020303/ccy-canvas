import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/styles/index.css';
import VideoTrimDialog from '../../src/app/components/VideoTrimDialog';
import video from '../../src/imports/login-background.mp4';
function Test(){
 const [open,setOpen]=useState(false),[result,setResult]=useState('');
 return <div className="p-10"><button onClick={()=>setOpen(true)}>打开剪辑测试</button><p>{result}</p>
 {open&&<VideoTrimDialog src={video} title="4K 测试素材" onClose={()=>setOpen(false)} onSubmit={s=>{setOpen(false);setResult(JSON.stringify(s));}}/>}</div>;
}
createRoot(document.getElementById('root')!).render(<Test/>);
