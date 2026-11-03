import { expect, it, vi } from 'vitest';
import { trimLocalVideo } from './video-edit';
import { apiClient } from './client';
vi.mock('./client',()=>({apiClient:{ post:vi.fn() }}));
it('sends trim parameters to the dedicated endpoint, not AI generation',async()=>{
 const result={url:'/uploads/clip.mp4',engine:'ffmpeg',duration:2,width:320,height:240,has_audio:true};
 vi.mocked(apiClient.post).mockResolvedValue(result);
 expect(await trimLocalVideo({media_url:'/api/app/proxy-media?url=https%3A%2F%2Fexample.com%2Fvideo.mp4',start:1,end:3,mute:false,node_id:'trim-test'})).toBe(result);
 expect(apiClient.post).toHaveBeenCalledWith('/api/app/video/trim',{
  media_url:'https://example.com/video.mp4',start:1,end:3,mute:false,node_id:'trim-test',
 },expect.any(AbortSignal));
});
