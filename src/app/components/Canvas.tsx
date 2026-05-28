import { useCallback, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  BackgroundVariant,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
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

const snapPosition = (position: { x: number; y: number }) => ({
  x: Math.round(position.x / GRID_SIZE) * GRID_SIZE,
  y: Math.round(position.y / GRID_SIZE) * GRID_SIZE,
});

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
  const language = useStore((state) => state.language);
  const dict = t[language];
  const { screenToFlowPosition, fitView } = useReactFlow();
  const selectedIds = nodes.filter((node) => node.selected).map((node) => node.id);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const connectingFrom = useRef<{ nodeId: string; handleId?: string | null } | null>(null);

  const [picker, setPicker] = useState<{ x: number; y: number; flowX: number; flowY: number; fromConnection: boolean } | null>(null);

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (!snapToGrid) {
        onNodesChange(changes);
        return;
      }

      onNodesChange(
        changes.map((change) => {
          if (change.type !== 'position' || !change.position) {
            return change;
          }

          return {
            ...change,
            position: snapPosition(change.position),
          };
        }),
      );
    },
    [onNodesChange, snapToGrid],
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

  return (
    <div
      ref={wrapperRef}
      className="relative h-screen w-full bg-[#0a0a0a]"
      onContextMenu={(event) => event.preventDefault()}
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
