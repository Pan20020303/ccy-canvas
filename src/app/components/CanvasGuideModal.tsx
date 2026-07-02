import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUpRight,
  Boxes,
  Brush,
  Copy,
  Hand,
  Image as ImageIcon,
  Layers,
  LocateFixed,
  Map as MapIcon,
  MousePointer2,
  Move,
  Pencil,
  Pin,
  Plus,
  Ruler,
  Save,
  Search,
  Sparkles,
  Spline,
  Trash2,
  Upload,
  Wand2,
  X,
  ZoomIn,
} from 'lucide-react';

import { useStore } from '../store';

/**
 * 画布使用指南 — the in-canvas help modal (opened from the bottom-left "?").
 * Every shortcut and gesture listed here is REAL: it mirrors the handlers in
 * Canvas.tsx / CustomNodes.tsx. Do not add aspirational entries — dead config
 * like Ctrl+D duplicate or WASD pan is deliberately absent.
 */

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-white/15 bg-white/[0.06] px-1.5 text-[11px] font-medium text-neutral-200">
      {children}
    </span>
  );
}

function Keys({ combo }: { combo: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {combo.map((key, index) => (
        <Kbd key={index}>{key}</Kbd>
      ))}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 mt-7 text-[13px] font-semibold text-neutral-100 first:mt-0">{children}</div>;
}

export function CanvasGuideModal({ onClose }: { onClose: () => void }) {
  const language = useStore((state) => state.language);
  const zh = language === 'zh';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 快捷键：label + key chips (+ 可选的 " / " 分隔第二组)
  const shortcuts: Array<{ label: string; combos: string[][] }> = zh
    ? [
      { label: '复制', combos: [[MOD, 'C']] },
      { label: '粘贴', combos: [[MOD, 'V']] },
      { label: '撤销', combos: [[MOD, 'Z']] },
      { label: '重做', combos: [['⇧', MOD, 'Z'], [MOD, 'Y']] },
      { label: '删除选中', combos: [['⌫'], ['Del']] },
      { label: '锁定 / 解锁', combos: [[MOD, 'L']] },
      { label: '图层上移（⇧ 置顶）', combos: [[MOD, ']']] },
      { label: '图层下移（⇧ 置底）', combos: [[MOD, '[']] },
      { label: '多选节点', combos: [['⇧', '点击'], [MOD, '点击']] },
      { label: '打开菜单', combos: [['右键'], ['双击']] },
      { label: '平移画布', combos: [['Space', '拖拽'], ['中键 / 右键拖']] },
      { label: '缩放画布', combos: [[MOD, '滚轮'], ['捏合']] },
    ]
    : [
      { label: 'Copy', combos: [[MOD, 'C']] },
      { label: 'Paste', combos: [[MOD, 'V']] },
      { label: 'Undo', combos: [[MOD, 'Z']] },
      { label: 'Redo', combos: [['⇧', MOD, 'Z'], [MOD, 'Y']] },
      { label: 'Delete selection', combos: [['⌫'], ['Del']] },
      { label: 'Lock / unlock', combos: [[MOD, 'L']] },
      { label: 'Layer up (⇧ = top)', combos: [[MOD, ']']] },
      { label: 'Layer down (⇧ = bottom)', combos: [[MOD, '[']] },
      { label: 'Multi-select', combos: [['⇧', 'Click'], [MOD, 'Click']] },
      { label: 'Open menu', combos: [['R-click'], ['Dbl-click']] },
      { label: 'Pan canvas', combos: [['Space', 'Drag'], ['Mid / R-drag']] },
      { label: 'Zoom canvas', combos: [[MOD, 'Wheel'], ['Pinch']] },
    ];

  const basics: Array<{ icon: typeof Plus; title: string; desc: string }> = zh
    ? [
      { icon: Plus, title: '添加节点', desc: '右键或双击画布空白处，选择节点类型；底部 dock 的 + 也可以' },
      { icon: Spline, title: '连接节点', desc: '悬停节点时两侧浮出 +，按住拖到另一个节点的卡片上即可连线' },
      { icon: Wand2, title: '连线生成节点', desc: '从 + 拖到空白处松手，弹出菜单直接创建新节点并自动接线' },
      { icon: ArrowUpRight, title: '批量连线', desc: '多选 ≥2 个节点后，选区右缘出现 +，一次性向目标节点连线' },
      { icon: MousePointer2, title: '选中与移动', desc: '单击选中并显示工具栏；左键空白拖拽是框选，拖节点可吸附对齐' },
      { icon: Pencil, title: '重命名节点', desc: '双击节点上方的标题，输入新名称，Enter 确认' },
      { icon: Trash2, title: '删除节点', desc: '选中后按 ⌫ / Delete；连线会随两端节点一起删除' },
      { icon: Upload, title: '添加媒体', desc: '外部文件直接拖入画布，或右键菜单上传；支持图片 / 视频 / 音频' },
      { icon: Save, title: '保存素材', desc: '右键节点 → 保存到我的素材，可在资产库里分类复用' },
      { icon: Boxes, title: '分组', desc: '多选后点选区上方的「分组」；标题栏拖动整组，右下角握把调大小' },
      { icon: Layers, title: '图层顺序', desc: `${MOD} + ] / [ 调整选中节点的层叠顺序，加 ⇧ 直接置顶 / 置底` },
      { icon: Search, title: '节点索引', desc: '右下角统计条点节点 / 分组数，打开索引面板一键飞到目标' },
    ]
    : [
      { icon: Plus, title: 'Add nodes', desc: 'Right-click or double-click empty canvas; the dock + works too' },
      { icon: Spline, title: 'Connect nodes', desc: 'Hover a node, drag the side + onto another card to wire them' },
      { icon: Wand2, title: 'Wire-to-create', desc: 'Drop a wire on empty canvas to create and connect a new node' },
      { icon: ArrowUpRight, title: 'Batch connect', desc: 'Multi-select 2+, drag the + at the selection edge to a target' },
      { icon: MousePointer2, title: 'Select & move', desc: 'Click to select; drag empty canvas to box-select; drags snap-align' },
      { icon: Pencil, title: 'Rename', desc: 'Double-click the node title, type, press Enter' },
      { icon: Trash2, title: 'Delete', desc: 'Select then ⌫ / Delete; edges go with their endpoints' },
      { icon: Upload, title: 'Add media', desc: 'Drop files onto the canvas or upload via the right-click menu' },
      { icon: Save, title: 'Save assets', desc: 'Right-click a node → save to library, reuse from the asset modal' },
      { icon: Boxes, title: 'Groups', desc: 'Multi-select then Group; drag the title bar, resize via the grip' },
      { icon: Layers, title: 'Layer order', desc: `${MOD}+]/[ reorders the selected node; add ⇧ for top/bottom` },
      { icon: Search, title: 'Node index', desc: 'Click the node/group counts (bottom-right) to jump anywhere' },
    ];

  const navigation: Array<{ icon: typeof Hand; title: string; desc: string }> = zh
    ? [
      { icon: Hand, title: '平移画布', desc: '按住 Space 左键拖，或中键 / 右键拖拽，滚轮自由平移' },
      { icon: ZoomIn, title: '缩放画布', desc: `${MOD} + 滚轮或触控板捏合；范围 10% – 400%` },
      { icon: Ruler, title: '缩放标尺', desc: '顶部标尺点击 / 拖动直接调缩放，双击回到 100%' },
      { icon: Pin, title: '自动吸附', desc: 'dock 图钉开关：24px 网格 + 邻居对齐参考线，松手保持对齐' },
      { icon: MapIcon, title: '小地图', desc: '左下角开关；点击小地图定位，右上角按钮放大 / 收起' },
      { icon: LocateFixed, title: '整理画布', desc: '左下角一键按连线方向自动布局并适配视图' },
    ]
    : [
      { icon: Hand, title: 'Pan', desc: 'Space + drag, middle / right drag, or free wheel scrolling' },
      { icon: ZoomIn, title: 'Zoom', desc: `${MOD} + wheel or pinch; range 10% – 400%` },
      { icon: Ruler, title: 'Zoom ruler', desc: 'Click / drag the top ruler to zoom; double-click resets to 100%' },
      { icon: Pin, title: 'Auto snap', desc: 'Dock pin toggle: 24px grid + alignment guides that stick on release' },
      { icon: MapIcon, title: 'Minimap', desc: 'Bottom-left toggle; click to navigate, expand via its corner button' },
      { icon: LocateFixed, title: 'Tidy canvas', desc: 'One click auto-layout along the wiring direction + fit view' },
    ];

  const imageTools: Array<{ icon: typeof Sparkles; title: string; desc: string }> = zh
    ? [
      { icon: Sparkles, title: '高清超分', desc: '图片工具栏「高清」：Nano Pro 引擎，2K / 4K 与画幅比例可选' },
      { icon: Brush, title: '画笔标注', desc: '在图上画笔 / 文字标注，保存为新节点并自动连线，原图不动' },
      { icon: ImageIcon, title: '全屏预览', desc: '双击图片打开大图：滚轮缩放、拖拽平移、Esc 关闭' },
      { icon: Copy, title: '二次创作', desc: '全景 / 多角度 / 打光 / 九宫格 / 宫格切分 / 对比，都在图片工具栏' },
      { icon: Move, title: '版本历史', desc: '节点右上角版本徽章可回看历史版本并设为主图' },
    ]
    : [
      { icon: Sparkles, title: 'HD upscale', desc: 'Image toolbar "HD": Nano Pro engine with 2K / 4K + aspect ratio' },
      { icon: Brush, title: 'Annotate', desc: 'Draw / add text on an image; saves as a NEW connected node' },
      { icon: ImageIcon, title: 'Fullscreen', desc: 'Double-click an image: wheel zoom, drag pan, Esc closes' },
      { icon: Copy, title: 'Derivations', desc: 'Panorama / angles / lighting / grid / split / compare — image toolbar' },
      { icon: Move, title: 'Versions', desc: 'The badge on a node opens its version history; promote any version' },
    ];

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-[min(760px,88vh)] w-[min(1180px,94vw)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#101218] shadow-[0_40px_120px_rgba(0,0,0,0.7)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] px-7 py-4">
          <div className="text-[15px] font-semibold text-neutral-100">{zh ? '画布使用指南' : 'Canvas Guide'}</div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-400 transition hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-7 pb-8 pt-5">
          <SectionTitle>{zh ? '快捷键' : 'Shortcuts'}</SectionTitle>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
            {shortcuts.map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-white/[0.03] px-3.5 py-2.5"
              >
                <span className="text-[12.5px] text-neutral-300">{item.label}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {item.combos.map((combo, index) => (
                    <span key={index} className="flex items-center gap-1.5">
                      {index > 0 ? <span className="text-[10px] text-neutral-600">/</span> : null}
                      <Keys combo={combo} />
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>

          <SectionTitle>{zh ? '基础操作' : 'Basics'}</SectionTitle>
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-4">
            {basics.map((item) => (
              <div key={item.title} className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-neutral-300">
                  <item.icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-neutral-100">{item.title}</div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-neutral-500">{item.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <SectionTitle>{zh ? '画布导航' : 'Navigation'}</SectionTitle>
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
            {navigation.map((item) => (
              <div key={item.title} className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-neutral-300">
                  <item.icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-neutral-100">{item.title}</div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-neutral-500">{item.desc}</div>
                </div>
              </div>
            ))}
          </div>

          <SectionTitle>{zh ? '图片工具' : 'Image tools'}</SectionTitle>
          <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
            {imageTools.map((item) => (
              <div key={item.title} className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-neutral-300">
                  <item.icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-neutral-100">{item.title}</div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-neutral-500">{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
