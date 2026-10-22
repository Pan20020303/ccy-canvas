import { useEffect, useRef, useState } from 'react';
import * as Range from '@radix-ui/react-slider';
import { Scissors, Play, RotateCcw, Volume2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';
import { toRenderableMediaUrl } from '../reference-media';

export type VideoTrimSelection = { start: number; end: number; mute: boolean };
export function validTrimSelection(start: number, end: number, duration: number) {
 return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(duration) &&
  start >= 0 && end <= duration && end <= 3600 && end-start >= 0.1 && end-start <= 600;
}
export default function VideoTrimDialog({ src, title, zh = true, onClose, onSubmit }: {
 src: string; title?: string; zh?: boolean; onClose: () => void;
 onSubmit: (selection: VideoTrimSelection) => void;
}) {
 const video = useRef<HTMLVideoElement>(null);
 const submitted = useRef(false);
 const previewing = useRef(false);
 const metadataLoaded = useRef(false);
 const [duration, setDuration] = useState(0);
 const [start, setStart] = useState(0);
 const [end, setEnd] = useState(0);
 const [position, setPosition] = useState(0);
 const [mute, setMute] = useState(false);
 const [error, setError] = useState('');
 const [attempt, setAttempt] = useState(0);
 useEffect(() => {
  const current = video.current;
  const timeout = window.setTimeout(() => {
   if (!metadataLoaded.current) setError(zh ? '视频加载超时，请重试' : 'Video loading timed out. Retry.');
  }, 30000);
  return () => { clearTimeout(timeout); current?.pause(); };
 }, [src, attempt, zh]);
 const valid = !error && validTrimSelection(start,end,duration);
 const seek = (time: number) => {
  if (video.current && duration > 0 && Number.isFinite(time)) {
   video.current.pause(); previewing.current=false;
   video.current.currentTime=Math.max(0,Math.min(time,duration));
  }
 };
 const preview = async () => {
  if (!valid || !video.current) return;
  video.current.currentTime=start; previewing.current=true;
  try { await video.current.play(); } catch { previewing.current=false; }
 };
 const button = 'rounded-lg border border-white/15 px-3 py-2 text-xs hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed';
 return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
  <DialogContent className="nodrag nopan nowheel flex max-h-[94vh] flex-col overflow-y-auto border-white/10 bg-[#12151b] text-neutral-100 sm:max-w-5xl">
   <DialogHeader>
    <DialogTitle className="flex items-center gap-2"><Scissors className="h-5 w-5 text-orange-400" />{zh ? '视频剪辑' : 'Trim video'}<span className="rounded-full bg-orange-500/10 px-2 py-1 text-[10px] text-orange-300">FFmpeg · {zh ? '本地' : 'Local'}</span></DialogTitle>
    <DialogDescription>{zh ? '截取原视频，不调用 AI、不消耗生成积分。原文件保持不变。' : 'Trim the original video locally. No AI or generation credits. Original stays unchanged.'}</DialogDescription>
   </DialogHeader>
   <div className="relative flex h-[38vh] min-h-48 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-black">
    <video key={attempt} ref={video} src={toRenderableMediaUrl(src)} controls playsInline preload="metadata" muted={mute}
     aria-label={zh ? '剪辑预览' : 'Trim preview'}
     className="h-full w-full object-contain"
     onLoadedMetadata={event => {
      const d=event.currentTarget.duration;
      if (!Number.isFinite(d) || d < 0.1) { setError(zh ? '视频时长无效，无法剪辑' : 'Invalid video duration'); return; }
      metadataLoaded.current=true;
      setDuration(d); setStart(0); setEnd(Math.floor(Math.min(d,600)*1000)/1000); setError('');
     }}
     onTimeUpdate={event => {
      const v=event.currentTarget; setPosition(v.currentTime);
      if (previewing.current && v.currentTime >= end) { v.pause(); previewing.current=false; v.currentTime=end; }
     }}
     onError={() => setError(zh ? '视频加载失败，请检查素材或重试' : 'Video failed to load. Check the source or retry.')}
    />
    {error && <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 text-sm">
     <span>{error}</span><button className={button} onClick={() => {metadataLoaded.current=false;setError('');setDuration(0);setAttempt(x=>x+1);}}>{zh ? '重试加载' : 'Retry'}</button>
    </div>}
   </div>
   <div className="flex justify-between gap-3 text-xs text-neutral-400"><span className="truncate">{title || (zh ? '原视频' : 'Source video')}</span><span>{position.toFixed(2)} / {duration.toFixed(2)} s</span></div>
   <Range.Root min={0} max={duration || 1} step={0.01} minStepsBetweenThumbs={10} value={[start,end]} disabled={!duration || !!error}
    onValueChange={([a,b]) => { setStart(a);setEnd(b);seek(a !== start ? a : b); }}
    className="relative flex h-10 w-full touch-none select-none items-center">
    <Range.Track className="relative h-3 grow rounded-full bg-white/10"><Range.Range className="absolute h-full rounded-full bg-orange-500/70" /></Range.Track>
    <Range.Thumb aria-label={zh ? '开始位置' : 'Start handle'} className="block h-7 w-3 rounded border-2 border-orange-300 bg-orange-500 focus:outline-2 focus:outline-white" />
    <Range.Thumb aria-label={zh ? '结束位置' : 'End handle'} className="block h-7 w-3 rounded border-2 border-orange-300 bg-orange-500 focus:outline-2 focus:outline-white" />
   </Range.Root>
   <div className="grid gap-4 sm:grid-cols-3">
    <label className="space-y-2 text-xs text-neutral-400">{zh ? '开始时间（秒）' : 'Start (seconds)'}
     <input aria-label={zh ? '开始时间（秒）' : 'Start (seconds)'} type="number" min={0} max={end-0.1} step={0.01} value={start} onChange={e => {setStart(Number(e.target.value));seek(Number(e.target.value));}} className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white" />
     <button type="button" disabled={!duration} className={button+' w-full'} onClick={() => setStart(Number(position.toFixed(2)))}>{zh ? '当前画面设为起点' : 'Set start at playhead'}</button>
    </label>
    <label className="space-y-2 text-xs text-neutral-400">{zh ? '结束时间（秒）' : 'End (seconds)'}
     <input aria-label={zh ? '结束时间（秒）' : 'End (seconds)'} type="number" min={start+0.1} max={duration} step={0.01} value={end} onChange={e => {setEnd(Number(e.target.value));seek(Number(e.target.value));}} className="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white" />
     <button type="button" disabled={!duration} className={button+' w-full'} onClick={() => setEnd(Number(position.toFixed(2)))}>{zh ? '当前画面设为终点' : 'Set end at playhead'}</button>
    </label>
    <div className="rounded-lg bg-white/5 p-3 text-xs text-neutral-400">
     <p>{zh ? '选中片段' : 'Selected duration'}</p><p className="my-1 text-2xl font-semibold text-orange-300">{Math.max(0,end-start).toFixed(2)} <span className="text-xs">s</span></p>
     <p>MP4 · H.264 / AAC</p><p className="mt-1">{zh ? '保持原分辨率和帧率' : 'Keep source size and frame rate'}</p>
    </div>
   </div>
   {!valid && duration > 0 && !error && <p role="alert" className="text-xs text-red-400">{zh ? '请在原视频内选择 0.1–600 秒的片段，结束位置不超过 3600 秒。' : 'Select a 0.1–600s range within the source, ending before 3600s.'}</p>}
   <div className="flex flex-wrap items-center gap-3 border-t border-white/10 pt-4">
    <button className={button+' flex items-center gap-2'} disabled={!valid} onClick={() => void preview()}><Play className="h-3.5 w-3.5"/>{zh ? '播放选中片段' : 'Preview selection'}</button>
    <button className={button+' flex items-center gap-2'} disabled={!duration} onClick={() => {setStart(0);setEnd(Math.min(duration,600));seek(0);}}><RotateCcw className="h-3.5 w-3.5"/>{zh ? '重置' : 'Reset'}</button>
    <label className="flex items-center gap-2 text-xs"><Volume2 className="h-4 w-4"/><input type="checkbox" checked={!mute} onChange={e=>setMute(!e.target.checked)}/>{zh ? '保留原声' : 'Keep audio'}</label>
    <button className="ml-auto rounded-lg bg-orange-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-40" disabled={!valid} onClick={() => {
     if (!valid || submitted.current) return;
     submitted.current=true;video.current?.pause();onSubmit({start,end,mute});
    }}>{zh ? '导出到新节点' : 'Export to new node'}</button>
   </div>
   <p className="text-[11px] text-neutral-500">{zh ? '最高 4K · 输入 ≤512 MB · 导出 ≤190 MB · 点击导出后可继续使用画布' : 'Up to 4K · input ≤512 MB · output ≤190 MB · continue using the canvas while exporting'}</p>
  </DialogContent>
 </Dialog>;
}
