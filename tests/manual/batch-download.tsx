import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/styles/index.css';
import BatchDownloadPanel from '../../src/app/components/BatchDownloadPanel';
import {collectDownloadItems,type DownloadItem} from '../../src/app/batch-download';
import video from '../../src/imports/login-background.mp4';
const nodes=[
 {id:'image',type:'referenceImageNode',data:{sourceName:'测试图片.svg',url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="orange"/></svg>')}},
 {id:'video',type:'videoNode',data:{customTitle:'测试视频',url:video}},
 {id:'empty',type:'imageNode',data:{url:''}},
];
function Test(){
 const [items,setItems]=useState<DownloadItem[]|null>(null);
 return <div className="relative h-screen p-10"><h1>批量下载交互测试</h1><p>模拟框选 3 个节点（1 图、1 视频、1 空节点）</p>
 <button className="m-4 rounded bg-orange-600 p-3" disabled={!!items} onClick={()=>setItems(collectDownloadItems(nodes))}>批量下载 (2)</button>
 <button className="m-4 rounded border p-3" disabled={!!items} onClick={()=>setItems([...collectDownloadItems(nodes),{id:'missing',name:'失效素材',kind:'image',url:'/tests/manual/missing-media.png'}])}>测试部分失败</button>
 {items&&<BatchDownloadPanel items={items} zh onClose={()=>setItems(null)}/>}</div>;
}
createRoot(document.getElementById('root')!).render(<Test/>);
