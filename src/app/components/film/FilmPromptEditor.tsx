import { useLayoutEffect, useRef, useState } from 'react';
import { Film, Music2 } from 'lucide-react';
import type { FilmReference } from './film-project';
import { filmDisplayPrompt, filmReferenceLabels, filmRefToken } from './film-references';
import { toRenderableMediaUrl } from '../../reference-media';

export function readFilmPrompt(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (node instanceof HTMLElement) {
    if (node.dataset.filmRef) return filmRefToken({ id: node.dataset.filmRef });
    if (node.tagName === 'BR') return '\n';
  }
  return Array.from(node.childNodes).map((child, i) => `${i > 0 && child instanceof HTMLElement && ['DIV', 'P'].includes(child.tagName) ? '\n' : ''}${readFilmPrompt(child)}`).join('');
}
function caret(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0).cloneRange(); range.selectNodeContents(root); range.setEnd(selection.anchorNode!, selection.anchorOffset);
  return readFilmPrompt(range.cloneContents()).length;
}
function moveCaret(root: HTMLElement, offset: number) {
  const range = document.createRange(); let remaining = offset;
  for (const node of Array.from(root.childNodes)) {
    const size = readFilmPrompt(node).length;
    if (remaining <= size) {
      if (node.nodeType === Node.TEXT_NODE) range.setStart(node, remaining);
      else if (remaining === 0) range.setStartBefore(node); else range.setStartAfter(node);
      range.collapse(true); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range); return;
    }
    remaining -= size;
  }
  range.selectNodeContents(root); range.collapse(false); window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
}
export function FilmPromptEditor({ value, refs, onChange, placeholder }: { value: string; refs: FilmReference[]; onChange: (text: string) => void; placeholder: string }) {
  const root = useRef<HTMLDivElement>(null), composing = useRef(false), pendingCaret = useRef<number | null>(null);
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null), [selected, setSelected] = useState(0);
  const labels = filmReferenceLabels(refs);
  const refsSignature = labels.map(r => `${r.id}:${r.url}:${r.label}`).join('|'), previousRefs = useRef('');
  useLayoutEffect(() => {
    const el = root.current; if (!el || composing.current) return;
    if (readFilmPrompt(el) === value && previousRefs.current === refsSignature) return;
    previousRefs.current = refsSignature;
    const position = pendingCaret.current ?? caret(el); pendingCaret.current = null;
    const fragment = document.createDocumentFragment(); let last = 0;
    for (const match of value.matchAll(/@\{([^}\r\n]+)\}/g)) {
      fragment.append(document.createTextNode(value.slice(last, match.index)));
      const ref = labels.find(r => r.id === match[1]);
      const chip = document.createElement('span'); chip.className = 'film-inline-reference'; chip.contentEditable = 'false'; chip.dataset.filmRef = match[1]; chip.title = ref?.name || '引用已移除';
      if (ref?.kind === 'image') { const img = document.createElement('img'); img.className = 'film-inline-reference-image'; img.src = toRenderableMediaUrl(ref.url); img.alt = ''; chip.append(img); }
      chip.append(document.createTextNode(ref?.label || '@已移除素材')); fragment.append(chip); last = match.index! + match[0].length;
    }
    fragment.append(document.createTextNode(value.slice(last))); el.replaceChildren(fragment);
    if (position !== null) moveCaret(el, Math.min(position, value.length));
  });
  const detect = () => {
    if (composing.current || !root.current) return;
    const offset = caret(root.current); if (offset === null) { setMention(null); return; }
    const before = readFilmPrompt(root.current).slice(0, offset), match = /@([^\s@{}]*)$/.exec(before);
    setMention(match ? { start: offset - match[0].length, end: offset, query: match[1] } : null); setSelected(0);
  };
  const input = () => {
    if (!root.current || composing.current) return;
    const text = readFilmPrompt(root.current); onChange(text.slice(0, 6000)); detect();
  };
  const insertText = (text: string) => {
    const el = root.current, selection = window.getSelection();
    if (!el || !selection?.rangeCount || !el.contains(selection.anchorNode)) return;
    const range = selection.getRangeAt(0); range.deleteContents(); const node = document.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); input();
  };
  const options = labels.filter(r => `${r.name}${r.label}`.toLowerCase().includes((mention?.query || '').toLowerCase()));
  const choose = (ref: FilmReference) => {
    if (!mention || !root.current) return;
    const current = readFilmPrompt(root.current), token = filmRefToken(ref) + ' ';
    const next = current.slice(0, mention.start) + token + current.slice(mention.end);
    if (next.length > 6000) return;
    pendingCaret.current = mention.start + token.length; root.current.focus(); onChange(next); setMention(null);
  };
  return <div className="film-rich-prompt-wrap"><div ref={root} className="film-prompt-text film-rich-prompt" contentEditable suppressContentEditableWarning role="textbox" aria-label="生成描述" aria-multiline="true" aria-autocomplete="list" aria-controls={mention ? 'film-reference-mention-list' : undefined} data-placeholder={placeholder}
    onInput={input} onClick={detect} onKeyUp={e => { if (!['ArrowDown', 'ArrowUp', 'Escape', 'Enter'].includes(e.key)) detect(); }}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; input(); }}
    onCopy={e => { const selection = window.getSelection(); if (selection?.rangeCount) { e.preventDefault(); e.clipboardData.setData('text/plain', filmDisplayPrompt(readFilmPrompt(selection.getRangeAt(0).cloneContents()), refs)); } }}
    onPaste={e => { e.preventDefault(); insertText(e.clipboardData.getData('text/plain')); }}
    onKeyDown={e => {
      if (e.nativeEvent.isComposing) return;
      if (mention && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setMention(null); }
      else if (mention && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setSelected(i => Math.max(0, Math.min(options.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))); }
      else if (e.key === 'Enter') { e.preventDefault(); if (mention && options[selected]) choose(options[selected]); else insertText('\n'); }
    }} />
    {mention && <div className="film-reference-menu" role="listbox" aria-label="引用素材" id="film-reference-mention-list">{options.length ? options.map((ref, i) => <button key={ref.id} className={`film-reference-option ${selected === i ? 'is-active' : ''}`} role="option" aria-selected={selected === i} onMouseDown={e => e.preventDefault()} onClick={() => choose(ref)}>{ref.kind === 'image' ? <img className="film-reference-option-image" src={toRenderableMediaUrl(ref.url)} alt="" /> : ref.kind === 'video' ? <Film className="film-reference-option-icon" size={22} /> : <Music2 className="film-reference-option-icon" size={22} />}<span className="film-reference-option-name">{ref.name}<small className="film-reference-option-label">{ref.label}</small></span><span className="film-reference-option-type">{{ image: '图像', video: '视频', audio: '音频' }[ref.kind]}</span></button>) : <p className="film-reference-no-match">{refs.length ? '没有匹配的素材' : '先上传参考图，或为本镜头关联的资产制作图片'}</p>}</div>}
  </div>;
}
