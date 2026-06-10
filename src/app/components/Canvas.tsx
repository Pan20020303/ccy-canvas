import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Bot as BotIcon,
  ClipboardPaste,
  Download,
  Expand,
  FolderHeart,
  Grid3X3,
  Image as ImageIcon,
  Layers3,
  Map,
  Music,
  Pencil,
  Play,
  Plus,
  Redo2,
  Scissors,
  Share2,
  Sparkles,
  SquarePen,
  Trash2,
  Upload,
  Ungroup as UngroupIcon,
  Undo2,
  Video,
  Wrench,
  Group as GroupIcon,
  Lock as LockIcon,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
} from 'lucide-react';

import clsx from 'clsx';
import { useStore, type HistoryItem } from '../store';
import { buildBulkOutboundEdges, computeGroupBounds } from '../group-routing';
import {
  getReferenceNodeTypeFromMimeType,
  readFileAsDataUrl,
  resolveBackendAssetUrl,
  setReferencePayloadValue,
} from '../reference-media';
import { nodeTypes } from './nodes/CustomNodes';
import { FlowEdge } from './FlowEdge';
import { SaveAssetDialog } from './SaveAssetDialog';
import { AgentRunPanel } from './AgentRunPanel';

const edgeTypes = { flow: FlowEdge };
const defaultEdgeOptions = { type: 'flow' as const };
import { t } from '../i18n';
import { HistoryImagePickerModal } from './HistoryImagePickerModal';

type NodeKind = 'textNode' | 'imageNode' | 'videoNode' | 'audioNode';
type ContextMenuMode = 'root' | 'add-node' | 'node-media' | 'node-text';
type ContextMenuState = {
  x: number;
  y: number;
  flowX: number;
  flowY: number;
  fromConnection: boolean;
  mode: ContextMenuMode;
  /** Target node id when mode is node-media / node-text. */
  nodeId?: string;
};

const PICKER_OPTIONS: { kind: NodeKind; icon: any; zh: string; en: string }[] = [
  { kind: 'textNode', icon: Pencil, zh: '文本', en: 'Text' },
  { kind: 'imageNode', icon: ImageIcon, zh: '图片', en: 'Image' },
  { kind: 'videoNode', icon: Video, zh: '视频', en: 'Video' },
  { kind: 'audioNode', icon: Music, zh: '音频', en: 'Audio' },
];

const FUTURE_NODE_OPTIONS = [
  { key: 'video-compose', icon: Scissors, zh: '视频合成', en: 'Video Compose', badge: 'Beta', subtitleZh: '', subtitleEn: '' },
  { key: 'director-desk', icon: Layers3, zh: '导演台', en: 'Director Desk', badge: 'NEW', subtitleZh: '', subtitleEn: '' },
  { key: 'script', icon: SquarePen, zh: '脚本', en: 'Script', badge: 'Beta', subtitleZh: '创意脚本、生成故事板', subtitleEn: 'Create scripts and storyboards' },
] as const;

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
    left: x,
    right: x + w,
    top: y,
    bottom: y + h,
    cx: x + w / 2,
    cy: y + h / 2,
  };
}

function computeGuides(dragged: Node, others: Node[]): { guides: GuideLine[]; snapDx: number; snapDy: number } {
  const db = getNodeBounds(dragged);
  const guides: GuideLine[] = [];

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
        {guides.map((guide, index) =>
          guide.orientation === 'v' ? (
            <line
              key={index}
              x1={guide.pos}
              y1={guide.from - 20}
              x2={guide.pos}
              y2={guide.to + 20}
              stroke="#22d3ee"
              strokeWidth={1 / zoom}
              strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            />
          ) : (
            <line
              key={index}
              x1={guide.from - 20}
              y1={guide.pos}
              x2={guide.to + 20}
              y2={guide.pos}
              stroke="#22d3ee"
              strokeWidth={1 / zoom}
              strokeDasharray={`${4 / zoom} ${3 / zoom}`}
            />
          ),
        )}
      </g>
    </svg>
  );
}

function isEditableTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return Boolean(element.closest('input, textarea, [contenteditable="true"]'));
}

const InnerCanvas = () => {
  const {
    nodes,
    edges,
    groups,
    onNodesChange,
    onEdgesChange,
    onConnect: connectEdge,
    addNode,
    createGroup,
    showMiniMap,
    setShowMiniMap,
    snapToGrid,
    setSnapToGrid,
    history,
  } = useStore();
  const saveCanvasToBackend = useStore((state) => state.saveCanvasToBackend);
  const activeBackendProjectId = useStore((state) => state.activeBackendProjectId);
  const language = useStore((state) => state.language);
  const isConnectionDragging = useStore((state) => state.isConnectionDragging);
  const setConnectionDragging = useStore((state) => state.setConnectionDragging);
  const undoCanvas = useStore((state) => state.undoCanvas);
  const copySelectedNodes = useStore((state) => state.copySelectedNodes);
  const pasteCopiedNodes = useStore((state) => state.pasteCopiedNodes);
  const removeGroup = useStore((state) => state.removeGroup);
  const ungroupNodes = useStore((state) => state.ungroupNodes);
  const setGroupMembers = useStore((state) => state.setGroupMembers);
  const moveGroup = useStore((state) => state.moveGroup);
  const alignSelectedNodes = useStore((state) => state.alignSelectedNodes);
  const distributeSelectedNodes = useStore((state) => state.distributeSelectedNodes);
  const toggleNodeLock = useStore((state) => state.toggleNodeLock);
  const bringNodeForward = useStore((state) => state.bringNodeForward);
  const sendNodeBackward = useStore((state) => state.sendNodeBackward);
  const bringNodeToFront = useStore((state) => state.bringNodeToFront);
  const sendNodeToBack = useStore((state) => state.sendNodeToBack);
  const openSaveAssetDialog = useStore((state) => state.openSaveAssetDialog);
  const setAssetLibraryOpen = useStore((state) => state.setAssetLibraryOpen);
  const dict = t[language];
  const { screenToFlowPosition, fitView } = useReactFlow();
  const viewport = useViewport();
  const selectedIds = nodes.filter((node) => node.selected).map((node) => node.id);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const connectingFrom = useRef<{ nodeId: string; handleId?: string | null } | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportRef = useRef(viewport);
  // Stable ref to the latest nodes array so window-level keyboard handlers
  // (which can't depend on `nodes` without re-attaching every change) can
  // still look up the currently-selected node.
  const nodesRef = useRef<typeof nodes>([]);
  const groupDragRef = useRef<{
    groupId: string;
    lastClientX: number;
    lastClientY: number;
    didCaptureUndo: boolean;
  } | null>(null);

  const [spaceHeld, setSpaceHeld] = useState(false);
  const [nodeDragging, setNodeDragging] = useState(false);
  // Mirrors `groupDragRef.current != null` as state so React re-renders the
  // surrounding UI (we use it to hide the multi-select toolbar/bounds while
  // the group is being moved).
  const [groupDragging, setGroupDragging] = useState(false);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [guides, setGuides] = useState<GuideLine[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [isHistoryImagePickerOpen, setHistoryImagePickerOpen] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [bulkRouting, setBulkRouting] = useState<{ startClient: { x: number; y: number }; currentClient: { x: number; y: number } } | null>(null);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  /** Group geometry is FIXED — set at creation, never auto-resized as members
   *  move around. The shell is the spatial container, not a live wrapper.
   *  - Members can drift inside freely (the box stays put)
   *  - Drag a member outside the box → it leaves the group on dragstop
   *  - Drag the group background → moveGroup translates the box + every member
   *  - Drop an outside node inside the box → it joins on dragstop */
  const liveGroups = useMemo(() => groups.map((group) => ({
    ...group,
    _liveBounds: {
      x: group.position?.x ?? 0,
      y: group.position?.y ?? 0,
      width: group.width ?? 0,
      height: group.height ?? 0,
    },
  })), [groups]);

  /** Selection bounding box in flow coordinates — used to position the multi-select toolbar above selection. */
  const selectionBounds = useMemo(() => {
    const selectedNodes = nodes.filter((node) => node.selected);
    if (selectedNodes.length < 2) return null;
    const bounds = computeGroupBounds(selectedNodes);
    return bounds;
  }, [nodes]);

  /** Sanitize orphan groups: drop members whose nodes no longer exist, then drop empty groups.
   *  Catches stale data persisted from older sessions or paths that bypassed onNodesChange. */
  useEffect(() => {
    const nodeIdSet = new Set(nodes.map((node) => node.id));
    groups.forEach((group) => {
      const validIds = group.nodeIds.filter((id) => nodeIdSet.has(id));
      if (validIds.length === 0) {
        ungroupNodes(group.id);
      } else if (validIds.length !== group.nodeIds.length) {
        setGroupMembers(group.id, validIds);
      }
    });
  }, [groups, nodes, setGroupMembers, ungroupNodes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !event.repeat) setSpaceHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Delete / Backspace: remove the actively-selected group (members are kept on canvas).
      if ((event.key === 'Delete' || event.key === 'Backspace') && !isEditableTarget(event.target) && selectedGroupId) {
        event.preventDefault();
        removeGroup(selectedGroupId);
        setSelectedGroupId(null);
        return;
      }

      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier || isEditableTarget(event.target)) return;

      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        undoCanvas();
        return;
      }
      if (key === 'c') {
        event.preventDefault();
        copySelectedNodes();
        return;
      }
      if (key === 'v') {
        event.preventDefault();
        pasteCopiedNodes();
      }
      // Ctrl+L → lock / unlock currently selected nodes.
      if (key === 'l') {
        event.preventDefault();
        toggleNodeLock();
      }
      // Ctrl+] / Ctrl+[ → bring forward / send backward (front / back when
      // also holding Shift). Operates on the lone selected node.
      if (event.key === ']' || event.key === '[') {
        const selectedNode = nodesRef.current.find((n) => n.selected);
        if (!selectedNode) return;
        event.preventDefault();
        if (event.key === ']') {
          event.shiftKey ? bringNodeToFront(selectedNode.id) : bringNodeForward(selectedNode.id);
        } else {
          event.shiftKey ? sendNodeToBack(selectedNode.id) : sendNodeBackward(selectedNode.id);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bringNodeForward, bringNodeToFront, copySelectedNodes, pasteCopiedNodes, removeGroup, selectedGroupId, sendNodeBackward, sendNodeToBack, toggleNodeLock, undoCanvas]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = groupDragRef.current;
      if (!drag) {
        return;
      }

      const dx = event.clientX - drag.lastClientX;
      const dy = event.clientY - drag.lastClientY;
      if (!dx && !dy) {
        return;
      }

      drag.lastClientX = event.clientX;
      drag.lastClientY = event.clientY;
      const zoom = viewportRef.current.zoom || 1;
      moveGroup(
        drag.groupId,
        { x: dx / zoom, y: dy / zoom },
        { captureUndo: !drag.didCaptureUndo },
      );
      drag.didCaptureUndo = true;
    };

    const handlePointerUp = () => {
      groupDragRef.current = null;
      setGroupDragging(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [moveGroup]);

  /** Intercept pointer/mouse downs on the ReactFlow pane: if the click falls
   *  inside any group's stored rectangle, hijack the gesture so ReactFlow
   *  can't start a marquee selection or pan, and arm groupDragRef so the
   *  existing window-level pointermove handler can translate the group.
   *
   *  Both `pointerdown` AND `mousedown` are intercepted because ReactFlow's
   *  selectionOnDrag listens to mousedown (legacy DnD pattern); blocking
   *  only pointerdown leaves the marquee path open. */
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    // Returns the group whose bounds contain `clientX/Y`, or null. Encapsulates
    // the viewport-to-flow coordinate transform so both handlers stay aligned.
    const hitTestGroup = (clientX: number, clientY: number) => {
      const wrapperRect = wrapper.getBoundingClientRect();
      const v = viewportRef.current;
      const flowX = (clientX - wrapperRect.left - v.x) / (v.zoom || 1);
      const flowY = (clientY - wrapperRect.top - v.y) / (v.zoom || 1);
      return groups.find((g) => {
        const gx = g.position?.x ?? 0;
        const gy = g.position?.y ?? 0;
        const gw = g.width ?? 0;
        const gh = g.height ?? 0;
        if (gw === 0 || gh === 0) return false;
        return flowX >= gx && flowX <= gx + gw && flowY >= gy && flowY <= gy + gh;
      }) ?? null;
    };

    const isPaneTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      // Treat as pane whenever the click landed on an empty ReactFlow surface
      // — pane, background dots, viewport, or renderer wrappers — and was
      // NOT on a node or edge (we let those keep their default behavior).
      if (el.closest('.react-flow__node')) return false;
      if (el.closest('.react-flow__edge')) return false;
      const cls = el.classList;
      if (
        cls.contains('react-flow__pane')
        || cls.contains('react-flow__background')
        || cls.contains('react-flow__viewport')
        || cls.contains('react-flow__renderer')
        || cls.contains('react-flow__container')
      ) return true;
      // Also accept SVG children of the background dots.
      return el.closest('.react-flow__background') !== null;
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !isPaneTarget(event.target)) return;
      const hit = hitTestGroup(event.clientX, event.clientY);
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setSelectedGroupId(hit.id);
      // Drop any lingering multi-selection from a prior marquee so the
      // floating toolbar and selection rectangle don't visually leak into
      // the group-drag gesture. Reads from the store directly so we don't
      // need to put `nodes` in this effect's dependency array (which would
      // force a re-subscribe on every node mutation).
      const currentNodes = useStore.getState().nodes;
      const deselects = currentNodes
        .filter((n) => n.selected)
        .map((n) => ({ id: n.id, type: 'select' as const, selected: false }));
      if (deselects.length > 0) onNodesChange(deselects);
      groupDragRef.current = {
        groupId: hit.id,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        didCaptureUndo: false,
      };
      setGroupDragging(true);
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || !isPaneTarget(event.target)) return;
      if (!hitTestGroup(event.clientX, event.clientY)) return;
      // Pointerdown already armed the drag ref; this just stops ReactFlow's
      // parallel mousedown-based marquee from firing.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    // Attach at WINDOW level in capture phase so we fire before ReactFlow's
    // own listeners regardless of whether they're on document, window, or
    // some descendant. Without this, ReactFlow's marquee handler — which
    // appears to register higher up — wins the race and starts a selection
    // box before our stopImmediatePropagation can take effect.
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('mousedown', handleMouseDown, true);

    // Block ReactFlow's wheel-to-zoom whenever the cursor is over a
    // scrollable text surface (node prompts, agent chat, agent composer,
    // generic prompt-editor scrollers). React's onWheel/stopPropagation
    // is not enough because ReactFlow registers a NATIVE non-passive wheel
    // listener on the pane — we have to interrupt it before that fires.
    const handleWheel = (event: WheelEvent) => {
      const el = event.target as HTMLElement | null;
      if (!el) return;
      // Anything inside a textarea, input, contentEditable, or our shared
      // `.prompt-editor-scroll` class counts as "user-scrollable text".
      const inText = el.closest('textarea, input, [contenteditable="true"], .prompt-editor-scroll, .rich-text-editor');
      if (!inText) return;
      // Stop propagation so ReactFlow never sees the wheel — the browser
      // still applies its own scroll to the textarea/div.
      event.stopPropagation();
    };
    window.addEventListener('wheel', handleWheel, { capture: true, passive: false });

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('mousedown', handleMouseDown, true);
      window.removeEventListener('wheel', handleWheel, true);
    };
  }, [groups, onNodesChange]);

  const cursorMode = nodeDragging ? 'canvas-mode-grabbing' : spaceHeld ? 'canvas-mode-grab' : '';

  const onConnect = useCallback((connection: Connection) => {
    connectEdge(connection);
    setConnectionDragging(false);
    connectingFrom.current = null;
  }, [connectEdge, setConnectionDragging]);

  /** Global mouse tracking for bulk-routing (selection +-handle drag). */
  useEffect(() => {
    if (!bulkRouting) return;
    const onMove = (event: MouseEvent) => {
      setBulkRouting((current) => current ? { ...current, currentClient: { x: event.clientX, y: event.clientY } } : current);
    };
    const onUp = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      const targetNodeId = target?.closest('.react-flow__node')?.getAttribute('data-id') ?? null;
      if (targetNodeId && selectedIds.length >= 2 && !selectedIds.includes(targetNodeId)) {
        const newEdges = buildBulkOutboundEdges({
          groupId: 'selection',
          memberNodeIds: selectedIds,
          targetNodeId,
          existingEdges: edges,
        });
        newEdges.forEach((edge) => connectEdge(edge as never));
      }
      setBulkRouting(null);
      setConnectionDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [bulkRouting, selectedIds, edges, connectEdge, setConnectionDragging]);

  /** One curve per selected node, all converging to the cursor.
   *  Each curve is in canvas-wrapper-local coordinates. */
  const bulkDragCurves = useMemo(() => {
    if (!bulkRouting || !wrapperRef.current) return null;
    const rect = wrapperRef.current.getBoundingClientRect();
    const target = {
      x: bulkRouting.currentClient.x - rect.left,
      y: bulkRouting.currentClient.y - rect.top,
    };
    const curves = nodes
      .filter((node) => node.selected)
      .map((node) => {
        const m = (node as { measured?: { width?: number; height?: number } }).measured;
        const nodeW = m?.width ?? node.width ?? 300;
        const nodeH = m?.height ?? node.height ?? 200;
        // Source point: right edge midpoint of node, in flow coords → screen coords.
        const flowX = node.position.x + nodeW;
        const flowY = node.position.y + nodeH / 2;
        const sx = viewport.x + flowX * viewport.zoom;
        const sy = viewport.y + flowY * viewport.zoom;
        // Bezier control points biased horizontally for a smooth S-curve.
        const dx = Math.max(60, Math.abs(target.x - sx) * 0.5);
        const c1 = { x: sx + dx, y: sy };
        const c2 = { x: target.x - dx, y: target.y };
        return {
          id: node.id,
          d: `M ${sx} ${sy} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${target.x} ${target.y}`,
        };
      });
    return curves;
  }, [bulkRouting, nodes, viewport]);

  /** Mark canvas dirty whenever nodes/edges change; auto-save with 2s debounce. */
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!activeBackendProjectId) return;
    dirtyRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveCanvasToBackend().finally(() => { dirtyRef.current = false; });
    }, 2000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [nodes, edges, activeBackendProjectId, saveCanvasToBackend]);

  /** Flush pending save synchronously on tab close / hard refresh, so users
   *  don't lose the last 0-2 seconds of work that the debounce hasn't yet
   *  written. visibilitychange + pagehide are more reliable than beforeunload
   *  on mobile and Chrome's bfcache. */
  useEffect(() => {
    if (!activeBackendProjectId) return;
    const flush = () => {
      if (!dirtyRef.current) return;
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      // Fire-and-forget; keepalive=true lets the browser keep the request
      // in flight even after navigation/tab-close starts.
      void saveCanvasToBackend({ keepalive: true }).catch(() => {});
      dirtyRef.current = false;
    };
    const onPageHide = () => flush();
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activeBackendProjectId, saveCanvasToBackend]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    if (!snapToGrid) {
      onNodesChange(changes);
      return;
    }

    const posChange = changes.find((change): change is NodeChange & { type: 'position'; id: string; position: { x: number; y: number }; dragging?: boolean } =>
      change.type === 'position' && 'position' in change && change.position != null,
    );

    if (posChange?.dragging) {
      const draggedNode = nodes.find((node) => node.id === posChange.id);
      if (draggedNode) {
        const virtual = { ...draggedNode, position: posChange.position };
        const { guides: nextGuides, snapDx, snapDy } = computeGuides(virtual, nodes);
        setGuides(nextGuides);

        const snapped = {
          x: snapDx === 0 ? snapPosition(posChange.position).x : posChange.position.x + snapDx,
          y: snapDy === 0 ? snapPosition(posChange.position).y : posChange.position.y + snapDy,
        };

        onNodesChange(changes.map((change) => (change === posChange ? { ...posChange, position: snapped } : change)));
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
  }, [nodes, onNodesChange, snapToGrid]);

  const openContextMenu = useCallback((event: { clientX: number; clientY: number }, mode: ContextMenuMode, fromConnection: boolean) => {
    if (!wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    setContextMenu({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      flowX: flowPos.x,
      flowY: flowPos.y,
      fromConnection,
      mode,
    });
  }, [screenToFlowPosition]);

  const onPaneContextMenu = useCallback((event: any) => {
    event.preventDefault();
    connectingFrom.current = null;
    openContextMenu(event, 'root', false);
  }, [openContextMenu]);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: { id: string; type?: string }) => {
    event.preventDefault();
    const isText = node.type === 'textNode';
    const mode: ContextMenuMode = isText ? 'node-text' : 'node-media';
    if (!wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    setContextMenu({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      flowX: flow.x,
      flowY: flow.y,
      fromConnection: false,
      mode,
      nodeId: node.id,
    });
  }, [screenToFlowPosition]);

  const onConnectStart = useCallback((_: any, params: any) => {
    connectingFrom.current = { nodeId: params.nodeId, handleId: params.handleId };
    setConnectionDragging(true);
  }, [setConnectionDragging]);

  const onConnectEnd = useCallback((event: any) => {
    const targetIsPane = (event.target as HTMLElement)?.classList?.contains('react-flow__pane');
    setConnectionDragging(false);
    if (!targetIsPane || !connectingFrom.current || !wrapperRef.current) return;
    const clientX = event.clientX ?? event.changedTouches?.[0]?.clientX;
    const clientY = event.clientY ?? event.changedTouches?.[0]?.clientY;
    openContextMenu({ clientX, clientY }, 'add-node', true);
  }, [openContextMenu, setConnectionDragging]);

  const onCanvasDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      target.closest(
        '.react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__minimap, [data-no-canvas-menu="true"]',
      )
    ) {
      return;
    }
    if (!target.closest('.react-flow__pane')) return;
    connectingFrom.current = null;
    openContextMenu(event, 'add-node', false);
  }, [openContextMenu]);


  const onPickerSelect = useCallback((kind: NodeKind) => {
    if (!contextMenu) return;
    const id = `node-${Date.now()}`;
    addNode({
      id,
      type: kind,
      position: snapToGrid ? snapPosition({ x: contextMenu.flowX, y: contextMenu.flowY }) : { x: contextMenu.flowX, y: contextMenu.flowY },
      data: {},
    });

    if (contextMenu.fromConnection && connectingFrom.current) {
      const connection: Connection = {
        source: connectingFrom.current.nodeId,
        sourceHandle: connectingFrom.current.handleId ?? null,
        target: id,
        targetHandle: null,
      };
      onConnect(connection);
    }

    setContextMenu(null);
    connectingFrom.current = null;
  }, [addNode, contextMenu, onConnect, snapToGrid]);

  const uploadFilesAtPosition = useCallback(async (files: File[], flowPos: { x: number; y: number }) => {
    let offsetY = 0;

    for (const file of files) {
      const nodeType = getReferenceNodeTypeFromMimeType(file?.type);
      if (!nodeType) continue;

      const form = new FormData();
      form.append('file', file);

      try {
        const referenceValuePromise = readFileAsDataUrl(file);
        const resp = await fetch('/api/app/upload', { method: 'POST', body: form, credentials: 'include' });
        if (!resp.ok) {
          const bodyText = await resp.text();
          addNode({
            id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: nodeType,
            position: snapToGrid
              ? snapPosition({ x: flowPos.x, y: flowPos.y + offsetY })
              : { x: flowPos.x, y: flowPos.y + offsetY },
            data: {
              status: 'error',
              sourceName: file.name,
              error: `Upload failed (${resp.status}): ${bodyText || file.name}`,
            },
          });
          offsetY += 320;
          continue;
        }

        const json = await resp.json();
        const rawUrl = json?.data?.url as string;
        if (!rawUrl) {
          addNode({
            id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: nodeType,
            position: snapToGrid
              ? snapPosition({ x: flowPos.x, y: flowPos.y + offsetY })
              : { x: flowPos.x, y: flowPos.y + offsetY },
            data: {
              status: 'error',
              sourceName: file.name,
              error: `Upload response missing file url: ${file.name}`,
            },
          });
          offsetY += 320;
          continue;
        }

        const url = resolveBackendAssetUrl(rawUrl, import.meta.env.VITE_API_BASE_URL ?? '');
        if (!url) continue;

        const id = `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const position = snapToGrid
          ? snapPosition({ x: flowPos.x, y: flowPos.y + offsetY })
          : { x: flowPos.x, y: flowPos.y + offsetY };
        const referenceValue = await referenceValuePromise;

        addNode({
          id,
          type: nodeType,
          position,
          data: { url, status: 'done', sourceName: file.name },
        });

        if (referenceValue) {
          setReferencePayloadValue(id, referenceValue);
        }

        offsetY += 320;
      } catch (error) {
        addNode({
          id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: nodeType,
          position: snapToGrid
            ? snapPosition({ x: flowPos.x, y: flowPos.y + offsetY })
            : { x: flowPos.x, y: flowPos.y + offsetY },
          data: {
            status: 'error',
            sourceName: file.name,
            error: error instanceof Error ? error.message : `Upload failed: ${file.name}`,
          },
        });
        offsetY += 320;
      }
    }
  }, [addNode, snapToGrid]);

  const openUploadDialog = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleMenuUpload = useCallback(() => {
    openUploadDialog();
    setContextMenu(null);
  }, [openUploadDialog]);

  const handleFileInputChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    const targetPosition = contextMenu ? { x: contextMenu.flowX, y: contextMenu.flowY } : { x: 240, y: 180 };
    await uploadFilesAtPosition(files, targetPosition);
    event.target.value = '';
  }, [contextMenu, uploadFilesAtPosition]);

  const insertHistoryImages = useCallback((selectedItems: HistoryItem[]) => {
    if (!selectedItems.length) return;
    const basePosition = contextMenu ? { x: contextMenu.flowX, y: contextMenu.flowY } : { x: 240, y: 180 };

    selectedItems.forEach((item, index) => {
      const url = item.thumbnail || item.content;
      if (!url) return;
      addNode({
        id: `node-history-image-${Date.now()}-${index}`,
        type: 'referenceImageNode',
        position: snapToGrid
          ? snapPosition({ x: basePosition.x + index * 44, y: basePosition.y + index * 44 })
          : { x: basePosition.x + index * 44, y: basePosition.y + index * 44 },
        data: { url, status: 'done', sourceName: item.title },
      });
    });
  }, [addNode, contextMenu, snapToGrid]);

  /** Force every edge through the unified FlowEdge renderer. */
  const normalizedEdges = useMemo(
    () => edges.map((edge) => ({ ...edge, type: 'flow', animated: false, style: undefined })),
    [edges],
  );

  /** Export a group's bounding box as a PNG. Uses html-to-image to snapshot
   *  the ReactFlow viewport (which contains all nodes + edges), then crops
   *  the result down to the group's flow-coordinate bounds. */
  const exportGroupAsImage = useCallback(async (groupId: string) => {
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    const viewportEl = wrapperRef.current?.querySelector('.react-flow__viewport') as HTMLElement | null;
    if (!viewportEl) return;

    try {
      const { toPng } = await import('html-to-image');
      const v = viewportRef.current;
      const gx = group.position?.x ?? 0;
      const gy = group.position?.y ?? 0;
      const gw = group.width ?? 0;
      const gh = group.height ?? 0;
      if (gw === 0 || gh === 0) return;

      // Render the full viewport at 2x for crisp output, then crop to the
      // group rectangle in screen coords post-render via a canvas.
      const dataUrl = await toPng(viewportEl, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: '#0a0a0a',
        // Skip lock badges / ReactFlow controls so the export is clean.
        filter: (node) => {
          const cls = (node as HTMLElement).className;
          if (typeof cls !== 'string') return true;
          return !cls.includes('react-flow__controls') && !cls.includes('react-flow__minimap');
        },
      });

      // Crop on a temporary canvas. viewportEl uses CSS transform for
      // pan/zoom; the captured PNG already bakes the zoom in, but coordinate
      // calculation has to account for it.
      const img = new Image();
      img.src = dataUrl;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
      const zoom = v.zoom || 1;
      const sx = gx * zoom * 2; // 2x pixelRatio
      const sy = gy * zoom * 2;
      const sw = gw * zoom * 2;
      const sh = gh * zoom * 2;
      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${group.name || 'group'}-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (err) {
      console.error('export group failed', err);
      alert((err as Error)?.message || 'Export failed');
    }
  }, [groups]);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (!files.length || !wrapperRef.current) return;
    const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    await uploadFilesAtPosition(files, flowPos);
  }, [screenToFlowPosition, uploadFilesAtPosition]);

  return (
    <div
      ref={wrapperRef}
      className={`relative h-screen w-full bg-[#0a0a0a] ${cursorMode}`}
      onContextMenu={(event) => event.preventDefault()}
      onDoubleClick={onCanvasDoubleClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*"
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* Group BACKGROUND layer — rendered before ReactFlow so nodes render above the gray shell. */}
      <div className="pointer-events-none absolute inset-0 z-0">
        {liveGroups.map((group) => {
          const b = group._liveBounds;
          const left = viewport.x + b.x * viewport.zoom;
          const top = viewport.y + b.y * viewport.zoom;
          const width = b.width * viewport.zoom;
          const height = b.height * viewport.zoom;
          const selected = selectedGroupId === group.id;
          return (
            <div
              key={`shell-${group.id}`}
              className={clsx(
                'pointer-events-auto absolute rounded-[26px] border bg-white/[0.025] backdrop-blur-[2px] transition-colors',
                selected ? 'border-cyan-400/40 bg-cyan-400/[0.04]' : 'border-white/8',
              )}
              style={{ left, top, width, height }}
              onPointerDown={(event) => {
                if (event.target !== event.currentTarget) return;
                event.preventDefault();
                event.stopPropagation();
                setSelectedGroupId(group.id);
                groupDragRef.current = {
                  groupId: group.id,
                  lastClientX: event.clientX,
                  lastClientY: event.clientY,
                  didCaptureUndo: false,
                };
                setGroupDragging(true);
              }}
            >
              <GroupTitle
                groupId={group.id}
                name={group.name}
                count={group.nodeIds.length}
                zoom={viewport.zoom}
                onSelect={() => setSelectedGroupId(group.id)}
                onStartDrag={(event) => {
                  // Title bar doubles as a drag handle so the user can move
                  // the group from a fixed area even when nodes fill the
                  // interior. Wires through to the same groupDragRef the
                  // shell uses.
                  setSelectedGroupId(group.id);
                  groupDragRef.current = {
                    groupId: group.id,
                    lastClientX: event.clientX,
                    lastClientY: event.clientY,
                    didCaptureUndo: false,
                  };
                  setGroupDragging(true);
                }}
              />
            </div>
          );
        })}
      </div>

      <ReactFlow
        nodes={nodes}
        edges={normalizedEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={() => setSelectedGroupId(null)}
        onNodeDragStart={() => setNodeDragging(true)}
        onNodeDragStop={(_event, _node, draggedNodes) => {
          setNodeDragging(false);
          setGuides([]);
          // Membership is re-evaluated against each group's FIXED stored
          // rectangle (the gray shell the user can see):
          //   - dragged member ends up INSIDE  → stays in
          //   - dragged member ends up OUTSIDE → leaves on this drop
          //   - dragged non-member ends up INSIDE → joins this drop
          // The group rectangle itself does NOT resize. To make the box
          // bigger or smaller, the user reframes it (move group / recreate).
          const movedIds = new Set(draggedNodes.map((n) => n.id));
          const isInsideGroup = (
            node: { position: { x: number; y: number }; width?: number; height?: number; measured?: { width?: number; height?: number } },
            group: { position?: { x: number; y: number }; width?: number; height?: number },
          ) => {
            const gx = group.position?.x ?? 0;
            const gy = group.position?.y ?? 0;
            const gw = group.width ?? 0;
            const gh = group.height ?? 0;
            if (gw === 0 || gh === 0) return false;
            const nodeW = node.measured?.width ?? node.width ?? 300;
            const nodeH = node.measured?.height ?? node.height ?? 200;
            const cx = node.position.x + nodeW / 2;
            const cy = node.position.y + nodeH / 2;
            return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
          };
          groups.forEach((group) => {
            const memberSet = new Set(group.nodeIds);
            let changed = false;
            const nextMembers = new Set(memberSet);
            // OUTFLOW
            for (const memberId of memberSet) {
              if (!movedIds.has(memberId)) continue;
              const node = nodes.find((n) => n.id === memberId);
              if (!node) continue;
              if (!isInsideGroup(node, group)) { nextMembers.delete(memberId); changed = true; }
            }
            // INFLOW
            for (const moved of draggedNodes) {
              if (memberSet.has(moved.id)) continue;
              const node = nodes.find((n) => n.id === moved.id) ?? moved;
              if (isInsideGroup(node as never, group)) { nextMembers.add(moved.id); changed = true; }
            }
            if (changed) setGroupMembers(group.id, Array.from(nextMembers));
          });
        }}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
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
            }}
          />
        ) : null}
        {snapToGrid ? <AlignmentGuides guides={guides} /> : null}
      </ReactFlow>

      {/* Lock indicators — one small Lock icon overlaid on every node whose
          `data.locked === true`. Lives at Canvas level so we don't have to
          thread a `locked` prop through every node type. */}
      <div className="pointer-events-none absolute inset-0 z-30">
        {nodes.filter((n) => (n.data as { locked?: boolean } | undefined)?.locked).map((n) => {
          const w = (n as { measured?: { width?: number } }).measured?.width ?? n.width ?? 300;
          const left = viewport.x + (n.position.x + w - 22) * viewport.zoom;
          const top  = viewport.y + (n.position.y - 6) * viewport.zoom;
          return (
            <div
              key={`lock-${n.id}`}
              className="pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full bg-amber-400/90 text-amber-950 shadow-md ring-1 ring-amber-300"
              style={{ left, top, transform: 'translate(0, 0)' }}
              title="已锁定 · 点击解锁（Ctrl+L）"
              onClick={(event) => {
                event.stopPropagation();
                toggleNodeLock([n.id]);
              }}
            >
              <LockIcon className="h-3 w-3" />
            </div>
          );
        })}
      </div>

      {/* Group toolbar — appears above the selected group. */}
      {selectedGroupId ? (() => {
        const sel = liveGroups.find((g) => g.id === selectedGroupId);
        if (!sel) return null;
        const b = sel._liveBounds;
        const left = viewport.x + (b.x + b.width / 2) * viewport.zoom;
        const top = viewport.y + b.y * viewport.zoom - 12;
        const itemClass = 'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40';
        return (
          <div
            className="absolute z-30 flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-full border border-white/10 bg-[#15181d]/90 px-2 py-1.5 shadow-2xl backdrop-blur-xl"
            style={{ left, top }}
          >
            <button disabled className={itemClass}>
              <Play className="h-3.5 w-3.5 text-neutral-400" />
              {language === 'zh' ? '整组执行' : 'Run Group'}
            </button>
            <div className="h-4 w-px bg-white/10" />
            <button disabled className={itemClass}>
              <Wrench className="h-3.5 w-3.5 text-neutral-400" />
              {language === 'zh' ? '添加到工具箱' : 'Add to Toolbox'}
            </button>
            <div className="h-4 w-px bg-white/10" />
            <button disabled className={itemClass}>
              <Share2 className="h-3.5 w-3.5 text-neutral-400" />
              {language === 'zh' ? '转分镜组' : 'Convert to Storyboard'}
            </button>
            <div className="h-4 w-px bg-white/10" />
            <button
              onClick={() => { ungroupNodes(selectedGroupId); setSelectedGroupId(null); }}
              className={itemClass}
            >
              <UngroupIcon className="h-3.5 w-3.5 text-neutral-400" />
              {language === 'zh' ? '解组' : 'Ungroup'}
            </button>
            <div className="h-4 w-px bg-white/10" />
            <button
              onClick={() => exportGroupAsImage(selectedGroupId)}
              className={itemClass}
              title={language === 'zh' ? '导出该组范围为 PNG' : 'Export group bounds as PNG'}
            >
              <Download className="h-3.5 w-3.5 text-neutral-400" />
              {language === 'zh' ? '导出 PNG' : 'Export PNG'}
            </button>
            <div className="h-4 w-px bg-white/10" />
            <button
              onClick={() => { removeGroup(selectedGroupId); setSelectedGroupId(null); }}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-rose-300 transition hover:bg-rose-500/10"
              title={language === 'zh' ? '删除整组（含节点）' : 'Delete group with nodes'}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })() : null}

      {selectedIds.length >= 2 && !contextMenu && !groupDragging && selectionBounds ? (() => {
        // If the entire selection corresponds exactly to one existing group, show "Ungroup" instead.
        const selectionSet = new Set(selectedIds);
        const matchingGroup = groups.find((group) => (
          group.nodeIds.length === selectionSet.size && group.nodeIds.every((id) => selectionSet.has(id))
        ));
        const rightX = viewport.x + (selectionBounds.x + selectionBounds.width) * viewport.zoom;
        const centerY = viewport.y + (selectionBounds.y + selectionBounds.height / 2) * viewport.zoom;
        return (
          <>
          {/* Selection bulk-routing + handle on the right edge */}
          <button
            type="button"
            className="absolute z-30 flex h-7 w-7 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-white/15 bg-[#1a1d22]/90 text-neutral-300 shadow-lg backdrop-blur-md transition hover:border-cyan-300/40 hover:text-cyan-200"
            style={{ left: rightX, top: centerY }}
            onMouseDown={(event) => {
              event.stopPropagation();
              setConnectionDragging(true);
              setBulkRouting({
                startClient: { x: event.clientX, y: event.clientY },
                currentClient: { x: event.clientX, y: event.clientY },
              });
            }}
            title={language === 'zh' ? '从所有选中节点拉线' : 'Connect all selected to a target'}
          >
            <Plus className="h-4 w-4" />
          </button>
          <div
            className="absolute z-30 flex -translate-x-1/2 -translate-y-full items-center gap-1 rounded-full border border-white/10 bg-[#15181d]/90 px-2 py-1.5 shadow-2xl backdrop-blur-xl"
            style={{
              left: viewport.x + (selectionBounds.x + selectionBounds.width / 2) * viewport.zoom,
              top: viewport.y + selectionBounds.y * viewport.zoom - 12,
            }}
          >
            <button className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/5">
              <Upload className="h-3.5 w-3.5 text-neutral-400" />
              {dict.create_asset}
              <span className="ml-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-[9px] tracking-wider text-rose-300">BETA</span>
            </button>
            <div className="h-4 w-px bg-white/10" />
            {matchingGroup ? (
              <button
                onClick={() => { ungroupNodes(matchingGroup.id); }}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/5"
              >
                <UngroupIcon className="h-3.5 w-3.5 text-neutral-400" />
                {language === 'zh' ? '解组' : 'Ungroup'}
              </button>
            ) : (
              <button
                onClick={() => createGroup(selectedIds)}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/5"
              >
                <GroupIcon className="h-3.5 w-3.5 text-neutral-400" />
                {dict.group}
              </button>
            )}

            {/* Alignment & distribution shortcuts. Distribute only useful for
                3+ selected nodes; alignment works at 2+. */}
            <div className="h-4 w-px bg-white/10" />
            <AlignmentToolbarButtons
              count={selectedIds.length}
              onAlign={(mode) => alignSelectedNodes(mode)}
              onDistribute={(axis) => distributeSelectedNodes(axis)}
              zh={language === 'zh'}
            />
          </div>
          </>
        );
      })() : null}

      {/* Bulk-routing converging curves with animated flow */}
      {bulkDragCurves && bulkDragCurves.length > 0 ? (
        <svg className="pointer-events-none absolute inset-0 z-30 h-full w-full overflow-visible">
          {bulkDragCurves.map((curve) => (
            <g key={curve.id}>
              {/* Soft outer glow */}
              <path d={curve.d} fill="none" stroke="#22d3ee" strokeOpacity={0.18} strokeWidth={6} strokeLinecap="round" />
              {/* Solid base stroke */}
              <path d={curve.d} fill="none" stroke="#22d3ee" strokeOpacity={0.85} strokeWidth={2} strokeLinecap="round" />
              {/* Animated dashed overlay — gives a flowing pulse along the curve */}
              <path d={curve.d} fill="none" stroke="#a5f3fc" strokeWidth={2} strokeLinecap="round" strokeDasharray="10 14">
                <animate attributeName="stroke-dashoffset" from="0" to="-24" dur="0.6s" repeatCount="indefinite" />
              </path>
            </g>
          ))}
        </svg>
      ) : null}

      {contextMenu ? (
        <>
          <div className="absolute inset-0 z-30" onClick={() => setContextMenu(null)} />
          <div
            className={clsx(
              'absolute z-40 rounded-[14px] border border-white/10 bg-[#252525]/98 shadow-2xl backdrop-blur-xl',
              contextMenu.mode === 'node-media' || contextMenu.mode === 'node-text'
                ? 'w-[220px] p-1.5'
                : 'w-[280px] p-2 rounded-[22px]',
            )}
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.mode === 'node-media' || contextMenu.mode === 'node-text' ? (
              <div className="flex flex-col">
                {contextMenu.mode === 'node-media' ? (
                  <NodeMenuItem labelZh="Seedance2.0合规校验" labelEn="Seedance2.0 Check" hint="?" disabled />
                ) : null}
                <NodeMenuItem
                  labelZh="保存到我的素材"
                  labelEn="Save to My Assets"
                  disabled={contextMenu.mode === 'node-text'}
                  onClick={() => {
                    if (contextMenu.nodeId) openSaveAssetDialog(contextMenu.nodeId);
                    setContextMenu(null);
                  }}
                />
                {contextMenu.mode === 'node-media' ? (
                  <NodeMenuItem labelZh="进入全景预览" labelEn="Panorama Preview" hint="?" disabled />
                ) : null}
                <NodeMenuItem labelZh="创建主体" labelEn="Create Subject" disabled />
                {contextMenu.mode === 'node-media' ? (
                  <NodeMenuItem labelZh="优化工作流布局" labelEn="Optimize Layout" disabled />
                ) : null}
                <div className="my-1 h-px bg-white/8" />
                <NodeMenuItem
                  labelZh="复制节点"
                  labelEn="Copy Node"
                  hint="?"
                  shortcut="⌘C"
                  onClick={() => { copySelectedNodes(); setContextMenu(null); }}
                />
                {contextMenu.mode === 'node-media' ? (
                  <NodeMenuItem labelZh="复制图片" labelEn="Copy Image" disabled />
                ) : null}
                <NodeMenuItem labelZh="创建副本" labelEn="Duplicate" hint="?" disabled />
                <NodeMenuItem
                  labelZh="粘贴"
                  labelEn="Paste"
                  shortcut="⌘V"
                  onClick={() => { pasteCopiedNodes(); setContextMenu(null); }}
                />
                <NodeMenuItem
                  labelZh="删除"
                  labelEn="Delete"
                  shortcut="⌘⌫"
                  onClick={() => {
                    if (contextMenu.nodeId) {
                      handleNodesChange([{ type: 'remove', id: contextMenu.nodeId }] as never);
                    }
                    setContextMenu(null);
                  }}
                />
                <div className="my-1 h-px bg-white/8" />
                {/* Lock / unlock toggle — Ctrl+L global shortcut also works. */}
                <NodeMenuItem
                  labelZh={(contextMenu.nodeId && (nodes.find((n) => n.id === contextMenu.nodeId)?.data as { locked?: boolean } | undefined)?.locked) ? '解锁' : '锁定'}
                  labelEn={(contextMenu.nodeId && (nodes.find((n) => n.id === contextMenu.nodeId)?.data as { locked?: boolean } | undefined)?.locked) ? 'Unlock' : 'Lock'}
                  shortcut="⌘L"
                  onClick={() => {
                    if (contextMenu.nodeId) toggleNodeLock([contextMenu.nodeId]);
                    setContextMenu(null);
                  }}
                />
                <div className="my-1 h-px bg-white/8" />
                {/* Z-order — array tail renders on top in ReactFlow. */}
                <NodeMenuItem
                  labelZh="置于顶层" labelEn="Bring to Front" shortcut="]"
                  onClick={() => { if (contextMenu.nodeId) bringNodeToFront(contextMenu.nodeId); setContextMenu(null); }}
                />
                <NodeMenuItem
                  labelZh="上移一层" labelEn="Bring Forward"
                  onClick={() => { if (contextMenu.nodeId) bringNodeForward(contextMenu.nodeId); setContextMenu(null); }}
                />
                <NodeMenuItem
                  labelZh="下移一层" labelEn="Send Backward"
                  onClick={() => { if (contextMenu.nodeId) sendNodeBackward(contextMenu.nodeId); setContextMenu(null); }}
                />
                <NodeMenuItem
                  labelZh="置于底层" labelEn="Send to Back" shortcut="["
                  onClick={() => { if (contextMenu.nodeId) sendNodeToBack(contextMenu.nodeId); setContextMenu(null); }}
                />
                <div className="my-1 h-px bg-white/8" />
                <NodeMenuItem labelZh="复制到剪贴板" labelEn="Copy to Clipboard" disabled />
              </div>
            ) : contextMenu.mode === 'root' ? (
              <div className="flex flex-col">
                <ContextMenuButton icon={Upload} labelZh="上传" labelEn="Upload" onClick={handleMenuUpload} />
                <ContextMenuButton
                  icon={FolderHeart}
                  labelZh="打开素材库"
                  labelEn="Open Asset Library"
                  onClick={() => { setAssetLibraryOpen(true); setContextMenu(null); }}
                />
                <ContextMenuButton
                  icon={Sparkles}
                  labelZh="添加节点"
                  labelEn="Add Node"
                  onClick={() => setContextMenu((current) => (current ? { ...current, mode: 'add-node' } : current))}
                />
                <div className="my-2 h-px bg-white/8" />
                <ContextMenuButton icon={Undo2} labelZh="撤销" labelEn="Undo" shortcut="⌘Z" disabled />
                <ContextMenuButton icon={Redo2} labelZh="重做" labelEn="Redo" shortcut="⇧⌘Z" disabled />
                <div className="my-2 h-px bg-white/8" />
                <ContextMenuButton icon={ClipboardPaste} labelZh="粘贴" labelEn="Paste" shortcut="⌘V" disabled />
              </div>
            ) : (
              <div className="flex flex-col">
                <div className="px-3 py-2 text-sm font-medium text-neutral-100">
                  {language === 'zh' ? '添加节点' : 'Add Node'}
                </div>
                {PICKER_OPTIONS.map((option) => (
                  <ContextMenuButton
                    key={option.kind}
                    icon={option.icon}
                    labelZh={option.zh}
                    labelEn={option.en}
                    onClick={() => onPickerSelect(option.kind)}
                  />
                ))}
                {FUTURE_NODE_OPTIONS.map((option) => (
                  <ContextMenuButton
                    key={option.key}
                    icon={option.icon}
                    labelZh={option.zh}
                    labelEn={option.en}
                    subtitleZh={option.subtitleZh}
                    subtitleEn={option.subtitleEn}
                    badge={option.badge}
                    disabled
                  />
                ))}
                <div className="px-3 pt-3 text-xs text-neutral-500">
                  {language === 'zh' ? '添加资源' : 'Add Resource'}
                </div>
                <ContextMenuButton icon={Upload} labelZh="上传" labelEn="Upload" onClick={handleMenuUpload} />
                <ContextMenuButton
                  icon={ImageIcon}
                  labelZh="从生成历史选择"
                  labelEn="Choose from History"
                  onClick={() => {
                    setHistoryImagePickerOpen(true);
                    setContextMenu(null);
                  }}
                />
              </div>
            )}
          </div>
        </>
      ) : null}

      <HistoryImagePickerModal
        isOpen={isHistoryImagePickerOpen}
        historyItems={history}
        onClose={() => setHistoryImagePickerOpen(false)}
        onConfirm={(selectedItems) => {
          insertHistoryImages(selectedItems);
          setHistoryImagePickerOpen(false);
          setContextMenu(null);
        }}
      />

      <div className="absolute bottom-6 left-6 z-40 flex flex-col gap-3">
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

      {/* Zoom % indicator — read-only pill at the top center of the
          canvas. Matches NeoWOW's `极简 · NNN%` chip; the "极简" render
          mode is deferred until a real implementation lands, so for now
          we surface zoom alone. */}
      <div className="pointer-events-none absolute left-1/2 top-4 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/8 bg-black/40 px-3 py-1 text-[11px] text-neutral-400 shadow-lg backdrop-blur-xl tabular-nums">
        {Math.round(viewport.zoom * 100)}%
      </div>

      {/* Canvas stats — node / edge / group counts, NeoWOW-style hairline
          pill in the bottom-right corner. Sits to the left of the Agent
          FAB so they don't overlap. */}
      <div className="pointer-events-none absolute bottom-6 right-24 z-30 flex items-center gap-2 rounded-full border border-white/8 bg-black/40 px-3 py-1 text-[11px] text-neutral-400 shadow-lg backdrop-blur-xl">
        <span className="tabular-nums">
          {language === 'zh' ? '节点' : 'Nodes'} {nodes.length}
        </span>
        <span className="text-neutral-600">/</span>
        <span className="tabular-nums">
          {language === 'zh' ? '边' : 'Edges'} {edges.length}
        </span>
        <span className="text-neutral-600">·</span>
        <span className="tabular-nums">
          {groups.length} {language === 'zh' ? '分组' : 'groups'}
        </span>
      </div>

      <SaveAssetDialog />

      {/* Agent run panel + toggle FAB (bottom-right) */}
      <button
        onClick={() => setAgentPanelOpen((v) => !v)}
        className="absolute bottom-6 right-6 z-30 flex h-12 w-12 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-500/15 text-cyan-200 shadow-2xl backdrop-blur-xl transition hover:bg-cyan-500/25"
        title={language === 'zh' ? '智能体' : 'Agent'}
        style={{ display: agentPanelOpen ? 'none' : undefined }}
      >
        <BotIcon className="h-5 w-5" />
      </button>
      <AgentRunPanel open={agentPanelOpen} onClose={() => setAgentPanelOpen(false)} />
    </div>
  );
};

function GroupTitle({
  groupId,
  name,
  count,
  zoom,
  onSelect,
  onStartDrag,
}: {
  groupId: string;
  name: string;
  count: number;
  zoom: number;
  onSelect: () => void;
  onStartDrag: (event: React.PointerEvent) => void;
}) {
  const language = useStore((state) => state.language);
  const renameGroup = useStore((state) => state.renameGroup);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  useEffect(() => { setDraft(name); }, [name]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== name) renameGroup(groupId, next);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') { setDraft(name); setEditing(false); }
        }}
        className="pointer-events-auto absolute left-0 top-0 -translate-y-[110%] rounded bg-[#1a1d22] px-1 text-neutral-100 outline-none ring-1 ring-cyan-300/40"
        style={{ fontSize: `${Math.max(9, 12 * zoom)}px`, padding: `${2 * zoom}px ${4 * zoom}px` }}
      />
    );
  }

  return (
    <div
      role="button"
      // Title bar is the canonical drag handle for the group. Mirrors the
      // shell's pointerdown wiring exactly so it behaves identically.
      onPointerDown={(event) => {
        // Only stopPropagation — NO preventDefault, otherwise the browser
        // suppresses the synthetic dblclick that powers rename. The window
        // pointermove handler only calls moveGroup when there's actual
        // pixel movement, so a quick click without movement still registers
        // cleanly as a click → dblclick path.
        event.stopPropagation();
        onStartDrag(event);
      }}
      onDoubleClick={(event) => { event.stopPropagation(); setEditing(true); }}
      className="pointer-events-auto absolute left-0 top-0 z-20 -translate-y-[110%] flex cursor-grab select-none items-center gap-1 whitespace-nowrap rounded text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200 active:cursor-grabbing"
      style={{ fontSize: `${Math.max(9, 12 * zoom)}px`, padding: `${2 * zoom}px ${4 * zoom}px` }}
      title={language === 'zh' ? '拖动移动整组 · 双击重命名' : 'Drag to move group · double-click to rename'}
    >
      <span aria-hidden className="opacity-50">⋮⋮</span>
      <span>{name} · {count}{language === 'zh' ? ' 个节点' : ' nodes'}</span>
    </div>
  );
}

function NodeMenuItem({
  labelZh,
  labelEn,
  hint,
  shortcut,
  disabled,
  onClick,
}: {
  labelZh: string;
  labelEn: string;
  hint?: string;
  shortcut?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const language = useStore((state) => state.language);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'flex items-center justify-between rounded-md px-3 py-2 text-left text-sm transition',
        disabled ? 'cursor-not-allowed text-neutral-500' : 'text-neutral-200 hover:bg-white/5',
      )}
    >
      <span className="flex items-center gap-1.5">
        {language === 'zh' ? labelZh : labelEn}
        {hint ? <span className="text-[10px] text-neutral-500">{hint}</span> : null}
      </span>
      {shortcut ? <span className="text-xs text-neutral-500">{shortcut}</span> : null}
    </button>
  );
}

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

function ContextMenuButton({
  icon: Icon,
  labelZh,
  labelEn,
  subtitleZh,
  subtitleEn,
  badge,
  shortcut,
  disabled,
  onClick,
}: {
  icon: any;
  labelZh: string;
  labelEn: string;
  subtitleZh?: string;
  subtitleEn?: string;
  badge?: string;
  shortcut?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const language = useStore((state) => state.language);
  const label = language === 'zh' ? labelZh : labelEn;
  const subtitle = language === 'zh' ? subtitleZh : subtitleEn;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center justify-between rounded-2xl px-3 py-3 text-left transition ${
        disabled ? 'cursor-not-allowed opacity-45' : 'hover:bg-white/5'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${disabled ? 'bg-white/6 text-neutral-500' : 'bg-white/8 text-neutral-200'}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2 text-sm text-neutral-100">
            <span>{label}</span>
            {badge ? <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10px] text-neutral-300">{badge}</span> : null}
          </div>
          {subtitle ? <div className="mt-1 text-xs text-neutral-500">{subtitle}</div> : null}
        </div>
      </div>
      {shortcut ? <div className="text-xs text-neutral-500">{shortcut}</div> : null}
    </button>
  );
}

/** Inline alignment cluster shown inside the multi-select toolbar. The
 *  6 alignment buttons map to a shared edge / center; the 2 distribute
 *  buttons (only enabled with 3+ nodes) spread the selection evenly. */
function AlignmentToolbarButtons({
  count,
  onAlign,
  onDistribute,
  zh,
}: {
  count: number;
  onAlign: (mode: 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom') => void;
  onDistribute: (axis: 'horizontal' | 'vertical') => void;
  zh: boolean;
}) {
  const distributeEnabled = count >= 3;
  const btn = 'flex h-7 w-7 items-center justify-center rounded text-neutral-300 transition hover:bg-white/8 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-neutral-300';
  return (
    <div className="flex items-center gap-0.5">
      <button onClick={() => onAlign('left')}     className={btn} title={zh ? '左对齐' : 'Align left'}>             <AlignStartVertical className="h-3.5 w-3.5" /></button>
      <button onClick={() => onAlign('center-h')} className={btn} title={zh ? '水平居中' : 'Align center (H)'}>    <AlignCenterVertical className="h-3.5 w-3.5" /></button>
      <button onClick={() => onAlign('right')}    className={btn} title={zh ? '右对齐' : 'Align right'}>            <AlignEndVertical className="h-3.5 w-3.5" /></button>
      <div className="mx-1 h-4 w-px bg-white/10" />
      <button onClick={() => onAlign('top')}      className={btn} title={zh ? '顶端对齐' : 'Align top'}>           <AlignStartHorizontal className="h-3.5 w-3.5" /></button>
      <button onClick={() => onAlign('center-v')} className={btn} title={zh ? '垂直居中' : 'Align middle (V)'}>    <AlignCenterHorizontal className="h-3.5 w-3.5" /></button>
      <button onClick={() => onAlign('bottom')}   className={btn} title={zh ? '底端对齐' : 'Align bottom'}>         <AlignEndHorizontal className="h-3.5 w-3.5" /></button>
      <div className="mx-1 h-4 w-px bg-white/10" />
      <button
        onClick={() => onDistribute('horizontal')}
        disabled={!distributeEnabled}
        className={btn}
        title={zh ? '水平等距分布（需选 3+）' : 'Distribute horizontally (3+ needed)'}
      >
        <AlignHorizontalDistributeCenter className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => onDistribute('vertical')}
        disabled={!distributeEnabled}
        className={btn}
        title={zh ? '垂直等距分布（需选 3+）' : 'Distribute vertically (3+ needed)'}
      >
        <AlignVerticalDistributeCenter className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export const Canvas = () => (
  <ReactFlowProvider>
    <InnerCanvas />
  </ReactFlowProvider>
);
