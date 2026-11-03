import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import JSZip from 'jszip';
import {BatchSizeError,buildDownloadZip,collectDownloadItems,downloadEntryName,type DownloadItem} from './batch-download';
const item=(id:string,kind:DownloadItem['kind']='image'):DownloadItem=>({id,name:'同名.png',kind,url:'/uploads/'+id+'.png'});
beforeEach(()=>vi.stubGlobal('fetch',vi.fn()));
afterEach(()=>vi.unstubAllGlobals());
it('collects uploaded, generated and editor outputs, excluding empty/non-media nodes',()=>{
 const items=collectDownloadItems([
  {id:'a',type:'referenceImageNode',data:{referenceValue:'/uploads/a.jpg',sourceName:'上传.jpg'}},
  {id:'b',type:'videoNode',data:{url:'https://media.test/b.mp4',customTitle:'成片'}},
  {id:'c',type:'referenceAudioNode',data:{url:'/uploads/c.wav'}},
  {id:'d',type:'videoEditorNode',data:{url:'/uploads/d.mp4'}},
  {id:'e',type:'layerEditorNode',data:{url:'/uploads/e.png'}},
  {id:'f',type:'imageNode',data:{status:'generating'}},
  {id:'g',type:'textNode',data:{url:'/uploads/no.png'}},
  {id:'h',type:'imageNode',data:{url:'javascript:alert(1)'}},
 ]);
 expect(items.map(i=>i.id)).toEqual(['a','b','c','d','e']);
 expect(items[0].name).toBe('上传.jpg');expect(items[1].name).toBe('成片');
});
it('sanitizes names, uses actual media MIME extension and avoids duplicate names',()=>{
 const a={...item('a'),name:'../危险:文件.png'};
 expect(downloadEntryName(a,0,'image/jpeg')).toBe('image/001--危险-文件.jpg');
 expect(downloadEntryName(item('b'),1,'image/jpeg')).not.toBe(downloadEntryName(item('a'),0,'image/jpeg'));
});
it('packs original bytes with one proxy layer and reports failed files without URLs',async()=>{
 vi.mocked(fetch).mockImplementation(async input=>{
  if(String(input).includes('bad'))return new Response('denied',{status:403});
  return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/jpeg'}});
 });
 const controller=new AbortController(),progress=vi.fn();
 const a={...item('a'),url:'/api/app/proxy-media?url='+encodeURIComponent('https://media.test/a.jpg')};
 const result=await buildDownloadZip([a,item('bad')],{signal:controller.signal,onProgress:progress});
 expect(result.succeeded).toBe(1);expect(result.failed).toHaveLength(1);
 expect(fetch).toHaveBeenCalledWith('/api/app/proxy-media?url=https%3A%2F%2Fmedia.test%2Fa.jpg',expect.objectContaining({credentials:'include',signal:expect.any(AbortSignal)}));
 const zip=await JSZip.loadAsync(await result.blob!.arrayBuffer());
 expect(await zip.file('image/001-同名.jpg')!.async('uint8array')).toEqual(new Uint8Array([1,2,3]));
 expect(await zip.file('下载失败清单.txt')!.async('string')).toContain('HTTP 403');
 expect(await zip.file('下载失败清单.txt')!.async('string')).not.toContain('/uploads/');
 expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({phase:'zip',percent:100}));
});
it('does not save an HTML error page disguised as a successful download',async()=>{
 vi.mocked(fetch).mockResolvedValue(new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}}));
 const r=await buildDownloadZip([item('a')],{signal:new AbortController().signal,onProgress:()=>{}});
 expect(r.blob).toBeNull();expect(r.failed[0].reason).toContain('不是媒体');
});
it('enforces byte budget for chunked responses with no Content-Length',async()=>{
 vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array(20),{headers:{'Content-Type':'video/mp4'}}));
 await expect(buildDownloadZip([item('a')],{signal:new AbortController().signal,onProgress:()=>{},maxBytes:10})).rejects.toBeInstanceOf(BatchSizeError);
});
it('cancels in-flight requests and never finishes a ZIP after cancellation',async()=>{
 const abort=new AbortController();
 vi.mocked(fetch).mockImplementation((_input,init)=>new Promise((_resolve,reject)=>{
  init!.signal!.addEventListener('abort',()=>reject(init!.signal!.reason));
 }));
 const result=buildDownloadZip([item('a')],{signal:abort.signal,onProgress:()=>{}});
 abort.abort();
 await expect(result).rejects.toMatchObject({name:'AbortError'});
});
it('limits simultaneous media requests to three and rejects oversized selections',async()=>{
 let active=0,peak=0;
 vi.mocked(fetch).mockImplementation(async()=>{
  active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;
  return new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});
 });
 const r=await buildDownloadZip(Array.from({length:12},(_,i)=>item(String(i))),{signal:new AbortController().signal,onProgress:()=>{}});
 expect(r.succeeded).toBe(12);expect(peak).toBe(3);
 await expect(buildDownloadZip(Array.from({length:501},(_,i)=>item(String(i))),{signal:new AbortController().signal,onProgress:()=>{}})).rejects.toThrow('500');
});
