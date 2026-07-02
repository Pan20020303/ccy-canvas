import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowRight, Boxes, Image as ImageIcon, Music, Search, Type as TypeIcon, Video, X, Layers3, Bot } from 'lucide-react';
import clsx from 'clsx';
import type { Node } from '@xyflow/react';

import { toRenderableMediaUrl } from '../reference-media';
import type { Group } from '../store';

/**
 * CanvasIndexPanel — the bottom-right "全画布索引" (à la the reference app):
 * a floating right-side panel listing EVERY node (searchable, type-filtered,
 * paginated) or every group on the canvas. Clicking a row jumps the viewport
 * to it. Opened from the bottom-right stats pill.
 */

type NodeKindKey = 'all' | 'image' | 'video' | 'audio' | 'text' | 'other';

const PAGE_SIZE = 12;

function nodeKind(type: string | undefined): Exclude<NodeKindKey, 'all'> {
  const t = String(type ?? '');
  if (/image|panorama/i.test(t)) return 'image';
  if (/video/i.test(t)) return 'video';
  if (/audio/i.test(t)) return 'audio';
  if (/text|sticky/i.test(t)) return 'text';
  return 'other';
}

function kindLabel(kind: Exclude<NodeKindKey, 'all'>, type: string | undefined, zh: boolean): string {
  const t = String(type ?? '');
  if (t === 'directorStageNode') return zh ? '导演台' : 'Stage';
  if (t === 'agentNode') return 'Agent';
  if (t === 'compositionPreviewNode') return zh ? '合成' : 'Comp';
  switch (kind) {
    case 'image': return zh ? '图片' : 'Image';
    case 'video': return zh ? '视频' : 'Video';
    case 'audio': return zh ? '音频' : 'Audio';
    case 'text': return zh ? '文本' : 'Text';
    default: return zh ? '其他' : 'Other';
  }
}

function nodeDisplayName(node: Node, zh: boolean): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const custom = typeof data.customTitle === 'string' ? data.customTitle : '';
  const source = typeof data.sourceName === 'string' ? data.sourceName : '';
  return custom || source || kindLabel(nodeKind(node.type), node.type, zh);
}

function nodeThumb(node: Node): string {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const kind = nodeKind(node.type);
  if (kind === 'image') {
    const u = (data.thumbnail as string) || (data.url as string) || '';
    return typeof u === 'string' ? u : '';
  }
  if (kind === 'video') {
    const u = (data.poster as string) || (data.thumbnail as string) || '';
    return typeof u === 'string' ? u : '';
  }
  return '';
}

/** Row thumbnail with a graceful icon fallback — node urls can be stripped
 *  blob:/data: refs or expired provider links; a broken <img> glyph reads as a
 *  bug, an icon doesn't. Never mutates data (unlike MediaThumb's auto-clean). */
function RowThumb({ src, kind, type }: { src: string; kind: Exclude<NodeKindKey, 'all'>; type: string | undefined }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return <KindIcon kind={kind} type={type} />;
  return (
    <img
      src={toRenderableMediaUrl(src)}
      alt=""
      className="h-full w-full object-cover"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function KindIcon({ kind, type }: { kind: Exclude<NodeKindKey, 'all'>; type: string | undefined }) {
  const t = String(type ?? '');
  if (t === 'directorStageNode') return <Layers3 className="h-4 w-4 text-violet-300/70" />;
  if (t === 'agentNode') return <Bot className="h-4 w-4 text-cyan-300/70" />;
  switch (kind) {
    case 'image': return <ImageIcon className="h-4 w-4 text-neutral-500" />;
    case 'video': return <Video className="h-4 w-4 text-neutral-500" />;
    case 'audio': return <Music className="h-4 w-4 text-neutral-500" />;
    case 'text': return <TypeIcon className="h-4 w-4 text-neutral-500" />;
    default: return <Boxes className="h-4 w-4 text-neutral-500" />;
  }
}

export function CanvasIndexPanel({
  open,
  onClose,
  nodes,
  groups,
  language,
  onJumpToNode,
  onJumpToGroup,
}: {
  open: 'nodes' | 'groups' | null;
  onClose: () => void;
  nodes: Node[];
  groups: Group[];
  language: string;
  onJumpToNode: (nodeId: string) => void;
  onJumpToGroup: (groupId: string) => void;
}) {
  const zh = language === 'zh';
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<NodeKindKey>('all');
  const [page, setPage] = useState(0);

  // Reset transient state whenever the panel (re)opens or switches mode.
  useEffect(() => {
    setQuery('');
    setKindFilter('all');
    setPage(0);
  }, [open]);

  const counts = useMemo(() => {
    const c: Record<NodeKindKey, number> = { all: nodes.length, image: 0, video: 0, audio: 0, text: 0, other: 0 };
    for (const n of nodes) c[nodeKind(n.type)] += 1;
    return c;
  }, [nodes]);

  const filteredNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return nodes.filter((n) => {
      if (kindFilter !== 'all' && nodeKind(n.type) !== kindFilter) return false;
      if (!q) return true;
      return nodeDisplayName(n, zh).toLowerCase().includes(q);
    });
  }, [nodes, kindFilter, query, zh]);

  if (!open) return null;

  const pageCount = Math.max(1, Math.ceil(filteredNodes.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageNodes = filteredNodes.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const chips: { key: NodeKindKey; zh: string; en: string }[] = [
    { key: 'all', zh: '全部', en: 'All' },
    { key: 'image', zh: '图', en: 'Img' },
    { key: 'video', zh: '视', en: 'Vid' },
    { key: 'audio', zh: '音', en: 'Aud' },
    { key: 'text', zh: '文', en: 'Txt' },
    { key: 'other', zh: '其他', en: 'Other' },
  ];

  return (
    <div className="absolute bottom-16 right-6 z-40 flex max-h-[70vh] w-[300px] flex-col rounded-2xl border border-white/10 bg-[#141519]/95 shadow-2xl backdrop-blur-xl">
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <div className="text-[13px] font-medium text-neutral-100">
          {open === 'nodes' ? (zh ? '所有节点' : 'All nodes') : (zh ? '分组' : 'Groups')}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 transition hover:bg-white/8 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {open === 'nodes' ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
            {pageNodes.length === 0 ? (
              <div className="py-10 text-center text-xs text-neutral-600">{zh ? '没有匹配的节点' : 'No matching nodes'}</div>
            ) : pageNodes.map((node, i) => {
              const kind = nodeKind(node.type);
              const thumb = nodeThumb(node);
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => onJumpToNode(node.id)}
                  className="group flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition hover:bg-white/6"
                >
                  <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-neutral-600">{safePage * PAGE_SIZE + i + 1}</span>
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-black/40">
                    <RowThumb src={thumb} kind={kind} type={node.type} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-neutral-100">{nodeDisplayName(node, zh)}</span>
                    <span className="block text-[10px] text-neutral-500">{kindLabel(kind, node.type, zh)}</span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-neutral-600 opacity-0 transition group-hover:opacity-100" />
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-center gap-1 px-3 pt-1 text-neutral-400">
            {[
              { Icon: ChevronsLeft, to: 0, disabled: safePage === 0 },
              { Icon: ChevronLeft, to: safePage - 1, disabled: safePage === 0 },
            ].map(({ Icon, to, disabled }, idx) => (
              <button key={idx} type="button" disabled={disabled} onClick={() => setPage(Math.max(0, to))}
                className="flex h-6 w-6 items-center justify-center rounded-md transition hover:bg-white/8 disabled:opacity-30">
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
            <span className="px-2 text-[11px] tabular-nums">{safePage + 1} / {pageCount}</span>
            {[
              { Icon: ChevronRight, to: safePage + 1, disabled: safePage >= pageCount - 1 },
              { Icon: ChevronsRight, to: pageCount - 1, disabled: safePage >= pageCount - 1 },
            ].map(({ Icon, to, disabled }, idx) => (
              <button key={idx} type="button" disabled={disabled} onClick={() => setPage(Math.min(pageCount - 1, to))}
                className="flex h-6 w-6 items-center justify-center rounded-md transition hover:bg-white/8 disabled:opacity-30">
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>

          <div className="px-3 pt-2">
            <div className="flex items-center gap-1.5 rounded-lg border border-white/8 bg-black/30 px-2 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
              <input
                value={query}
                onChange={(event) => { setQuery(event.target.value); setPage(0); }}
                placeholder={zh ? '搜索节点…' : 'Search nodes…'}
                className="w-full bg-transparent text-[12px] text-neutral-100 outline-none placeholder:text-neutral-600"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3 pt-2">
            {chips.map((chip) => (
              counts[chip.key] > 0 || chip.key === 'all' ? (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => { setKindFilter(chip.key); setPage(0); }}
                  className={clsx(
                    'rounded-full px-2 py-0.5 text-[10.5px] transition',
                    kindFilter === chip.key ? 'bg-white/15 text-white' : 'bg-white/5 text-neutral-400 hover:bg-white/10',
                  )}
                >
                  {zh ? chip.zh : chip.en}<sup className="ml-0.5 tabular-nums">{counts[chip.key]}</sup>
                </button>
              ) : null
            ))}
          </div>
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {groups.length === 0 ? (
            <div className="py-10 text-center text-xs text-neutral-600">{zh ? '画布上还没有分组' : 'No groups yet'}</div>
          ) : groups.map((group) => (
            <button
              key={group.id}
              type="button"
              onClick={() => onJumpToGroup(group.id)}
              className="group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition hover:bg-white/6"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-black/40">
                <Boxes className="h-4 w-4 text-neutral-500" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-neutral-100">{group.name || (zh ? '组' : 'Group')}</span>
                <span className="block text-[10px] text-neutral-500">{group.nodeIds.length} {zh ? '个节点' : 'nodes'}</span>
              </span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-neutral-600 opacity-0 transition group-hover:opacity-100" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
