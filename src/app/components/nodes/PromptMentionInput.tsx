import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { toRenderableMediaUrl } from '../../reference-media';
import { mentionLabel, promptMentionParts, readablePromptMentions, type PromptMention } from './prompt-mentions';
import './prompt-mentions.css';

export function readPromptInput(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (node instanceof HTMLElement) {
    if (node.dataset.promptTag) return node.dataset.promptTag;
    if (node.tagName === 'BR') return '\n';
  }
  return [...node.childNodes].map((child, index) => `${index && child instanceof HTMLElement && /^(DIV|P)$/.test(child.tagName) ? '\n' : ''}${readPromptInput(child)}`).join('');
}
function selectionOffsets(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const range = selection.getRangeAt(0), before = range.cloneRange();
  before.selectNodeContents(root); before.setEnd(range.startContainer, range.startOffset);
  const start = readPromptInput(before.cloneContents()).length;
  before.setEnd(range.endContainer, range.endOffset);
  return { start, end: readPromptInput(before.cloneContents()).length };
}
function pointAt(root: Node, offset: number): [Node, number] {
  let remaining = offset;
  for (let index = 0; index < root.childNodes.length; index++) {
    const node = root.childNodes[index], size = readPromptInput(node).length;
    if (remaining <= size) {
      if (node.nodeType === Node.TEXT_NODE) return [node, remaining];
      if (node instanceof HTMLElement && (node.dataset.promptTag || node.tagName === 'BR')) return [root, index + (remaining ? 1 : 0)];
      return pointAt(node, remaining);
    }
    remaining -= size;
  }
  return [root, root.childNodes.length];
}
function setSelection(root: HTMLElement, start: number, end = start) {
  const range = document.createRange(); range.setStart(...pointAt(root, Math.max(0, start))); range.setEnd(...pointAt(root, Math.max(start, end)));
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}
export type PromptInputHandle = {
  element: HTMLDivElement; value: string; selectionStart: number; selectionEnd: number; scrollTop: number;
  focus: () => void; blur: () => void; setSelectionRange: (start: number, end: number) => void;
  caretRect: (offset: number) => { left: number; top: number };
};
type Props = {
  value: string; mentions: PromptMention[]; placeholder: string; expanded?: boolean; height: number;
  onChange: (value: string) => void; onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onMentionClick: (mention: PromptMention, start: number, rect: DOMRect) => void;
  onMentionHover: (id: string, rect: DOMRect) => void; onMouseLeave: () => void; onTextClick: () => void;
};
export const PromptMentionInput = forwardRef<PromptInputHandle, Props>(function PromptMentionInput(props, ref) {
  const root = useRef<HTMLDivElement>(null), composing = useRef(false), savedSelection = useRef({ start: 0, end: 0 });
  const capture = () => { if (root.current) savedSelection.current = selectionOffsets(root.current) || savedSelection.current; return savedSelection.current; };
  useImperativeHandle(ref, () => ({
    get element() { return root.current!; },
    get value() { return readPromptInput(root.current!); },
    get selectionStart() { return capture().start; }, get selectionEnd() { return capture().end; },
    get scrollTop() { return root.current!.scrollTop; }, set scrollTop(value: number) { root.current!.scrollTop = value; },
    focus: () => root.current?.focus(), blur: () => root.current?.blur(),
    setSelectionRange: (start, end) => { savedSelection.current = { start, end }; if (root.current) setSelection(root.current, start, end); },
    caretRect: offset => {
      const el = root.current!, range = document.createRange(); range.setStart(...pointAt(el, offset)); range.collapse(true);
      const rect = range.getClientRects?.()[0] || el.getBoundingClientRect();
      return { left: rect.left, top: rect.bottom || rect.top + 22 };
    },
  }));
  const signature = JSON.stringify(props.mentions);
  useLayoutEffect(() => {
    const el = root.current; if (!el || composing.current) return;
    const focused = document.activeElement === el, selection = capture(), scroll = el.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const part of promptMentionParts(props.value, props.mentions)) {
      if (!part.mention) { fragment.append(document.createTextNode(part.text)); continue; }
      const mention = part.mention, chip = document.createElement('span');
      chip.className = 'canvas-mention-chip'; chip.contentEditable = 'false'; chip.dataset.promptTag = part.text; chip.dataset.mentionStart = String(part.start); chip.dataset.mentionId = mention.id;
      chip.title = mentionLabel(mention); chip.setAttribute('aria-label', `引用：${mentionLabel(mention)}`);
      if (mention.thumb) {
        const img = document.createElement('img'); img.src = toRenderableMediaUrl(mention.thumb, { thumbWidth: 720 }); img.alt = ''; img.draggable = false; chip.append(img);
      } else {
        const icon = document.createElement('span'); icon.className = 'canvas-mention-icon'; icon.textContent = ({ audio: '♪', video: '▶', text: 'T' } as Record<string, string>)[mention.kind || ''] || '#'; chip.append(icon);
      }
      const label = document.createElement('span'); label.className = 'canvas-mention-label'; label.textContent = mentionLabel(mention); chip.append(label);
      const arrow = document.createElement('span'); arrow.className = 'canvas-mention-arrow'; arrow.textContent = '⌄'; chip.append(arrow);
      fragment.append(chip);
    }
    // A text position after the final chip lets consecutive references retain
    // a real caret even when there is no intervening whitespace.
    if (props.value) fragment.append(document.createTextNode('')); el.replaceChildren(fragment);
    if (focused) setSelection(el, Math.min(selection.start, props.value.length), Math.min(selection.end, props.value.length));
    el.scrollTop = scroll;
  }, [props.value, signature]);
  const input = () => { if (!composing.current && root.current) { capture(); props.onChange(readPromptInput(root.current)); } };
  const insertText = (text: string) => {
    const el = root.current; if (!el) return;
    const { start, end } = capture(); setSelection(el, start, end);
    const selection = window.getSelection(), range = selection?.getRangeAt(0); if (!range) return;
    range.deleteContents(); const node = document.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection!.removeAllRanges(); selection!.addRange(range); input();
  };
  const copy = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const el = root.current; if (!el) return;
    const { start, end } = capture(), text = readPromptInput(el).slice(start, end);
    event.preventDefault(); event.clipboardData.setData('text/plain', readablePromptMentions(text, props.mentions));
    event.clipboardData.setData('application/x-ccy-prompt', JSON.stringify({ text, tags: props.mentions.filter(m => text.includes(m.tag)).map(m => m.tag) }));
  };
  return <div ref={root} contentEditable suppressContentEditableWarning role="textbox" aria-label="生成提示词" aria-multiline="true"
    className={`canvas-prompt-input prompt-editor-scroll ${props.expanded ? 'is-expanded' : ''}`} data-placeholder={props.placeholder}
    style={props.expanded ? undefined : { height: props.height }} onInput={input} onBlur={capture} onKeyUp={capture} onMouseUp={capture}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; input(); }}
    onKeyDown={event => { if (event.nativeEvent.isComposing) return; props.onKeyDown(event); if (event.key === 'Enter' && !event.defaultPrevented) { event.preventDefault(); insertText('\n'); } }}
    onClick={event => {
      capture(); const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-prompt-tag]');
      if (!chip) { props.onTextClick(); return; }
      const mention = props.mentions.find(m => m.tag === chip.dataset.promptTag);
      if (mention) props.onMentionClick(mention, Number(chip.dataset.mentionStart), chip.getBoundingClientRect());
    }}
    onMouseMove={event => {
      const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-prompt-tag]');
      if (chip) props.onMentionHover(chip.dataset.mentionId!, chip.getBoundingClientRect()); else props.onMouseLeave();
    }} onMouseLeave={props.onMouseLeave} onWheel={event => event.stopPropagation()}
    onCopy={copy} onCut={event => { copy(event); insertText(''); }}
    onPaste={event => {
      event.preventDefault(); let text = event.clipboardData.getData('text/plain');
      try { const rich = JSON.parse(event.clipboardData.getData('application/x-ccy-prompt')); if (typeof rich.text === 'string' && Array.isArray(rich.tags) && rich.tags.every((t: string) => props.mentions.some(m => m.tag === t))) text = rich.text; } catch { /* External clipboard content is always plain text. */ }
      insertText(text);
    }} onDrop={event => event.preventDefault()} />;
});
