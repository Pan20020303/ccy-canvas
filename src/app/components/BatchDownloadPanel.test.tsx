// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import BatchDownloadPanel from './BatchDownloadPanel';
import {buildDownloadZip,saveDownloadBlob,type DownloadItem} from '../batch-download';
vi.mock('../batch-download',()=>({buildDownloadZip:vi.fn(),saveDownloadBlob:vi.fn()}));
let root:Root;
const items:DownloadItem[]=[{id:'a',name:'a',url:'/a.png',kind:'image'},{id:'b',name:'b',url:'/b.mp4',kind:'video'}];
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(()=>{act(()=>root.unmount());document.body.innerHTML='';vi.clearAllMocks();vi.unstubAllGlobals();});
it('automatically saves ZIP and retries only failed items',async()=>{
 vi.mocked(buildDownloadZip).mockResolvedValueOnce({blob:new Blob(['zip']),succeeded:1,failed:[{item:items[1],reason:'HTTP 403'}]})
  .mockResolvedValueOnce({blob:new Blob(['retry']),succeeded:1,failed:[]});
 await act(async()=>root.render(<BatchDownloadPanel items={items} zh onClose={()=>{}}/>));
 expect(saveDownloadBlob).toHaveBeenCalledOnce();
 expect(document.body.textContent).toContain('成功 1 项');
 const retry=[...document.querySelectorAll('button')].find(b=>b.textContent==='仅重试失败项')!;
 await act(async()=>retry.click());
 expect(vi.mocked(buildDownloadZip).mock.calls[1][0]).toEqual([items[1]]);
 expect(saveDownloadBlob).toHaveBeenCalledTimes(2);
});
it('cancels requests on close without saving a late result',async()=>{
 let complete:(value:any)=>void=()=>{};let signal:AbortSignal|undefined;
 vi.mocked(buildDownloadZip).mockImplementation((_items,options)=>{signal=options.signal;return new Promise(r=>{complete=r;});});
 const close=vi.fn();
 await act(async()=>root.render(<BatchDownloadPanel items={items} zh onClose={close}/>));
 await act(async()=>{(document.querySelector('[aria-label="关闭下载面板"]') as HTMLElement).click();});
 expect(signal?.aborted).toBe(true);expect(close).toHaveBeenCalledOnce();
 await act(async()=>root.unmount());
 await act(async()=>complete({blob:new Blob(['late']),succeeded:2,failed:[]}));
 expect(saveDownloadBlob).not.toHaveBeenCalled();
});
