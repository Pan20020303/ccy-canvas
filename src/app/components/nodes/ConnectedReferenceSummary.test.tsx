import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectedReferenceSummary } from './ConnectedReferenceSummary';

it('keeps audio count and filenames visible outside the thumbnail scroller', () => {
  const images = Array.from({ length: 8 }, (_, i) => ({ id: `image-${i}`, kind: 'image', index: i + 1, sourceName: `图${i + 1}` }));
  const html = renderToStaticMarkup(<ConnectedReferenceSummary zh refs={[...images,
    { id: 'audio-1', kind: 'audio', index: 1, sourceName: '@音频1 苏灵雨.MP3' },
    { id: 'audio-2', kind: 'audio', index: 2, sourceName: '@音频2 关肥.mp3' },
  ]} />);
  expect(html).toContain('已绑定：');
  expect(html).toContain('8 张图片 · 2 条音频');
  expect(html).toContain('音频1 · 苏灵雨.MP3');
  expect(html).toContain('音频2 · 关肥.mp3');
  expect(html).toContain('data-reference-audio-id="audio-2"');
  expect(html).not.toContain('overflow-x');
});

it('does not invent an audio binding for a silent segment or an empty graph', () => {
  const imageOnly = renderToStaticMarkup(<ConnectedReferenceSummary zh refs={[{ id: 'i1', kind: 'image', index: 1, sourceName: '烛龙' }]} />);
  expect(imageOnly).toContain('1 张图片');
  expect(imageOnly).toContain('0 条音频');
  expect(imageOnly).not.toContain('data-reference-audio-id');
  expect(renderToStaticMarkup(<ConnectedReferenceSummary zh refs={[]} />)).toBe('');
});
