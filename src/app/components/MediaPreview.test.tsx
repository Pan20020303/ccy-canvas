// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MediaPreview, { PreviewVideo } from './MediaPreview';
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const mocks = vi.hoisted(() => ({ options: [] as any[], destroy: vi.fn() }));
vi.mock('plyr', () => ({ default: class { constructor(_video: unknown, options: unknown) { mocks.options.push(options); } destroy() { mocks.destroy(); } } }));
vi.mock('yet-another-react-lightbox', () => ({ default: (props: any) => <div>
  {props.toolbar.buttons.filter((b: unknown) => b !== 'close')}
  {props.render.slide({slide:props.slides[0],rect:{width:1000,height:600}})}
</div> }));
vi.mock('yet-another-react-lightbox/plugins/zoom', () => ({ default: () => {} }));
vi.mock('yet-another-react-lightbox/plugins/fullscreen', () => ({ default: () => {} }));
let root: Root | undefined;
function mount(element: React.ReactNode) {
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);act(() => root!.render(element));return host;
}
function click(label: string) { const b=[...document.querySelectorAll('button')].find(e=>e.textContent?.includes(label)); expect(b).toBeTruthy();act(() => b!.click()); }
afterEach(() => { if(root) act(() => root!.unmount());root=undefined;document.body.replaceChildren();vi.restoreAllMocks();mocks.options.length=0;mocks.destroy.mockClear(); });
it('fits loaded images and retries the exact same URL without changing signatures', () => {
 mount(<MediaPreview kind="image" src="data:image/png;base64,AA==" onClose={()=>{}} onDownload={async()=>{}} />);
 const img=document.querySelector('img')!;
 Object.defineProperties(img,{naturalWidth:{value:430},naturalHeight:{value:430}});
 act(() => img.dispatchEvent(new Event('load')));
 expect(img.style.width).toBe('600px');
 act(() => img.dispatchEvent(new Event('error')));
 expect(document.body.textContent).toContain('素材加载失败');
 click('重新加载');const retry=document.querySelector('img')!;
 expect(retry).not.toBe(img);expect(retry.getAttribute('src')).toBe('data:image/png;base64,AA==');
});
it('routes edit/upscale actions and prevents duplicate downloads', async () => {
 const edit=vi.fn(), upscale=vi.fn();let finish!:()=>void;
 const download=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 mount(<MediaPreview kind="image" src="data:image/png;base64,AA==" onClose={()=>{}} onDownload={download} onEdit={edit} onUpscale={upscale}/>);
 click('编辑图片');click('超分');expect(edit).toHaveBeenCalledOnce();expect(upscale).toHaveBeenCalledOnce();
 click('下载原文件');click('下载中');expect(download).toHaveBeenCalledOnce();
 await act(async()=>{finish();});
 expect(document.body.textContent).toContain('下载原文件');
});
it('initializes locally hosted player controls, reports metadata and destroys on retry/close', () => {
 vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
 vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{});
 const dimensions=vi.fn();
 mount(<PreviewVideo src="/sample.webm" zh rect={{width:1000,height:600}} onDimensions={dimensions}/>);
 const video=document.querySelector('video')!;
 expect(video.getAttribute('src')).toBe('/sample.webm');
 expect(mocks.options[0].iconUrl).not.toMatch(/^https?:/);
 expect(mocks.options[0].storage.enabled).toBe(false);
 expect(mocks.options[0].keyboard.global).toBe(false);
 expect(mocks.options[0].speed.options).toContain(2);
 Object.defineProperties(video,{videoWidth:{value:720},videoHeight:{value:1280}});
 act(()=>video.dispatchEvent(new Event('loadedmetadata')));
 expect(dimensions).toHaveBeenCalledWith(720,1280);
 act(()=>video.dispatchEvent(new Event('error')));expect(document.body.textContent).toContain('素材加载失败');
 click('重新加载');expect(mocks.destroy).toHaveBeenCalledTimes(1);expect(document.querySelector('video')).not.toBe(video);
 act(()=>root!.unmount());root=undefined;expect(mocks.destroy).toHaveBeenCalledTimes(2);expect(document.querySelector('video')).toBeNull();
});
