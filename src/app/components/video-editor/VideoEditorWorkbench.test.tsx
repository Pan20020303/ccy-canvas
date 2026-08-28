// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {webcrypto} from 'node:crypto';
import VideoEditorWorkbench from './VideoEditorWorkbench';
import {importEditorFiles} from './VideoEditorHost';
import {uploadFileWithProgress} from '../../api/projects';
import {editorId,emptyVideoProject,inspectEditorAsset,splitEditorClip,type EditorAsset,type VideoEditProject} from '../../video-editor-project';
import {VideoEditorNode} from '../nodes/VideoEditorNode';
vi.mock('../../api/projects',()=>({uploadFileWithProgress:vi.fn()}));
vi.mock('../../api/client',()=>({apiClient:{post:vi.fn()}}));
vi.mock('../../store',()=>({useStore:(selector:any)=>selector({nodes:[],openVideoEditor:vi.fn(),isConnectionDragging:false}),useActiveProjectReadOnly:()=>false}));
vi.mock('@xyflow/react',()=>({Position:{Left:'left',Right:'right'},Handle:({id,type,children,className,style,...props}:any)=><div data-handle-id={id||'default'} data-handle-type={type} className={className} style={style} aria-label={props['aria-label']}>{children}</div>}));
vi.mock('../../video-editor-project',async()=>({...await vi.importActual('../../video-editor-project'),inspectEditorAsset:vi.fn()}));
let root:Root|undefined;
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.stubGlobal('crypto',{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)});
 vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{});
 vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
 vi.stubGlobal('URL',class extends URL {
  static createObjectURL=vi.fn(()=> 'blob:test-upload');
  static revokeObjectURL=vi.fn();
 });
 vi.mocked(inspectEditorAsset).mockResolvedValue({duration:3,width:640,height:360});
 vi.mocked(uploadFileWithProgress).mockResolvedValue({url:'/uploads/imported.png'} as any);
});
afterEach(()=>{act(()=>root?.unmount());root=undefined;document.body.innerHTML='';vi.restoreAllMocks();vi.unstubAllGlobals();vi.clearAllMocks();});
const image:EditorAsset={id:'canvas-photo',name:'参考图.png',url:'/uploads/photo.png',kind:'image',duration:3};
const video:EditorAsset={id:'canvas-video',name:'视频.mp4',url:'/uploads/video.mp4',kind:'video',duration:4};
const audio:EditorAsset={id:'canvas-audio',name:'配乐.wav',url:'/uploads/music.wav',kind:'audio',duration:2};
it('separates video audio through the toolbar, selects it for editing, and supports undo/redo',async()=>{
 const latest=mount();await click('画布素材');await dropAsset(1);
 await act(async()=>{(document.querySelector('.ve-video-lane .ve-clip') as HTMLElement).click();});
 await click('分离音频');
 expect(latest().audio).toHaveLength(1);expect(latest().clips[0].volume).toBe(0);
 expect(document.querySelector('.ve-audio-lane .selected')).not.toBeNull();
 expect(document.querySelector('audio')?.getAttribute('src')).toContain('/uploads/video.mp4');
 expect(document.querySelector('[aria-label="背景音起点"]')).not.toBeNull();
 await click('撤销');expect(latest().audio).toHaveLength(0);expect(latest().clips[0].volume).toBe(1);
 await click('重做');expect(latest().audio).toHaveLength(1);expect(latest().clips[0].volume).toBe(0);
 await act(async()=>{(document.querySelector('.ve-video-lane .ve-clip') as HTMLElement).click();});
 const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='已分离音频')!;
 expect(button.disabled).toBe(true);
});
function mount(){
 const host=document.createElement('div');host.id='root';document.body.append(host);root=createRoot(host);
 let latest=emptyVideoProject();const onChange=vi.fn((p:VideoEditProject)=>{latest=p;});
 act(()=>root!.render(<VideoEditorWorkbench initialProject={latest} canvasAssets={[image,video,audio]} onChange={onChange} onClose={()=>{}} onExport={()=>{}} onImport={importEditorFiles} onResolveAsset={async a=>a}/>));
 return ()=>latest;
}
async function click(text:string){
 const el=[...document.querySelectorAll('button')].find(e=>e.textContent===text||e.getAttribute('aria-label')===text||e.title===text)!;
 expect(el).toBeTruthy();await act(async()=>{el.click();});
}
async function dropAsset(index:number,at?:number){
 at??=index===2?0:Math.max(0,...[...document.querySelectorAll<HTMLElement>('.ve-video-lane .ve-clip')].map(el=>(parseFloat(el.style.left)+parseFloat(el.style.width))/40));
 const values=new Map<string,string>();
 const dataTransfer={setData:(k:string,v:string)=>values.set(k,v),getData:(k:string)=>values.get(k)||'',files:[]};
 const source=document.querySelectorAll('.ve-asset')[index];
 await act(async()=>{
  const start=new Event('dragstart',{bubbles:true,cancelable:true});Object.defineProperty(start,'dataTransfer',{value:dataTransfer});source.dispatchEvent(start);
  const drop=new MouseEvent('drop',{bubbles:true,cancelable:true,clientX:at!*40});Object.defineProperty(drop,'dataTransfer',{value:dataTransfer});document.querySelector('.ve-tracks')!.dispatchEvent(drop);
 });
}
it('supports HTTP IDs, dragging canvas image/video/audio, copying, and splitting',async()=>{
 expect(globalThis.crypto.randomUUID).toBeUndefined();
 const latest=mount();await click('画布素材');
 await dropAsset(0);await dropAsset(1);await dropAsset(2);
 expect(latest().clips).toHaveLength(2);expect(latest().audio).toHaveLength(1);
 expect(new Set([...latest().clips,...latest().audio].map(c=>c.id)).size).toBe(3);
 await act(async()=>{(document.querySelector('.ve-clip') as HTMLElement).click();});
 await click('复制');expect(latest().clips).toHaveLength(3);
 const split=splitEditorClip(latest(),latest().clips[0].id,1);
 expect(split.clips).toHaveLength(4);
 expect(new Set(split.clips.map(c=>c.id)).size).toBe(4);
 expect(document.body.textContent).not.toContain('randomUUID');
});
it('uploads selected files and adds the resulting asset to the timeline on HTTP',async()=>{
 const latest=mount(),file=new File(['test'],'导入图片.png',{type:'image/png'});
 const input=document.querySelector('input[type=file]')!;
 Object.defineProperty(input,'files',{value:[file],configurable:true});
 await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(uploadFileWithProgress).toHaveBeenCalledWith(file,file.name,expect.any(Function));
 expect(latest().assets).toHaveLength(1);expect(latest().assets[0].url).toBe('/uploads/imported.png');
 expect(latest().assets[0].id).toMatch(/^[0-9a-f]{8}-/);
 expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-upload');
 await click('添加 导入图片.png');expect(latest().clips).toHaveLength(1);
});
it('reports failed uploads without inserting a broken asset and permits retry',async()=>{
 const latest=mount(),file=new File(['test'],'重试.png',{type:'image/png'});
 const input=document.querySelector('input[type=file]')!;
 Object.defineProperty(input,'files',{value:[file],configurable:true});
 vi.mocked(uploadFileWithProgress).mockRejectedValueOnce(new Error('测试上传失败'));
 await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(latest().assets).toHaveLength(0);expect(document.body.textContent).toContain('测试上传失败');
 await act(async()=>{input.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(latest().assets).toHaveLength(1);
});
it('generates distinct non-security IDs even if Web Crypto is unavailable',()=>{
 vi.stubGlobal('crypto',undefined);
 expect(new Set(Array.from({length:1000},editorId)).size).toBe(1000);
});
it('prefers the native UUID implementation on HTTPS',()=>{
 const native=vi.fn(()=> 'native-id');vi.stubGlobal('crypto',{randomUUID:native});
 expect(editorId()).toBe('native-id');expect(native).toHaveBeenCalledOnce();
});
it('renders both + ports outside clipping and exposes Canvas-normalized wire anchors',()=>{
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);
 act(()=>root!.render(<VideoEditorNode {...{id:'editor',data:{},selected:true} as any}/>));
 for(const id of ['qc-target-left','qc-source-right']){
  const handle=document.querySelector('[data-handle-id="'+id+'"]')!;
  expect(handle.querySelector('svg')).not.toBeNull();expect(handle.closest('.overflow-hidden')).toBeNull();
 }
 expect(document.querySelector('[data-handle-id="edge-target-left"]')).not.toBeNull();
expect(document.querySelector('[data-handle-id="edge-source-right"]')).not.toBeNull();
});
it('drags visuals independently, preserves gaps after delete, and aligns detached audio',async()=>{
 const latest=mount();await click('画布素材');await dropAsset(1,0);await dropAsset(0,8);
 const first=document.querySelector('.ve-video-lane .ve-clip') as HTMLElement;
 Object.defineProperty(first,'setPointerCapture',{value:()=>{}});
 const pointer=async(type:string,x:number,target:EventTarget)=>act(async()=>{
  const e=new MouseEvent(type,{clientX:x,button:0,bubbles:true,cancelable:true});
  Object.defineProperty(e,'pointerId',{value:1});target.dispatchEvent(e);
 });
 await pointer('pointerdown',0,first);await pointer('pointermove',80,window);await pointer('pointerup',80,window);
 expect(latest().clips.map(c=>c.at)).toEqual([2,8]);
 expect(document.querySelector('.ve-video-lane .ve-clip')?.getAttribute('style')).toContain('left: 80px');
 await click('分离音频');
 // Move the independent audio away, then restore source synchronization.
 const sound=document.querySelector('.ve-audio-lane .ve-clip') as HTMLElement;
 Object.defineProperty(sound,'setPointerCapture',{value:()=>{}});
 await pointer('pointerdown',80,sound);await pointer('pointermove',160,window);await pointer('pointerup',160,window);
 expect(latest().audio[0].at).toBe(4);
 await click('对齐原视频');expect(latest().audio[0].at).toBe(2);
 await act(async()=>first.click());await click('删除');
 expect(latest().clips).toHaveLength(1);expect(latest().clips[0].at).toBe(8);
 await click('回到开始');expect(document.querySelector('[aria-label="空隙黑场"]')).not.toBeNull();
 await click('撤销');expect(latest().clips).toHaveLength(2);
});
it('adds overlapping visual tracks, previews picture-in-picture and restores edits',async()=>{
 const latest=mount();await click('画布素材');await dropAsset(1,0);
 expect(document.querySelectorAll('[data-video-track]')).toHaveLength(3);
 await click('选择画面轨道 2');await click('添加 参考图.png');
 expect(latest().clips.map(c=>[c.at,c.track])).toEqual([[0,0],[0,1]]);
 const overlay=document.querySelector('[data-video-track="1"] .ve-clip') as HTMLElement;
 await act(async()=>overlay.click());await click('右下画中画');
 expect(latest().clips[1]).toMatchObject({scale:.35,x:.78,y:.78});
 const preview=document.querySelector('[data-preview-track="1"]') as HTMLElement;
 expect(preview.style.width).toBe('35%');expect(preview.style.left).toBe('78%');
 expect(document.querySelectorAll('[data-preview-track]')).toHaveLength(2);
 await click('新增画面轨');expect(document.querySelectorAll('[data-video-track]')).toHaveLength(4);
 expect(latest().videoTracks).toBe(4);
 await click('撤销');expect(document.querySelectorAll('[data-video-track]')).toHaveLength(3);
 await click('还原全画面');expect(latest().clips[1]).toMatchObject({scale:1,x:.5,y:.5});
});
it('drags a clip vertically onto another track without changing its start',async()=>{
 const latest=mount();await click('画布素材');await dropAsset(1,2);
 const target=document.querySelector('[data-video-track="2"]')!;
 vi.spyOn(target,'getBoundingClientRect').mockReturnValue({top:100,bottom:164,height:64} as DOMRect);
 const clip=document.querySelector('[data-video-track="0"] .ve-clip')!;
 const pointer=async(type:string,y:number,target:EventTarget)=>act(async()=>{
  const e=new MouseEvent(type,{clientX:80,clientY:y,button:0,bubbles:true,cancelable:true});
  Object.defineProperty(e,'pointerId',{value:2});target.dispatchEvent(e);
 });
 await pointer('pointerdown',250,clip);await pointer('pointermove',125,window);await pointer('pointerup',125,window);
 expect(latest().clips[0]).toMatchObject({at:2,track:2});
 expect(document.querySelector('[data-video-track="2"] .ve-clip')).not.toBeNull();
 await click('撤销');expect(latest().clips[0]).toMatchObject({at:2,track:0});
});
