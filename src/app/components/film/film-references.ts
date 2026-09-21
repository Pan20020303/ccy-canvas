import { isModeSatisfied, type ReferenceModeKey } from '../../reference-modes';
import { filmMediaPayload, filmShotPrompt, type FilmGenerationSettings, type FilmModel, type FilmProject, type FilmReference, type FilmShot } from './film-project';

export const filmRefToken = (ref: Pick<FilmReference, 'id'>) => `@{${ref.id}}`;
export function filmReferenceLabels(refs: FilmReference[]) {
  const counts = { image: 0, video: 0, audio: 0 };
  return refs.map(ref => ({ ...ref, label: `@${ref.kind}${++counts[ref.kind]}`, wireLabel: `@${{ image: '图像', video: '视频', audio: '音频' }[ref.kind]}${counts[ref.kind]}` }));
}
export function filmDisplayPrompt(prompt: string, refs: FilmReference[]) {
  const labels = filmReferenceLabels(refs);
  return prompt.replace(/@\{([^}\r\n]+)\}/g, (_, id: string) => labels.find(r => r.id === id)?.label || '@已移除素材');
}
export function filmReferences(p: FilmProject, target: string, kind: 'asset' | 'image' | 'video'): FilmReference[] {
  const item = kind === 'asset' ? p.assets.find(a => a.id === target) : p.shots.find(s => s.id === target);
  if (!item) return [];
  // Older explicit selections remain explicit; new editor choices enable live bindings.
  if (item.autoBindReferences === false || (item.references !== undefined && item.autoBindReferences === undefined)) return item.references || [];
  const shot = kind === 'asset' ? undefined : p.shots.find(s => s.id === target);
  const bound: FilmReference[] = shot ? shot.assetIds.flatMap(id => {
    const asset = p.assets.find(a => a.id === id);
    return asset?.url ? [{ id: `asset:${id}`, assetId: id, name: asset.name, kind: 'image' as const, url: asset.url, duration: 0, layer: asset.type === 'audio' ? 'other' as const : asset.type }] : [];
  }) : [];
  if (shot?.imageUrl) bound.push({ id: `shot:${shot.id}`, name: '本镜头分镜图', kind: 'image', url: shot.imageUrl, duration: 0, layer: 'other' });
  if (p.settings.styleImage) bound.push({ id: 'project-style', name: '画风参考', kind: 'image', url: p.settings.styleImage, duration: 0, layer: 'other' });
  const excluded = new Set(item.excludedReferenceIds || []);
  const automatic = bound.filter(r => !excluded.has(r.id));
  const custom = (item.references || []).filter(r => !r.assetId && !r.id.startsWith('shot:') && r.id !== 'project-style');
  const seen = new Set<string>();
  return [...automatic, ...custom].filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
}
export function filmReferencePrompt(prompt: string, refs: FilmReference[]) {
  // A reference legend is not a substitute for the user's generation prompt.
  if (!prompt.trim()) return '';
  const labeled = filmReferenceLabels(refs);
  const text = prompt.replace(/@\{([^}\r\n]+)\}/g, (_, id: string) => {
    const ref = labeled.find(r => r.id === id);
    if (!ref) throw new Error('提示词中有已移除的引用，请重新选择 @ 素材。');
    return ref.wireLabel;
  }).replace(/@(image|video|audio)(\d+)\b/g, (_, kind: string, num: string) => `@${{ image: '图像', video: '视频', audio: '音频' }[kind]}${num}`);
  const links = labeled.map(r => `${r.wireLabel}：${r.layer === 'character' ? '人物' : r.layer === 'scene' ? '场景' : r.layer === 'prop' ? '道具' : '参考'}「${r.name}」`);
  return links.length ? `${text}\n\n本镜头参考素材绑定（按下列图片/视频/音频序号使用，不混入其他镜头）：\n${links.join('\n')}` : text;
}
export function filmGenerationValues(model: FilmModel | undefined, p: FilmProject, saved: FilmGenerationSettings, shot?: FilmShot) {
  const t = model?.template, resolutions = t?.resolutionOptions || [], ratios = t?.aspectRatioOptions || [p.settings.ratio];
  const duration = saved.duration ?? (Number.parseFloat(shot?.duration || '') || t?.durationRange?.defaultValue || t?.durationOptions?.[0] || 4);
  const finiteDuration = Number.isFinite(duration) ? duration : t?.durationRange?.defaultValue || 4;
  const modes = t?.referenceModes?.length ? t.referenceModes : ['text-to-video', 'multi-image'] as ReferenceModeKey[];
  let mode = saved.mode || (p.settings.method === 'reference' ? 'all-in-one' : 'first-frame');
  if (!saved.mode && shot) {
    const refs = filmReferences(p, shot.id, 'video');
    const counts = { images: refs.filter(r => r.kind === 'image').length, videos: refs.filter(r => r.kind === 'video').length, audios: refs.filter(r => r.kind === 'audio').length };
    // Character/scene reference images must not accidentally become a first/last
    // frame pair. Prefer reference modes when multiple bound assets are present.
    const preferred: ReferenceModeKey[] = refs.length > 1 || p.settings.method === 'reference' ? ['all-in-one', 'multi-image', 'first-frame', 'text-to-video'] : ['first-frame', 'all-in-one', 'multi-image', 'text-to-video'];
    mode = preferred.find(m => modes.includes(m) && isModeSatisfied(m, counts, t?.referenceRequirements?.[m])) || mode;
  }
  return { ratio: ratios.includes(saved.ratio || p.settings.ratio) ? saved.ratio || p.settings.ratio : ratios[0],
    resolution: resolutions.includes(saved.resolution || '') ? saved.resolution! : t?.defaults?.resolution || resolutions[0] || '',
    duration: t?.supportsAutoDuration && finiteDuration === -1 ? -1 : t?.durationOptions?.length ? (t.durationOptions.includes(finiteDuration) ? finiteDuration : t.durationOptions[0]) : Math.max(t?.durationRange?.min ?? 1, Math.min(t?.durationRange?.max ?? 30, Math.round(finiteDuration / (t?.durationRange?.step || 1)) * (t?.durationRange?.step || 1))),
    mode: modes.includes(mode) ? mode : modes[0], audio: saved.audio ?? true,
    quality: t?.qualityOptions?.includes(saved.quality || '') ? saved.quality : t?.defaults?.quality || t?.qualityOptions?.[0] || '',
    outputFormat: t?.outputFormatOptions?.includes(saved.outputFormat || '') ? saved.outputFormat : t?.defaults?.outputFormat || t?.outputFormatOptions?.[0] || '' };
}
export function filmShotVideoRequest(p: FilmProject, shot: FilmShot, models: FilmModel[]) {
  const saved = shot.generation?.video || {}, key = saved.modelKey || p.settings.videoModel;
  const model = key ? models.find(m => m.key === key && m.type === 'video') : models.find(m => m.type === 'video');
  if (!model) throw new Error(`「${shot.title}」的视频模型不可用，请重新选择。`);
  const refs = filmReferences(p, shot.id, 'video');
  const params = filmGenerationValues(model, p, saved, shot);
  if (p.settings.method !== 'reference' && !shot.imageUrl) throw new Error(`请先生成「${shot.title}」的分镜图。`);
  return filmMediaPayload(model, p, filmReferencePrompt(filmShotPrompt(shot, true), refs), 'video', refs, params);
}
export function filmImageRequest(p: FilmProject, target: string, kind: 'asset' | 'image', models: FilmModel[]) {
  const asset = kind === 'asset' ? p.assets.find(a => a.id === target) : undefined;
  const shot = kind === 'image' ? p.shots.find(s => s.id === target) : undefined;
  const item = asset || shot;
  if (!item) throw new Error('素材已经不存在。');
  const saved = item.generation?.image || {}, key = saved.modelKey || p.settings.imageModel;
  const model = key ? models.find(m => m.key === key && m.type === 'image') : models.find(m => m.type === 'image');
  if (!model) throw new Error('图片模型不可用，请重新选择。');
  const refs = filmReferences(p, target, kind);
  const prompt = asset ? asset.generationPrompt || asset.description : filmShotPrompt(shot!, false);
  return filmMediaPayload(model, p, filmReferencePrompt(prompt, refs), 'image', refs, filmGenerationValues(model, p, saved, shot));
}
