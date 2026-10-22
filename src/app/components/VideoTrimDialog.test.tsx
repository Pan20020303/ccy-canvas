// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import VideoTrimDialog, { validTrimSelection } from './VideoTrimDialog';
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
let root: Root | undefined;
afterEach(()=>{ act(()=>root?.unmount());root=undefined;document.body.innerHTML='';vi.restoreAllMocks();vi.useRealTimers(); });
function mount() {
 vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);
 const submit=vi.fn(),close=vi.fn();
 act(()=>root!.render(<VideoTrimDialog src="/clip.mp4" onClose={close} onSubmit={submit}/>));
 return {submit,close};
}
function click(text: string) {
 const b=[...document.querySelectorAll('button')].find(b=>b.textContent===text)!;
 act(()=>b.click());
}
it('validates finite, ordered, bounded selections',()=>{
 expect(validTrimSelection(1,3,4)).toBe(true);
 for(const r of [[-1,1,4],[3,1,4],[0,5,4],[0,601,900],[0,NaN,4]])expect(validTrimSelection(...r as [number,number,number])).toBe(false);
});
it('waits for metadata, exports once, and keeps the original audio by default',()=>{
 const {submit}=mount();
 click('导出到新节点');expect(submit).not.toHaveBeenCalled();
 const v=document.querySelector('video')!;
 Object.defineProperty(v,'duration',{value:4,configurable:true});
 act(()=>v.dispatchEvent(new Event('loadedmetadata')));
 expect(document.body.textContent).toContain('4.00');
 click('导出到新节点');click('导出到新节点');
 expect(submit).toHaveBeenCalledExactlyOnceWith({start:0,end:4,mute:false});
});
it('supports silent export and refuses export on playback errors',()=>{
 const {submit}=mount();const v=document.querySelector('video')!;
 Object.defineProperty(v,'duration',{value:5});
 act(()=>v.dispatchEvent(new Event('loadedmetadata')));
 const checkbox=document.querySelector('input[type=checkbox]') as HTMLInputElement;
 act(()=>checkbox.click());
 act(()=>v.dispatchEvent(new Event('error')));
 click('导出到新节点');expect(submit).not.toHaveBeenCalled();
 expect(document.body.textContent).toContain('视频加载失败');
 click('重试加载');expect(document.querySelector('video')).not.toBe(v);
});
it('does not show a false timeout after metadata loaded through the portal',()=>{
 vi.useFakeTimers();
 mount();const v=document.querySelector('video')!;
 Object.defineProperty(v,'duration',{value:4});
 act(()=>v.dispatchEvent(new Event('loadedmetadata')));
 act(()=>vi.advanceTimersByTime(31000));
 expect(document.querySelector('[role=alert]')).toBeNull();
});
it('submits mute=true when original audio is unchecked',()=>{
 const {submit}=mount();const v=document.querySelector('video')!;
 Object.defineProperty(v,'duration',{value:4});
 act(()=>v.dispatchEvent(new Event('loadedmetadata')));
 act(()=>(document.querySelector('input[type=checkbox]') as HTMLInputElement).click());
 click('导出到新节点');
 expect(submit).toHaveBeenCalledExactlyOnceWith({start:0,end:4,mute:true});
});
