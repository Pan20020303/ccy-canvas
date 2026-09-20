export type PromptMention = { tag: string; id: string; thumb: string; kind?: string };
export const MENTION_WRAP = '\u2060';
export const MENTION_THUMB_SLOT = '\u3000';
export const wrapMentionTag = (label: string) => `${MENTION_WRAP}${MENTION_THUMB_SLOT}${label}${MENTION_WRAP}`;
export const mentionLabel = (mention: PromptMention) => mention.tag.replace(/^\[@|\]$/g, '').split(MENTION_WRAP).join('').replace(/^\u3000/, '');

export function migrateMentionTags(text: string, mentions: PromptMention[]): { text: string; mentions: PromptMention[] } | null {
  let changed = false;
  const next = mentions.map(m => {
    const old = /^\[@(.+)\]$/.exec(m.tag);
    const needsSlot = m.tag.startsWith(MENTION_WRAP) && m.tag.endsWith(MENTION_WRAP) && m.tag[1] !== MENTION_THUMB_SLOT;
    if (!old && !needsSlot) return m;
    changed = true;
    const tag = wrapMentionTag(old ? old[1].replace(/\s+/g, '') : mentionLabel(m));
    text = text.split(m.tag).join(tag);
    return { ...m, tag };
  });
  return changed ? { text, mentions: next } : null;
}

export function promptMentionParts(text: string, mentions: PromptMention[]) {
  const byTag = new Map(mentions.filter(m => m.tag).map(m => [m.tag, m]));
  const tags = [...byTag.keys()].sort((a, b) => b.length - a.length);
  const parts: { text: string; start: number; mention?: PromptMention }[] = [];
  let start = 0;
  if (tags.length) {
    const pattern = new RegExp(tags.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    for (const match of text.matchAll(pattern)) {
      if (match.index! > start) parts.push({ text: text.slice(start, match.index), start });
      parts.push({ text: match[0], start: match.index!, mention: byTag.get(match[0]) });
      start = match.index! + match[0].length;
    }
  }
  if (start < text.length || !parts.length) parts.push({ text: text.slice(start), start });
  return parts;
}

export function promptMentionTrigger(text: string, cursor: number) {
  // Never consume a previous mention or a preceding @ in a run of @@.
  const match = /@([^\s@\u2060]*)$/.exec(text.slice(0, cursor));
  return match ? { start: cursor - match[0].length, end: cursor, query: match[1] } : null;
}

export function replacePromptMention(text: string, mentions: PromptMention[], start: number, currentTag: string, next: PromptMention) {
  if (start < 0 || text.slice(start, start + currentTag.length) !== currentTag) return null;
  return {
    text: text.slice(0, start) + next.tag + text.slice(start + currentTag.length),
    mentions: [...mentions.filter(m => m.tag !== next.tag), next],
  };
}

export function resolvePromptMentions(text: string, mentions: PromptMention[]) {
  return promptMentionParts(text, mentions).map(p => p.mention ? `@${p.mention.id.slice(0, 12)}` : p.text).join('').split(MENTION_WRAP).join('');
}
export function readablePromptMentions(text: string, mentions: PromptMention[]) {
  return promptMentionParts(text, mentions).map(p => p.mention ? `@${mentionLabel(p.mention)}` : p.text).join('').split(MENTION_WRAP).join('');
}
