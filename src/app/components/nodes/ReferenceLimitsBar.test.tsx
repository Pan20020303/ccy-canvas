import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getModelTemplate } from '../../model-templates';
import { ReferenceLimitsBar, resolveReferenceLimits, type ReferenceLimits } from './ReferenceLimitsBar';

const empty = { images: 0, videos: 0, audios: 0 };
const render = (limits: ReferenceLimits | null, counts = empty, serviceType = 'image', zh = true) =>
  renderToStaticMarkup(<ReferenceLimitsBar limits={limits} counts={counts} serviceType={serviceType} zh={zh} />);

it.each(['flux2-klein-base-4b-local', 'flux2-klein-base-9b-local'])('shows %s limits before connecting any media', model => {
  const template = getModelTemplate(model);
  const limits = resolveReferenceLimits({ imageRange: template?.referenceImageRange });
  expect(limits?.images).toEqual({ min: 0, max: 4 });
  expect(render(limits)).toContain('图片 ≤ 4');
  expect(render(limits)).toContain('图片参考：0–4');
});

it.each(['krea2-turbo-local', 'z-image-turbo-local', 'z-image-turbo-v60-local'])('marks %s as text-only', model => {
  const limits = resolveReferenceLimits({ imageRange: getModelTemplate(model)?.referenceImageRange });
  expect(render(limits)).toContain('仅文生图 · 不支持参考素材');
  expect(render(limits, { images: 1, videos: 0, audios: 1 })).toContain('不支持音频参考');
  expect(render(limits, { images: 1, videos: 0, audios: 1 })).not.toContain('请切换');
});

it('preserves all-in-one image/video/audio badges even with zero inputs', () => {
  const limits = resolveReferenceLimits({ mode: 'all-in-one' });
  const html = render(limits, empty, 'video');
  for (const chip of ['图片 ≤ 9', '视频 ≤ 3', '音频 ≤ 3']) expect(html).toContain(chip);
  expect(render(limits, { images: 10, videos: 4, audios: 4 }, 'video')).toContain('音频参考最多 3，当前 4');
});

it('honors model-specific mode overrides and first-frame mode changes', () => {
  const limits = resolveReferenceLimits({ mode: 'motion-mimic', override: getModelTemplate('wan-animate-2-motion-local')?.referenceRequirements?.['motion-mimic'] });
  expect(limits?.images).toEqual({ min: 1, max: 1 });
  expect(render(limits, empty, 'video')).toContain('图片参考：1–1');
  const multi = resolveReferenceLimits({ mode: 'multi-image', override: { images: { min: 2, max: 7 } } });
  expect(render(multi, empty, 'video')).toContain('图片 ≤ 7');
  const first = render(resolveReferenceLimits({ mode: 'first-frame' }), empty, 'video');
  expect(first).toContain('图片 ≤ 1');
  expect(first).not.toContain('音频 ≤');
});

it('handles HappyHorse text-only, English, over-limit warnings and unknown capabilities', () => {
  const zero = { min: 0, max: 0 };
  const text = resolveReferenceLimits({ mode: 'multi-image', suffixRequires: { images: zero, videos: zero } });
  expect(render(text, empty, 'video')).toContain('仅文生视频');
  const klein = resolveReferenceLimits({ imageRange: { min: 0, max: 4 } });
  expect(render(klein, { ...empty, images: 5 }, 'image', false)).toContain('Images: at most 4; currently 5');
  expect(render(resolveReferenceLimits({}))).toBe('');
});
