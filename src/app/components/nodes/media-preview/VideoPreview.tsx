import { useEffect, useRef, useState } from 'react';
import { CircleHelp, Loader2, Maximize, Pause, Play, Repeat, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { toRenderableMediaUrl } from '../../../reference-media';
import { clamp, formatMediaTime, videoErrorMessage, type MediaDimensions, type PreviewItem } from './media-preview-model';
import { PreviewButton } from './PreviewButton';

export type PlaybackPreferences = { volume: number; rate: number; loop: boolean };
export function VideoPreview({ item, zh, preferences, onPreferences, onDimensions }: {
  item: PreviewItem;
  zh: boolean;
  preferences: PlaybackPreferences;
  onPreferences: (value: PlaybackPreferences) => void;
  onDimensions: (value: MediaDimensions) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [height, setHeight] = useState(item.height);
  const [dimensions, setDimensions] = useState({ width: item.width || 16, height: item.height || 9 });
  const [buffering, setBuffering] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [help, setHelp] = useState(false);
  const lastVolume = useRef(preferences.volume || 0.7);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = preferences.volume;
    video.muted = preferences.volume === 0;
    video.playbackRate = preferences.rate;
    video.loop = preferences.loop;
  }, [preferences]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let alive = true;
    void video.play()?.catch((failure: unknown) => {
      if (alive && failure instanceof Error && failure.name === 'NotAllowedError') setNotice(zh ? '点击播放开始观看' : 'Click play to start');
    });
    return () => { alive = false; video.pause(); };
  }, [zh]);
  const seek = (value: number) => {
    if (!duration || !videoRef.current) return;
    const next = clamp(value, 0, duration);
    videoRef.current.currentTime = next;
    setTime(next);
  };
  const togglePlay = () => {
    const video = videoRef.current;
    if (!video || error) return;
    if (!video.paused) { video.pause(); return; }
    setNotice('');
    void video.play()?.catch((failure: unknown) => {
      if (failure instanceof Error && failure.name === 'AbortError') return;
      setNotice(zh ? '无法开始播放，请重试或下载原视频。' : 'Playback could not start. Retry or download the original video.');
    });
  };
  const toggleMute = () => {
    if (preferences.volume > 0) lastVolume.current = preferences.volume;
    onPreferences({ ...preferences, volume: preferences.volume > 0 ? 0 : lastVolume.current });
  };
  useEffect(() => {
    const dialog = frameRef.current?.closest('[role="dialog"]');
    if (!dialog) return;
    const handler = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.target instanceof HTMLElement && key.target.closest('input, select, button')) return;
      if (key.key === ' ') { key.preventDefault(); togglePlay(); }
      if (key.key.toLowerCase() === 'm') { key.preventDefault(); toggleMute(); }
      if (key.key === '[') { key.preventDefault(); seek(time - 1); }
      if (key.key === ']') { key.preventDefault(); seek(time + 1); }
    };
    dialog.addEventListener('keydown', handler);
    return () => dialog.removeEventListener('keydown', handler);
  });

  return <div className="media-preview-video-stage">
    <div ref={frameRef} className="media-preview-video-frame" style={{ aspectRatio: `${dimensions.width} / ${dimensions.height}`, width: `min(100%, calc(var(--media-preview-video-height) * ${dimensions.width / dimensions.height}))` }}>
      <video ref={videoRef} className="media-preview-video" src={toRenderableMediaUrl(item.src)} poster={item.poster ? toRenderableMediaUrl(item.poster) : undefined}
        playsInline preload="auto" onClick={togglePlay}
        onLoadedMetadata={event => {
          const video = event.currentTarget;
          setDuration(Number.isFinite(video.duration) ? video.duration : 0);
          if (video.videoWidth && video.videoHeight) {
            const next = { width: video.videoWidth, height: video.videoHeight };
            setDimensions(next); onDimensions(next); setHeight(video.videoHeight);
          }
        }}
        onDurationChange={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onTimeUpdate={event => setTime(event.currentTarget.currentTime)}
        onPlay={() => { setPlaying(true); setNotice(''); }} onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setBuffering(false); }} onWaiting={() => setBuffering(true)}
        onCanPlay={() => setBuffering(false)} onPlaying={() => setBuffering(false)} onSeeked={() => setBuffering(false)}
        onError={event => { setError(videoErrorMessage(event.currentTarget.error?.code, zh)); setBuffering(false); setPlaying(false); }} />
      {error ? <div className="media-preview-status" role="alert"><CircleHelp /><span>{error}</span></div>
        : buffering ? <div className="media-preview-status" role="status"><Loader2 className="media-preview-spin" /><span>{zh ? '正在加载视频…' : 'Loading video…'}</span></div>
          : !playing ? <PreviewButton className="media-preview-play-large" label={zh ? '播放视频' : 'Play video'} onClick={togglePlay}><Play /></PreviewButton> : null}
      {notice && <div className="media-preview-video-notice" role="status">{notice}</div>}
      <div className="media-preview-video-controls" role="toolbar" aria-label={zh ? '视频播放控制' : 'Video controls'}>
        <PreviewButton label={playing ? (zh ? '暂停' : 'Pause') : (zh ? '播放' : 'Play')} disabled={Boolean(error)} onClick={togglePlay}>{playing ? <Pause /> : <Play />}</PreviewButton>
        <PreviewButton label={zh ? '后退 1 秒' : 'Back 1 second'} disabled={!duration || Boolean(error)} onClick={() => seek(time - 1)}><SkipBack /></PreviewButton>
        <PreviewButton label={zh ? '前进 1 秒' : 'Forward 1 second'} disabled={!duration || Boolean(error)} onClick={() => seek(time + 1)}><SkipForward /></PreviewButton>
        <input className="media-preview-seek" type="range" min="0" max={duration || 1} step="0.01" value={time} aria-label={zh ? '视频进度' : 'Video progress'} aria-valuetext={`${formatMediaTime(time)} / ${formatMediaTime(duration)}`} disabled={!duration || Boolean(error)} onChange={event => seek(Number(event.target.value))} />
        <span className="media-preview-time">{formatMediaTime(time, true)} <span>/ {formatMediaTime(duration)}</span></span>
        <select className="media-preview-rate" aria-label={zh ? '播放倍速' : 'Playback speed'} value={preferences.rate} onChange={event => onPreferences({ ...preferences, rate: Number(event.target.value) })}>
          {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}
        </select>
        <PreviewButton label={zh ? '循环播放' : 'Loop playback'} aria-pressed={preferences.loop} onClick={() => onPreferences({ ...preferences, loop: !preferences.loop })}><Repeat /></PreviewButton>
        <div className="media-preview-volume">
          <PreviewButton label={preferences.volume ? (zh ? '静音' : 'Mute') : (zh ? '取消静音' : 'Unmute')} onClick={toggleMute}>{preferences.volume ? <Volume2 /> : <VolumeX />}</PreviewButton>
          <div className="media-preview-volume-popover"><Volume2 /><input type="range" min="0" max="1" step="0.01" value={preferences.volume} aria-label={zh ? '音量' : 'Volume'} onChange={event => onPreferences({ ...preferences, volume: Number(event.target.value) })} /><span>{Math.round(preferences.volume * 100)}</span></div>
        </div>
        {height && <span className="media-preview-resolution" title={zh ? '原视频分辨率，不进行转码' : 'Original resolution; no transcoding'}>{height}p</span>}
        <PreviewButton label={zh ? '全屏播放' : 'Fullscreen'} onClick={() => {
          const request = frameRef.current?.requestFullscreen?.();
          if (!request) { setNotice(zh ? '当前浏览器不支持全屏播放。' : 'Fullscreen is not available.'); return; }
          void request.catch(() => setNotice(zh ? '无法进入全屏，请检查浏览器权限。' : 'Fullscreen could not be opened.'));
        }}><Maximize /></PreviewButton>
        <div className="media-preview-help-wrap"><PreviewButton label={zh ? '播放帮助' : 'Playback help'} aria-expanded={help} onClick={() => setHelp(!help)}><CircleHelp /></PreviewButton>
          {help && <div className="media-preview-help">{zh ? '空格 播放 / 暂停 · M 静音\n[ / ] 后退 / 前进 1 秒\n← / → 切换节点 · Esc 关闭预览\n清晰度为原视频实际分辨率。' : 'Space: play / pause · M: mute\n[ / ]: back / forward 1 second\n← / →: switch node · Esc: close\nResolution is the original video resolution.'}</div>}
        </div>
      </div>
    </div>
  </div>;
}
