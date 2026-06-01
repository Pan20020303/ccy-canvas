import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  BackgroundVariant,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Connection,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Expand,
  Grid3X3,
  Image as ImageIcon,
  Map,
  Music,
  Pencil,
  Upload,
  Video,
  Group as GroupIcon,
} from 'lucide-react';

import { useStore } from '../store';
import {
  getReferenceNodeTypeFromMimeType,
  readFileAsDataUrl,
  resolveBackendAssetUrl,
  setReferencePayloadValue,
} from '../reference-media';
import { nodeTypes } from './nodes/CustomNodes';
import { t } from '../i18n';

type NodeKind = 'textNode' | 'imageNode' | 'videoNode' | 'audioNode';

const PICKER_OPTIONS: { kind: NodeKind; icon: any; zh: string; en: string }[] = [
  { kind: 'textNode', icon: Pencil, zh: '生成文本', en: 'Generate Text' },
  { kind: 'imageNode', icon: ImageIcon, zh: '生成图像', en: 'Generate Image' },
  { kind: 'videoNode', icon: Video, zh: '生成视频', en: 'Generate Video' },
  { kind: 'audioNode', icon: Music, zh: '生成音频', en: 'Generate Audio' },
];

const GRID_SIZE = 24;
const GUIDE_THRESHOLD = 5;

const snapPosition = (position: { x: number; y: number }) => ({
  x: Math.round(position.x / GRID_SIZE) * GRID_SIZE,
  y: Math.round(position.y / GRID_SIZE) * GRID_SIZE,
});

type GuideLine = { orientation: 'h' | 'v'; pos: number; from: number; to: number };

function getNodeBounds(node: Node) {
  const w = node.measured?.width ?? node.width ?? 300;
  const h = node.measured?.height ?? node.height ?? 200;
  const x = node.position.x;
  const y = node.position.y;
  return {
    left: x, right: x + w, top: y, bottom: y + h,
    cx: x + w / 2, cy: y + h / 2, w, h,
  };
}

function computeGuides(dragged: Node, others: Node[]): { guides: GuideLine[]; snapDx: number; snapDy: number } {
  const db = getNodeBounds(dragged);
  const guides: GuideLine[] = [];

  // Track closest distance for X and Y independently.
  let bestDistX = GUIDE_THRESHOLD;
  let bestDistY = GUIDE_THRESHOLD;
  let snapDx = 0;
  let snapDy = 0;

  const dragXAnchors = [db.left, db.cx, db.right];
  const dragYAnchors = [db.top, db.cy, db.bottom];

  for (const other of others) {
    if (other.id === dragged.id) continue;
    const ob = getNodeBounds(other);
    const otherXAnchors = [ob.left, ob.cx, ob.right];
    const otherYAnchors = [ob.top, ob.cy, ob.bottom];

    for (const dx of dragXAnchors) {
      for (const ox of otherXAnchors) {
        const dist = Math.abs(dx - ox);
        if (dist < bestDistX) {
          bestDistX = dist;
          snapDx = ox - dx;
        }
      }
    }

    for (const dy of dragYAnchors) {
      for (const oy of otherYAnchors) {
        const dist = Math.abs(dy - oy);
        if (dist < bestDistY) {
          bestDistY = dist;
          snapDy = oy - dy;
        }
      }
    }
  }

  // Recompute bounds after snapping to build accurate guide lines.
  const snappedLeft = db.left + snapDx;
  const snappedRight = db.right + snapDx;
  const snappedCx = db.cx + snapDx;
  const snappedTop = db.top + snapDy;
  const snappedBottom = db.bottom + snapDy;
  const snappedCy = db.cy + snapDy;

  for (const other of others) {
    if (other.id === dragged.id) continue;
    const ob = getNodeBounds(other);

    for (const sx of [snappedLeft, snappedCx, snappedRight]) {
      for (const ox of [ob.left, ob.cx, ob.right]) {
        if (Math.abs(sx - ox) < 0.5) {
          guides.push({ orientation: 'v', pos: ox, from: Math.min(snappedTop, ob.top), to: Math.max(snappedBottom, ob.bottom) });
        }
      }
    }

    for (const sy of [snappedTop, snappedCy, snappedBottom]) {
      for (const oy of [ob.top, ob.cy, ob.bottom]) {
        if (Math.abs(sy - oy) < 0.5) {
          guides.push({ orientation: 'h', pos: oy, from: Math.min(snappedLeft, ob.left), to: Math.max(snappedRight, ob.right) });
        }
      }
    }
  }

  return { guides, snapDx, snapDy };
}

function AlignmentGuides({ guides }: { guides: GuideLine[] }) {
  const { x, y, zoom } = useViewport();
  if (!guides.length) return null;
  return (
    <svg className="pointer-events-none absolute inset-0 z-[5] h-full w-full overflow-visible">
      <g transform={`translate(${x},${y}) scale(${zoom})`}>
        {guides.map((g, i) =>
          g.orientation === 'v' ? (
            <line key={i} x1={g.pos} y1={g.from - 20} x2={g.pos} y2={g.to + 20} stroke="#22d3ee" strokeWidth={1 / zoom} strokeDasharray={`${4 / zoom} ${3 / zoom}`} />
          ) : (
            <line key={i} x1={g.from - 20} y1={g.pos} x2={g.to + 20} y2={g.pos} stroke="#22d3ee" strokeWidth={1 / zoom} strokeDasharray={`${4 / zoom} ${3 / zoom}`} />
          ),
        )}
      </g>
    </svg>
  );
}

const InnerCanvas = () => {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addNode,
    createGroup,
    showMiniMap,
    setShowMiniMap,
    snapToGrid,
    setSnapToGrid,
  } = useStore();
  const saveCanvasToBackend = useStore((state) => state.saveCanvasToBackend);
  const activeBackendProjectId = useStore((state) => state.activeBackendProjectId);
  const language = useStore((state) => state.language);
  const dict = t[language];
  const { screenToFlowPosition, fitView } = useReactFlow();
  const selectedIds = nodes.filter((node) => node.selected).map((node) => node.id);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const connectingFrom = useRef<{ nodeId: string; handleId?: string | null } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- cursor state ---
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [nodeDragging, setNodeDragging] = useState(false);
  const [dropMessage, setDropMessage] = useState<string | null>(null);
  const [guides, setGuides] = useState<GuideLine[]>([]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) setSpaceHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const cursorMode = nodeDragging ? 'canvas-mode-grabbing' : spaceHeld ? 'canvas-mode-grab' : '';

  // Debounced auto-save to backend (2 s after last change).
  useEffect(() => {
    if (!activeBackendProjectId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveCanvasToBackend();
    }, 2000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, activeBackendProjectId]);

  const [picker, setPicker] = useState<{ x: number; y: number; flowX: number; flowY: number; fromConnection: boolean } | null>(null);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!snapToGrid) {
        onNodesChange(changes);
        return;
      }

      const posChange = changes.find((c): c is NodeChange & { type: 'position'; id: string; position: { x: number; y: number }; dragging?: boolean } =>
        c.type === 'position' && 'position' in c && c.position != null,
      );

      if (posChange?.dragging) {
        const draggedNode = nodes.find((n) => n.id === posChange.id);
        if (draggedNode) {
          const virtual = { ...draggedNode, position: posChange.position };
          const { guides: newGuides, snapDx, snapDy } = computeGuides(virtual, nodes);
          setGuides(newGuides);

          const snapped = {
            x: posChange.position.x + snapDx,
            y: posChange.position.y + snapDy,
          };
          // If no alignment found on an axis, fall back to grid snap on that axis.
          if (snapDx === 0) snapped.x = snapPosition(posChange.position).x;
          if (snapDy === 0) snapped.y = snapPosition(posChange.position).y;

          onNodesChange(changes.map((c) =>
            c === posChange ? { ...posChange, position: snapped } : c,
          ));
          return;
        }
      }

      if (posChange && !posChange.dragging) {
        setGuides([]);
      }

      onNodesChange(
        changes.map((change) => {
          if (change.type !== 'position' || !('position' in change) || !change.position) return change;
          return { ...change, position: snapPosition(change.position) };
        }),
      );
    },
    [nodes, onNodesChange, snapToGrid],
  );

  const onPaneContextMenu = useCallback((event: any) => {
    event.preventDefault();
    if (!wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    connectingFrom.current = null;
    setPicker({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      flowX: flowPos.x,
      flowY: flowPos.y,
      fromConnection: false,
    });
  }, [screenToFlowPosition]);

  const onConnectStart = useCallback((_: any, params: any) => {
    connectingFrom.current = { nodeId: params.nodeId, handleId: params.handleId };
  }, []);

  const onConnectEnd = useCallback((event: any) => {
    const targetIsPane = (event.target as HTMLElement)?.classList?.contains('react-flow__pane');
    if (!targetIsPane || !connectingFrom.current || !wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const clientX = event.clientX ?? event.changedTouches?.[0]?.clientX;
    const clientY = event.clientY ?? event.changedTouches?.[0]?.clientY;
    const flowPos = screenToFlowPosition({ x: clientX, y: clientY });
    setPicker({
      x: clientX - rect.left,
      y: clientY - rect.top,
      flowX: flowPos.x,
      flowY: flowPos.y,
      fromConnection: true,
    });
  }, [screenToFlowPosition]);

  const onPickerSelect = (kind: NodeKind) => {
    if (!picker) return;
    const id = `node-${Date.now()}`;
    addNode({
      id,
      type: kind,
      position: snapToGrid ? snapPosition({ x: picker.flowX, y: picker.flowY }) : { x: picker.flowX, y: picker.flowY },
      data: {},
    });
    if (picker.fromConnection && connectingFrom.current) {
      const conn: Connection = {
        source: connectingFrom.current.nodeId,
        sourceHandle: connectingFrom.current.handleId ?? null,
        target: id,
        targetHandle: null,
      };
      onConnect(conn);
    }
    setPicker(null);
    connectingFrom.current = null;
  };

  // Drag & drop files from desktop → create image/video nodes.
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    setDropMessage(null);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length || !wrapperRef.current) return;

    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    let offsetY = 0;

    for (const file of files) {
      const nodeType = getReferenceNodeTypeFromMimeType(file?.type);
      if (!nodeType) continue;

      // Upload to backend, get a stable URL.
      const form = new FormData();
      form.append('file', file);
      try {
        const referenceValuePromise = readFileAsDataUrl(file);
        const resp = await fetch('/api/app/upload', { method: 'POST', body: form, credentials: 'include' });
        if (!resp.ok) {
          const bodyText = await resp.text();
          setDropMessage(`Upload failed (${resp.status}): ${bodyText || file.name}`);
          continue;
        }
        const json = await resp.json();
        const rawUrl = json?.data?.url as string;
        if (!rawUrl) {
          setDropMessage(`Upload response missing file url: ${file.name}`);
          continue;
        }
        const url = resolveBackendAssetUrl(rawUrl, import.meta.env.VITE_API_BASE_URL ?? '');
        if (!url) continue;

        const id = `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const pos = snapToGrid
          ? snapPosition({ x: flowPos.x, y: flowPos.y + offsetY })
          : { x: flowPos.x, y: flowPos.y + offsetY };
        const referenceValue = await referenceValuePromise;

        addNode({
          id,
          type: nodeType,
          position: pos,
          data: { url, status: 'done', sourceName: file.name },
        });
        if (referenceValue) {
          setReferencePayloadValue(id, referenceValue);
        }
        offsetY += 320;
      } catch (error) {
        setDropMessage(error instanceof Error ? error.message : `Upload failed: ${file.name}`);
      }
    }
  }, [addNode, screenToFlowPosition, snapToGrid]);

  return (
    <div
      ref={wrapperRef}
      className={`relative h-screen w-full bg-[#0a0a0a] ${cursorMode}`}
      onContextMenu={(event) => event.preventDefault()}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onPaneContextMenu={onPaneContextMenu}
        onNodeDragStart={() => setNodeDragging(true)}
        onNodeDragStop={() => { setNodeDragging(false); setGuides([]); }}
        nodeTypes={nodeTypes}
        fitView
        className="touch-none"
        minZoom={0.1}
        maxZoom={4}
        selectionOnDrag
        panOnDrag={[1, 2]}
        selectionMode={"partial" as never}
        multiSelectionKeyCode={["Meta", "Shift", "Control"]}
        snapToGrid={snapToGrid}
        snapGrid={[GRID_SIZE, GRID_SIZE]}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={2} color="#222" />
        {showMiniMap ? (
          <MiniMap
            position="bottom-left"
            pannable
            zoomable
            maskColor="rgba(10,10,10,0.85)"
            nodeColor="#0891b2"
            nodeStrokeColor="#22d3ee"
            style={{
              width: 180,
              height: 110,
              left: 16,
              right: 'auto',
              bottom: 76,
              backgroundColor: 'rgba(12,14,17,0.88)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 18,
              marginLeft: 0,
              marginBottom: 0,
            }}
          />
        ) : null}
        {snapToGrid ? <AlignmentGuides guides={guides} /> : null}
      </ReactFlow>

      {selectedIds.length >= 2 && !picker ? (
        <div className="absolute left-1/2 top-20 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-[#15181d]/90 px-2 py-1.5 shadow-2xl backdrop-blur-xl">
          <button className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/5">
            <Upload className="h-3.5 w-3.5 text-neutral-400" />
            {dict.create_asset}
            <span className="ml-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-[9px] tracking-wider text-rose-300">BETA</span>
          </button>
          <div className="h-4 w-px bg-white/10" />
          <button
            onClick={() => createGroup(selectedIds)}
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/5"
          >
            <GroupIcon className="h-3.5 w-3.5 text-neutral-400" />
            {dict.group}
          </button>
        </div>
      ) : null}

      {picker ? (
        <>
          <div className="absolute inset-0 z-30" onClick={() => setPicker(null)} />
          <div
            className="absolute z-40 w-[220px] rounded-2xl border border-white/10 bg-[#15181d]/95 p-2 shadow-2xl backdrop-blur-xl"
            style={{ left: picker.x, top: picker.y }}
          >
            <div className="px-3 py-2 text-sm text-neutral-200">
              {picker.fromConnection
                ? (language === 'zh' ? '引用该节点生成' : 'Generate from this node')
                : (language === 'zh' ? '在此处创建节点' : 'Create node here')}
            </div>
            <div className="flex flex-col">
              {PICKER_OPTIONS.map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    key={option.kind}
                    onClick={() => onPickerSelect(option.kind)}
                    className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-neutral-200 transition hover:bg-white/5"
                  >
                    <Icon className="h-4 w-4 text-neutral-400" />
                    <span className="text-sm">{language === 'zh' ? option.zh : option.en}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : null}

      <div className="absolute bottom-6 left-6 z-40 flex flex-col gap-3">
        {dropMessage ? (
          <div className="max-w-[320px] rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-xs text-rose-200 shadow-2xl backdrop-blur-xl">
            {dropMessage}
          </div>
        ) : null}
        <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-black/45 px-3 py-2 shadow-2xl backdrop-blur-xl">
          <ControlButton
            active={showMiniMap}
            label={language === 'zh' ? '开关小地图' : 'Toggle minimap'}
            onClick={() => setShowMiniMap(!showMiniMap)}
          >
            <Map className="h-4 w-4" />
          </ControlButton>
          <ControlButton
            active={snapToGrid}
            label={language === 'zh' ? '开关网格对齐' : 'Toggle grid snap'}
            onClick={() => setSnapToGrid(!snapToGrid)}
          >
            <Grid3X3 className="h-4 w-4" />
          </ControlButton>
          <ControlButton
            active={false}
            label={language === 'zh' ? '适应画布' : 'Fit canvas'}
            onClick={() => void fitView({ padding: 0.18, duration: 300 })}
          >
            <Expand className="h-4 w-4" />
          </ControlButton>
        </div>
      </div>
    </div>
  );
};

function ControlButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className={[
        'flex h-10 w-10 items-center justify-center rounded-xl border text-neutral-300 transition',
        active
          ? 'border-cyan-400/35 bg-cyan-500/15 text-cyan-300'
          : 'border-white/8 bg-white/[0.03] hover:border-white/15 hover:bg-white/[0.06]',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

export const Canvas = () => (
  <ReactFlowProvider>
    <InnerCanvas />
  </ReactFlowProvider>
);
