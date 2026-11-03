// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fitMedia, requestMediaPreviewAction, useMediaPreviewAction } from './media-preview-utils';
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
let root: Root | undefined;
afterEach(() => { if(root) act(() => root!.unmount()); root = undefined; document.body.replaceChildren(); });
it('fits small images to the window and preserves aspect ratio', () => {
 expect(fitMedia(430,430,1600,800)).toEqual({width:800,height:800,scale:800/430});
 expect(fitMedia(720,1280,1600,800)).toEqual({width:450,height:800,scale:.625});
 expect(fitMedia(3840,2160,1600,900)).toEqual({width:1600,height:900,scale:1600/3840});
});
it('has a finite layout before metadata arrives', () => {
 const size=fitMedia(0,0,0,0); expect(Number.isFinite(size.width)).toBe(true); expect(size.width).toBeGreaterThan(0);
});
it('dispatches tools to only the matching node and removes listeners on close', () => {
 const first=vi.fn(), second=vi.fn();
 function Listener({id,handler}:{id:string;handler:typeof first}) {useMediaPreviewAction(id,handler);return null;}
 const host=document.createElement('div'); document.body.append(host); root=createRoot(host);
 act(() => root!.render(<><Listener id="one" handler={first}/><Listener id="two" handler={second}/></>));
 act(() => requestMediaPreviewAction('two','edit'));
 expect(first).not.toHaveBeenCalled();expect(second).toHaveBeenCalledExactlyOnceWith('edit');
 act(() => requestMediaPreviewAction('one','upscale')); expect(first).toHaveBeenCalledExactlyOnceWith('upscale');
 act(() => root!.unmount());root=undefined;
 requestMediaPreviewAction('one','edit');expect(first).toHaveBeenCalledTimes(1);
});
