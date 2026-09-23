import { describe, expect, it } from 'vitest';
import { migrateMentionTags, resolvePromptMentionTags, synchronizeReferenceMentions, wrapMentionTag } from './reference-mentions';

describe('stable reference chips', () => {
  const refs = [{ id: 'same-prefix-image', label: '图片1', kind: 'image', thumb: '/image.png' }, { id: 'same-prefix-audio', label: '音频1', kind: 'audio', thumb: '' }];
  it('round trips literal bound references and repeated tokens without changing prose or spacing', () => {
    const text = '角色  保持@图片1，声音取@音频1。\n再用@图片1和@音频1。';
    const mentions = refs.map(ref => ({ tag: `@${ref.label}`, id: ref.id, thumb: ref.thumb, kind: ref.kind }));
    const chips = synchronizeReferenceMentions(text, mentions, refs);
    expect(chips.text).toContain(wrapMentionTag('音频1'));
    expect(resolvePromptMentionTags(chips.text, chips.mentions, refs, true)).toBe(text);
  });
  it('renumbers by stable identity after removing an earlier media input', () => {
    const text = '@图片1注视@图片2';
    const mentions = [{ tag: '@图片1', id: 'removed', thumb: '' }, { tag: '@图片2', id: refs[0].id, thumb: '/image.png' }];
    const chips = synchronizeReferenceMentions(text, mentions, refs);
    expect(resolvePromptMentionTags(chips.text, chips.mentions, refs, true)).toBe('注视@图片1');
  });
  it('migrates both legacy forms and replaces all repeats', () => {
    const oldAudio = '\u2060音频1\u2060';
    const text = `[@图片 1] [@图片 1] ${oldAudio}`;
    const migrated = migrateMentionTags(text, [{ tag: '[@图片 1]', id: refs[0].id, thumb: '' }, { tag: oldAudio, id: refs[1].id, thumb: '' }])!;
    expect(resolvePromptMentionTags(migrated.text, migrated.mentions, refs, true)).toBe('@图片1 @图片1 @音频1');
  });
});
