import {expect,it} from 'vitest';
import {emptyVideoProject,appendEditorAsset,clipDuration,projectDuration,splitEditorClip,moveEditorClip,validateEditorProject,editorExportPayload,clipAt,detachEditorAudio,normalizeEditorTimeline,patchEditorClip,alignEditorAudio,snapEditorPosition,activeEditorLayers,editorTrackCount,copyEditorClip} from './video-editor-project';
function fixture(){return appendEditorAsset(emptyVideoProject(),{id:'source',name:'test',url:'/uploads/test.mp4',kind:'video',duration:4});}
it('detaches cropped/speed-adjusted video audio at its timeline offset without changing the source',()=>{
 let p=fixture();p=appendEditorAsset(p,{id:'second',name:'second.mp4',url:'/uploads/second.mp4',kind:'video',duration:10});
 p.clips[0].speed=2;p.clips[1]={...p.clips[1],start:2,end:8,speed:1.5,volume:.6};
 const original=JSON.parse(JSON.stringify(p)),id=p.clips[1].id;
 const next=detachEditorAudio(p,id),sound=next.audio[0];
 expect(p).toEqual(original);expect(next.clips[1].volume).toBe(0);expect(next.clips[0].volume).toBe(1);
 expect(sound).toMatchObject({start:2,end:8,speed:1.5,volume:.6,at:4,sourceClipId:id});
 expect(clipDuration(sound)).toBe(4);expect(projectDuration(next)).toBe(projectDuration(p));
 expect(editorExportPayload(next,'n').audio[0]).toEqual({media_url:'/uploads/second.mp4',kind:'audio',start:2,end:8,speed:1.5,volume:.6,at:4});
 expect(validateEditorProject(next)).toBe('');expect(detachEditorAudio(next,id)).toBe(next);
 expect(JSON.parse(JSON.stringify(next))).toEqual(next);
});
it('rejects duplicate separation, non-video selection, and too many audio clips',()=>{
 let p=appendEditorAsset(emptyVideoProject(),{id:'still',name:'image',url:'/a.png',kind:'image',duration:3});
 expect(detachEditorAudio(p,p.clips[0].id)).toBe(p);expect(detachEditorAudio(p,'missing')).toBe(p);
 p=fixture();const id=p.clips[0].id;
 for(let i=0;i<8;i++)p=appendEditorAsset(p,{id:'sound-'+i,name:'sound',url:'/sound.wav',kind:'audio',duration:2});
 expect(()=>detachEditorAudio(p,id)).toThrow('最多 8');
});
it('splits independent audio using its offset and speed and keeps video unchanged',()=>{
 const p=detachEditorAudio(fixture(),fixture().clips[0].id);
 expect(p.audio).toHaveLength(0);
 const base=fixture();const next=detachEditorAudio(base,base.clips[0].id);
 next.audio[0]={...next.audio[0],start:1,end:4,speed:2,at:1};
 const split=splitEditorClip(next,next.audio[0].id,1.5);
 expect(split.audio).toHaveLength(2);expect(split.clips).toEqual(next.clips);
 expect(split.audio[0]).toMatchObject({start:1,end:2,at:1,speed:2});
 expect(split.audio[1]).toMatchObject({start:2,end:4,at:1.5,speed:2});
 expect(splitEditorClip(next,next.audio[0].id,.5)).toBe(next);
});
it('adds video clips and keeps audio on a separate track',()=>{
 let p=fixture();p=appendEditorAsset(p,{id:'sound',name:'audio',url:'/uploads/a.wav',kind:'audio',duration:2});
 expect(projectDuration(p)).toBe(4);expect(p.clips).toHaveLength(1);expect(p.audio).toHaveLength(1);expect(p.audio[0].at).toBe(0);
});
it('splits at the playhead with correct source offsets, including speed',()=>{
 let p=fixture();p.clips[0].speed=2;
 p=splitEditorClip(p,p.clips[0].id,.5);
 expect(p.clips).toHaveLength(2);expect(p.clips[0].end).toBe(1);expect(p.clips[1].start).toBe(1);
 expect(projectDuration(p)).toBe(2);expect(clipDuration(p.clips[1])).toBe(1.5);
 expect(clipAt(p,.75)?.clip.id).toBe(p.clips[1].id);
});
it('reorders clips without changing source ranges or total duration',()=>{
 let p=fixture();p=splitEditorClip(p,p.clips[0].id,1);const second=p.clips[1].id;
 p=moveEditorClip(p,second,p.clips[0].id);expect(p.clips[0].id).toBe(second);expect(projectDuration(p)).toBe(4);
});
it('validates exports and keeps aspect ratio and clip parameters in the payload',()=>{
 const p=fixture();p.ratio='9:16';p.resolution='720p';
 expect(validateEditorProject(p)).toBe('');
 const payload=editorExportPayload(p,'node');expect(payload.width).toBe(720);expect(payload.height).toBe(1280);
 expect(payload.clips[0]).toEqual({media_url:'/uploads/test.mp4',kind:'video',start:0,end:4,speed:1,volume:1,at:0,track:0,scale:1,x:.5,y:.5});
 p.clips[0].end=8;expect(validateEditorProject(p)).toContain('时长');
 p.clips[0].end=4;p.assets[0].url='blob:unfinished';expect(validateEditorProject(p)).toContain('上传');
});
it('serializes a re-openable project without browser-only file objects',()=>{
const p=fixture();expect(JSON.parse(JSON.stringify(p))).toEqual(p);
});
it('keeps old project positions when migrating and preserves gaps through edits and export',()=>{
 let p=fixture();p=appendEditorAsset(p,{id:'b',name:'b',url:'/b.mp4',kind:'video',duration:2});
 const legacy={...p,clips:p.clips.map(({at,...c})=>c)};
 const normalized=normalizeEditorTimeline(legacy);expect(normalized.clips.map(c=>c.at)).toEqual([0,4]);
 const moved=patchEditorClip(normalized,normalized.clips[1].id,{at:8});
 expect(moved.clips[0].at).toBe(0);expect(projectDuration(moved)).toBe(10);
 expect(clipAt(moved,6)).toBeNull();expect(clipAt(moved,8)?.clip.id).toBe(moved.clips[1].id);
 const trimmed=patchEditorClip(moved,moved.clips[0].id,{end:2});
 expect(trimmed.clips[1].at).toBe(8);
 const deleted={...trimmed,clips:trimmed.clips.slice(1)};
 expect(clipAt(deleted,0)).toBeNull();expect(projectDuration(deleted)).toBe(10);
 expect(editorExportPayload(deleted,'n')).toMatchObject({free_timeline:true,clips:[{at:8}]});
 expect(JSON.parse(JSON.stringify(moved))).toEqual(moved);
 expect(()=>patchEditorClip(moved,moved.clips[1].id,{at:3})).toThrow('重叠');
});
it('aligns audio starts/ends and restores source sync after trimming or changing speed',()=>{
 let p=fixture();p=patchEditorClip(p,p.clips[0].id,{at:5,speed:2});p=detachEditorAudio(p,p.clips[0].id);
 const id=p.audio[0].id,target=p.clips[0].id;
 p=patchEditorClip(p,id,{at:12,start:1,end:3,speed:1});
 expect(alignEditorAudio(p,id,target,'start').audio[0].at).toBe(5);
 expect(alignEditorAudio(p,id,target,'end').audio[0].at).toBe(5);
 expect(alignEditorAudio(p,id,target,'source').audio[0]).toMatchObject({at:5.5,speed:2,start:1,end:3});
 expect(projectDuration(p)).toBe(14);
});
it('snaps both clip edges to audio/video edges and supports disabling snapping',()=>{
 const base=fixture();base.clips[0].at=5;
 expect(snapEditorPosition(base,'other',4.9,1,.2,0)).toMatchObject({at:5,guide:5});
 expect(snapEditorPosition(base,'other',3.9,1,.2,0)).toMatchObject({at:4,guide:5});
 expect(snapEditorPosition(base,'other',4.9,1,.2,0,false)).toEqual({at:4.9,guide:null});
 expect(snapEditorPosition(base,'other',-1,1,.2,0).at).toBe(0);
 expect(snapEditorPosition(base,'other',700,1,.2,0).at).toBe(599);
});
it('overlaps different tracks, preserves layer order and exports transforms',()=>{
 let p=fixture();const base=p.clips[0];
 p=appendEditorAsset(p,p.assets[0],0,2);
 p=appendEditorAsset(p,p.assets[0],1,1);
 p=patchEditorClip(p,p.clips[1].id,{scale:.35,x:.78,y:.78});
 expect(editorTrackCount(p)).toBe(3);
 expect(activeEditorLayers(p,2).map(c=>c.track)).toEqual([0,1,2]);
 expect(activeEditorLayers(p,4.5).map(c=>c.track)).toEqual([1]);
 expect(validateEditorProject(p)).toBe('');
 expect(editorExportPayload(p,'n')).toMatchObject({multi_track:true,clips:[{track:0},{track:2,scale:.35,x:.78,y:.78},{track:1}]});
 expect(()=>patchEditorClip(p,p.clips[1].id,{track:0})).toThrow('重叠');
 for(const patch of [{track:8},{track:-1},{track:1.5},{scale:0},{scale:2},{x:NaN},{y:1.2}]){
  expect(()=>patchEditorClip(p,base.id,patch)).toThrow();
 }
 const copy=copyEditorClip(p,base.id);
 expect(copy.clips.at(-1)).toMatchObject({track:0,at:4});
 const appended=appendEditorAsset(p,p.assets[0],undefined,2);
 expect(appended.clips.at(-1)).toMatchObject({track:2,at:4});
 expect(JSON.parse(JSON.stringify(p))).toEqual(p);
});
