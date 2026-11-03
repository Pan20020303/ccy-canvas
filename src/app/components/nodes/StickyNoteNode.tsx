import { useCallback, useEffect, useRef, useState } from 'react';
import { Handle, NodeProps, Position } from '@xyflow/react';
import { Palette, X } from 'lucide-react';
import clsx from 'clsx';

import { useStore } from '../../store';

/**
 * Lightweight free-text annotation node. Doesn't participate in generation;
 * just lives on the canvas as a colored sticky for reminders, captions, or
 * planning notes. Click-and-edit text, color swatch picker on hover.
 */

export type StickyColor = 'yellow' | 'cyan' | 'pink' | 'green' | 'violet';

const COLOR_STYLES: Record<StickyColor, { bg: string; ring: string; text: string; swatch: string }> = {
  yellow: { bg: 'bg-amber-300/95',  ring: 'ring-amber-400/60',  text: 'text-amber-950',  swatch: 'bg-amber-300' },
  cyan:   { bg: 'bg-cyan-300/90',   ring: 'ring-cyan-400/60',   text: 'text-cyan-950',   swatch: 'bg-cyan-300' },
  pink:   { bg: 'bg-pink-300/90',   ring: 'ring-pink-400/60',   text: 'text-pink-950',   swatch: 'bg-pink-300' },
  green:  { bg: 'bg-emerald-300/90',ring: 'ring-emerald-400/60',text: 'text-emerald-950',swatch: 'bg-emerald-300' },
  violet: { bg: 'bg-violet-300/90', ring: 'ring-violet-400/60', text: 'text-violet-950', swatch: 'bg-violet-300' },
};

type StickyData = {
  text?: string;
  color?: StickyColor;
};

export function StickyNoteNode({ id, data: rawData, selected }: NodeProps) {
  const data = (rawData ?? {}) as StickyData;
  const text = data.text ?? '';
  const color = (data.color as StickyColor) ?? 'yellow';
  const styles = COLOR_STYLES[color];

  const updateNodeData = useStore((state) => state.updateNodeData);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [showColors, setShowColors] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync external updates (undo/redo) back into the editing draft.
  useEffect(() => { setDraft(text); }, [text]);

  // Autosize the textarea so it grows with content instead of scrolling.
  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
  }, [draft, editing]);

  const commit = useCallback(() => {
    if (draft !== text) updateNodeData(id, { text: draft });
    setEditing(false);
  }, [draft, id, text, updateNodeData]);

  const setColor = (next: StickyColor) => {
    updateNodeData(id, { color: next });
    setShowColors(false);
  };

  return (
    <div
      className={clsx(
        'relative min-h-[120px] w-[220px] rounded-lg p-3 shadow-[0_12px_28px_-12px_rgba(0,0,0,0.55)] transition',
        styles.bg,
        selected ? `ring-2 ${styles.ring}` : 'ring-1 ring-black/10',
      )}
      onDoubleClick={(event) => {
        event.stopPropagation();
        setEditing(true);
        // Defer focus so the textarea is mounted by the time we call it.
        requestAnimationFrame(() => textareaRef.current?.focus());
      }}
    >
      {/* Color swatch picker — hover-reveal in the top-right corner. */}
      <div
        className={clsx(
          'absolute right-1.5 top-1.5 z-10 transition',
          selected || showColors ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        <div className="relative">
          <button
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => { event.stopPropagation(); setShowColors((v) => !v); }}
            className={clsx('flex h-5 w-5 items-center justify-center rounded-full bg-black/10 hover:bg-black/20', styles.text)}
            title="切换颜色"
          >
            <Palette className="h-3 w-3" />
          </button>
          {showColors ? (
            <div
              className="absolute right-0 top-7 z-20 flex items-center gap-1 rounded-full bg-black/70 p-1 backdrop-blur-md"
              onMouseDown={(event) => event.stopPropagation()}
            >
              {(Object.keys(COLOR_STYLES) as StickyColor[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={clsx('h-4 w-4 rounded-full ring-1 ring-white/20 transition hover:scale-110', COLOR_STYLES[c].swatch, c === color ? 'ring-2 ring-white' : '')}
                  title={c}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* Body — editable textarea when editing, prose when idle. */}
      {editing ? (
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            // Enter commits, Shift+Enter inserts newline, Esc cancels.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              commit();
            }
            if (event.key === 'Escape') { setDraft(text); setEditing(false); }
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
          placeholder="输入便签内容…"
          className={clsx(
            'min-h-[80px] w-full resize-none rounded bg-transparent text-sm leading-relaxed outline-none placeholder:text-black/35',
            styles.text,
          )}
          style={{ fontFamily: 'inherit' }}
        />
      ) : (
        <div
          className={clsx(
            'min-h-[80px] cursor-text whitespace-pre-wrap break-words text-sm leading-relaxed',
            styles.text,
            !text ? 'italic opacity-60' : '',
          )}
        >
          {text || '双击编辑'}
        </div>
      )}

      {/* Handles are intentionally invisible — sticky notes don't participate
          in dataflow but we keep the anchors so React Flow can still route
          edges if a user wants to connect one as a free-form callout. */}
      <Handle type="target" position={Position.Left}  className="!h-2 !w-2 !border-0 !bg-black/20 opacity-0 hover:opacity-100" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-black/20 opacity-0 hover:opacity-100" />

      {/* Tiny X to dismiss — top-right corner, hover-reveal. */}
      {selected ? (
        <button
          type="button"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            useStore.getState().onNodesChange([{ id, type: 'remove' }]);
          }}
          className={clsx('absolute -right-2 -top-2 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white hover:bg-rose-500', styles.text)}
          title="删除便签"
        >
          <X className="h-3 w-3 text-white" />
        </button>
      ) : null}
    </div>
  );
}
