import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  FolderHeart,
  HelpCircle,
  Image as ImageIcon,
  Layers3,
  LayoutGrid,
  Map,
  Maximize2,
  Minimize2,
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
  ChevronDown,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  Search as SearchIcon,
  MoveRight,
  Boxes,
  Palette,
  MoveDiagonal2,
} from 'lucide-react';

import clsx from 'clsx';
import { useStore, eventMatchesShortcut, setCanvasInteractionActive, type HistoryItem, type Group } from '../store';
import { uploadFileWithProgress } from '../api/projects';
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
import { CanvasGuideModal } from './CanvasGuideModal';
import { CanvasIndexPanel } from './CanvasIndexPanel';

// 3D 导演台 overlay 走动态 import,three.js + r3f + drei (~1MB) 只在用户首次
// 打开导演台时按需加载,首屏 0 影响.
const DirectorStageOverlay = lazy(() =>
  import('./nodes/DirectorStageOverlay').then((m) => ({ default: m.DirectorStageOverlay })),
);

const edgeTypes = { flow: FlowEdge };
const defaultEdgeOptions = { type: 'flow' as const };
import { t } from '../i18n';
import { HistoryImagePickerModal } from './HistoryImagePickerModal';

type NodeKind = 'textNode' | 'imageNode' | 'videoNode' | 'audioNode' | 'directorStageNode';
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
/** Snap window in SCREEN pixels — divided by zoom before comparing flow
 *  coords, so the grab distance feels identical at 37% and 200%. */
const GUIDE_THRESHOLD_SCREEN = 8;

/** Node types whose edges keep their own default handles instead of being
 *  routed to the flush `edge-source-right` / `edge-target-left` anchors (see
 *  normalizedEdges). Agent + sticky nodes already expose small handles centered
 *  ON the node edge (React Flow default Position.Left/Right), so their wires are
 *  already flush. Director-stage + composition nodes DO define the flush anchors
 *  (their `+` bubbles sit 20px outside), so they are NOT excluded here. */
const NON_PORT_NODE_TYPES = new Set(['agentNode', 'stickyNoteNode']);

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

function computeGuides(dragged: Node, others: Node[], threshold: number): {
  guides: GuideLine[];
  snapDx: number;
  snapDy: number;
  hasSnapX: boolean;
  hasSnapY: boolean;
} {
  const db = getNodeBounds(dragged);
  const guides: GuideLine[] = [];

  // hasSnapX/Y must be tracked separately from the delta: a PERFECT alignment
  // yields snapDx === 0, which the caller used to misread as "no snap" and
  // then grid-round the node right off its alignment.
  let bestDistX = threshold;
  let bestDistY = threshold;
  let snapDx = 0;
  let snapDy = 0;
  let hasSnapX = false;
  let hasSnapY = false;

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
          hasSnapX = true;
        }
      }
    }

    for (const dy of dragYAnchors) {
      for (const oy of otherYAnchors) {
        const dist = Math.abs(dy - oy);
        if (dist < bestDistY) {
          bestDistY = dist;
          snapDy = oy - dy;
          hasSnapY = true;
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

  return { guides, snapDx, snapDy, hasSnapX, hasSnapY };
}

function AlignmentGuides({ guides }: { guides: GuideLine[] }) {
  const { x, y, zoom } = useViewport();
  if (!guides.length) return null;

  // Reference-style guides: fine white dashed line spanning both nodes with
  // short perpendicular ticks at each end. All strokes/dashes/extents are
  // divided by zoom so they render at a constant screen size.
  const overshoot = 12 / zoom;
  const tick = 4 / zoom;
  const stroke = 'rgba(255,255,255,0.75)';
  const width = 1 / zoom;
  const dash = `${5 / zoom} ${4 / zoom}`;

  return (
    <svg className="pointer-events-none absolute inset-0 z-[5] h-full w-full overflow-visible">
      <g transform={`translate(${x},${y}) scale(${zoom})`}>
        {guides.map((guide, index) => {
          const from = guide.from - overshoot;
          const to = guide.to + overshoot;
          return guide.orientation === 'v' ? (
            <g key={index}>
              <line x1={guide.pos} y1={from} x2={guide.pos} y2={to} stroke={stroke} strokeWidth={width} strokeDasharray={dash} />
              <line x1={guide.pos - tick} y1={from} x2={guide.pos + tick} y2={from} stroke={stroke} strokeWidth={width} />
              <line x1={guide.pos - tick} y1={to} x2={guide.pos + tick} y2={to} stroke={stroke} strokeWidth={width} />
            </g>
          ) : (
            <g key={index}>
              <line x1={from} y1={guide.pos} x2={to} y2={guide.pos} stroke={stroke} strokeWidth={width} strokeDasharray={dash} />
              <line x1={from} y1={guide.pos - tick} x2={from} y2={guide.pos + tick} stroke={stroke} strokeWidth={width} />
              <line x1={to} y1={guide.pos - tick} x2={to} y2={guide.pos + tick} stroke={stroke} strokeWidth={width} />
            </g>
          );
        })}
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
    updateNodeData,
    createGroup,
    showMiniMap,
    setShowMiniMap,
    snapToGrid,
    history,
  } = useStore();
  const saveCanvasToBackend = useStore((state) => state.saveCanvasToBackend);
  const activeBackendProjectId = useStore((state) => state.activeBackendProjectId);
  const canvasHydrated = useStore((state) => state.canvasHydrated);
  const language = useStore((state) => state.language);
  const isConnectionDragging = useStore((state) => state.isConnectionDragging);
  const setConnectionDragging = useStore((state) => state.setConnectionDragging);
  const undoCanvas = useStore((state) => state.undoCanvas);
  const redoCanvas = useStore((state) => state.redoCanvas);
  const pushUndoSnapshot = useStore((state) => state.pushUndoSnapshot);
  const deleteSelectedNodes = useStore((state) => state.deleteSelectedNodes);
  const shortcuts = useStore((state) => state.shortcuts);
  const copySelectedNodes = useStore((state) => state.copySelectedNodes);
  const pasteCopiedNodes = useStore((state) => state.pasteCopiedNodes);
  const removeGroup = useStore((state) => state.removeGroup);
  const ungroupNodes = useStore((state) => state.ungroupNodes);
  const setGroupMembers = useStore((state) => state.setGroupMembers);
  const moveGroup = useStore((state) => state.moveGroup);
  const resizeGroup = useStore((state) => state.resizeGroup);
  const setGroupColor = useStore((state) => state.setGroupColor);
  const arrangeGroupNodes = useStore((state) => state.arrangeGroupNodes);
  const commitCanvasMirrors = useStore((state) => state.commitCanvasMirrors);
  const arrangeSelectedNodes = useStore((state) => state.arrangeSelectedNodes);
  const tidyCanvas = useStore((state) => state.tidyCanvas);
  const toggleNodeLock = useStore((state) => state.toggleNodeLock);
  const bringNodeForward = useStore((state) => state.bringNodeForward);
  const sendNodeBackward = useStore((state) => state.sendNodeBackward);
  const bringNodeToFront = useStore((state) => state.bringNodeToFront);
  const sendNodeToBack = useStore((state) => state.sendNodeToBack);
  const openSaveAssetDialog = useStore((state) => state.openSaveAssetDialog);
  const directorStageNodeId = useStore((state) => state.directorStageNodeId);
  const setAssetLibraryOpen = useStore((state) => state.setAssetLibraryOpen);
  const dict = t[language];
  const { screenToFlowPosition, fitView, setCenter, zoomTo } = useReactFlow();
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
  // Corner-resize drag state for group shells (pointer-captured on the grip).
  const groupResizeRef = useRef<{
    groupId: string;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    didCaptureUndo: boolean;
  } | null>(null);

  const [spaceHeld, setSpaceHeld] = useState(false);
  const [nodeDragging, setNodeDragging] = useState(false);
  // Mirrors `groupDragRef.current != null` as state so React re-renders the
  // surrounding UI (we use it to hide the multi-select toolbar/bounds while
  // the group is being moved).
  const [groupDragging, setGroupDragging] = useState(false);
  // Bottom-right canvas index — the "所有节点 / 分组" jump panel.
  const [indexPanel, setIndexPanel] = useState<'nodes' | 'groups' | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const agentPanelOpen = useStore((s) => s.agentPanelOpen);
  const setAgentPanelOpen = useStore((s) => s.setAgentPanelOpen);
  const [guides, setGuides] = useState<GuideLine[]>([]);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [minimapExpanded, setMinimapExpanded] = useState(false);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const minimapHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reveal the enlarge button only while the pointer is over the minimap (or
  // the button). Debounced hide so moving between them doesn't flicker.
  const enterMinimap = useCallback(() => {
    if (minimapHideTimer.current) clearTimeout(minimapHideTimer.current);
    setMinimapHovered(true);
  }, []);
  const leaveMinimap = useCallback(() => {
    if (minimapHideTimer.current) clearTimeout(minimapHideTimer.current);
    minimapHideTimer.current = setTimeout(() => setMinimapHovered(false), 120);
  }, []);
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const rippleIdRef = useRef(0);

  // Spawn a short-lived click ripple at the pointer (canvas coords relative to
  // the wrapper). Auto-removed after the animation so the list stays tiny.
  const spawnRipple = useCallback((clientX: number, clientY: number) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const id = (rippleIdRef.current += 1);
    setRipples((rs) => [...rs, { id, x: clientX - rect.left, y: clientY - rect.top }]);
    window.setTimeout(() => setRipples((rs) => rs.filter((r) => r.id !== id)), 650);
  }, []);
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

  // Block the BROWSER's Ctrl/⌘+wheel page zoom app-wide. Over the canvas,
  // ReactFlow still zooms programmatically (it reads the wheel delta, not the
  // default action); over the UI overlays (toolbar, minimap, header) Ctrl+wheel
  // now does nothing instead of zooming the whole page.
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) event.preventDefault();
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

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
      // Never hijack keys while the user is typing in an input/textarea/editor.
      if (isEditableTarget(event.target)) return;

      // ── Delete / Backspace ─────────────────────────────────────────────
      // Office-standard: Del removes the current selection. A selected group
      // takes priority (its members stay on canvas); otherwise remove the
      // selected node(s). Backspace is always accepted as an alias, and the
      // bound `delete_node` combo (default Delete) is honored too.
      if (eventMatchesShortcut(event, 'delete_node', shortcuts) || event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedGroupId) {
          event.preventDefault();
          removeGroup(selectedGroupId);
          setSelectedGroupId(null);
          return;
        }
        if (nodesRef.current.some((n) => n.selected)) {
          event.preventDefault();
          deleteSelectedNodes();
        }
        return;
      }

      // ── Undo / Redo ────────────────────────────────────────────────────
      // Config-aware (recording in settings actually rebinds these), with the
      // universal office combos always accepted: Ctrl+Z undo; Ctrl+Y and
      // Ctrl+Shift+Z redo.
      if (eventMatchesShortcut(event, 'undo', shortcuts)) {
        event.preventDefault();
        undoCanvas();
        return;
      }
      const mod = event.ctrlKey || event.metaKey;
      const isRedoAlias = mod && (
        (event.shiftKey && event.key.toLowerCase() === 'z') || // Ctrl+Shift+Z
        (!event.shiftKey && event.key.toLowerCase() === 'y')   // Ctrl+Y
      );
      if (eventMatchesShortcut(event, 'redo', shortcuts) || isRedoAlias) {
        event.preventDefault();
        redoCanvas();
        return;
      }

      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;

      const key = event.key.toLowerCase();
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
  }, [bringNodeForward, bringNodeToFront, copySelectedNodes, deleteSelectedNodes, pasteCopiedNodes, redoCanvas, removeGroup, selectedGroupId, sendNodeBackward, sendNodeToBack, shortcuts, toggleNodeLock, undoCanvas]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      // Corner-resize drag takes priority — it's armed exclusively.
      const resize = groupResizeRef.current;
      if (resize) {
        setCanvasInteractionActive(true); // idempotent; freezes persist work
        const zoom = viewportRef.current.zoom || 1;
        resizeGroup(resize.groupId, {
          width: resize.startW + (event.clientX - resize.startX) / zoom,
          height: resize.startH + (event.clientY - resize.startY) / zoom,
        }, { captureUndo: !resize.didCaptureUndo });
        resize.didCaptureUndo = true;
        return;
      }

      const drag = groupDragRef.current;
      if (!drag) {
        return;
      }
      setCanvasInteractionActive(true);

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
      const hadGesture = groupDragRef.current != null || groupResizeRef.current != null;
      groupDragRef.current = null;
      groupResizeRef.current = null;
      setGroupDragging(false);
      if (hadGesture) {
        // Gesture over: resume persist work + reconcile the skipped mirrors.
        setCanvasInteractionActive(false);
        commitCanvasMirrors();
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [moveGroup, resizeGroup, commitCanvasMirrors]);

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

    // True when the pointer sits in the group's bottom-right resize corner
    // (a ~26px screen-space square). Uses the same coordinate transform as
    // hitTestGroup so the corner tracks the rendered grip at any zoom.
    const hitsGroupResizeCorner = (group: Group, clientX: number, clientY: number) => {
      const wrapperRect = wrapper.getBoundingClientRect();
      const v = viewportRef.current;
      const zoom = v.zoom || 1;
      const flowX = (clientX - wrapperRect.left - v.x) / zoom;
      const flowY = (clientY - wrapperRect.top - v.y) / zoom;
      const corner = 26 / zoom;
      const gx = group.position?.x ?? 0;
      const gy = group.position?.y ?? 0;
      const gw = group.width ?? 0;
      const gh = group.height ?? 0;
      return flowX >= gx + gw - corner && flowY >= gy + gh - corner;
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
      // Corner hit → arm a RESIZE drag instead of a move. Routed through the
      // same window-capture path as group moves because the ReactFlow pane
      // sits above the shell layer and eats direct pointer events.
      if (hitsGroupResizeCorner(hit, event.clientX, event.clientY)) {
        groupResizeRef.current = {
          groupId: hit.id,
          startX: event.clientX,
          startY: event.clientY,
          startW: hit.width ?? 0,
          startH: hit.height ?? 0,
          didCaptureUndo: false,
        };
        return;
      }
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
      // Ctrl/⌘+wheel over a text surface must NOT zoom the browser page (nor
      // scroll the text). We stopPropagation here in the WINDOW CAPTURE phase,
      // which by definition cancels the bubble phase too — so the bubble-phase
      // page-zoom guard (onWheel above) never runs over text. Block the browser
      // default right here instead, matching the "no effect over UI" behavior.
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      // Plain wheel: stop ReactFlow from zooming; browser still scrolls the text.
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
    // Data-loss guard: never auto-save before the backend canvas has loaded.
    // On refresh the store first rehydrates the heavy-media-stripped
    // localStorage canvas; saving that back would overwrite the full backend
    // snapshot. canvasHydrated flips true only once the real canvas is loaded.
    if (!canvasHydrated) return;
    dirtyRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void saveCanvasToBackend().finally(() => { dirtyRef.current = false; });
    }, 2000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [nodes, edges, activeBackendProjectId, canvasHydrated, saveCanvasToBackend]);

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

    const draggedNode = posChange ? nodes.find((node) => node.id === posChange.id) : undefined;
    if (posChange && draggedNode) {
      // Snap window is defined in SCREEN pixels — at low zoom the old fixed
      // flow-px threshold shrank to ~2 screen px and never engaged.
      const zoom = viewportRef.current?.zoom || 1;
      const threshold = GUIDE_THRESHOLD_SCREEN / zoom;
      // In a multi-select drag the co-dragged nodes move too — aligning
      // against them means chasing a moving target, so exclude them.
      const isMultiDrag = Boolean(draggedNode.selected);
      const others = nodes.filter((node) => node.id !== draggedNode.id && !(isMultiDrag && node.selected));
      const virtual = { ...draggedNode, position: posChange.position };
      const { guides: nextGuides, snapDx, snapDy, hasSnapX, hasSnapY } = computeGuides(virtual, others, threshold);

      if (posChange.dragging) {
        // Skip the setState when nothing changed (empty→empty is the common
        // case) — a fresh [] every frame forced a second full re-render.
        setGuides((prev) => (prev.length === 0 && nextGuides.length === 0 ? prev : nextGuides));
      } else {
        setGuides([]);
      }

      // While dragging: neighbor alignment wins, otherwise move freely (the
      // old per-frame grid rounding made motion chunky). On RELEASE: keep the
      // alignment if one is engaged — the old code grid-rounded the final
      // position, destroying the alignment the guides had just shown — and
      // grid-snap only the unaligned axes.
      const snapped = {
        x: hasSnapX ? posChange.position.x + snapDx : (posChange.dragging ? posChange.position.x : snapPosition(posChange.position).x),
        y: hasSnapY ? posChange.position.y + snapDy : (posChange.dragging ? posChange.position.y : snapPosition(posChange.position).y),
      };
      const deltaX = snapped.x - posChange.position.x;
      const deltaY = snapped.y - posChange.position.y;

      onNodesChange(
        changes.map((change) => {
          if (change === posChange) return { ...posChange, position: snapped };
          // Co-dragged nodes receive the SAME delta so the formation holds
          // instead of only the primary node jumping onto the guide.
          if (change.type === 'position' && 'position' in change && change.position) {
            return { ...change, position: { x: change.position.x + deltaX, y: change.position.y + deltaY } };
          }
          return change;
        }),
      );
      return;
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

      const id = `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const position = snapToGrid
        ? snapPosition({ x: flowPos.x, y: flowPos.y + offsetY })
        : { x: flowPos.x, y: flowPos.y + offsetY };
      offsetY += 320;

      // 1. Create the node up-front with a local preview so it appears
      //    instantly, with an "上传中 (X%)" overlay while the upload runs.
      const previewUrl = URL.createObjectURL(file);
      addNode({
        id,
        type: nodeType,
        position,
        data: { url: previewUrl, status: 'uploading', progress: 0, sourceName: file.name, sourceKind: 'upload' },
      });

      // 2. Upload with progress + retry. Uploads run concurrently so every
      //    dropped file gets its node immediately; on success we swap in the
      //    durable URL. The COS pipeline can intermittently EOF, so we retry a
      //    few times before giving up. CRUCIAL: on final failure we KEEP the
      //    local blob preview (never blank the url or revoke the blob) so the
      //    image doesn't vanish — the user still sees it + an error and can
      //    re-upload, instead of the picture flashing then disappearing.
      void (async () => {
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          try {
            const data = await uploadFileWithProgress(file, file.name, (percent) => {
              updateNodeData(id, { progress: percent });
            });
            const url = resolveBackendAssetUrl(data.url, import.meta.env.VITE_API_BASE_URL ?? '');
            if (!url) throw new Error(`Upload response missing file url: ${file.name}`);
            updateNodeData(id, { url, status: 'done', progress: 100, error: undefined });
            const referenceValue = await readFileAsDataUrl(file);
            if (referenceValue) setReferencePayloadValue(id, referenceValue);
            URL.revokeObjectURL(previewUrl); // durable URL is live; drop the preview blob
            return;
          } catch (error) {
            if (attempt < MAX_ATTEMPTS) {
              // Transient (intermittent upstream EOF / network) — keep the
              // preview, back off, and retry.
              updateNodeData(id, { status: 'uploading', progress: 0, error: undefined });
              await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
              continue;
            }
            // Final failure: keep the blob preview visible (do NOT revoke it or
            // blank the url) so the image stays; surface the error so the user
            // can re-upload.
            updateNodeData(id, {
              status: 'error',
              error: error instanceof Error ? error.message : `Upload failed: ${file.name}`,
            });
          }
        }
      })();
    }
  }, [addNode, updateNodeData, snapToGrid]);

  /** Flow-coord drop point for the next file-dialog upload. Captured when the
   *  dialog opens — by the time the user picks a file, contextMenu is already
   *  cleared, so we can't read it in handleFileInputChange. */
  const pendingUploadFlowPosRef = useRef<{ x: number; y: number } | null>(null);

  /** Center of the visible canvas in flow coords, so an uploaded node always
   *  lands in view regardless of pan/zoom (previously a hardcoded 240,180 put
   *  it off-screen — the node "disappeared" until you tidied the canvas). */
  const viewportCenterFlowPos = useCallback(() => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    return screenToFlowPosition({ x: cx, y: cy });
  }, [screenToFlowPosition]);

  const openUploadDialog = useCallback((flowPos?: { x: number; y: number }) => {
    pendingUploadFlowPosRef.current = flowPos ?? viewportCenterFlowPos();
    fileInputRef.current?.click();
  }, [viewportCenterFlowPos]);

  const handleMenuUpload = useCallback(() => {
    // Capture the right-click point BEFORE clearing the menu.
    openUploadDialog(contextMenu ? { x: contextMenu.flowX, y: contextMenu.flowY } : undefined);
    setContextMenu(null);
  }, [openUploadDialog, contextMenu]);

  const handleFileInputChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    const targetPosition = pendingUploadFlowPosRef.current ?? viewportCenterFlowPos();
    pendingUploadFlowPosRef.current = null;
    await uploadFilesAtPosition(files, targetPosition);
    event.target.value = '';
  }, [uploadFilesAtPosition, viewportCenterFlowPos]);

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
        data: { url, status: 'done', sourceName: item.title, sourceKind: 'upload' },
      });
    });
  }, [addNode, contextMenu, snapToGrid]);

  /** Force every edge through the unified FlowEdge renderer AND pin a FINISHED
   *  wire's endpoints to the flush edge anchors (`edge-source-right` /
   *  `edge-target-left`) that sit exactly ON the node's right/left edge — so a
   *  connected wire joins the node border, not the floating `+` bubble (~20px
   *  outside) it was dragged from, and not the full-area drop handle (whose
   *  center is the NODE center, which made wires attach mid-image). BaseNode
   *  media/text nodes expose these anchors; agent/sticky/director/composition
   *  nodes use their own default Left/Right handles, so those edges are left
   *  untouched. Dragging still starts from the `+` bubble (its own handle); the
   *  full-area target still catches drops anywhere on the card — we only reroute
   *  how the committed wire is DRAWN. */
  // id→type projection with a STABLE identity: node types almost never change,
  // but the `nodes` array is re-minted every drag frame. Keying the memo on a
  // cheap string signature keeps normalizedEdges from re-minting every edge
  // object (and re-rendering every FlowEdge) once per pointermove.
  const nodeTypeSignature = useMemo(
    () => nodes.map((node) => `${node.id}:${node.type ?? ''}`).join('|'),
    [nodes],
  );
  const nodeTypeById = useMemo(() => {
    // NB: `Map` here would resolve to the lucide-react icon (imported above), so
    // use a plain lookup object for id → node type.
    const typeById: Record<string, string> = {};
    nodes.forEach((node) => { typeById[node.id] = node.type ?? ''; });
    return typeById;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeTypeSignature]);
  const normalizedEdges = useMemo(() => {
    const typeById = nodeTypeById;
    return edges.map((edge) => {
      const sourceHasPorts = !NON_PORT_NODE_TYPES.has(typeById[edge.source] ?? '');
      const targetHasPorts = !NON_PORT_NODE_TYPES.has(typeById[edge.target] ?? '');
      return {
        ...edge,
        type: 'flow',
        animated: false,
        style: undefined,
        sourceHandle: sourceHasPorts ? 'edge-source-right' : (edge.sourceHandle ?? null),
        targetHandle: targetHasPorts ? 'edge-target-left' : (edge.targetHandle ?? null),
      };
    });
  }, [edges, nodeTypeById]);

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
        backgroundColor: '#1d1f24',
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

  // Breakdown of canvas nodes by media kind for the bottom-right stats pill.
  const nodeTypeStats = useMemo(() => {
    let img = 0, vid = 0, aud = 0, txt = 0, other = 0;
    for (const n of nodes) {
      const t = String(n.type ?? '');
      if (/image/i.test(t)) img += 1;
      else if (/video/i.test(t)) vid += 1;
      else if (/audio/i.test(t)) aud += 1;
      else if (/text/i.test(t)) txt += 1;
      else if (t !== 'groupNode') other += 1;
    }
    return { img, vid, aud, txt, other };
  }, [nodes]);

  /** Zoom ruler mapping — log scale between the canvas minZoom/maxZoom so the
   *  10%→100% range doesn't get crushed into a corner of the track. */
  const ZOOM_RULER = { min: 0.1, max: 4 } as const;
  const zoomToRulerT = useCallback(
    (z: number) => (Math.log(Math.min(ZOOM_RULER.max, Math.max(ZOOM_RULER.min, z))) - Math.log(ZOOM_RULER.min)) / (Math.log(ZOOM_RULER.max) - Math.log(ZOOM_RULER.min)),
    [ZOOM_RULER.max, ZOOM_RULER.min],
  );
  const zoomRulerTrackRef = useRef<HTMLDivElement>(null);
  const zoomRulerSeek = useCallback((clientX: number) => {
    const rect = zoomRulerTrackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const z = Math.exp(Math.log(ZOOM_RULER.min) + t * (Math.log(ZOOM_RULER.max) - Math.log(ZOOM_RULER.min)));
    zoomTo(z);
  }, [ZOOM_RULER.max, ZOOM_RULER.min, zoomTo]);

  return (
    <div
      ref={wrapperRef}
      className={`relative h-screen w-full bg-[#1d1f24] ${cursorMode}`}
      onContextMenu={(event) => event.preventDefault()}
      onDoubleClick={onCanvasDoubleClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,video/*,audio/*"
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
                // Dashed shell à la the reference: the group reads as a spatial
                // frame, not a solid card.
                'pointer-events-auto absolute border border-dashed bg-white/[0.025] backdrop-blur-[2px] transition-colors',
                selected ? 'border-cyan-400/40 bg-cyan-400/[0.04]' : 'border-white/15',
              )}
              style={{
                left,
                top,
                width,
                height,
                // Modest FIXED-range corner radius (not zoom-scaled): a big
                // radius pushed the dashed edge far from the rectangular
                // corner, so the resize grip looked detached and "wandered"
                // as zoom changed. Small radius keeps the dashed line hugging
                // the corner the grip is pinned to, and the size caps still
                // prevent a tiny group from turning into a pill.
                borderRadius: Math.max(6, Math.min(16, width / 6, height / 6)),
                // User-picked shell tint (inline bg wins over the tint classes).
                ...(group.color ? { backgroundColor: group.color } : null),
              }}
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
              {/* Bottom-right corner grip — drag to resize the group frame.
                  Hover swaps the corner lines for a diagonal-arrows icon so
                  the affordance reads as "drag me to resize". Pointer capture
                  keeps the drag alive outside the grip; the screen-space delta
                  is divided by zoom to stay in flow units. */}
              <div
                className={clsx(
                  'group/grip absolute bottom-1 right-1 flex h-6 w-6 cursor-nwse-resize items-center justify-center rounded-md transition-colors',
                  selected ? 'text-cyan-300/80' : 'text-neutral-500',
                )}
                title={language === 'zh' ? '拖动调整分组大小' : 'Drag to resize group'}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* no-op */ }
                  setSelectedGroupId(group.id);
                  groupResizeRef.current = {
                    groupId: group.id,
                    startX: event.clientX,
                    startY: event.clientY,
                    startW: b.width,
                    startH: b.height,
                    didCaptureUndo: false,
                  };
                }}
                onPointerMove={(event) => {
                  const r = groupResizeRef.current;
                  if (!r || r.groupId !== group.id) return;
                  const z = viewport.zoom || 1;
                  resizeGroup(group.id, {
                    width: r.startW + (event.clientX - r.startX) / z,
                    height: r.startH + (event.clientY - r.startY) / z,
                  }, { captureUndo: !r.didCaptureUndo });
                  r.didCaptureUndo = true;
                }}
                onPointerUp={(event) => {
                  groupResizeRef.current = null;
                  try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* no-op */ }
                  setCanvasInteractionActive(false);
                  commitCanvasMirrors();
                }}
                onPointerCancel={(event) => {
                  groupResizeRef.current = null;
                  try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* no-op */ }
                  setCanvasInteractionActive(false);
                  commitCanvasMirrors();
                }}
              >
                {/* Default: subtle corner lines. Hover: diagonal resize arrows. */}
                <svg viewBox="0 0 10 10" className="h-3 w-3 transition-opacity group-hover/grip:opacity-0" aria-hidden>
                  <path d="M2.5 9L9 2.5M5.5 9L9 5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
                </svg>
                <MoveDiagonal2 className="absolute h-3.5 w-3.5 text-cyan-300 opacity-0 transition-opacity group-hover/grip:opacity-100" />
              </div>
            </div>
          );
        })}
      </div>

      <ReactFlow
        proOptions={{ hideAttribution: true }}
        onError={(code, message) => {
          // Guardrail: React Flow error '008' = an edge's source/target handle id
          // did not resolve to a measured handle, so the edge is silently NOT
          // drawn (getEdgePosition returns null). normalizedEdges pins port nodes
          // to edge-source-right/edge-target-left and passes non-port handles
          // through — a stale/renamed handle id would otherwise vanish an edge
          // with no trace. Surface it instead of hiding it.
          if (code === '008') console.warn(`[ReactFlow] edge not drawn — handle not found (008): ${message}`);
        }}
        nodes={nodes}
        edges={normalizedEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={(event) => {
          spawnRipple(event.clientX, event.clientY);
          setSelectedGroupId(null);
          if (useStore.getState().agentNodePickActive) useStore.getState().cancelAgentNodePick();
        }}
        onNodeClick={(_event, node) => {
          // Agent "pick from canvas" mode: capture this node as a reference.
          if (useStore.getState().agentNodePickActive) {
            useStore.getState().resolveAgentNodePick(node.id);
          }
        }}
        onNodeDragStart={() => {
          // Snapshot the pre-drag state ONCE so the whole drag is a single
          // undo step (position changes during the drag are not auto-captured).
          pushUndoSnapshot();
          setNodeDragging(true);
          // Drag-smoothness P0: freeze the persist partialize while the
          // gesture runs (debounced storage discards intermediates anyway).
          setCanvasInteractionActive(true);
        }}
        onNodeDragStop={(_event, _node, draggedNodes) => {
          setNodeDragging(false);
          setGuides([]);
          setCanvasInteractionActive(false);
          // Reconcile the project/space mirrors once — per-frame position
          // changes skipped them (see store.onNodesChange).
          commitCanvasMirrors();
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
        deleteKeyCode={null}
        snapToGrid={snapToGrid}
        snapGrid={[GRID_SIZE, GRID_SIZE]}
        /* 关闭 xyflow 内置的 pane 双击缩放,让外层 wrapper 的
           onCanvasDoubleClick 能收到事件唤出"添加节点"菜单. */
        zoomOnDoubleClick={false}
        /* 滚轮 = 上下/左右平移画布（设计工具惯例），而非缩放。
           缩放走 Ctrl/⌘+滚轮、触控板双指捏合，或工具栏/快捷键。 */
        zoomOnScroll={false}
        panOnScroll={true}
        panOnScrollMode={"free" as never}
        zoomOnPinch={true}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={2} color="#3a3d44" />
        {showMiniMap ? (
          <MiniMap
            position="bottom-left"
            pannable
            zoomable
            onClick={(_event, position) => setCenter(position.x, position.y, { zoom: viewport.zoom, duration: 400 })}
            onMouseEnter={enterMinimap}
            onMouseLeave={leaveMinimap}
            maskColor="rgba(0,0,0,0.6)"
            maskStrokeColor="rgba(255,255,255,0.35)"
            maskStrokeWidth={3}
            nodeColor="#3f4149"
            nodeStrokeColor="rgba(255,255,255,0.14)"
            nodeBorderRadius={3}
            style={{
              // Compact by default (reference proportions); expandable on demand.
              width: minimapExpanded ? 300 : 148,
              height: minimapExpanded ? 190 : 94,
              left: 16,
              right: 'auto',
              bottom: 64,
              backgroundColor: 'rgba(12,14,17,0.9)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 14,
              transition: 'width 0.2s, height 0.2s',
            }}
          />
        ) : null}
        {snapToGrid ? <AlignmentGuides guides={guides} /> : null}
      </ReactFlow>

      {/* Enlarge/collapse the minimap. Overlaid at the minimap's top-right
          corner (subtle by default, brightens on hover) — toggles its size. */}
      {showMiniMap ? (
        <button
          type="button"
          className={`nodrag absolute z-30 flex h-6 w-6 items-center justify-center rounded-md bg-black/60 text-white/75 backdrop-blur-sm transition-opacity duration-150 hover:bg-black/80 hover:text-white ${minimapHovered ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          style={{ left: 16 + (minimapExpanded ? 300 : 148) - 30, bottom: 64 + (minimapExpanded ? 190 : 94) - 30 }}
          title={minimapExpanded ? '收起小地图' : '放大小地图'}
          onMouseEnter={enterMinimap}
          onMouseLeave={leaveMinimap}
          onClick={() => setMinimapExpanded((v) => !v)}
        >
          {minimapExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
      ) : null}

      {/* Click ripples — a short expanding ring at each pane click. */}
      {ripples.length > 0 ? (
        <div className="pointer-events-none absolute inset-0 z-40 overflow-hidden">
          {ripples.map((r) => (
            <span key={r.id} className="canvas-ripple" style={{ left: r.x, top: r.y }} />
          ))}
        </div>
      ) : null}

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
            {/* Reference trio first: 颜色 | 整理布局 | 解组 */}
            <GroupColorMenu
              zh={language === 'zh'}
              current={sel.color}
              onPick={(color) => setGroupColor(sel.id, color)}
            />
            <div className="h-4 w-px bg-white/10" />
            <ArrangeMenu
              zh={language === 'zh'}
              label={language === 'zh' ? '整理布局' : 'Tidy layout'}
              onArrange={(mode) => arrangeGroupNodes(sel.id, mode)}
            />
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

            {/* Arrange the selection: grid / horizontal / vertical, always
                spaced out so nodes never overlap. */}
            <div className="h-4 w-px bg-white/10" />
            <ArrangeMenu
              onArrange={(mode) => arrangeSelectedNodes(mode)}
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
                {FUTURE_NODE_OPTIONS.map((option) => {
                  const isDirectorStage = option.key === 'director-desk';
                  return (
                    <ContextMenuButton
                      key={option.key}
                      icon={option.icon}
                      labelZh={option.zh}
                      labelEn={option.en}
                      subtitleZh={option.subtitleZh}
                      subtitleEn={option.subtitleEn}
                      badge={option.badge}
                      disabled={!isDirectorStage}
                      onClick={isDirectorStage ? () => onPickerSelect('directorStageNode') : undefined}
                    />
                  );
                })}
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

      {/* Bottom-left control strip — compact reference proportions: flat icon
          toggles + a zoom readout in one hairline pill. The snap toggle moved
          into the bottom dock (reference keeps the pin there). */}
      <div className="absolute bottom-6 left-6 z-40 flex items-center gap-1 rounded-full border border-white/10 bg-black/45 px-1.5 py-1 shadow-2xl backdrop-blur-xl">
        <ControlButton
          active={showMiniMap}
          label={language === 'zh' ? '开关小地图' : 'Toggle minimap'}
          onClick={() => setShowMiniMap(!showMiniMap)}
        >
          <Map className="h-3.5 w-3.5" />
        </ControlButton>
        <ControlButton
          active={false}
          label={language === 'zh' ? '整理画布' : 'Tidy canvas'}
          onClick={() => {
            tidyCanvas();
            // Fit after the layout commits so the freshly-arranged graph
            // is framed nicely.
            setTimeout(() => void fitView({ padding: 0.15, duration: 400 }), 60);
          }}
        >
          <LayoutGrid className="h-3.5 w-3.5" />
        </ControlButton>
        <span className="flex items-center gap-1 px-1.5 text-[11px] tabular-nums text-neutral-400">
          <SearchIcon className="h-3 w-3" />
          {Math.round(viewport.zoom * 100)}%
        </span>
      </div>

      {/* 使用指南 — standalone "?" beside the bottom-left strip (reference
          placement); opens the canvas guide modal. */}
      <button
        type="button"
        onClick={() => setGuideOpen(true)}
        title={language === 'zh' ? '使用指南' : 'Canvas guide'}
        className="absolute bottom-6 left-[150px] z-40 flex h-[34px] w-[34px] items-center justify-center rounded-full border border-white/10 bg-black/45 text-neutral-400 shadow-2xl backdrop-blur-xl transition hover:bg-black/70 hover:text-neutral-100"
      >
        <HelpCircle className="h-4 w-4" />
      </button>
      {guideOpen ? <CanvasGuideModal onClose={() => setGuideOpen(false)} /> : null}

      {/* Zoom % indicator — read-only pill at the top center of the
          canvas. Matches NeoWOW's `极简 · NNN%` chip; the "极简" render
          mode is deferred until a real implementation lands, so for now
          we surface zoom alone. */}
      <div className="pointer-events-none absolute left-1/2 top-4 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/8 bg-black/40 px-3 py-1 text-[11px] text-neutral-400 shadow-lg backdrop-blur-xl tabular-nums">
        {Math.round(viewport.zoom * 100)}%
      </div>

      {/* Zoom ruler (reference: the tick ruler under the % chip). Log-scale
          track from 10% to 400%; the white cursor is the current zoom, the
          amber tick marks 100%. Click / drag to zoom around the viewport
          center; double-click snaps back to 100%. */}
      <div
        className="absolute left-1/2 top-12 z-30 flex h-7 -translate-x-1/2 cursor-ew-resize touch-none select-none items-center rounded-full border border-white/8 bg-black/40 px-3 shadow-lg backdrop-blur-xl"
        title={language === 'zh' ? '缩放标尺 — 拖动调整，双击回到 100%' : 'Zoom ruler — drag to zoom, double-click for 100%'}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          zoomRulerSeek(event.clientX);
        }}
        onPointerMove={(event) => {
          if ((event.buttons & 1) === 1) zoomRulerSeek(event.clientX);
        }}
        onDoubleClick={() => zoomTo(1, { duration: 200 })}
      >
        <div ref={zoomRulerTrackRef} className="relative h-full w-[220px]">
          {Array.from({ length: 41 }, (_, i) => (
            <span
              key={i}
              className={clsx('absolute top-1/2 w-px -translate-y-1/2 bg-white/25', i % 8 === 0 ? 'h-[11px] bg-white/40' : 'h-[6px]')}
              style={{ left: `${(i / 40) * 100}%` }}
            />
          ))}
          {/* 100% anchor */}
          <span
            className="absolute top-1/2 h-[11px] w-px -translate-y-1/2 bg-amber-400/80"
            style={{ left: `${zoomToRulerT(1) * 100}%` }}
          />
          {/* current zoom cursor */}
          <span
            className="absolute top-1/2 h-[15px] w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.6)]"
            style={{ left: `${zoomToRulerT(viewport.zoom) * 100}%` }}
          />
        </div>
      </div>

      {/* Canvas stats — node / edge / group counts. Reference placement: a
          bare hairline strip tucked into the bottom-right corner, directly
          BELOW the Agent FAB (no pill chrome). 节点 / 分组 open the jump-to
          index panel. */}
      <div className="absolute bottom-3 right-5 z-30 flex items-center gap-2.5 text-[11px] text-neutral-500">
        {/* Compact icon+count trio (reference proportions): → edges, ⊞ nodes,
            ⊟ groups. Labels live in tooltips; per-type breakdown moved to the
            nodes tooltip. Nodes/groups open the jump-to index panel. */}
        <span
          className="flex items-center gap-1 tabular-nums text-neutral-500"
          title={language === 'zh' ? `连线 ${edges.length}` : `${edges.length} edges`}
        >
          <MoveRight className="h-3 w-3" />
          {edges.length}
        </span>
        <button
          type="button"
          onClick={() => setIndexPanel((v) => (v === 'nodes' ? null : 'nodes'))}
          className={clsx(
            'flex items-center gap-1 tabular-nums font-medium transition hover:text-white',
            indexPanel === 'nodes' ? 'text-cyan-300' : 'text-neutral-200',
          )}
          title={(language === 'zh'
            ? [`节点 ${nodes.length}`, nodeTypeStats.img ? `图 ${nodeTypeStats.img}` : '', nodeTypeStats.vid ? `视 ${nodeTypeStats.vid}` : '', nodeTypeStats.aud ? `音 ${nodeTypeStats.aud}` : '', nodeTypeStats.txt ? `文 ${nodeTypeStats.txt}` : '']
            : [`${nodes.length} nodes`, nodeTypeStats.img ? `img ${nodeTypeStats.img}` : '', nodeTypeStats.vid ? `vid ${nodeTypeStats.vid}` : '', nodeTypeStats.aud ? `aud ${nodeTypeStats.aud}` : '', nodeTypeStats.txt ? `txt ${nodeTypeStats.txt}` : '']
          ).filter(Boolean).join(' · ')}
        >
          <LayoutGrid className="h-3 w-3" />
          {nodes.length}
        </button>
        <button
          type="button"
          onClick={() => setIndexPanel((v) => (v === 'groups' ? null : 'groups'))}
          className={clsx(
            'flex items-center gap-1 tabular-nums transition hover:text-white',
            indexPanel === 'groups' ? 'text-cyan-300' : undefined,
          )}
          title={language === 'zh' ? `分组 ${groups.length}` : `${groups.length} groups`}
        >
          <Boxes className="h-3 w-3" />
          {groups.length}
        </button>
      </div>

      <CanvasIndexPanel
        open={indexPanel}
        onClose={() => setIndexPanel(null)}
        nodes={nodes}
        groups={groups}
        language={language}
        onJumpToNode={(nodeId) => {
          const node = nodes.find((n) => n.id === nodeId);
          if (!node) return;
          // Keep the user's zoom unless they're zoomed way out (a jump at 10%
          // zoom lands "nowhere" visually) — clamp up to a readable level.
          setCenter(node.position.x + 170, node.position.y + 130, {
            zoom: Math.max(viewport.zoom, 0.6),
            duration: 400,
          });
          onNodesChange([
            ...nodes.filter((n) => n.selected && n.id !== nodeId).map((n) => ({ id: n.id, type: 'select' as const, selected: false })),
            { id: nodeId, type: 'select' as const, selected: true },
          ]);
        }}
        onJumpToGroup={(groupId) => {
          const group = groups.find((g) => g.id === groupId);
          if (!group) return;
          const cx = (group.position?.x ?? 0) + (group.width ?? 0) / 2;
          const cy = (group.position?.y ?? 0) + (group.height ?? 0) / 2;
          setCenter(cx, cy, { zoom: Math.max(viewport.zoom, 0.5), duration: 400 });
          setSelectedGroupId(groupId);
        }}
      />

      <SaveAssetDialog />

      {/* 3D 导演台 overlay — 仅在用户打开时挂载,关闭后整个 WebGL 上下文释放. */}
      {directorStageNodeId ? (
        <Suspense fallback={null}>
          <DirectorStageOverlay />
        </Suspense>
      ) : null}

      {/* Agent run panel + toggle FAB — bottom-right, stacked ABOVE the
          stats strip (reference layout). */}
      <button
        onClick={() => setAgentPanelOpen(true)}
        className="absolute bottom-10 right-5 z-30 flex h-12 w-12 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-500/15 text-cyan-200 shadow-2xl backdrop-blur-xl transition hover:bg-cyan-500/25"
        title={language === 'zh' ? '智能体' : 'Agent'}
        style={{ display: agentPanelOpen ? 'none' : undefined }}
      >
        <BotIcon className="h-5 w-5" />
      </button>
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
      className="pointer-events-auto absolute left-0 top-0 z-20 -translate-y-[110%] flex cursor-grab select-none items-center gap-1 whitespace-nowrap rounded font-medium text-white/60 transition hover:bg-white/5 hover:text-white/90 active:cursor-grabbing"
      style={{ fontSize: `${Math.max(9, 12 * zoom)}px`, padding: `${2 * zoom}px ${4 * zoom}px` }}
      title={language === 'zh' ? '拖动移动整组 · 双击重命名' : 'Drag to move group · double-click to rename'}
    >
      <span aria-hidden className="opacity-30">⋮⋮</span>
      <span>{name}</span>
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
        // Compact reference proportions: small flat icon buttons inside a
        // single hairline pill (no per-button borders).
        'flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition',
        active
          ? 'bg-white/12 text-white'
          : 'hover:bg-white/8 hover:text-neutral-200',
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

/** Arrange dropdown shown inside the multi-select toolbar. Three layouts —
 *  grid / horizontal / vertical — each spaces nodes out so they never overlap. */
function ArrangeMenu({
  onArrange,
  zh,
  label,
}: {
  onArrange: (mode: 'grid' | 'horizontal' | 'vertical') => void;
  zh: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const items: { mode: 'grid' | 'horizontal' | 'vertical'; Icon: typeof LayoutGrid; label: string }[] = [
    { mode: 'grid', Icon: LayoutGrid, label: zh ? '宫格排列' : 'Grid' },
    { mode: 'horizontal', Icon: AlignHorizontalDistributeCenter, label: zh ? '水平排列' : 'Horizontal' },
    { mode: 'vertical', Icon: AlignVerticalDistributeCenter, label: zh ? '垂直排列' : 'Vertical' },
  ];
  const triggerLabel = label ?? (zh ? '排列' : 'Arrange');
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/5"
        title={triggerLabel}
      >
        <LayoutGrid className="h-3.5 w-3.5 text-neutral-400" />
        {triggerLabel}
        <ChevronDown className="h-3 w-3 text-neutral-500" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-1/2 z-50 mb-2 min-w-[148px] -translate-x-1/2 overflow-hidden rounded-xl border border-white/10 bg-[#1e2026]/95 p-1 shadow-2xl backdrop-blur-xl">
            {items.map(({ mode, Icon, label }) => (
              <button
                key={mode}
                onClick={() => { onArrange(mode); setOpen(false); }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-neutral-200 transition hover:bg-white/8 hover:text-cyan-100"
              >
                <Icon className="h-4 w-4 text-neutral-400" />
                {label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** Group shell tint presets — subtle rgba washes so member nodes stay legible.
 *  The swatch preview uses a stronger alpha of the same hue for visibility. */
const GROUP_COLOR_PRESETS: { tint?: string; swatch: string; zh: string; en: string }[] = [
  { tint: undefined, swatch: 'transparent', zh: '默认', en: 'Default' },
  { tint: 'rgba(148,163,184,0.08)', swatch: 'rgba(148,163,184,0.8)', zh: '灰', en: 'Slate' },
  { tint: 'rgba(59,130,246,0.08)', swatch: 'rgba(59,130,246,0.8)', zh: '蓝', en: 'Blue' },
  { tint: 'rgba(6,182,212,0.08)', swatch: 'rgba(6,182,212,0.8)', zh: '青', en: 'Cyan' },
  { tint: 'rgba(34,197,94,0.08)', swatch: 'rgba(34,197,94,0.8)', zh: '绿', en: 'Green' },
  { tint: 'rgba(245,158,11,0.09)', swatch: 'rgba(245,158,11,0.85)', zh: '琥珀', en: 'Amber' },
  { tint: 'rgba(236,72,153,0.08)', swatch: 'rgba(236,72,153,0.8)', zh: '粉', en: 'Pink' },
  { tint: 'rgba(139,92,246,0.09)', swatch: 'rgba(139,92,246,0.8)', zh: '紫', en: 'Violet' },
];

function GroupColorMenu({
  zh,
  current,
  onPick,
}: {
  zh: boolean;
  current?: string;
  onPick: (color?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-neutral-200 transition hover:bg-white/5"
        title={zh ? '背景颜色' : 'Shell color'}
      >
        <Palette className="h-3.5 w-3.5 text-neutral-400" />
        {zh ? '颜色' : 'Color'}
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-1/2 z-50 mb-2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-white/10 bg-[#1e2026]/95 px-2 py-1.5 shadow-2xl backdrop-blur-xl">
            {GROUP_COLOR_PRESETS.map((preset) => (
              <button
                key={preset.swatch}
                type="button"
                title={zh ? preset.zh : preset.en}
                onClick={() => { onPick(preset.tint); setOpen(false); }}
                className={clsx(
                  'flex h-5 w-5 items-center justify-center rounded-full border transition hover:scale-110',
                  current === preset.tint ? 'border-white' : 'border-white/20',
                )}
                style={{ backgroundColor: preset.swatch }}
              >
                {preset.tint === undefined ? <span className="text-[10px] leading-none text-white/50">/</span> : null}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export const Canvas = () => (
  <ReactFlowProvider>
    <InnerCanvas />
  </ReactFlowProvider>
);
