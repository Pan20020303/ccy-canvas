import { lazy, Suspense, useState } from 'react';
import { Download, Film, LoaderCircle, Music2, Play, RefreshCw, Scissors, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { toRenderableMediaUrl } from '../../reference-media';
import { inspectEditorAsset, projectDuration, type VideoEditProject } from '../../video-editor-project';
import { importEditorFiles } from '../video-editor/VideoEditorHost';
import { buildFilmTimeline, type FilmProject } from './film-project';
import { exportFilm, filmError, filmStore } from './film-store';
import { downloadFilmMedia } from './FilmMediaEditor';
import { FilmDialog } from './FilmControls';

const VideoEditorWorkbench = lazy(() => import('../video-editor/VideoEditorWorkbench'));
export function FilmPreview({ project: p, userId, onVideoStep }: { project: FilmProject; userId: string; onVideoStep: () => void }) {
  const [editorOpen, setEditorOpen] = useState(false), [updating, setUpdating] = useState(false), [confirmUpdate, setConfirmUpdate] = useState(false), [index, setIndex] = useState(0), [showExport, setShowExport] = useState(true);
  const patch = filmStore(userId, p.cloudId).getState().patch;
  const edit = p.editProject;
  const clips = edit?.clips || [];
  const selected = clips[Math.min(index, Math.max(0, clips.length - 1))];
  const media = edit?.assets.find(a => a.id === selected?.assetId);
  const updateTimeline = async () => {
    setUpdating(true); setConfirmUpdate(false);
    try {
      const shots = await Promise.all(p.shots.map(async shot => shot.videoUrl && !shot.videoDuration ? { ...shot, videoDuration: (await inspectEditorAsset(toRenderableMediaUrl(shot.videoUrl), 'video')).duration } : shot));
      const next = buildFilmTimeline({ ...p, shots });
      if (!next.clips.length) throw new Error('请先生成或上传分镜图片、视频，再更新时间轴。');
      patch({ shots, editProject: next, exportUrl: undefined }); setIndex(0);
      toast.success(`已将 ${next.clips.length} 个镜头加入时间轴`);
    } catch (e) { toast.error(filmError(e)); } finally { setUpdating(false); }
  };
  const exportVideo = async (project: VideoEditProject) => {
    try { setEditorOpen(false); await exportFilm(userId, project, p.cloudId); setShowExport(true); } catch (e) { toast.error(filmError(e)); }
  };
  return <section className="film-preview-stage">
    <div className="film-preview-toolbar">{p.exportUrl && !showExport && <button className="film-button" onClick={() => setShowExport(true)}>查看已导出成片</button>}<span className="film-muted film-small">{clips.length ? `${clips.length} 个片段 · ${projectDuration(edit!).toFixed(1)} 秒` : '等待添加分镜素材'}</span><span className="film-spacer" /><button className="film-button" disabled={updating || p.exporting} onClick={() => clips.length ? setConfirmUpdate(true) : void updateTimeline()}><RefreshCw className={updating ? 'film-spin' : ''} size={15} />更新视频到时间轴</button><button className="film-button" disabled={!clips.length || p.exporting} onClick={() => setEditorOpen(true)}><Scissors size={15} />剪辑 / 配音 / 音乐</button><button className="film-primary" disabled={!clips.length || p.exporting || updating} onClick={() => edit && void exportVideo(edit)}>{p.exporting ? <LoaderCircle className="film-spin" size={16} /> : <Download size={16} />}{p.exporting ? '正在合成…' : '导出视频'}</button></div>
    {p.exportError && <p className="film-error" role="alert">{p.exportError}</p>}
    <div className="film-preview-screen">{p.exportUrl && showExport ? <div className="film-export-player"><video className="film-stage-player" src={toRenderableMediaUrl(p.exportUrl)} controls playsInline /><button className="film-button" onClick={() => void downloadFilmMedia(p.exportUrl!, p.name + '.mp4').catch(e => toast.error(filmError(e)))}><Download size={15} />下载成片</button></div> : media ? <div className="film-export-player">{media.kind === 'video' ? <video key={media.id} className="film-stage-player" src={toRenderableMediaUrl(media.url)} controls playsInline onEnded={() => setIndex(i => Math.min(i + 1, clips.length - 1))} /> : <img className="film-stage-player" src={toRenderableMediaUrl(media.url)} alt={media.name} />}<span className="film-muted film-small">{media.name} · 分镜素材预览，剪辑与混音效果以合成视频为准</span></div> : <div className="film-preview-empty"><Film size={52} strokeWidth={1} /><p>让每个镜头，连成你的故事</p><span className="film-muted film-small">完成分镜后，更新时间轴即可预览与导出</span><button className="film-button" onClick={onVideoStep}><Play size={15} />制作分镜视频</button></div>}</div>
    <div className="film-timeline"><div className="film-time-ruler"><span>00:00</span><span>{edit ? `${projectDuration(edit).toFixed(1)}s` : '00:00'}</span></div>
      <div className="film-track"><span className="film-track-label"><Film size={15} />视频</span><div className="film-track-content film-visual-track">{clips.length ? clips.map((clip, i) => { const a = edit!.assets.find(a => a.id === clip.assetId); return <button className={`film-timeline-clip ${i === index ? 'is-active' : ''}`} style={{ flexGrow: (clip.end - clip.start) / clip.speed }} key={clip.id} onClick={() => { setIndex(i); setShowExport(false); }}>{a?.kind === 'image' && <img className="film-cover" src={toRenderableMediaUrl(a.url)} alt="" />}<span>{String(i + 1).padStart(2, '0')} · {a?.name}</span><small>{((clip.end - clip.start) / clip.speed).toFixed(1)}s</small></button>; }) : <button className="film-track-empty" onClick={onVideoStep}>＋ 还没有视频，快去生成吧～</button>}</div></div>
      <div className="film-track"><span className="film-track-label"><Volume2 size={15} />配音</span><div className="film-track-content film-audio-track">{edit?.audio.length ? edit.audio.map(a => <span className="film-audio-clip" key={a.id}>{edit.assets.find(v => v.id === a.assetId)?.name}</span>) : <span className="film-muted">无 · 可在剪辑工作台导入配音</span>}</div></div>
      <div className="film-track"><span className="film-track-label">字幕</span><div className="film-track-content film-subtitle-track">暂无字幕轨道</div></div>
      <div className="film-track"><span className="film-track-label"><Music2 size={15} />音乐</span><button className="film-track-content film-music-track" disabled={!clips.length} onClick={() => setEditorOpen(true)}>♫ {edit?.audio.length ? '在剪辑工作台调整音频' : '添加背景音乐'}</button></div>
    </div>
    {confirmUpdate && <FilmDialog title="更新时间轴" onClose={() => setConfirmUpdate(false)}><p className="film-dialog-copy">将按当前分镜顺序重建时间轴，已有裁剪、配音和音乐编辑会被替换。</p><footer className="film-dialog-footer"><button className="film-button" onClick={() => setConfirmUpdate(false)}>取消</button><button className="film-primary" onClick={() => void updateTimeline()}>确认更新</button></footer></FilmDialog>}
    {editorOpen && edit && <Suspense fallback={<div className="film-overlay film-loading">正在打开剪辑工作台…</div>}><VideoEditorWorkbench initialProject={edit} onChange={next => patch({ editProject: next, exportUrl: undefined })} onClose={() => setEditorOpen(false)} onExport={next => void exportVideo(next)} onImport={importEditorFiles} onResolveAsset={async asset => ({ ...asset, ...await inspectEditorAsset(toRenderableMediaUrl(asset.url), asset.kind) })} /></Suspense>}
  </section>;
}
