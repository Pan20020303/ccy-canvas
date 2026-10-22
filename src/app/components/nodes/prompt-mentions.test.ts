import { describe, expect, it } from 'vitest';
import { mentionLabel, migrateMentionTags, promptMentionParts, promptMentionTrigger, readablePromptMentions, replacePromptMention, resolvePromptMentions, wrapMentionTag } from './prompt-mentions';
const a = { tag: wrapMentionTag('角色A_很长的文件名.png·1'), id: 'asset-a-1234567890', thumb: '/a.png', kind: 'image' };
const b = { tag: wrapMentionTag('角色B.png·2'), id: 'asset-b-1234567890', thumb: '/b.png', kind: 'image' };
describe('canvas prompt mention identity', () => {
  it('changes one repeated occurrence and preserves all other bindings', () => {
    const raw = a.tag + a.tag + b.tag + a.tag;
    const result = replacePromptMention(raw, [a, b], a.tag.length, a.tag, b)!;
    expect(promptMentionParts(result.text, result.mentions).filter(p => p.mention).map(p => p.mention?.id)).toEqual([a.id, b.id, b.id, a.id]);
    expect(resolvePromptMentions(result.text, result.mentions)).toBe(`@${a.id.slice(0, 12)}@${b.id.slice(0, 12)}@${b.id.slice(0, 12)}@${a.id.slice(0, 12)}`);
  });
  it('resolves every repeated and adjacent mention for generation', () => {
    expect(resolvePromptMentions(a.tag + b.tag + a.tag, [a, b])).toBe(`@${a.id.slice(0, 12)}@${b.id.slice(0, 12)}@${a.id.slice(0, 12)}`);
  });
  it('finds only the newest @ without consuming an adjacent chip or @', () => {
    expect(promptMentionTrigger(a.tag + '@', a.tag.length + 1)).toEqual({ start: a.tag.length, end: a.tag.length + 1, query: '' });
    expect(promptMentionTrigger('@@', 2)).toEqual({ start: 1, end: 2, query: '' });
    expect(promptMentionTrigger(a.tag, a.tag.length)).toBeNull();
  });
  it('does not modify a different occurrence when a picker position becomes stale', () => {
    expect(replacePromptMention(a.tag + b.tag, [a, b], 1, a.tag, b)).toBeNull();
  });
  it('preserves full file names independently of display truncation', () => {
    expect(mentionLabel(a)).toBe('角色A_很长的文件名.png·1');
    expect(readablePromptMentions(a.tag + b.tag, [a, b])).toBe('@角色A_很长的文件名.png·1@角色B.png·2');
  });
  it('migrates old repeated labels without collapsing occurrences', () => {
    const old = { ...a, tag: '[@图片 1]' };
    const result = migrateMentionTags(old.tag + old.tag, [old])!;
    expect(promptMentionParts(result.text, result.mentions).filter(p => p.mention)).toHaveLength(2);
    expect(resolvePromptMentions(result.text, result.mentions)).toBe(`@${a.id.slice(0, 12)}@${a.id.slice(0, 12)}`);
  });
});
