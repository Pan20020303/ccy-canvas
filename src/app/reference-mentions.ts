import { replaceReferenceTags } from './reference-connections';

export type PromptMention = { tag: string; id: string; thumb: string; kind?: string };
export type MentionReference = { id: string; label: string; thumb: string; kind: string };
export const MENTION_WRAP = '\u2060';
export const MENTION_THUMB_SLOT = '\u3000';
export const wrapMentionTag = (label: string) => `${MENTION_WRAP}${MENTION_THUMB_SLOT}${label}${MENTION_WRAP}`;

export function migrateMentionTags(text: string, mentions: PromptMention[]): { text: string; mentions: PromptMention[] } | null {
  const replacements = new Map<string, string>();
  const nextMentions = mentions.map(mention => {
    const old = /^\[@(.+)\]$/.exec(mention.tag);
    const label = old ? old[1].replace(/\s+/g, '')
      : mention.tag.startsWith(MENTION_WRAP) && mention.tag.endsWith(MENTION_WRAP) && mention.tag[1] !== MENTION_THUMB_SLOT
        ? mention.tag.slice(MENTION_WRAP.length, -MENTION_WRAP.length) : null;
    if (label === null) return mention;
    const tag = wrapMentionTag(label);
    replacements.set(mention.tag, tag);
    return { ...mention, tag };
  });
  return replacements.size ? { text: replaceReferenceTags(text, replacements), mentions: nextMentions } : null;
}

/** Stable node identity governs chip labels; unbound prose is left untouched. */
export function synchronizeReferenceMentions(text: string, mentions: PromptMention[], references: MentionReference[]) {
  const byId = new Map(references.map(ref => [ref.id, ref]));
  const replacements = new Map<string, string>();
  let removed = false;
  const nextMentions = mentions.flatMap(mention => {
    const ref = byId.get(mention.id);
    const tag = ref ? wrapMentionTag(ref.label) : '';
    replacements.set(mention.tag, tag);
    if (!ref) { removed = true; return []; }
    return [{ ...mention, tag, thumb: ref.thumb, kind: ref.kind }];
  });
  let nextText = replaceReferenceTags(text, replacements);
  if (removed) nextText = nextText.replace(/[^\S\n]{2,}/g, ' ').replace(/[^\S\n]+\n/g, '\n');
  return { text: nextText, mentions: nextMentions };
}

/** The prompt panel's exact conversion before runNode, including every repeated chip. */
export function resolvePromptMentionTags(raw: string, mentions: PromptMention[], references: MentionReference[], numberedMedia: boolean): string {
  const byId = new Map(references.map(ref => [ref.id, ref]));
  const replacements = new Map<string, string>();
  for (const mention of mentions) {
    const ref = byId.get(mention.id);
    const numbered = numberedMedia && ref && ['image', 'video', 'audio'].includes(ref.kind);
    replacements.set(mention.tag, numbered ? `@${ref.label}` : `@${mention.id.slice(0, 12)}`);
  }
  return replaceReferenceTags(raw, replacements).split(MENTION_WRAP).join('');
}
