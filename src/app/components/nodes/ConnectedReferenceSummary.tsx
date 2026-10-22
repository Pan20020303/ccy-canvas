export function ConnectedReferenceSummary({ refs, zh }: {
  refs: { id: string; kind: string; index: number; sourceName: string }[];
  zh: boolean;
}) {
  const images = refs.filter(ref => ref.kind === 'image').length;
  const videos = refs.filter(ref => ref.kind === 'video').length;
  const audios = refs.filter(ref => ref.kind === 'audio');
  if (!images && !videos && !audios.length) return null;
  const counts = [images ? (zh ? `${images} 张图片` : `${images} images`) : '', videos ? (zh ? `${videos} 条视频` : `${videos} videos`) : '', zh ? `${audios.length} 条音频` : `${audios.length} audio clips`].filter(Boolean);
  return <div aria-label={zh ? '已绑定参考素材' : 'Bound references'} className="mb-2 space-y-1 px-1 text-[10px]">
    <p className="text-cyan-300">{zh ? '已绑定：' : 'Bound: '}{counts.join(' · ')}</p>
    {audios.length ? <div className="flex flex-wrap gap-x-3 gap-y-1 text-emerald-300">{audios.map(ref => (
      <span key={ref.id} data-reference-audio-id={ref.id} title={ref.sourceName} className="max-w-full break-words">
        {zh ? '音频' : 'Audio '}{ref.index} · {ref.sourceName.replace(/^@音频\s*\d+\s*[｜|·]?\s*/, '')}
      </span>
    ))}</div> : null}
  </div>;
}
