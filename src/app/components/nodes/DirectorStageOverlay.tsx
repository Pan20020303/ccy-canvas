import React, { Suspense, forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Canvas, ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { CameraControls, Grid, TransformControls, useGLTF } from '@react-three/drei';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  X, Camera, Loader2, Move3D, RotateCw, Maximize2, Plus, Video as VideoIcon, Trash2, UserPlus,
  RefreshCw, PersonStanding, Settings2, ChevronDown, Eye, Lock,
  ListTree, Boxes, HelpCircle, Search, Users, User, Globe2, Type, Monitor,
  Magnet, Undo2, Redo2, ArrowDown, RectangleHorizontal, Image as ImageLucide, Film, UploadCloud,
} from 'lucide-react';
import * as THREE from 'three';

import { useStore } from '../../store';
import type { DirectorStageData, ActorPose } from './DirectorStageNode';
import { PROP_DEFS, PropMesh, propDefOf, type PropTransform } from './director-props';

/**
 * Full-screen 3D 导演台编辑器.
 *
 * 功能维度:
 *   - 演员: 程序化关节素体 + TransformControls 拖动 + 12 种姿势预设 + 关节滑杆
 *   - 机位: 多机位列表 + 场景内可见相机标记 + 拖动调整 + 应用当前视图到指定机位
 *   - 出图: 「确认构图」时**逐机位渲染 + 截图**,每个机位独立产物,节点上每个
 *     机位独立 source handle,下游可以从任意机位连线引用画面
 */

type CaptureFn = () => string | null;
type MultiCaptureFn = (cams: CameraSpec[]) => Promise<Record<string, string>>;
/** 按机位 spec 离屏出图(比例 = cam.aspect,不动主视口相机)。 */
type SpecCaptureFn = (cam: CameraSpec, opts?: { longSide?: number }) => string | null;
type TransformMode = 'translate' | 'rotate' | 'scale';
type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '21:9';

type ActorTransform = {
  id: string;
  /** 体型 id —— 'mannequin-standard' / 'mannequin-female' / 'mannequin-child'
   *  / 'mannequin-sturdy' / 'mannequin-slim'. Mannequin 内部按 BODY_TYPES 表
   *  调比例 + 默认色. */
  assetId: string;
  label: string;
  position: [number, number, number];
  rotationY: number;                      // 老字段, 仅 Y 轴弧度
  scale: number;                          // 老字段, uniform
  /** 新:全 XYZ 旋转 (弧度). 未设时回落到 [0, rotationY, 0]. */
  rotation?: [number, number, number];
  /** 新:全 XYZ 缩放. 未设时回落到 [scale, scale, scale]. */
  scaleXYZ?: [number, number, number];
  /** 新:整体着色, 未设时用 BODY_TYPES[assetId].defaultColor. */
  color?: string;
  pose?: ActorPose;
};

/** 体型预设表 —— 5 种内置素体. assetId 用作 key.
 *
 *  glbUrl: 如果 public/mannequins/ 下面放了对应的 GLB,会优先用真模型.
 *  没有放就 fallback 到 procedural primitive 版本. 见
 *  public/mannequins/README.md 介绍怎么获取 CC0 / 免费素材. */
// 配色（2026-07 参考对齐）：从暖米色改为中性浅石墨灰 — 参考产品的素体是
// 无色温的雕塑灰，暖色调来自灯光而不是材质本身。
// 2026-07:五个体型共用一个高质量绑定模型(three.js 示例库的 Mixamo X Bot,
// 标准 mixamorig 骨架 + 手指骨),按 widthMul/heightMul 派生体型差异。
// 想按体型换不同模型,放不同的 glb 再把 glbUrl 指过去即可。
const BODY_TYPES: Record<string, { label: string; defaultColor: string; widthMul: number; heightMul: number; headBoost: number; glbUrl: string }> = {
  'mannequin-standard': { label: '标准素体', defaultColor: '#c9ccd1', widthMul: 1.00, heightMul: 1.00, headBoost: 1.00, glbUrl: '/mannequins/xbot.glb' },
  'mannequin-female':   { label: '女性素体', defaultColor: '#d3d5d9', widthMul: 0.92, heightMul: 0.96, headBoost: 1.00, glbUrl: '/mannequins/xbot.glb' },
  'mannequin-child':    { label: '儿童素体', defaultColor: '#d8dadd', widthMul: 0.78, heightMul: 0.72, headBoost: 1.18, glbUrl: '/mannequins/xbot.glb' },
  'mannequin-sturdy':   { label: '壮实素体', defaultColor: '#bfc2c7', widthMul: 1.14, heightMul: 1.02, headBoost: 0.98, glbUrl: '/mannequins/xbot.glb' },
  'mannequin-slim':     { label: '纤细素体', defaultColor: '#ced1d5', widthMul: 0.88, heightMul: 1.04, headBoost: 1.00, glbUrl: '/mannequins/xbot.glb' },
};
const BODY_TYPE_IDS = Object.keys(BODY_TYPES);
function bodyTypeOf(assetId: string) {
  return BODY_TYPES[assetId] ?? BODY_TYPES['mannequin-standard'];
}

// 2026-07:换上真模型(xbot.glb, Mixamo 骨架)后重新启用蒙皮素体;
// 程序化胶囊素体保留作 GLB 加载失败时的回落。
const USE_SKINNED_GLB = true;

type CameraSpec = {
  id: string;
  label: string;
  position: [number, number, number];
  lookAt: [number, number, number];
  fov: number;
  aspect: AspectRatio;
  /** 荷兰角(绕视轴滚转,弧度)。主视口的 CameraControls 不支持 roll,
   *  只在离屏出图 / 实时预览里生效。 */
  roll?: number;
  /** "应用视图到此机位"时拍下的快照. 每个机位只保留一份,
   *  下次再 apply 直接覆盖. 显示在右下角面板里. */
  previewImage?: string;
};

type SelectionKind = 'actor' | 'camera' | 'prop';
type Selection = { kind: SelectionKind; id: string; obj: THREE.Object3D };

const DEFAULT_POSE: Required<ActorPose> = {
  torso: [0, 0, 0],
  head: [0, 0, 0],
  shoulderL: [0, 0, 0],
  shoulderR: [0, 0, 0],
  elbowL: [0, 0, 0],
  elbowR: [0, 0, 0],
  hipL: [0, 0, 0],
  hipR: [0, 0, 0],
  kneeL: [0, 0, 0],
  kneeR: [0, 0, 0],
  wristL: [0, 0, 0],
  wristR: [0, 0, 0],
  ankleL: [0, 0, 0],
  ankleR: [0, 0, 0],
};

const DEFAULT_ACTOR: ActorTransform = {
  id: 'actor-default',
  assetId: 'mannequin-standard',
  label: '角色A',
  position: [0, 0, 0],
  rotationY: 0,
  scale: 1,
  // 自然站立(双臂下垂),不是 T-pose —— 数值同 POSE_PRESETS['站立']
  // (它声明在下面,模块顶层引用会 TDZ,这里直接写字面量)。
  pose: { ...DEFAULT_POSE, shoulderL: [0, 0, -1.4], shoulderR: [0, 0, 1.4] },
};

const DEFAULT_CAMERA: CameraSpec = {
  id: 'cam-1',
  label: '机位1',
  position: [3.5, 2.2, 4.5],
  lookAt: [0, 1.2, 0],
  fov: 50,
  aspect: '16:9',
};

// 编辑器主视口的"原点"视角 —— 故意和 DEFAULT_CAMERA(机位1)错开:
// 机位标记现在常显,视口若与机位重合会钻进标记模型内部一片黑。
const EDITOR_HOME = {
  position: [-4.6, 3.1, 5.8] as [number, number, number],
  lookAt: [0, 1, 0] as [number, number, number],
};

const ASPECT_RATIOS: AspectRatio[] = ['16:9', '9:16', '1:1', '4:3', '21:9'];

/** "16:9" → "16 / 9" 给 CSS aspect-ratio 用. */
function aspectRatioToCss(ar: AspectRatio): string {
  const [w, h] = ar.split(':');
  return `${w} / ${h}`;
}

/** "16:9" → [16, 9](数值)。 */
function aspectRatioWH(ar: AspectRatio): [number, number] {
  const [w, h] = ar.split(':').map(Number);
  return [w, h];
}

/** ====== 舞台环境设置(全景背景 / 标签)——持久化在 node.data.stageSettings ====== */

type StageSettings = {
  skyColor: string;
  /** 地面(网格 + 轴线)不透明度 0..1 —— 通过把网格色向天空色靠拢来模拟。 */
  groundOpacity: number;
  /** 地面整体抬升 / 下沉(米)。 */
  groundY: number;
  groundVisible: boolean;
  labelsVisible: boolean;
  /** 标签字号(参考滑杆 10..32,默认 18,按 18 为 1x 缩放浮标)。 */
  labelFontSize: number;
  /** 机位参考线 —— 从相机标记画出视锥框线。 */
  cameraGuides: boolean;
};

const DEFAULT_STAGE_SETTINGS: StageSettings = {
  skyColor: '#050507',
  groundOpacity: 1,
  groundY: 0,
  groundVisible: true,
  labelsVisible: true,
  labelFontSize: 18,
  cameraGuides: false,
};

// 天空色板(参考图两排:深色系 + 亮色系)。
const SKY_SWATCHES = [
  '#050507', '#0b1120', '#101a2e', '#1c2440', '#2a2350',
  '#3a3f4a', '#9fb6c9', '#7ec8e3', '#dfe5ea', '#ffffff',
];

/** 线性混合两个 hex 颜色, t=0 → a, t=1 → b。 */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sa: number, sb: number) => Math.round(sa + (sb - sa) * t);
  const r = ch((pa >> 16) & 255, (pb >> 16) & 255);
  const g = ch((pa >> 8) & 255, (pb >> 8) & 255);
  const bl = ch(pa & 255, pb & 255);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

/** ====== 机位预设(参考:正面中景 / 过肩 / 荷兰角……) ======
 *  az: 方位角(度), 0 = 人物正面(+Z 方向), 90 = 人物左侧;
 *  el: 仰角(度), 正值从上往下俯拍, 负值贴地仰拍;
 *  dist: 与焦点(演员质心)的距离(米); targetY: 目光落点高度(默认胸口 1.1m). */
type CameraPresetDef = {
  id: string;
  zh: string;
  en: string;
  az: number;
  el: number;
  dist: number;
  fov: number;
  targetY?: number;
  /** 荷兰角(度)。 */
  roll?: number;
  /** POV 第一视角 —— 直接站在焦点人物头部朝前看,忽略球面参数。 */
  pov?: boolean;
};

const CAMERA_PRESETS: CameraPresetDef[] = [
  { id: 'front-mid',   zh: '正面中景',      en: 'Front medium',   az: 0,    el: 4,   dist: 2.6, fov: 42 },
  { id: 'front-close', zh: '正面特写',      en: 'Front close-up', az: 0,    el: 2,   dist: 1.2, fov: 34, targetY: 1.5 },
  { id: 'front-full',  zh: '正面全景',      en: 'Front wide',     az: 0,    el: 6,   dist: 5.2, fov: 50 },
  { id: 'side-track',  zh: '侧面跟拍',      en: 'Side tracking',  az: 90,   el: 3,   dist: 2.6, fov: 45 },
  { id: 'side-far',    zh: '侧面远景',      en: 'Side long',      az: 90,   el: 6,   dist: 6.5, fov: 48 },
  { id: 'back-mid',    zh: '背面中景',      en: 'Back medium',    az: 180,  el: 4,   dist: 2.6, fov: 42 },
  { id: 'top-full',    zh: '俯拍全景',      en: 'High wide',      az: 15,   el: 52,  dist: 6,   fov: 50 },
  { id: 'top-45',      zh: '45° 俯拍',     en: '45° high',       az: 45,   el: 45,  dist: 4,   fov: 46 },
  { id: 'low-up',      zh: '低角度仰拍',    en: 'Low angle',      az: 0,    el: -18, dist: 2.4, fov: 45, targetY: 1.35 },
  { id: 'low-wide',    zh: '低角度广角',    en: 'Low wide',       az: 12,   el: -14, dist: 1.9, fov: 68, targetY: 1.3 },
  { id: 'ots-left',    zh: '过肩镜头',      en: 'Over-shoulder',  az: 152,  el: 6,   dist: 1.5, fov: 40, targetY: 1.45 },
  { id: 'ots-right',   zh: '过肩镜头 (右)', en: 'OTS right',      az: -152, el: 6,   dist: 1.5, fov: 40, targetY: 1.45 },
  { id: 'birdseye',    zh: '鸟瞰',          en: "Bird's-eye",     az: 0,    el: 78,  dist: 7,   fov: 50 },
  { id: 'dutch',       zh: '荷兰角',        en: 'Dutch angle',    az: 24,   el: 5,   dist: 2.4, fov: 44, roll: 14 },
  { id: 'far-track',   zh: '远景跟踪',      en: 'Long tracking',  az: 35,   el: 10,  dist: 8.5, fov: 42, targetY: 1.0 },
  { id: 'pov',         zh: 'POV 第一视角',  en: 'POV',            az: 0,    el: 0,   dist: 0,   fov: 62, pov: true },
];

/** 姿势预设 —— 用 Math.PI 表达的关节欧拉角.
 *
 *  ★ 重要标定 ★
 *  -------------
 *  Mixamo X Bot 的 **bind pose 是 T-pose** (双臂水平外伸),不是自然站立.
 *  我们的预设以"自然站立 = 双臂自然下垂"作 baseline,所以:
 *    - 'T型' 预设 = 全 0(就是 bind pose,不动)
 *    - 所有其他预设(站立 / 行走 / 坐姿 / ...) 都要先把双臂"扣"到身侧,
 *      再叠加动作. ARMS_DOWN_L / ARMS_DOWN_R 是这两块基线.
 *
 *  规则:
 *    1. 宁可"动作小一点"也不让网格穿过身体(防穿模).
 *       用户嫌不够大可以切到「微调」Tab 用滑杆放大.
 *    2. 所有 shoulder Z 数值都是相对身侧(±)的角位移,不直接用 ±PI/2.
 *    3. 肘 / 髋 / 膝的 X 旋转方向跟 Mixamo 局部坐标对齐:
 *         elbow.x > 0  → 前臂折回去(屈肘)
 *         hip.x   < 0  → 大腿往身前抬(屈髋)
 *         knee.x  > 0  → 小腿往后折(屈膝)
 *
 *  procedural 素体(当前默认渲染路径, USE_SKINNED_GLB=false)的建模 rest
 *  是 arms-down、肩部旋向与 Mixamo 镜像 —— Mannequin 内部做了一次基准
 *  换算(shL/shR/elL/elR),预设数值本身保持 T-pose 基准约定不动.
 */
const PI = Math.PI;
const ARMS_DOWN_L: [number, number, number] = [0, 0, -1.4];  // ≈ -80°, 左臂从 T-pose 收到身侧
const ARMS_DOWN_R: [number, number, number] = [0, 0,  1.4];  // 镜像

const POSE_PRESETS: Record<string, ActorPose> = {
  // 'T型' = bind pose, 双臂水平外伸
  'T型': DEFAULT_POSE,

  // 'L 站立': 自然站立, 双臂垂在身侧
  '站立': {
    ...DEFAULT_POSE,
    shoulderL: ARMS_DOWN_L,
    shoulderR: ARMS_DOWN_R,
  },

  // 行走: 步伐 + 自然摆臂. 全部数值都从 arms-down baseline 起算.
  '行走': {
    ...DEFAULT_POSE,
    shoulderL: [PI / 7, 0, ARMS_DOWN_L[2]],   // 左臂往后摆一点
    shoulderR: [-PI / 7, 0, ARMS_DOWN_R[2]],  // 右臂往前摆一点
    hipL: [-PI / 10, 0, 0],                   // 左腿迈前
    hipR: [PI / 10, 0, 0],                    // 右腿在后
    kneeL: [PI / 14, 0, 0],
  },

  // 跑步: 大幅摆臂 + 大步幅 + 微前倾. 肘部弯曲跑步姿态.
  '跑步': {
    ...DEFAULT_POSE,
    torso: [PI / 14, 0, 0],
    shoulderL: [PI / 3, 0, ARMS_DOWN_L[2]],
    shoulderR: [-PI / 3, 0, ARMS_DOWN_R[2]],
    elbowL: [PI / 2, 0, 0],
    elbowR: [PI / 2, 0, 0],
    hipL: [-PI / 4, 0, 0],
    hipR: [PI / 5, 0, 0],
    kneeL: [PI / 3, 0, 0],
    kneeR: [PI / 7, 0, 0],
  },

  // 坐姿: 髋屈 90°, 膝屈 90°, 双臂垂在身侧
  '坐姿': {
    ...DEFAULT_POSE,
    shoulderL: ARMS_DOWN_L,
    shoulderR: ARMS_DOWN_R,
    hipL: [-PI / 2, 0, 0],
    hipR: [-PI / 2, 0, 0],
    kneeL: [PI / 2, 0, 0],
    kneeR: [PI / 2, 0, 0],
  },

  // 蹲下: 深蹲, 躯干前倾配重, 双臂略前伸保持平衡
  '蹲下': {
    ...DEFAULT_POSE,
    shoulderL: [PI / 5, 0, ARMS_DOWN_L[2] * 0.92],
    shoulderR: [-PI / 5, 0, ARMS_DOWN_R[2] * 0.92],
    torso: [PI / 6, 0, 0],
    hipL: [-PI / 1.5, 0, 0],
    hipR: [-PI / 1.5, 0, 0],
    kneeL: [PI / 1.2, 0, 0],
    kneeR: [PI / 1.2, 0, 0],
  },

  // 招手: 左臂保持下垂, 右臂抬到耳边稍弯
  '招手': {
    ...DEFAULT_POSE,
    shoulderL: ARMS_DOWN_L,
    shoulderR: [0, 0, -PI / 2.2],      // 右臂从 T-pose 反向旋转, 抬到斜上方
    elbowR: [0, 0, -PI / 3.5],         // 前臂折向头
  },
  // 举手: 左臂下垂, 右臂直直伸向天空 (从 T-pose 再多一档 ~70°)
  '举手': {
    ...DEFAULT_POSE,
    shoulderL: ARMS_DOWN_L,
    shoulderR: [0, 0, -PI / 1.4],   // ≈ -128°: 从 T-pose 沿头顶方向旋转
  },

  // 叉腰: 双手按在髋上, 上臂略向外抬, 肘大幅屈, 手腕落到髋骨
  '叉腰': {
    ...DEFAULT_POSE,
    shoulderL: [PI / 12, 0, ARMS_DOWN_L[2] + PI / 8],  // 略外抬留出肘空间
    shoulderR: [PI / 12, 0, ARMS_DOWN_R[2] - PI / 8],
    elbowL: [PI / 2.2, 0, 0],  // 屈肘往身前折
    elbowR: [PI / 2.2, 0, 0],
  },

  // 思考: 左臂下垂, 右肘屈起手扶下巴, 头微歪
  '思考': {
    ...DEFAULT_POSE,
    shoulderL: ARMS_DOWN_L,
    shoulderR: [PI / 4, 0, ARMS_DOWN_R[2] * 0.7],  // 右上臂略前 + 略外抬
    elbowR: [PI / 1.6, 0, 0],                      // 大角度屈肘, 手到下巴
    head: [PI / 16, PI / 16, PI / 22],             // 微点头 + 微歪头
  },

  // 拍照: 双臂前举, 双肘屈 ~60° 模拟端相机
  '拍照': {
    ...DEFAULT_POSE,
    shoulderL: [PI / 2.4, 0, ARMS_DOWN_L[2] + PI / 7],   // 前举 + 向中收
    shoulderR: [PI / 2.4, 0, ARMS_DOWN_R[2] - PI / 7],
    elbowL: [PI / 3, 0, 0],
    elbowR: [PI / 3, 0, 0],
  },

  // 指向: 左臂下垂, 右臂前伸指向远处 (肩前举 + 略外展)
  '指向': {
    ...DEFAULT_POSE,
    shoulderL: ARMS_DOWN_L,
    shoulderR: [PI / 2.2, 0, ARMS_DOWN_R[2] * 0.5],   // 抬到接近水平指前
  },
};

const PRESET_KEYS = Object.keys(POSE_PRESETS);

/** ============================================================
 *  Mannequin —— 程序化关节素体
 *  ============================================================
 *  以髋为根,层级:pelvis → (torso → (chest → neck → head + shoulders → arms))
 *                       → hips → legs. 每个关节是一个 <group>,姿势数据是
 *  各关节的欧拉角. T-pose 时所有角度都是 0,人物自然下垂站立. */

// 暖白皮调代替原来的纯灰,接近木质艺用人偶 + 现代姿势 reference 工具.
// 这三个常量是"标准素体"的默认值;Mannequin 内部按 bodyType + actor.color
// 实时派生出 light / deep 两档,所以这里更多是给 CameraMarker 等其他场景
// 物件兜底用.
const POSE_MAT = '#c9ccd1';      // 主肢体表面色 —— 中性雕塑灰（参考色调）
const POSE_MAT_DEEP = '#a9adb3'; // 关节/腹/下肢深一档
const POSE_HEAD = '#d8dade';     // 头/颈/手 略亮,做高光区

/** Hex 颜色 +/- 亮度. amount 在 [-1, 1] 之间. 用于从用户选的 actor.color
 *  自动派生关节深色和高光浅色,避免再让用户挑两次. */
function shadeColor(hex: string, amount: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return hex;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const mix = (c: number) => Math.max(0, Math.min(255, Math.round(c + 255 * amount)));
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

const Mannequin = forwardRef<THREE.Group, {
  actor: ActorTransform;
  selected: boolean;
  onSelect: (id: string, obj: THREE.Object3D) => void;
  labelScale?: number;
}>(function Mannequin({ actor, selected, onSelect, labelScale = 1 }, ref) {
  const groupRef = useRef<THREE.Group>(null!);
  const setRef = useCallback((g: THREE.Group | null) => {
    groupRef.current = g!;
    if (typeof ref === 'function') ref(g);
    else if (ref) (ref as React.MutableRefObject<THREE.Group | null>).current = g;
  }, [ref]);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (groupRef.current) onSelect(actor.id, groupRef.current);
  };

  const p = { ...DEFAULT_POSE, ...(actor.pose ?? {}) };
  // ★ 基准换算 ★ 预设/滑杆的数值约定沿用 Mixamo T-pose 基准(shoulder z
  // ∓1.4 = 双臂下垂、elbow x>0 = 屈肘)。程序化素体的建模 rest 是「双臂
  // 自然下垂、手臂沿 -Y」,肩部零点和旋向都不同 —— 在应用层换算一次,让
  // 同一份预设在数据层语义不变(2026-07 反馈:站立在素体上显示成 T-pose)。
  const shL: [number, number, number] = [p.shoulderL[0], p.shoulderL[1], -(p.shoulderL[2] + 1.4)];
  const shR: [number, number, number] = [p.shoulderR[0], p.shoulderR[1], -(p.shoulderR[2] - 1.4)];
  const elL: [number, number, number] = [-p.elbowL[0], p.elbowL[1], p.elbowL[2]];
  const elR: [number, number, number] = [-p.elbowR[0], p.elbowR[1], p.elbowR[2]];
  // 体型 → 内部比例 (宽 / 高 / 头大小放大系数). 这是相对 actor.scale 之上
  // 再叠加的一层 "形态调整",让女性 / 儿童 / 壮实 / 纤细看起来不像同一
  // 个人盖印章.
  const bt = bodyTypeOf(actor.assetId);
  const bodyColor = actor.color || bt.defaultColor;
  const bodyColorDeep = shadeColor(bodyColor, -0.12);
  const bodyColorLight = shadeColor(bodyColor, 0.08);

  // 兼容 + 新字段:rotation > rotationY, scaleXYZ > scale (uniform).
  const finalRotation: [number, number, number] = actor.rotation ?? [0, actor.rotationY, 0];
  const finalScale: [number, number, number] = actor.scaleXYZ ?? [actor.scale, actor.scale, actor.scale];

  return (
    <group
      ref={setRef}
      name={`stage-actor-${actor.id}`}
      position={actor.position}
      rotation={finalRotation}
      scale={[finalScale[0] * bt.widthMul, finalScale[1] * bt.heightMul, finalScale[2] * bt.widthMul]}
      onClick={handleClick}
    >
      {/* 髋部根 (y=0.92 是站立髋高度) —— 比例参考真人 7.5 头身, 用胶囊
          / 球关节 / 锥型四肢替换原始的纯柱体, 更接近木质艺用人偶. */}
      <group position={[0, 0.92, 0]}>
        {/* 髋盆 —— 上窄下宽倒梯形, 用胶囊侧面观更自然 */}
        <mesh castShadow>
          <capsuleGeometry args={[0.13, 0.08, 6, 16]} />
          <meshStandardMaterial color={bodyColorDeep} roughness={0.6} metalness={0.05} />
        </mesh>

        {/* 躯干 (relative to pelvis top) */}
        <group position={[0, 0.08, 0]} rotation={p.torso}>
          {/* 腰部窄 → 胸部宽: 用两段叠加做沙漏腰线 */}
          <mesh position={[0, 0.04, 0]} castShadow>
            <capsuleGeometry args={[0.12, 0.06, 6, 16]} />
            <meshStandardMaterial color={bodyColorDeep} roughness={0.6} />
          </mesh>
          {/* 上胸 —— 一整段平滑胶囊, 不再叠加胸肌/腹肌/锁骨小球.
              所有"肌肉块"用堆球的方式都会出现"贴疙瘩"感, 体型靠 light
              + rim 光的明暗去暗示, 而不是几何凸起. */}
          <mesh position={[0, 0.2, 0]} castShadow>
            <capsuleGeometry args={[0.155, 0.18, 8, 20]} />
            <meshStandardMaterial color={bodyColor} roughness={0.5} />
          </mesh>

          {/* 颈+头 */}
          <group position={[0, 0.34, 0]}>
            <mesh position={[0, 0.04, 0]} castShadow>
              <cylinderGeometry args={[0.048, 0.058, 0.08, 16]} />
              <meshStandardMaterial color={bodyColorLight} roughness={0.5} />
            </mesh>
            <group position={[0, 0.08, 0]} rotation={p.head} scale={bt.headBoost}>
              {/* 头 —— 蛋形 (Y 拉长 18%) 比正球更像人头. headBoost > 1
                  时整个头节点都放大,儿童素体看起来头大身小. */}
              <mesh position={[0, 0.13, 0]} castShadow scale={[1, 1.18, 1]}>
                <sphereGeometry args={[0.115, 24, 24]} />
                <meshStandardMaterial color={bodyColorLight} roughness={0.5} />
              </mesh>
              {/* 下颌微微外凸, 让侧面有人脸形状 */}
              <mesh position={[0, 0.05, 0.025]} castShadow>
                <sphereGeometry args={[0.075, 16, 16]} />
                <meshStandardMaterial color={bodyColorLight} roughness={0.5} />
              </mesh>
              <Billboard text={actor.label} position={[0, 0.4, 0]} scale={labelScale} />
            </group>
          </group>

          {/* 左肩 + 左臂 —— 单段上臂胶囊 (无凸起肌肉) + 肘关节球 + 前臂
              + 手. 主体用 capsule 而非 cylinder, 两端自然圆润. */}
          <group position={[-0.18, 0.22, 0]} rotation={shL}>
            {/* 三角肌大球 */}
            <mesh castShadow scale={[1.15, 1, 1.05]}>
              <sphereGeometry args={[0.062, 16, 16]} />
              <meshStandardMaterial color={bodyColor} roughness={0.5} />
            </mesh>
            {/* 上臂 —— capsule 比 cylinder 更连贯 */}
            <mesh position={[0, -0.19, 0]} castShadow>
              <capsuleGeometry args={[0.045, 0.28, 6, 16]} />
              <meshStandardMaterial color={bodyColor} roughness={0.55} />
            </mesh>
            <group position={[0, -0.36, 0]} rotation={elL}>
              <mesh castShadow>
                <sphereGeometry args={[0.04, 14, 14]} />
                <meshStandardMaterial color={bodyColor} roughness={0.5} />
              </mesh>
              {/* 前臂 capsule —— 略细于上臂 */}
              <mesh position={[0, -0.17, 0]} castShadow>
                <capsuleGeometry args={[0.037, 0.24, 6, 16]} />
                <meshStandardMaterial color={bodyColor} roughness={0.55} />
              </mesh>
              {/* 手 —— 腕关节枢轴 + 手掌 + 拇指 */}
              <group position={[0, -0.36, 0]} rotation={p.wristL}>
                <mesh castShadow scale={[1, 1.5, 0.5]}>
                  <sphereGeometry args={[0.044, 16, 16]} />
                  <meshStandardMaterial color={bodyColorLight} roughness={0.55} />
                </mesh>
                <mesh position={[0.025, -0.015, 0]} castShadow scale={[1.3, 0.9, 0.55]}>
                  <sphereGeometry args={[0.02, 10, 10]} />
                  <meshStandardMaterial color={bodyColorLight} roughness={0.55} />
                </mesh>
              </group>
            </group>
          </group>

          {/* 右肩 + 右臂 (镜像) */}
          <group position={[0.18, 0.22, 0]} rotation={shR}>
            <mesh castShadow scale={[1.15, 1, 1.05]}>
              <sphereGeometry args={[0.062, 16, 16]} />
              <meshStandardMaterial color={bodyColor} roughness={0.5} />
            </mesh>
            <mesh position={[0, -0.19, 0]} castShadow>
              <capsuleGeometry args={[0.045, 0.28, 6, 16]} />
              <meshStandardMaterial color={bodyColor} roughness={0.55} />
            </mesh>
            <group position={[0, -0.36, 0]} rotation={elR}>
              <mesh castShadow>
                <sphereGeometry args={[0.04, 14, 14]} />
                <meshStandardMaterial color={bodyColor} roughness={0.5} />
              </mesh>
              <mesh position={[0, -0.17, 0]} castShadow>
                <capsuleGeometry args={[0.037, 0.24, 6, 16]} />
                <meshStandardMaterial color={bodyColor} roughness={0.55} />
              </mesh>
              <group position={[0, -0.36, 0]} rotation={p.wristR}>
                <mesh castShadow scale={[1, 1.5, 0.5]}>
                  <sphereGeometry args={[0.044, 16, 16]} />
                  <meshStandardMaterial color={bodyColorLight} roughness={0.55} />
                </mesh>
                <mesh position={[-0.025, -0.015, 0]} castShadow scale={[1.3, 0.9, 0.55]}>
                  <sphereGeometry args={[0.02, 10, 10]} />
                  <meshStandardMaterial color={bodyColorLight} roughness={0.55} />
                </mesh>
              </group>
            </group>
          </group>
        </group>

        {/* 左髋 + 左腿 —— 平滑 capsule, 没有股四头/腿肚等凸起小球 */}
        <group position={[-0.08, -0.04, 0]} rotation={p.hipL}>
          <mesh castShadow scale={[1.05, 1, 1.05]}>
            <sphereGeometry args={[0.07, 16, 16]} />
            <meshStandardMaterial color={bodyColor} roughness={0.5} />
          </mesh>
          {/* 大腿 capsule —— 全长 0.5 含两端 cap */}
          <mesh position={[0, -0.26, 0]} castShadow>
            <capsuleGeometry args={[0.06, 0.4, 6, 16]} />
            <meshStandardMaterial color={bodyColor} roughness={0.55} />
          </mesh>
          <group position={[0, -0.5, 0]} rotation={p.kneeL}>
            <mesh castShadow>
              <sphereGeometry args={[0.052, 14, 14]} />
              <meshStandardMaterial color={bodyColor} roughness={0.5} />
            </mesh>
            {/* 小腿 capsule —— 略细 */}
            <mesh position={[0, -0.17, 0]} castShadow>
              <capsuleGeometry args={[0.046, 0.24, 6, 16]} />
              <meshStandardMaterial color={bodyColor} roughness={0.55} />
            </mesh>
            {/* 脚 —— 踝关节枢轴 + 脚跟球 + 脚掌长椭球 */}
            <group position={[0, -0.32, 0]} rotation={p.ankleL}>
              <mesh position={[0, -0.005, -0.02]} castShadow>
                <sphereGeometry args={[0.045, 14, 14]} />
                <meshStandardMaterial color={bodyColorDeep} roughness={0.6} />
              </mesh>
              <mesh position={[0, -0.015, 0.075]} castShadow scale={[1.05, 0.45, 2.1]}>
                <sphereGeometry args={[0.055, 16, 16]} />
                <meshStandardMaterial color={bodyColorDeep} roughness={0.6} />
              </mesh>
            </group>
          </group>
        </group>

        {/* 右髋 + 右腿 (镜像) */}
        <group position={[0.08, -0.04, 0]} rotation={p.hipR}>
          <mesh castShadow scale={[1.05, 1, 1.05]}>
            <sphereGeometry args={[0.07, 16, 16]} />
            <meshStandardMaterial color={bodyColor} roughness={0.5} />
          </mesh>
          <mesh position={[0, -0.26, 0]} castShadow>
            <capsuleGeometry args={[0.06, 0.4, 6, 16]} />
            <meshStandardMaterial color={bodyColor} roughness={0.55} />
          </mesh>
          <group position={[0, -0.5, 0]} rotation={p.kneeR}>
            <mesh castShadow>
              <sphereGeometry args={[0.052, 14, 14]} />
              <meshStandardMaterial color={bodyColor} roughness={0.5} />
            </mesh>
            <mesh position={[0, -0.17, 0]} castShadow>
              <capsuleGeometry args={[0.046, 0.24, 6, 16]} />
              <meshStandardMaterial color={bodyColor} roughness={0.55} />
            </mesh>
            <group position={[0, -0.32, 0]} rotation={p.ankleR}>
              <mesh position={[0, -0.005, -0.02]} castShadow>
                <sphereGeometry args={[0.045, 14, 14]} />
                <meshStandardMaterial color={bodyColorDeep} roughness={0.6} />
              </mesh>
              <mesh position={[0, -0.015, 0.075]} castShadow scale={[1.05, 0.45, 2.1]}>
                <sphereGeometry args={[0.055, 16, 16]} />
                <meshStandardMaterial color={bodyColorDeep} roughness={0.6} />
              </mesh>
            </group>
          </group>
        </group>
      </group>

      {/* 脚下指示圈 */}
      <mesh position={[0, 0.001, 0]} rotation={[-PI / 2, 0, 0]}>
        <ringGeometry args={selected ? [0.18, 0.24, 32] : [0.18, 0.21, 32]} />
        <meshBasicMaterial
          color={selected ? '#c4b5fd' : '#a78bfa'}
          transparent
          opacity={selected ? 0.85 : 0.4}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
});

/** ============================================================
 *  SkinnedMannequin —— 真正的 GLB skinned mesh 版本
 *  ============================================================
 *  当 BODY_TYPES[assetId].glbUrl 对应的文件存在时,优先用这个 path:
 *    - useGLTF 加载 (drei 会缓存 + 走 Suspense)
 *    - SkeletonUtils.clone 让多 actor 共享同一份资源也能独立姿态
 *    - findBone 按 Mixamo / Quaternius / Ready Player Me 常见命名 fuzzy
 *      匹配, 不强求严格 bone name
 *    - useFrame 每帧把 actor.pose 应用到对应的 bone.rotation
 *
 *  下面 BONE_NAME_PATTERNS 几个常见名空间都覆盖了, 一般主流 mannequin
 *  rig 不用改就能用. 自定义 rig 加进去也只是加几个字符串. */

const BONE_NAME_PATTERNS: Record<keyof Required<ActorPose>, string[]> = {
  // 每组末尾的 Skeleton_* / leg_joint_* 是项目自带素体 GLB 的实测骨名
  // （链条顺序用骨骼世界坐标验证过：肩 0.10m→肘 0.31m→腕 0.45m 离躯干渐远）。
  torso:     ['Spine', 'Spine1', 'Spine2', 'spine', 'mixamorigSpine', 'Skeleton_torso_joint_2'],
  head:      ['Head', 'head', 'mixamorigHead', 'Skeleton_neck_joint_2'],
  shoulderL: ['LeftArm', 'arm_L', 'arm.L', 'LeftShoulder', 'mixamorigLeftArm', 'Skeleton_arm_joint_L__4_'],
  shoulderR: ['RightArm', 'arm_R', 'arm.R', 'RightShoulder', 'mixamorigRightArm', 'Skeleton_arm_joint_R'],
  elbowL:    ['LeftForeArm', 'forearm_L', 'forearm.L', 'mixamorigLeftForeArm', 'Skeleton_arm_joint_L__3_'],
  elbowR:    ['RightForeArm', 'forearm_R', 'forearm.R', 'mixamorigRightForeArm', 'Skeleton_arm_joint_R__2_'],
  hipL:      ['LeftUpLeg', 'upper_leg_L', 'upper_leg.L', 'thigh_L', 'thigh.L', 'mixamorigLeftUpLeg', 'leg_joint_L_1'],
  hipR:      ['RightUpLeg', 'upper_leg_R', 'upper_leg.R', 'thigh_R', 'thigh.R', 'mixamorigRightUpLeg', 'leg_joint_R_1'],
  kneeL:     ['LeftLeg', 'lower_leg_L', 'lower_leg.L', 'shin_L', 'shin.L', 'mixamorigLeftLeg', 'leg_joint_L_2'],
  kneeR:     ['RightLeg', 'lower_leg_R', 'lower_leg.R', 'shin_R', 'shin.R', 'mixamorigRightLeg', 'leg_joint_R_2'],
  wristL:    ['LeftHand', 'hand_L', 'hand.L', 'mixamorigLeftHand', 'Skeleton_arm_joint_L__2_'],
  wristR:    ['RightHand', 'hand_R', 'hand.R', 'mixamorigRightHand', 'Skeleton_arm_joint_R__3_'],
  ankleL:    ['LeftFoot', 'foot_L', 'foot.L', 'mixamorigLeftFoot', 'leg_joint_L_3'],
  ankleR:    ['RightFoot', 'foot_R', 'foot.R', 'mixamorigRightFoot', 'leg_joint_R_3'],
};

/** 骨名归一化 —— 去掉大小写与分隔符差异('mixamorig:LeftArm' / 'hand.L'
 *  / 'arm_L' 全部拉平),不同导出器的命名就都能对上。 */
function normalizeBoneName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findBoneInScene(root: THREE.Object3D, candidates: string[]): THREE.Bone | null {
  // pass 1: exact match
  for (const name of candidates) {
    let hit: THREE.Bone | null = null;
    root.traverse((obj) => {
      if (hit) return;
      if ((obj as THREE.Bone).isBone && obj.name === name) hit = obj as THREE.Bone;
    });
    if (hit) return hit;
  }
  // pass 2: 归一化后的 includes 匹配。按候选优先级逐个找(不是按骨骼顺序),
  // 否则 'LeftShoulder'(锁骨)会先于 'LeftArm'(上臂)命中,肩关节接错骨头。
  for (const cand of candidates) {
    const c = normalizeBoneName(cand);
    let hit: THREE.Bone | null = null;
    root.traverse((obj) => {
      if (hit) return;
      if ((obj as THREE.Bone).isBone && normalizeBoneName(obj.name).includes(c)) {
        hit = obj as THREE.Bone;
      }
    });
    if (hit) return hit;
  }
  return null;
}

/** ErrorBoundary 包 SkinnedMannequin —— GLB 加载就算最后一步出问题
 *  (网络中断 / 文件损坏 / glTF schema 不兼容), 也不让整个 overlay
 *  whitescreen. 出错时静默回退到 procedural Mannequin. */
class GLBErrorBoundary extends React.Component<
  { fallback: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: React.ReactNode; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: unknown) {
    console.warn('[DirectorStage] GLB load failed, falling back to procedural mannequin:', err);
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

const SkinnedMannequin = forwardRef<THREE.Group, {
  actor: ActorTransform;
  selected: boolean;
  onSelect: (id: string, obj: THREE.Object3D) => void;
  labelScale?: number;
}>(function SkinnedMannequin({ actor, selected, onSelect, labelScale = 1 }, ref) {
  const bt = bodyTypeOf(actor.assetId);
  // useGLTF 会 Suspense, 调用方需要在 <Suspense> 里包.
  const { scene } = useGLTF(bt.glbUrl);
  const bodyColor = actor.color || bt.defaultColor;
  // 每个 actor 独立一份 clone, 避免共享 skeleton 一动全动.
  const cloned = useMemo(() => {
    const c = cloneSkeleton(scene);
    const deepColor = shadeColor(bodyColor, -0.35);
    c.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        // 骨骼大幅摆姿势后包围盒会失真,禁用视锥剔除防止模型被误裁掉。
        mesh.frustumCulled = false;
        // 统一雕塑灰材质(参考色调)——覆盖模型自带配色(xbot 是肤色),
        // 关节件压深一档,和程序化素体一个观感;actor.color 也因此生效。
        const isJoint = /joint/i.test(mesh.name) || /joint/i.test((mesh.material as THREE.Material)?.name ?? '');
        mesh.material = new THREE.MeshStandardMaterial({
          color: isJoint ? deepColor : bodyColor,
          roughness: isJoint ? 0.5 : 0.58,
          metalness: 0.05,
        });
      }
    });
    return c;
  }, [scene, bodyColor]);
  const bones = useMemo(() => {
    // 连 rest 姿态一起存:骨骼在绑定姿态下自带旋转(这套素体的臂骨 rest rx≈-π),
    // 姿势必须做成 rest + 偏移的加性应用,直接覆盖会把模型拧碎.
    const map: Partial<Record<keyof ActorPose, { bone: THREE.Bone; rest: THREE.Euler }>> = {};
    for (const key of Object.keys(BONE_NAME_PATTERNS) as Array<keyof Required<ActorPose>>) {
      const bone = findBoneInScene(cloned, BONE_NAME_PATTERNS[key]);
      if (bone) map[key] = { bone, rest: bone.rotation.clone() };
    }
    return map;
  }, [cloned]);

  const groupRef = useRef<THREE.Group>(null!);
  const setRef = useCallback((g: THREE.Group | null) => {
    groupRef.current = g!;
    if (typeof ref === 'function') ref(g);
    else if (ref) (ref as React.MutableRefObject<THREE.Group | null>).current = g;
  }, [ref]);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (groupRef.current) onSelect(actor.id, groupRef.current);
  };

  // 每帧把 actor.pose 应用到 bone.rotation. 注意:不同 rig 的 bone 本地
  // 坐标系不一致, 这里直接 Euler 赋值, 用户用同一套滑杆就能微调.
  useFrame(() => {
    const p = { ...DEFAULT_POSE, ...(actor.pose ?? {}) };
    for (const key of Object.keys(BONE_NAME_PATTERNS) as Array<keyof Required<ActorPose>>) {
      const entry = bones[key];
      const r = p[key];
      if (entry && r) {
        entry.bone.rotation.set(entry.rest.x + r[0], entry.rest.y + r[1], entry.rest.z + r[2]);
      }
    }
  });

  const finalRotation: [number, number, number] = actor.rotation ?? [0, actor.rotationY, 0];
  const finalScale: [number, number, number] = actor.scaleXYZ ?? [actor.scale, actor.scale, actor.scale];

  return (
    <group
      ref={setRef}
      name={`stage-actor-${actor.id}`}
      position={actor.position}
      rotation={finalRotation}
      scale={[finalScale[0] * bt.widthMul, finalScale[1] * bt.heightMul, finalScale[2] * bt.widthMul]}
      onClick={handleClick}
    >
      <primitive object={cloned} />

      {/* 脚下指示圈 —— 跟 procedural 版同款, 选中态加粗 */}
      <mesh position={[0, 0.001, 0]} rotation={[-PI / 2, 0, 0]}>
        <ringGeometry args={selected ? [0.18, 0.24, 32] : [0.18, 0.21, 32]} />
        <meshBasicMaterial
          color={selected ? '#c4b5fd' : '#a78bfa'}
          transparent
          opacity={selected ? 0.85 : 0.4}
          side={THREE.DoubleSide}
        />
      </mesh>
      <Billboard text={actor.label} position={[0, 1.95, 0]} scale={labelScale} />
    </group>
  );
});

/** 文字浮标 —— 永远朝向相机. scale ≤ 0 表示隐藏(标签设置里的开关/字号都走它). */
function Billboard({ text, position, scale = 1 }: { text: string; position: [number, number, number]; scale?: number }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.fillStyle = '#f0f0f0';
    ctx.font = '600 28px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [text]);
  if (scale <= 0) return null;
  return (
    <sprite position={position} scale={[0.45 * scale, 0.11 * scale, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

/** 场景里的相机标记物 —— 相机外形,可点选,可 TransformControls 拖.
 *  所有机位常显(参考:主视口是自由编辑视角);活跃机位紫色、其余琥珀色. */
const CameraMarker = forwardRef<THREE.Group, {
  camera: CameraSpec;
  isActive: boolean;
  selected: boolean;
  onSelect: (id: string, obj: THREE.Object3D) => void;
  /** 标签浮标缩放(≤0 隐藏)。 */
  labelScale?: number;
  /** 机位参考线 —— 画出到 lookAt 距离处的视锥框线。 */
  showGuide?: boolean;
}>(function CameraMarker({ camera: cam, isActive, selected, onSelect, labelScale = 1, showGuide = false }, ref) {
  const gRef = useRef<THREE.Group>(null!);
  const setRef = useCallback((g: THREE.Group | null) => {
    gRef.current = g!;
    if (typeof ref === 'function') ref(g);
    else if (ref) (ref as React.MutableRefObject<THREE.Group | null>).current = g;
  }, [ref]);

  // 计算朝向 —— 让相机外形面对 lookAt.
  useEffect(() => {
    if (!gRef.current) return;
    const target = new THREE.Vector3(...cam.lookAt);
    gRef.current.lookAt(target);
  }, [cam.lookAt]);

  // 视锥参考线:原点 → lookAt 距离处按 fov/aspect 张开的取景框 4 角 + 框线。
  // group 已经 lookAt 对准目标(本地 +Z 朝向 lookAt),在本地系里画即可。
  // 2026-07:活跃机位也渲染标记(主视口是自由编辑视角,不再"透过"机位看),
  // 用紫色调与普通机位(琥珀色)区分。
  // 主视口贴得太近(点击机位切换视角会飞进机位)时隐藏标记,否则视口
  // 卡在标记模型内部一片黑。直接改 group.visible,不走 React 重渲染。
  const proximityTmp = useRef(new THREE.Vector3());
  useFrame(({ camera: viewCam }) => {
    if (!gRef.current) return;
    const d = viewCam.position.distanceTo(proximityTmp.current.set(cam.position[0], cam.position[1], cam.position[2]));
    gRef.current.visible = d > 0.65;
  });

  const guideGeom = useMemo(() => {
    if (!showGuide) return null;
    const d = Math.max(0.2, new THREE.Vector3(...cam.lookAt).distanceTo(new THREE.Vector3(...cam.position)));
    const hh = Math.tan((cam.fov * PI) / 360) * d;
    const [aw, ah] = aspectRatioWH(cam.aspect);
    const hw = hh * (aw / ah);
    const corners: Array<[number, number, number]> = [
      [-hw, -hh, d], [hw, -hh, d], [hw, hh, d], [-hw, hh, d],
    ];
    const pts: number[] = [];
    for (const c of corners) pts.push(0, 0, 0, ...c);
    for (let i = 0; i < 4; i++) pts.push(...corners[i], ...corners[(i + 1) % 4]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [showGuide, cam.fov, cam.aspect, cam.lookAt, cam.position]);
  useEffect(() => () => { guideGeom?.dispose(); }, [guideGeom]);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (gRef.current) onSelect(cam.id, gRef.current);
  };

  const bodyColor = selected ? '#fcd34d' : isActive ? '#a78bfa' : '#f59e0b';
  const bodyEmissive = selected ? '#fde68a' : isActive ? '#8b5cf6' : '#f59e0b';

  return (
    <group ref={setRef} name={`stage-camera-${cam.id}`} position={cam.position} onClick={handleClick}>
      {/* 主体外壳 */}
      <mesh castShadow>
        <boxGeometry args={[0.22, 0.18, 0.3]} />
        <meshStandardMaterial
          color={bodyColor}
          emissive={bodyEmissive}
          emissiveIntensity={selected ? 0.4 : 0.2}
          roughness={0.5}
        />
      </mesh>
      {/* 镜头 */}
      <mesh position={[0, 0, 0.2]} rotation={[PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.07, 0.085, 0.1, 16]} />
        <meshStandardMaterial color="#1a1d22" roughness={0.3} metalness={0.6} />
      </mesh>
      {/* 顶部小棱角 (取景器) */}
      <mesh position={[0, 0.12, -0.04]} castShadow>
        <boxGeometry args={[0.08, 0.06, 0.08]} />
        <meshStandardMaterial color="#1a1d22" roughness={0.5} />
      </mesh>
      {/* 机位参考线(标签设置里开关) */}
      {guideGeom ? (
        <lineSegments geometry={guideGeom}>
          <lineBasicMaterial color="#f59e0b" transparent opacity={0.35} depthWrite={false} />
        </lineSegments>
      ) : null}
      {/* 标签 */}
      <Billboard text={cam.label} position={[0, 0.3, 0]} scale={labelScale} />
    </group>
  );
});

/** 站位参考层 —— AI识图导入的图片半透明平铺在地面,辅助按图摆位。
 *  raycast 关闭:不挡实体点选。 */
type ReferenceLayer = { image: string; width: number; height: number; timestamp: number };
function ReferenceLayerPlane({ layer }: { layer: ReferenceLayer }) {
  const texture = useMemo(() => {
    const tex = new THREE.TextureLoader().load(layer.image);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, [layer.image]);
  useEffect(() => () => { texture.dispose(); }, [texture]);
  const long = 10;
  const ar = layer.width > 0 && layer.height > 0 ? layer.width / layer.height : 16 / 9;
  const w = ar >= 1 ? long : long * ar;
  const h = ar >= 1 ? long / ar : long;
  return (
    <mesh rotation={[-PI / 2, 0, 0]} position={[0, 0.004, 0]} raycast={() => null}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={texture} transparent opacity={0.55} depthWrite={false} />
    </mesh>
  );
}

/** 参考快捷键方案:WASD 平移 + E/Q 升降 + Shift 加速(按住持续移动),
 *  以及鼠标键位配置 —— 左键只做选中,右键/中键拖拽环视。 */
function FlyBridge({ keysRef, controlsRef }: {
  keysRef: React.MutableRefObject<Set<string>>;
  controlsRef: React.MutableRefObject<any>;
}) {
  useEffect(() => {
    const cc = controlsRef.current;
    if (!cc) return;
    const ACTION = (cc.constructor as { ACTION?: Record<string, number> }).ACTION;
    if (!ACTION) return;
    cc.mouseButtons.left = ACTION.NONE;
    cc.mouseButtons.right = ACTION.ROTATE;
    cc.mouseButtons.middle = ACTION.ROTATE;
  }, [controlsRef]);
  useFrame((_, dt) => {
    const cc = controlsRef.current;
    const k = keysRef.current;
    if (!cc || k.size === 0) return;
    const sp = (k.has('shift') ? 9 : 3) * Math.min(dt, 0.1);
    if (k.has('w')) cc.forward(sp, false);
    if (k.has('s')) cc.forward(-sp, false);
    if (k.has('a')) cc.truck(-sp, 0, false);
    if (k.has('d')) cc.truck(sp, 0, false);
    if (k.has('e')) cc.elevate(sp, false);
    if (k.has('q')) cc.elevate(-sp, false);
  });
  return null;
}

/** 把 three 场景根暴露给 Canvas 外的 UI（大纲面板按名字找 Object3D 选中）. */
function SceneBridge({ sceneRef }: { sceneRef: React.MutableRefObject<THREE.Scene | null> }) {
  const { scene, advance } = useThree();
  useEffect(() => {
    sceneRef.current = scene;
    if (import.meta.env.DEV) {
      // E2E 探针:隐藏页面里 rAF 挂起、帧循环不跑,测试脚本用 __stageAdvance
      // 手动推一帧(useFrame 订阅会同步执行)。生产构建下两者都不存在。
      const w = window as unknown as Record<string, unknown>;
      w.__stageScene = scene;
      w.__stageAdvance = (t: number) => advance(t, true);
    }
    return () => { sceneRef.current = null; };
  }, [scene, sceneRef, advance]);
  useFrame(() => {
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, number>;
      w.__stageFrames = (w.__stageFrames ?? 0) + 1;
    }
  });
  return null;
}

/** 把 r3f 内部的 toDataURL 暴露给 overlay 外部.
 *  - `singleRef` 当前主视口截一帧 (用于"应用到机位" / 关闭时的封面快照)
 *  - `specRef`   按 CameraSpec 离屏出图:同步把画布缓冲改成目标比例尺寸 →
 *    用独立 PerspectiveCamera(支持荷兰角 roll)渲染 → toDataURL → 恢复主视口.
 *    整个过程在同一个任务里完成,中间没有 paint,主视口不会闪也不会被拽走.
 *  - `multiRef`  逐机位调 specRef,导出图比例 = 各机位自己的 aspect. */
function CaptureBridge({
  singleRef,
  multiRef,
  specRef,
}: {
  singleRef: React.MutableRefObject<CaptureFn | null>;
  multiRef: React.MutableRefObject<MultiCaptureFn | null>;
  specRef: React.MutableRefObject<SpecCaptureFn | null>;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const tempCam = new THREE.PerspectiveCamera();
    singleRef.current = () => {
      gl.render(scene, camera);
      try {
        return gl.domElement.toDataURL('image/png');
      } catch (err) {
        console.error('[DirectorStage] capture failed', err);
        return null;
      }
    };
    const renderSpec: SpecCaptureFn = (cam, opts) => {
      const longSide = opts?.longSide ?? 1280;
      const [aw, ah] = aspectRatioWH(cam.aspect);
      const w = aw >= ah ? longSide : Math.max(2, Math.round((longSide * aw) / ah));
      const h = aw >= ah ? Math.max(2, Math.round((longSide * ah) / aw)) : longSide;
      const prevSize = new THREE.Vector2();
      gl.getSize(prevSize);
      const prevPixelRatio = gl.getPixelRatio();
      // 机位视角出图时隐藏所有机位标记 —— 临时相机就在自己标记盒的中心,
      // 不隐藏的话整张图都是盒子内壁(全黑);其他机位的标记/参考线也不该
      // 出现在成片里。
      const hiddenMarkers: THREE.Object3D[] = [];
      scene.traverse((o) => {
        if (o.name && o.name.startsWith('stage-camera-') && o.visible) {
          o.visible = false;
          hiddenMarkers.push(o);
        }
      });
      try {
        // updateStyle=false:只换 drawing buffer,CSS 尺寸不变 → 布局不动。
        gl.setPixelRatio(1);
        gl.setSize(w, h, false);
        tempCam.position.set(cam.position[0], cam.position[1], cam.position[2]);
        tempCam.up.set(0, 1, 0);
        tempCam.lookAt(cam.lookAt[0], cam.lookAt[1], cam.lookAt[2]);
        if (cam.roll) tempCam.rotateZ(cam.roll);
        tempCam.fov = cam.fov;
        tempCam.aspect = w / h;
        tempCam.near = 0.05;
        tempCam.far = 200;
        tempCam.updateProjectionMatrix();
        tempCam.updateMatrixWorld();
        gl.render(scene, tempCam);
        return gl.domElement.toDataURL('image/png');
      } catch (err) {
        console.error('[DirectorStage] spec capture failed for', cam.id, err);
        return null;
      } finally {
        hiddenMarkers.forEach((o) => { o.visible = true; });
        gl.setPixelRatio(prevPixelRatio);
        gl.setSize(prevSize.x, prevSize.y, false);
        // 立刻把主视口画回来,下一次 paint 不会闪机位画面。
        gl.render(scene, camera);
      }
    };
    specRef.current = renderSpec;
    multiRef.current = async (cams: CameraSpec[]) => {
      const results: Record<string, string> = {};
      for (const cam of cams) {
        // 1600 长边:构图预览是全面屏大卡,1280 在 2x 屏上会发虚。
        const img = renderSpec(cam, { longSide: 1600 });
        if (img) results[cam.id] = img;
      }
      return results;
    };
    return () => {
      singleRef.current = null;
      multiRef.current = null;
      specRef.current = null;
    };
  }, [gl, scene, camera, singleRef, multiRef, specRef]);

  return null;
}

export function DirectorStageOverlay() {
  const nodeId = useStore((s) => s.directorStageNodeId);
  const close = useStore((s) => s.closeDirectorStage);
  const nodes = useStore((s) => s.nodes);
  const updateNodeData = useStore((s) => s.updateNodeData);
  const language = useStore((s) => s.language);

  const node = useMemo(() => nodes.find((n) => n.id === nodeId), [nodes, nodeId]);
  const data = (node?.data ?? {}) as DirectorStageData;

  // 演员状态.
  const [actors, setActors] = useState<ActorTransform[]>(() => {
    if (data.characters && data.characters.length > 0) return data.characters as ActorTransform[];
    return [DEFAULT_ACTOR];
  });

  // 机位状态.
  const [cameras, setCameras] = useState<CameraSpec[]>(() => {
    if (data.cameras && data.cameras.length > 0) return data.cameras as CameraSpec[];
    return [DEFAULT_CAMERA];
  });
  const [activeCameraId, setActiveCameraId] = useState<string>(
    () => data.activeCameraId ?? cameras[0]?.id ?? 'cam-1',
  );

  // 道具状态（持久化字段 data.props 之前只是类型占位，这里正式接通）.
  const [stageProps, setStageProps] = useState<PropTransform[]>(() => {
    if (data.props && data.props.length > 0) {
      return (data.props as Array<Record<string, unknown>>).map((p, i) => {
        const seed = p as unknown as PropTransform;
        return {
          ...seed,
          id: String(p.id ?? `prop-seed-${i}`),
          // 老数据没有 label 字段 —— 用资产定义的中文名回填.
          label: seed.label ?? propDefOf(String(p.assetId ?? 'rock')).zh,
        };
      });
    }
    return [];
  });

  // 左上面板（大纲 / 资产库，互斥）与左下帮助指南.
  const [sidePanel, setSidePanel] = useState<'outline' | 'assets' | null>(null);
  const [assetTab, setAssetTab] = useState<'props' | 'actors' | 'cameras'>('props');
  const [assetQuery, setAssetQuery] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);

  // 舞台环境设置(全景背景 / 标签) + 底栏弹层。老节点没有 stageSettings,
  // 用默认值补齐;关闭和确认构图时都会落盘。
  const [stageSettings, setStageSettings] = useState<StageSettings>(() => ({
    ...DEFAULT_STAGE_SETTINGS,
    ...((data as { stageSettings?: Partial<StageSettings> }).stageSettings ?? {}),
  }));
  const patchStageSettings = useCallback((p: Partial<StageSettings>) => {
    setStageSettings((s) => ({ ...s, ...p }));
  }, []);
  const [envPopover, setEnvPopover] = useState<'panorama' | 'labels' | 'aspect' | null>(null);

  // AI识图:站位参考层(半透明铺地面) + 弹窗开关。
  const [refLayer, setRefLayer] = useState<ReferenceLayer | null>(
    () => (data as { referenceLayer?: ReferenceLayer | null }).referenceLayer ?? null,
  );
  const [aiVisionOpen, setAiVisionOpen] = useState(false);

  // 选中态 (actor / camera / prop).
  const [selection, setSelection] = useState<Selection | null>(null);
  const [mode, setMode] = useState<TransformMode>('translate');
  const [presetFlash, setPresetFlash] = useState<{ camId: string } | null>(null);
  // 吸附(X 切换):开启时 Gizmo 拖动按 0.25m / 15° / 0.1 步进对齐。
  const [snapping, setSnapping] = useState(false);

  // 两段式确认构图状态:
  //   idle    —— 显示"确认构图"按钮,点击后变 armed.
  //   armed   —— 已经把当前视图应用到活跃机位,弹底部提示;再点一次才真正派生节点.
  //   capturing —— 正在逐机位渲染 + 派生 compositionPreviewNode.
  // 设计参照 neowow:第一次点确认其实只是"锁定视角",第二次才出图.
  const [confirmStage, setConfirmStage] = useState<'idle' | 'armed' | 'capturing'>('idle');
  const armedTimerRef = useRef<number | null>(null);

  // GLB 资产探测 —— 启动时 HEAD 一下 public/mannequins/*.glb, 命中的体型
  // 走 SkinnedMannequin (真模型), 没命中的回落 procedural 版.
  //
  // 坑:Vite dev server 在 public/ 找不到文件时, **不返回 404, 而是返回
  // index.html (SPA fallback)**, status 也是 200. 单看 r.ok 会误判.
  // 修正:同时检查 content-type 不是 text/html, 再 GET 头 4 字节判 glTF
  // magic ("glTF" = 0x676c5446). 双保险.
  const [glbAvailable, setGlbAvailable] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!USE_SKINNED_GLB) return; // GLB 素体停用时连探测都省了.
    const urls = Array.from(new Set(Object.values(BODY_TYPES).map((b) => b.glbUrl).filter(Boolean)));
    let cancelled = false;
    Promise.all(urls.map(async (url) => {
      try {
        // 1) HEAD —— 看 status + content-type.
        const head = await fetch(url, { method: 'HEAD' });
        if (!head.ok) return [url, false] as const;
        const ct = (head.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/html')) return [url, false] as const;
        // 2) GET 前 8 字节验 GLB magic. GLB 文件以 ASCII "glTF" 起头.
        const probe = await fetch(url, { headers: { Range: 'bytes=0-7' } });
        if (!probe.ok && probe.status !== 206) return [url, false] as const;
        const buf = await probe.arrayBuffer();
        const view = new DataView(buf);
        // 0x676C5446 = ASCII "glTF" (big-endian read).
        const isGLB = buf.byteLength >= 4 && view.getUint32(0, false) === 0x676C5446;
        return [url, isGLB] as const;
      } catch {
        return [url, false] as const;
      }
    })).then((results) => {
      if (cancelled) return;
      const next: Record<string, boolean> = {};
      for (const [url, ok] of results) next[url] = ok;
      setGlbAvailable(next);
    });
    return () => { cancelled = true; };
  }, []);

  // refs
  const cameraControlsRef = useRef<any>(null);
  const transformControlsRef = useRef<any>(null);
  const captureRef = useRef<CaptureFn | null>(null);
  const multiCaptureRef = useRef<MultiCaptureFn | null>(null);
  const specCaptureRef = useRef<SpecCaptureFn | null>(null);

  const [capturing, setCapturing] = useState(false);

  // 派生节点 / 连线需要 store 的写口.
  const addNode = useStore((s) => s.addNode);
  const onConnect = useStore((s) => s.onConnect);

  const activeCamera = useMemo(() => cameras.find((c) => c.id === activeCameraId) ?? cameras[0], [cameras, activeCameraId]);
  const selectedActor = selection?.kind === 'actor' ? actors.find((a) => a.id === selection.id) : null;
  const selectedCamera = selection?.kind === 'camera' ? cameras.find((c) => c.id === selection.id) : null;

  /** ====== Selection helpers ====== */

  const onSelectActor = useCallback((id: string, obj: THREE.Object3D) => {
    setSelection({ kind: 'actor', id, obj });
  }, []);

  const onSelectCamera = useCallback((id: string, obj: THREE.Object3D) => {
    setSelection({ kind: 'camera', id, obj });
  }, []);

  const onSelectProp = useCallback((id: string, obj: THREE.Object3D) => {
    setSelection({ kind: 'prop', id, obj });
  }, []);

  const onDeselect = useCallback(() => setSelection(null), []);

  /** 大纲面板按 id 选中 —— UI 在 Canvas 外拿不到 Object3D，走场景名字查找
   *  （所有实体的根 group 都挂了 stage-{kind}-{id} 名）。 */
  const sceneRootRef = useRef<THREE.Scene | null>(null);
  const selectFromOutline = useCallback((kind: SelectionKind, id: string) => {
    const scene = sceneRootRef.current;
    const obj = scene?.getObjectByName(`stage-${kind}-${id}`) ?? null;
    if (obj) setSelection({ kind, id, obj });
  }, []);

  /** ====== Actor management ====== */

  const addActorOfType = useCallback((assetId: string) => {
    setActors((prev) => {
      const nextIndex = prev.length + 1;
      const labelChar = nextIndex <= 26 ? String.fromCharCode(64 + nextIndex) : null;
      const label = labelChar ? `角色${labelChar}` : `Actor-${nextIndex}`;
      const offsetX = (prev.length % 4) * 0.8 - 1.2;
      const offsetZ = Math.floor(prev.length / 4) * 0.8;
      const newActor: ActorTransform = {
        id: `actor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        assetId,
        label,
        position: [offsetX, 0, offsetZ],
        rotationY: 0,
        scale: 1,
        // 新演员默认自然站立（双臂垂在身侧），不再是 T-pose —— 动作合理优先.
        pose: { ...DEFAULT_POSE, ...POSE_PRESETS['站立'] },
      };
      return [...prev, newActor];
    });
  }, []);

  const addActor = useCallback(() => addActorOfType('mannequin-standard'), [addActorOfType]);

  /** 群众阵列 —— 一排 n 个标准素体，间距 0.7m，居中摆在原点前方. */
  const addCrowd = useCallback((count: number) => {
    setActors((prev) => {
      const base = prev.length;
      const stamp = Date.now();
      const row: ActorTransform[] = Array.from({ length: count }, (_, i) => ({
        id: `actor-${stamp}-${i}-${Math.random().toString(36).slice(2, 4)}`,
        assetId: 'mannequin-standard',
        label: `群众${base + i + 1}`,
        position: [(i - (count - 1) / 2) * 0.7, 0, 1.6 + Math.floor(base / 6) * 0.8],
        rotationY: 0,
        scale: 1,
        pose: { ...DEFAULT_POSE, ...POSE_PRESETS['站立'] },
      }));
      return [...prev, ...row];
    });
  }, []);

  /** ====== Prop management ====== */

  const addProp = useCallback((assetId: string) => {
    setStageProps((prev) => {
      const def = propDefOf(assetId);
      const sameKind = prev.filter((p) => p.assetId === assetId).length;
      const idx = prev.length;
      const newProp: PropTransform = {
        id: `prop-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        assetId,
        label: sameKind > 0 ? `${def.zh}${sameKind + 1}` : def.zh,
        // 环形错位摆放，避免连点几次全部叠在原点.
        position: [1.6 + (idx % 3) * 0.9, 0, -0.6 - Math.floor(idx / 3) * 0.9],
        rotationY: 0,
        scale: 1,
      };
      return [...prev, newProp];
    });
  }, []);

  const removeProp = useCallback((id: string) => {
    setStageProps((prev) => prev.filter((p) => p.id !== id));
    setSelection((cur) => (cur?.kind === 'prop' && cur.id === id ? null : cur));
  }, []);

  const removeActor = useCallback((id: string) => {
    setActors((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((a) => a.id !== id);
    });
    setSelection((cur) => (cur?.kind === 'actor' && cur.id === id ? null : cur));
  }, []);

  const updateActorPose = useCallback((actorId: string, patch: Partial<ActorPose>) => {
    setActors((prev) => prev.map((a) => a.id === actorId ? {
      ...a,
      pose: { ...DEFAULT_POSE, ...(a.pose ?? {}), ...patch },
    } : a));
  }, []);

  /** 属性面板通用 patcher —— 名称 / 位置 / 旋转 / 缩放 / 体型 / 颜色
   *  都走这里. 切换体型时如果用户没显式选过 color,把 color 也清掉让
   *  Mannequin 用新体型的默认色. */
  const updateActor = useCallback((actorId: string, patch: Partial<ActorTransform>) => {
    setActors((prev) => prev.map((a) => {
      if (a.id !== actorId) return a;
      const next: ActorTransform = { ...a, ...patch };
      // 兼容:有 rotation 时把 rotationY 同步, 反之亦然.
      if (patch.rotation) next.rotationY = patch.rotation[1];
      if (typeof patch.rotationY === 'number' && !patch.rotation) {
        next.rotation = [next.rotation?.[0] ?? 0, patch.rotationY, next.rotation?.[2] ?? 0];
      }
      // scale (uniform) ↔ scaleXYZ 同步.
      if (patch.scaleXYZ) next.scale = patch.scaleXYZ[0];
      if (typeof patch.scale === 'number' && !patch.scaleXYZ) {
        next.scaleXYZ = [patch.scale, patch.scale, patch.scale];
      }
      // 切换体型自动清掉自定义 color, 让默认色刷新.
      if (patch.assetId && patch.assetId !== a.assetId && patch.color === undefined) {
        next.color = undefined;
      }
      return next;
    }));
  }, []);

  /** 复制选中演员 —— 横向偏移 0.6m,避免叠在一起. */
  const duplicateActor = useCallback((actorId: string) => {
    setActors((prev) => {
      const src = prev.find((a) => a.id === actorId);
      if (!src) return prev;
      const newActor: ActorTransform = {
        ...src,
        id: `actor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        label: `${src.label}·副`,
        position: [src.position[0] + 0.6, src.position[1], src.position[2]],
      };
      return [...prev, newActor];
    });
  }, []);

  const applyPosePreset = useCallback((actorId: string, presetName: string) => {
    const preset = POSE_PRESETS[presetName];
    if (!preset) return;
    setActors((prev) => prev.map((a) => a.id === actorId ? {
      ...a,
      pose: { ...DEFAULT_POSE, ...preset },
    } : a));
  }, []);

  /** ====== Camera management ====== */

  const applyViewToCamera = useCallback((cameraId: string) => {
    const cc = cameraControlsRef.current;
    if (!cc) return;
    const pos = new THREE.Vector3();
    const tgt = new THREE.Vector3();
    cc.getPosition(pos);
    cc.getTarget(tgt);
    // 同步抓一张当前主视口的快照,替换这个机位旧的 previewImage.
    // captureRef 在 r3f 内部 (CaptureBridge) 已经把 toDataURL 装好,
    // 在这里同步调一次就行.
    const preview = captureRef.current?.() ?? undefined;
    setCameras((prev) => prev.map((c) => c.id === cameraId ? {
      ...c,
      position: [pos.x, pos.y, pos.z],
      lookAt: [tgt.x, tgt.y, tgt.z],
      previewImage: preview || c.previewImage,
    } : c));
    setPresetFlash({ camId: cameraId });
    setTimeout(() => setPresetFlash(null), 1200);
  }, []);

  /** 切换活跃机位:预览/出图对象切过去,主视口同时飞进该机位视角
   *  (2026-07 反馈:点击机位要切换视角)。机位标记有贴近自动隐身,
   *  飞进去不会黑屏。 */
  const switchToCamera = useCallback((id: string) => {
    setActiveCameraId(id);
    const cam = cameras.find((c) => c.id === id);
    const cc = cameraControlsRef.current;
    if (cam && cc) {
      cc.setLookAt(
        cam.position[0], cam.position[1], cam.position[2],
        cam.lookAt[0], cam.lookAt[1], cam.lookAt[2],
        true,
      );
    }
  }, [cameras]);

  const addCameraFromCurrentView = useCallback(() => {
    const cc = cameraControlsRef.current;
    if (!cc) return;
    const pos = new THREE.Vector3();
    const tgt = new THREE.Vector3();
    cc.getPosition(pos);
    cc.getTarget(tgt);
    const nextIndex = cameras.length + 1;
    const id = `cam-${Date.now()}`;
    // 新建机位时也抓一张预览, 跟 applyViewToCamera 一致.
    const preview = captureRef.current?.() ?? undefined;
    const cam: CameraSpec = {
      id,
      label: `机位${nextIndex}`,
      position: [pos.x, pos.y, pos.z],
      lookAt: [tgt.x, tgt.y, tgt.z],
      fov: 50,
      aspect: '16:9',
      previewImage: preview,
    };
    setCameras((prev) => [...prev, cam]);
    setActiveCameraId(id);
  }, [cameras]);

  /** 机位预设(资产库·机位页签):按演员质心 + 球面参数摆一台新机位并切过去。 */
  const addCameraFromPreset = useCallback((presetId: string) => {
    const def = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!def) return;
    // 焦点 = 演员质心(x/z 平均),没有演员就取原点。
    let fx = 0;
    let fz = 0;
    if (actors.length > 0) {
      for (const a of actors) { fx += a.position[0]; fz += a.position[2]; }
      fx /= actors.length;
      fz /= actors.length;
    }
    const targetY = def.targetY ?? 1.1;
    let position: [number, number, number];
    let lookAt: [number, number, number];
    if (def.pov) {
      // POV:站在焦点人物头部,朝 +Z(人物正面)看出去。
      position = [fx, 1.55, fz + 0.15];
      lookAt = [fx, 1.45, fz + 4];
    } else {
      const az = (def.az * PI) / 180;
      const el = (def.el * PI) / 180;
      position = [
        fx + Math.sin(az) * Math.cos(el) * def.dist,
        Math.max(0.12, targetY + Math.sin(el) * def.dist),
        fz + Math.cos(az) * Math.cos(el) * def.dist,
      ];
      lookAt = [fx, targetY, fz];
    }
    const id = `cam-${Date.now()}`;
    const cam: CameraSpec = {
      id,
      label: def.zh,
      position,
      lookAt,
      fov: def.fov,
      aspect: activeCamera?.aspect ?? '16:9',
      roll: def.roll ? (def.roll * PI) / 180 : undefined,
    };
    setCameras((prev) => [...prev, cam]);
    // 设为活跃并飞进新机位视角(标记有贴近隐身,不会黑屏)。
    setActiveCameraId(id);
    cameraControlsRef.current?.setLookAt(
      position[0], position[1], position[2],
      lookAt[0], lookAt[1], lookAt[2],
      true,
    );
  }, [actors, activeCamera]);

  const removeCamera = useCallback((id: string) => {
    if (cameras.length <= 1) return;
    setCameras((prev) => prev.filter((c) => c.id !== id));
    if (activeCameraId === id) {
      const remaining = cameras.filter((c) => c.id !== id);
      if (remaining[0]) setActiveCameraId(remaining[0].id);
    }
    setSelection((cur) => (cur?.kind === 'camera' && cur.id === id ? null : cur));
  }, [cameras, activeCameraId]);

  const setActiveCameraAspect = useCallback((aspect: AspectRatio) => {
    setCameras((prev) => prev.map((c) => c.id === activeCameraId ? { ...c, aspect } : c));
  }, [activeCameraId]);

  const setActiveCameraFov = useCallback((fov: number) => {
    setCameras((prev) => prev.map((c) => c.id === activeCameraId ? { ...c, fov } : c));
  }, [activeCameraId]);

  /** ====== TransformControls integration ====== */

  /** 拖完 gizmo 后把 three.js 对象的 transform 回写到 React state. */
  const persistSelectedTransform = useCallback(() => {
    if (!selection) return;
    const { kind, id, obj } = selection;
    if (kind === 'actor') {
      setActors((prev) => prev.map((a) => a.id === id ? {
        ...a,
        position: [obj.position.x, obj.position.y, obj.position.z],
        rotationY: obj.rotation.y,
        scale: obj.scale.x,
      } : a));
    } else if (kind === 'camera') {
      // 相机标记物只调位置 (lookAt 通过 "应用视图到机位" 单独流程更新).
      setCameras((prev) => prev.map((c) => c.id === id ? {
        ...c,
        position: [obj.position.x, obj.position.y, obj.position.z],
      } : c));
    } else if (kind === 'prop') {
      setStageProps((prev) => prev.map((p) => p.id === id ? {
        ...p,
        position: [obj.position.x, obj.position.y, obj.position.z],
        rotationY: obj.rotation.y,
        rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
        scale: obj.scale.x,
        scaleXYZ: [obj.scale.x, obj.scale.y, obj.scale.z],
      } : p));
    }
  }, [selection]);

  /** 拖 gizmo 时关 CameraControls 避免抢拖拽事件. */
  useEffect(() => {
    const tc = transformControlsRef.current;
    if (!tc || !selection) return;
    const onDraggingChanged = (e: { value: boolean }) => {
      const cc = cameraControlsRef.current;
      if (cc) cc.enabled = !e.value;
      if (!e.value) persistSelectedTransform();
    };
    tc.addEventListener('dragging-changed', onDraggingChanged);
    return () => tc.removeEventListener('dragging-changed', onDraggingChanged);
  }, [selection, persistSelectedTransform]);

  /** ====== View restoration / reset ====== */

  const isCameraStateHealthy = (pos: [number, number, number], lookAt: [number, number, number]) => {
    const allFinite = [...pos, ...lookAt].every((n) => Number.isFinite(n));
    if (!allFinite) return false;
    const dx = pos[0] - lookAt[0], dy = pos[1] - lookAt[1], dz = pos[2] - lookAt[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.01) return false;
    const camDist = Math.sqrt(pos[0] * pos[0] + pos[1] * pos[1] + pos[2] * pos[2]);
    if (camDist > 500) return false;
    return true;
  };

  const resetView = useCallback(() => {
    const cc = cameraControlsRef.current;
    if (!cc) return;
    cc.setLookAt(
      EDITOR_HOME.position[0], EDITOR_HOME.position[1], EDITOR_HOME.position[2],
      EDITOR_HOME.lookAt[0], EDITOR_HOME.lookAt[1], EDITOR_HOME.lookAt[2],
      true,
    );
  }, []);

  /** ====== 舞台编辑撤销 / 重做 ======
   *  快照 = { 演员, 道具, 机位, 活跃机位 }。状态变化 350ms 防抖入栈
   *  (滑杆连续拖动合并成一步),undo/redo 应用时跳过入栈。 */
  type StageSnapshot = {
    actors: ActorTransform[];
    stageProps: PropTransform[];
    cameras: CameraSpec[];
    activeCameraId: string;
  };
  const historyRef = useRef<{ past: StageSnapshot[]; future: StageSnapshot[] }>({ past: [], future: [] });
  const presentRef = useRef<StageSnapshot | null>(null);
  const applyingHistoryRef = useRef(false);
  const [historyVersion, setHistoryVersion] = useState(0);

  useEffect(() => {
    if (!nodeId) return;
    const cur: StageSnapshot = { actors, stageProps, cameras, activeCameraId };
    if (applyingHistoryRef.current) {
      applyingHistoryRef.current = false;
      presentRef.current = cur;
      return;
    }
    const t = window.setTimeout(() => {
      if (presentRef.current) {
        historyRef.current.past.push(presentRef.current);
        if (historyRef.current.past.length > 50) historyRef.current.past.shift();
        historyRef.current.future = [];
      }
      presentRef.current = cur;
      setHistoryVersion((v) => v + 1);
    }, 350);
    return () => window.clearTimeout(t);
  }, [nodeId, actors, stageProps, cameras, activeCameraId]);

  const applySnapshot = useCallback((snap: StageSnapshot) => {
    applyingHistoryRef.current = true;
    setActors(snap.actors);
    setStageProps(snap.stageProps);
    setCameras(snap.cameras);
    setActiveCameraId(snap.activeCameraId);
    setSelection(null); // 快照里可能没有当前选中的实体,直接清选
    setHistoryVersion((v) => v + 1);
  }, []);

  const undoStage = useCallback(() => {
    const h = historyRef.current;
    const prev = h.past.pop();
    if (!prev || !presentRef.current) return;
    h.future.push(presentRef.current);
    presentRef.current = prev;
    applySnapshot(prev);
  }, [applySnapshot]);

  const redoStage = useCallback(() => {
    const h = historyRef.current;
    const next = h.future.pop();
    if (!next || !presentRef.current) return;
    h.past.push(presentRef.current);
    presentRef.current = next;
    applySnapshot(next);
  }, [applySnapshot]);

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;
  void historyVersion; // 只为触发重渲染刷新 canUndo/canRedo

  /** 俯视(T) / 正面(Y) —— 参考的视角快切。 */
  const viewTop = useCallback(() => {
    cameraControlsRef.current?.setLookAt(0, 14, 0.02, 0, 0, 0, true);
  }, []);
  const viewFront = useCallback(() => {
    cameraControlsRef.current?.setLookAt(0, 1.3, 9, 0, 1.1, 0, true);
  }, []);

  /** 主视口焦距([ / ] 调整,顶栏实时显示,参考快捷键方案)。 */
  const [mainFov, setMainFov] = useState(50);
  const adjustFov = useCallback((delta: number) => {
    setMainFov((f) => {
      const next = Math.min(120, Math.max(20, f + delta));
      const cam = cameraControlsRef.current?.camera as THREE.PerspectiveCamera | undefined;
      if (cam) {
        cam.fov = next;
        cam.updateProjectionMatrix();
      }
      return next;
    });
  }, []);

  /** F 聚焦 —— 把视口对准选中实体;没选中就回看舞台中心。 */
  const focusSelection = useCallback(() => {
    const cc = cameraControlsRef.current;
    if (!cc) return;
    if (selection?.obj) {
      void cc.fitToBox(selection.obj, true, { paddingTop: 0.5, paddingBottom: 0.3, paddingLeft: 0.6, paddingRight: 0.6 });
    } else {
      void cc.setTarget(0, 1, 0, true);
    }
  }, [selection]);

  /** WASD / E/Q / Shift 按住集合 —— FlyBridge 每帧消费。 */
  const flyKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!nodeId) return;
    const relevant = new Set(['w', 'a', 's', 'd', 'e', 'q', 'shift']);
    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (relevant.has(k)) flyKeysRef.current.add(k);
    };
    const up = (e: KeyboardEvent) => { flyKeysRef.current.delete(e.key.toLowerCase()); };
    const clear = () => flyKeysRef.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
      clear();
    };
  }, [nodeId]);

  /** 关闭(取消 / X / Esc)时落一张「退出时的镜头」快照 + 环境设置。
   *  演员/道具/机位仍然只在「确认构图」时才持久化(取消 = 放弃编辑),
   *  但节点封面和直接拉线的输出用的就是这张退出快照。 */
  const closeWithSnapshot = useCallback(() => {
    if (nodeId) {
      try {
        const snap = captureRef.current?.();
        const patch: Record<string, unknown> = { stageSettings, referenceLayer: refLayer };
        if (snap) patch.editorPreview = snap;
        updateNodeData(nodeId, patch);
      } catch (err) {
        console.warn('[DirectorStage] exit snapshot failed', err);
      }
    }
    close();
  }, [nodeId, stageSettings, refLayer, updateNodeData, close]);

  /** AI识图弹窗「生成站位参考」:把上传图设为站位参考层;覆盖模式额外
   *  重置演员/道具/机位/环境到初始态(参考弹窗里两个单选的语义)。 */
  const applyReferenceLayer = useCallback((p: { image: string; width: number; height: number; overwrite: boolean }) => {
    setRefLayer({ image: p.image, width: p.width, height: p.height, timestamp: Date.now() });
    if (p.overwrite) {
      setActors([{ ...DEFAULT_ACTOR }]);
      setStageProps([]);
      setCameras([DEFAULT_CAMERA]);
      setActiveCameraId(DEFAULT_CAMERA.id);
      setSelection(null);
      setStageSettings({ ...DEFAULT_STAGE_SETTINGS });
    }
  }, []);

  /** 右下机位面板的实时预览 —— 离屏按机位比例渲染,700ms 一帧;选中了某个
   *  机位标记就预览它,否则预览活跃机位。finalize 抓图期间暂停,避免争抢
   *  同一块 drawing buffer。 */
  const previewCam = selectedCamera ?? activeCamera;
  const [livePreview, setLivePreview] = useState<string | null>(null);
  useEffect(() => {
    if (!previewCam || capturing) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const img = specCaptureRef.current?.(previewCam, { longSide: 384 });
      if (img) setLivePreview(img);
    };
    // 等 Canvas 首帧再抓第一张,之后定时刷新。
    const t0 = window.setTimeout(tick, 80);
    const iv = window.setInterval(tick, 700);
    return () => {
      cancelled = true;
      window.clearTimeout(t0);
      window.clearInterval(iv);
    };
  }, [previewCam, capturing, stageSettings]);

  useEffect(() => {
    if (!nodeId) return;
    // 打开时用编辑器默认视角(不钻进活跃机位 —— 机位标记现在常显,
    // 与机位重合会卡在标记模型内部)。CameraControls 在 r3f 里异步挂载,
    // ref 可能还没就绪 —— 轮询到拿到为止,不能只试一次。
    const t = window.setInterval(() => {
      const cc = cameraControlsRef.current;
      if (!cc) return;
      cc.setLookAt(
        EDITOR_HOME.position[0], EDITOR_HOME.position[1], EDITOR_HOME.position[2],
        EDITOR_HOME.lookAt[0], EDITOR_HOME.lookAt[1], EDITOR_HOME.lookAt[2],
        false,
      );
      window.clearInterval(t);
    }, 60);
    return () => window.clearInterval(t);
  }, [nodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** ====== Confirm + multi-camera capture ====== */

  /** 第一次点确认:把当前主视口锁到活跃机位,屏幕底部弹提示,等用户再点
   *  一次才真正派生节点。30 秒不操作自动 disarm,避免视角变了还按旧 armed
   *  状态出图。 */
  const armConfirm = useCallback(() => {
    // 把当前视图应用到活跃机位.
    const cc = cameraControlsRef.current;
    if (cc) {
      const pos = new THREE.Vector3();
      const tgt = new THREE.Vector3();
      cc.getPosition(pos);
      cc.getTarget(tgt);
      setCameras((prev) => prev.map((c) => c.id === activeCameraId ? {
        ...c,
        position: [pos.x, pos.y, pos.z],
        lookAt: [tgt.x, tgt.y, tgt.z],
      } : c));
    }
    setConfirmStage('armed');
    if (armedTimerRef.current) window.clearTimeout(armedTimerRef.current);
    armedTimerRef.current = window.setTimeout(() => setConfirmStage('idle'), 30_000);
  }, [activeCameraId]);

  /** 第二次点确认:逐机位渲染 + 派生 compositionPreviewNode + 自动连线
   *  + 关 overlay. */
  const finalizeConfirm = useCallback(async () => {
    if (!nodeId || !node) return;
    if (armedTimerRef.current) {
      window.clearTimeout(armedTimerRef.current);
      armedTimerRef.current = null;
    }
    setConfirmStage('capturing');
    setCapturing(true);
    try {
      // 用当前主视图作为导演台节点的"封面"截图.
      let editorPreview: string | undefined;
      const single = captureRef.current?.();
      if (single) editorPreview = single;

      // 逐机位渲染.
      const captures: Record<string, string> = await (multiCaptureRef.current?.(cameras) ?? Promise.resolve({} as Record<string, string>));
      const ts = Date.now();
      const lastCaptures: Record<string, { image: string; timestamp: number }> = {};
      for (const [camId, img] of Object.entries(captures)) {
        lastCaptures[camId] = { image: img, timestamp: ts };
      }

      // 1) 把导演台自身刷成已构图态.
      const patch: Partial<DirectorStageData> = {
        status: 'done',
        characters: actors,
        props: stageProps,
        cameras,
        activeCameraId,
        editorPreview,
        lastCaptures,
        stageSettings,
        referenceLayer: refLayer,
      };
      updateNodeData(nodeId, patch as Record<string, unknown>);

      // 2) 为每个机位派生一个 compositionPreviewNode + 自动连线.
      // X 间距 280px(导演台宽 300 + 横向留白 ~280)让 bezier 曲线舒展,
      // 不再挤成一个短"S"。Y 间距 260px,留出标题 + meta 行 + 边距.
      const dirX = node.position?.x ?? 0;
      const dirY = node.position?.y ?? 0;
      const horizontalGap = 280;
      const verticalGap = 260;
      const directorWidth = 300;
      cameras.forEach((cam, idx) => {
        const img = captures[cam.id];
        if (!img) return;
        const offsetY = (idx - (cameras.length - 1) / 2) * verticalGap;
        const previewId = `comp-preview-${nodeId}-${cam.id}-${ts}`;
        addNode({
          id: previewId,
          type: 'compositionPreviewNode',
          position: { x: dirX + directorWidth + horizontalGap, y: dirY + offsetY },
          data: {
            directorNodeId: nodeId,
            cameraId: cam.id,
            cameraLabel: cam.label,
            image: img,
            timestamp: ts,
            aspect: cam.aspect,
          },
        } as never);
        onConnect({
          source: nodeId,
          sourceHandle: null,
          target: previewId,
          targetHandle: null,
        } as never);
      });
    } finally {
      setCapturing(false);
      setConfirmStage('idle');
      close();
    }
  }, [nodeId, node, updateNodeData, close, activeCameraId, actors, stageProps, cameras, stageSettings, refLayer, addNode, onConnect]);

  /** "确认构图"按钮统一入口:按当前阶段路由. */
  const onConfirm = useCallback(() => {
    if (capturing) return;
    if (confirmStage === 'armed') {
      void finalizeConfirm();
    } else {
      armConfirm();
    }
  }, [capturing, confirmStage, armConfirm, finalizeConfirm]);

  /** 关 overlay 时清理 armed 定时器,避免下次开 overlay 还在 armed. */
  useEffect(() => {
    if (!nodeId && armedTimerRef.current) {
      window.clearTimeout(armedTimerRef.current);
      armedTimerRef.current = null;
      setConfirmStage('idle');
    }
  }, [nodeId]);

  /** ====== Keyboard ====== */

  useEffect(() => {
    if (!nodeId) return;
    // 快捷键对齐参考方案:左键选中 / 右键中键环视(FlyBridge 配置),
    // WASD+E/Q+Shift 飞行(独立 keydown/keyup 集合),这里处理单发按键:
    // F 聚焦、方向键转向、[ ] 焦距、0 回原点、C 应用机位、Del/⌫ 删除、Esc。
    // W/E/S 不再切换 Gizmo 模式(与移动键冲突),模式走底部按钮。
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      // Ctrl/⌘ 组合只处理撤销重做,其余(复制/刷新等)放行浏览器默认 ——
      // 否则 Ctrl+C 会误触发「应用视图到机位」。
      if (e.ctrlKey || e.metaKey) {
        if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) redoStage();
          else undoStage();
        } else if (k === 'y') {
          e.preventDefault();
          redoStage();
        }
        return;
      }
      if (k === 'escape') {
        if (selection) onDeselect();
        else closeWithSnapshot();
        return;
      }
      if (k === 'c') { applyViewToCamera(activeCameraId); return; }
      if (k === 'f') { focusSelection(); return; }
      if (k === 'x') { setSnapping((s) => !s); return; }
      if (k === 't') { viewTop(); return; }
      if (k === 'y') { viewFront(); return; }
      if (k === '0') { resetView(); return; }
      if (k === '[' || k === ']') {
        e.preventDefault();
        adjustFov(k === '[' ? -5 : 5);
        return;
      }
      if (k.startsWith('arrow')) {
        e.preventDefault();
        const cc = cameraControlsRef.current;
        if (!cc) return;
        const step = (15 * PI) / 180;
        if (k === 'arrowleft') cc.rotate(step, 0, true);
        else if (k === 'arrowright') cc.rotate(-step, 0, true);
        else if (k === 'arrowup') cc.rotate(0, -step * 0.6, true);
        else if (k === 'arrowdown') cc.rotate(0, step * 0.6, true);
        return;
      }
      if (k === 'delete' || k === 'backspace') {
        // 没选中东西也吞掉 —— 不然事件落到画布的全局删除快捷键上,
        // 会把导演台节点本身删掉(Canvas 侧还有 directorStageNodeId 兜底)。
        e.preventDefault();
        if (!selection) return;
        if (selection.kind === 'actor') removeActor(selection.id);
        else if (selection.kind === 'camera') removeCamera(selection.id);
        else if (selection.kind === 'prop') removeProp(selection.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nodeId, selection, closeWithSnapshot, onDeselect, applyViewToCamera, activeCameraId, focusSelection, resetView, adjustFov, removeActor, removeCamera, removeProp, undoStage, redoStage, viewTop, viewFront]);

  if (!nodeId || !node) return null;

  // 标签浮标缩放:字号 18 = 1x;关掉显示标签时为 0(Billboard 直接不渲染)。
  const labelScale = stageSettings.labelsVisible ? stageSettings.labelFontSize / 18 : 0;
  // 地面透明度:把网格/轴线颜色向天空色靠拢, opacity=0 时完全融入背景。
  const groundFade = 1 - stageSettings.groundOpacity;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-[#050507]">
      {/* 3D 视口 —— 全面屏(参考):没有顶部栏,提示条 / 关闭按钮浮在视口上。 */}
      <div className="relative flex-1">
        {/* 顶部中央:快捷键提示胶囊条(浮动) */}
        <div className="pointer-events-none absolute left-1/2 top-3 z-20 hidden -translate-x-1/2 items-center gap-3 rounded-lg border border-white/10 bg-black/65 px-3.5 py-1.5 text-[12px] text-white/60 backdrop-blur-md md:flex">
          <Hint k={language === 'zh' ? '左键' : 'LMB'} v={language === 'zh' ? '选中' : 'Select'} />
          <Hint k={language === 'zh' ? '右键 / 中键拖拽' : 'RMB/MMB drag'} v={language === 'zh' ? '环视' : 'Orbit'} />
          <Hint k="WASD" v={language === 'zh' ? '移动' : 'Move'} />
          <Hint k="E / Q" v={language === 'zh' ? '升降' : 'Up / Down'} />
          <Hint k="F" v={language === 'zh' ? '聚焦' : 'Focus'} />
          <Hint k="C" v={language === 'zh' ? '应用视图到机位' : 'Apply view'} />
          <span className="font-mono text-[11px] text-white/50">FOV {mainFov}°</span>
        </div>
        {/* 右上:退出(浮动) */}
        <button
          type="button"
          onClick={closeWithSnapshot}
          className="absolute right-4 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-black/65 text-white/60 backdrop-blur-md transition hover:border-white/25 hover:text-white"
          title="Esc"
        >
          <X className="h-4 w-4" />
        </button>
        <Canvas
          shadows
          dpr={[1, 2]}
          gl={{ preserveDrawingBuffer: true, antialias: true }}
          camera={{ position: EDITOR_HOME.position, fov: 50 }}
          style={{ background: stageSettings.skyColor }}
          onPointerMissed={onDeselect}
        >
          {/* 三点布光: key + fill + rim. 多一层填充和轮廓光,
              身体表面就有 "光面 / 阴影面 / 轮廓亮边" 三档,
              即便是平滑 capsule 也能看出体感, 不靠几何凸起去伪造肌肉. */}
          <ambientLight intensity={0.35} />
          {/* Key light —— 右上前主光 */}
          <directionalLight
            position={[4, 6, 3]}
            intensity={1.05}
            castShadow
            shadow-mapSize-width={1024}
            shadow-mapSize-height={1024}
          />
          {/* Fill light —— 左前柔光, 减弱阴影面死黑 */}
          <directionalLight position={[-3, 3, 2.5]} intensity={0.55} color="#c8d4e2" />
          {/* Rim / back light —— 背光勾出身体轮廓。参考色调是中性的：
              暖米色轮廓光会把整套灰色素体染黄，换成冷灰。 */}
          <directionalLight position={[-1, 4, -4]} intensity={0.7} color="#ccd3dc" />
          <Suspense fallback={null}>
            {/* 地面组:全景设置里的高度 / 显隐;"透明度"通过把网格与轴线
                颜色向天空色混合来实现(drei Grid 没有 opacity 口)。 */}
            <group position={[0, stageSettings.groundY, 0]} visible={stageSettings.groundVisible}>
              <Grid
                args={[40, 40]}
                cellSize={0.5}
                cellThickness={0.5}
                cellColor={mixHex('#1a1d24', stageSettings.skyColor, groundFade)}
                sectionSize={2}
                sectionThickness={1}
                sectionColor={mixHex('#2a2e38', stageSettings.skyColor, groundFade)}
                fadeDistance={30}
                fadeStrength={1}
                infiniteGrid
              />
              {/* 参考同款的全场轴线：X 红 / Z 蓝，贴地细条，低饱和不抢戏。 */}
              <mesh position={[0, 0.0015, 0]}>
                <boxGeometry args={[40, 0.002, 0.02]} />
                <meshBasicMaterial color={mixHex('#a03c44', stageSettings.skyColor, groundFade)} />
              </mesh>
              <mesh position={[0, 0.0015, 0]}>
                <boxGeometry args={[0.02, 0.002, 40]} />
                <meshBasicMaterial color={mixHex('#3c55a0', stageSettings.skyColor, groundFade)} />
              </mesh>
            </group>
            {/* 坐标轴 —— 仅在有选中时(actor 或 camera)显示, 没选时
                场景干净, 跟最终出图风格一致. 0.5 长度刚好够辨认 X/Y/Z
                方向不喧宾夺主. */}
            {/* AI识图的站位参考层(半透明铺地) */}
            {refLayer ? <ReferenceLayerPlane layer={refLayer} /> : null}
            {selection ? <axesHelper args={[0.5]} /> : null}
            {actors.map((a) => {
              const url = bodyTypeOf(a.assetId).glbUrl;
              const haveGLB = USE_SKINNED_GLB && url ? glbAvailable[url] === true : false;
              const isSelected = selection?.kind === 'actor' && selection.id === a.id;
              const procedural = (
                <Mannequin
                  key={a.id}
                  actor={a}
                  selected={isSelected}
                  onSelect={onSelectActor}
                  labelScale={labelScale}
                />
              );
              return haveGLB ? (
                <GLBErrorBoundary key={a.id} fallback={procedural}>
                  <SkinnedMannequin
                    actor={a}
                    selected={isSelected}
                    onSelect={onSelectActor}
                    labelScale={labelScale}
                  />
                </GLBErrorBoundary>
              ) : procedural;
            })}
            {stageProps.map((p) => (
              <PropMesh
                key={p.id}
                prop={p}
                selected={selection?.kind === 'prop' && selection.id === p.id}
                onSelect={onSelectProp}
              />
            ))}
            {cameras.map((cam) => (
              <CameraMarker
                key={cam.id}
                camera={cam}
                isActive={cam.id === activeCameraId}
                selected={selection?.kind === 'camera' && selection.id === cam.id}
                onSelect={onSelectCamera}
                labelScale={labelScale}
                showGuide={stageSettings.cameraGuides}
              />
            ))}
            {selection ? (
              <TransformControls
                ref={transformControlsRef}
                object={selection.obj}
                mode={selection.kind === 'camera' ? 'translate' : mode}
                size={1.1}
                translationSnap={snapping ? 0.25 : null}
                rotationSnap={snapping ? PI / 12 : null}
                scaleSnap={snapping ? 0.1 : null}
              />
            ) : null}
          </Suspense>
          <CameraControls ref={cameraControlsRef} makeDefault />
          <FlyBridge keysRef={flyKeysRef} controlsRef={cameraControlsRef} />
          <SceneBridge sceneRef={sceneRootRef} />
          <CaptureBridge
            singleRef={captureRef}
            multiRef={multiCaptureRef}
            specRef={specCaptureRef}
          />
        </Canvas>

        {/* 左上工具栏：大纲 / 资产库 切换 + 新建演员 + 选中态 */}
        <div className="absolute left-4 top-4 flex flex-col items-start gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSidePanel((p) => (p === 'outline' ? null : 'outline'))}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11.5px] backdrop-blur-md transition ${
                sidePanel === 'outline'
                  ? 'border-violet-300/50 bg-violet-500/20 text-violet-100'
                  : 'border-white/12 bg-black/70 text-white/80 hover:border-white/30 hover:text-white'
              }`}
            >
              <ListTree className="h-3.5 w-3.5" />
              <span>{language === 'zh' ? '大纲' : 'Outline'}</span>
            </button>
            <button
              type="button"
              onClick={() => setSidePanel((p) => (p === 'assets' ? null : 'assets'))}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11.5px] backdrop-blur-md transition ${
                sidePanel === 'assets'
                  ? 'border-violet-300/50 bg-violet-500/20 text-violet-100'
                  : 'border-white/12 bg-black/70 text-white/80 hover:border-white/30 hover:text-white'
              }`}
            >
              <Boxes className="h-3.5 w-3.5" />
              <span>{language === 'zh' ? '资产' : 'Assets'}</span>
            </button>
            <button
              type="button"
              onClick={() => setAiVisionOpen(true)}
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11.5px] backdrop-blur-md transition ${
                aiVisionOpen
                  ? 'border-violet-300/50 bg-violet-500/20 text-violet-100'
                  : 'border-white/12 bg-black/70 text-white/80 hover:border-white/30 hover:text-white'
              }`}
            >
              <ImageLucide className="h-3.5 w-3.5" />
              <span>{language === 'zh' ? 'AI识图' : 'AI Vision'}</span>
            </button>
            <button
              type="button"
              onClick={addActor}
              className="flex items-center gap-1.5 rounded-md border border-white/12 bg-black/70 px-3 py-1.5 text-[11.5px] text-white/80 backdrop-blur-md transition hover:border-white/30 hover:bg-black/90 hover:text-white"
            >
              <UserPlus className="h-3.5 w-3.5" />
              <span>{language === 'zh' ? '新建演员' : 'New Actor'}</span>
            </button>
            {selection ? (
              <>
                <div className="pointer-events-none flex items-center gap-2 rounded-md border border-white/12 bg-black/70 px-3 py-1.5 text-[11.5px] text-white/80 backdrop-blur-md">
                  <span className="text-white/40">{language === 'zh' ? '选中' : 'Selected'}</span>
                  <span className="font-medium text-white">
                    {selection.kind === 'actor'
                      ? actors.find((a) => a.id === selection.id)?.label ?? selection.id
                      : selection.kind === 'camera'
                        ? cameras.find((c) => c.id === selection.id)?.label ?? selection.id
                        : stageProps.find((p) => p.id === selection.id)?.label ?? selection.id}
                  </span>
                  <span className="text-white/30">·</span>
                  <span className="inline-flex items-center gap-1 text-violet-200">
                    {(selection.kind === 'camera' ? 'translate' : mode) === 'translate' && <><Move3D className="h-3 w-3" /> {language === 'zh' ? '移动' : 'Move'}</>}
                    {mode === 'rotate' && selection.kind !== 'camera' && <><RotateCw className="h-3 w-3" /> {language === 'zh' ? '旋转' : 'Rotate'}</>}
                    {mode === 'scale' && selection.kind !== 'camera' && <><Maximize2 className="h-3 w-3" /> {language === 'zh' ? '缩放' : 'Scale'}</>}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (selection.kind === 'actor') removeActor(selection.id);
                    else if (selection.kind === 'camera') removeCamera(selection.id);
                    else if (selection.kind === 'prop') removeProp(selection.id);
                  }}
                  disabled={selection.kind === 'actor' ? actors.length <= 1 : selection.kind === 'camera' ? cameras.length <= 1 : false}
                  className="flex items-center gap-1.5 rounded-md border border-rose-400/30 bg-rose-500/[0.08] px-2.5 py-1.5 text-[11.5px] text-rose-200 backdrop-blur-md transition hover:border-rose-400/60 hover:bg-rose-500/[0.18] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>{language === 'zh' ? '删除' : 'Delete'}</span>
                  <span className="font-mono text-[10px] text-rose-200/50">Del</span>
                </button>
              </>
            ) : (
              <div className="pointer-events-none flex items-center gap-2 rounded-md border border-white/[0.06] bg-black/40 px-3 py-1.5 text-[11px] text-white/40 backdrop-blur-md">
                {language === 'zh'
                  ? '点演员、道具或相机选中,再拖 Gizmo 调位置'
                  : 'Click an actor, prop or camera to select, then drag the gizmo'}
              </div>
            )}
          </div>

          {/* 场景大纲面板 */}
          {sidePanel === 'outline' ? (
            <OutlinePanel
              actors={actors}
              stageProps={stageProps}
              cameras={cameras}
              activeCameraId={activeCameraId}
              selection={selection}
              onSelectEntity={selectFromOutline}
              onAddActor={addActor}
              onAddCamera={addCameraFromCurrentView}
              onAddCrowd={addCrowd}
              onClose={() => setSidePanel(null)}
            />
          ) : null}

          {/* 资产库面板 */}
          {sidePanel === 'assets' ? (
            <AssetLibraryPanel
              tab={assetTab}
              setTab={setAssetTab}
              query={assetQuery}
              setQuery={setAssetQuery}
              onAddProp={addProp}
              onAddActorType={addActorOfType}
              onAddCrowd={addCrowd}
              onAddCameraFromView={addCameraFromCurrentView}
              onAddCameraPreset={addCameraFromPreset}
              onClose={() => setSidePanel(null)}
            />
          ) : null}
        </div>

        {/* 右侧:选中演员时,「属性 / 姿势」双 Tab 面板. */}
        {selectedActor ? (
          <ActorPanel
            actor={selectedActor}
            onUpdate={(patch) => updateActor(selectedActor.id, patch)}
            onApplyPreset={(name) => applyPosePreset(selectedActor.id, name)}
            onUpdatePose={(patch) => updateActorPose(selectedActor.id, patch)}
            onDuplicate={() => duplicateActor(selectedActor.id)}
            onDelete={() => removeActor(selectedActor.id)}
            disableDelete={actors.length <= 1}
          />
        ) : null}

        {/* 右侧:选中相机时,机位详情面板 + 应用视图按钮 */}
        {selectedCamera ? (
          <CameraDetailPanel
            camera={selectedCamera}
            isActive={selectedCamera.id === activeCameraId}
            onApplyViewToCamera={() => applyViewToCamera(selectedCamera.id)}
            onSwitchToCamera={() => switchToCamera(selectedCamera.id)}
            applied={presetFlash?.camId === selectedCamera.id}
          />
        ) : null}

        {/* 左下:操作指南 "?" —— 打开控制说明面板（参考样式）. */}
        <button
          type="button"
          onClick={() => setHelpOpen((v) => !v)}
          title={language === 'zh' ? '操作指南' : 'Controls guide'}
          className={`absolute bottom-4 left-4 flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur-md transition ${
            helpOpen
              ? 'border-violet-300/50 bg-violet-500/20 text-violet-100'
              : 'border-white/12 bg-black/70 text-white/70 hover:border-white/30 hover:text-white'
          }`}
        >
          <HelpCircle className="h-4 w-4" />
        </button>
        {helpOpen ? <StageHelpPanel onClose={() => setHelpOpen(false)} /> : null}

        {/* 左下:操作模式 + 应用到机位 + 重置. */}
        <div className="absolute bottom-4 left-[60px] flex gap-1 rounded-md border border-white/12 bg-black/70 p-1 backdrop-blur-md">
          <ModeButton active={mode === 'translate'} onClick={() => setMode('translate')} hint="" icon={Move3D} label={language === 'zh' ? '移动' : 'Move'} />
          <ModeButton active={mode === 'rotate'} onClick={() => setMode('rotate')} hint="" icon={RotateCw} label={language === 'zh' ? '旋转' : 'Rotate'} />
          <ModeButton active={mode === 'scale'} onClick={() => setMode('scale')} hint="" icon={Maximize2} label={language === 'zh' ? '缩放' : 'Scale'} />
          <div className="mx-1 w-px self-stretch bg-white/10" />
          {/* 吸附:开关按钮(X),开启时 Gizmo 步进对齐。 */}
          <ModeButton active={snapping} onClick={() => setSnapping((s) => !s)} hint="X" icon={Magnet} label={language === 'zh' ? '吸附' : 'Snap'} />
          <div className="mx-1 w-px self-stretch bg-white/10" />
          {/* 视角快切:俯视 / 正面 / 重置。 */}
          <ModeButton active={false} onClick={viewTop} hint="T" icon={ArrowDown} label={language === 'zh' ? '俯视' : 'Top'} />
          <ModeButton active={false} onClick={viewFront} hint="Y" icon={RectangleHorizontal} label={language === 'zh' ? '正面' : 'Front'} />
          <ModeButton active={false} onClick={resetView} hint="0" icon={RefreshCw} label={language === 'zh' ? '重置' : 'Reset'} />
          <div className="mx-1 w-px self-stretch bg-white/10" />
          {/* 撤销 / 重做(舞台编辑历史,Ctrl+Z / Ctrl+Shift+Z)。 */}
          <button
            type="button"
            onClick={undoStage}
            disabled={!canUndo}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.06] hover:text-white disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <Undo2 className="h-3 w-3" />
            <span>{language === 'zh' ? '撤销' : 'Undo'}</span>
            <span className="font-mono text-[10px] text-white/40">⌘Z</span>
          </button>
          <button
            type="button"
            onClick={redoStage}
            disabled={!canRedo}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.06] hover:text-white disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"
          >
            <Redo2 className="h-3 w-3" />
            <span>{language === 'zh' ? '重做' : 'Redo'}</span>
            <span className="font-mono text-[10px] text-white/40">⌘⇧Z</span>
          </button>
          <div className="mx-1 w-px self-stretch bg-white/10" />
          <button
            type="button"
            onClick={() => applyViewToCamera(activeCameraId)}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.06] hover:text-white"
          >
            <VideoIcon className="h-3 w-3" />
            <span>{language === 'zh' ? '应用到机位' : 'Apply to Camera'}</span>
            <span className="font-mono text-[10px] text-white/40">C</span>
          </button>
        </div>

        {/* 右下机位列表. */}
        <div className="absolute bottom-4 right-4 flex w-[280px] flex-col gap-1.5 rounded-md border border-white/12 bg-black/70 p-2 backdrop-blur-md">
          <div className="flex items-center justify-between px-1 pb-0.5">
            <span className="text-[11px] font-medium text-white/70">
              {language === 'zh' ? '机位' : 'Cameras'} · {cameras.length}
            </span>
            <button
              type="button"
              onClick={addCameraFromCurrentView}
              className="flex h-5 w-5 items-center justify-center rounded text-white/60 transition hover:bg-white/[0.08] hover:text-white"
              title={language === 'zh' ? '用当前视口新建机位' : 'New camera from current view'}
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
          <div className="flex max-h-[200px] flex-col gap-1 overflow-y-auto pr-1">
            {cameras.map((cam) => {
              const isActive = cam.id === activeCameraId;
              const isSelected = selection?.kind === 'camera' && selection.id === cam.id;
              return (
                <div
                  key={cam.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    // 点击机位 = 切换活跃机位并把主视口飞进该机位视角
                    // (活跃行再点一次也会重新飞回去)。
                    switchToCamera(cam.id);
                  }}
                  className={`group flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition ${
                    isActive
                      ? 'border-violet-400/60 bg-violet-500/15 text-white'
                      : isSelected
                        ? 'border-amber-300/50 bg-amber-400/10 text-white'
                        : 'border-white/10 bg-white/[0.02] text-white/70 hover:border-white/20 hover:bg-white/[0.06]'
                  }`}
                >
                  <VideoIcon className={`h-3 w-3 shrink-0 ${isActive ? 'text-violet-300' : isSelected ? 'text-amber-300' : 'text-white/40'}`} />
                  <span className="flex-1 truncate font-medium">{cam.label}</span>
                  <span className="text-[10px] text-white/40">
                    FOV {Math.round(cam.fov)}° · {cam.aspect}
                  </span>
                  {presetFlash?.camId === cam.id ? (
                    <span className="text-[10px] text-emerald-300">✓</span>
                  ) : null}
                  {cameras.length > 1 ? (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); removeCamera(cam.id); }}
                      className="ml-1 flex h-4 w-4 items-center justify-center rounded text-white/30 opacity-0 transition hover:bg-rose-500/20 hover:text-rose-300 group-hover:opacity-100"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          {/* 机位实时预览 —— 离屏按机位 aspect 渲染,700ms 刷新;选中某个
              机位标记时预览它,否则预览活跃机位(参考:右下常驻预览窗)。 */}
          {previewCam ? (
            <div className="overflow-hidden rounded border border-white/10 bg-black/60">
              <div
                className="relative w-full bg-black"
                style={{ aspectRatio: aspectRatioToCss(previewCam.aspect) }}
              >
                {livePreview ? (
                  <img
                    src={livePreview}
                    alt={`${previewCam.label} preview`}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] text-white/35">
                    {language === 'zh' ? '预览生成中…' : 'Rendering preview…'}
                  </div>
                )}
                <span className="absolute left-1 top-1 rounded bg-black/55 px-1.5 py-px text-[9px] font-medium text-white/80 backdrop-blur-sm">
                  {previewCam.label}
                </span>
                <span className="absolute right-1 top-1 rounded bg-black/55 px-1.5 py-px font-mono text-[9px] text-white/60 backdrop-blur-sm">
                  FOV {Math.round(previewCam.fov)}° · {previewCam.aspect}
                </span>
              </div>
            </div>
          ) : null}
          {/* 活跃机位的参数. */}
          {activeCamera ? (
            <div className="flex flex-col gap-1.5 border-t border-white/[0.06] pt-2">
              <div className="flex items-center gap-2 px-1">
                <span className="w-12 text-[10px] text-white/50">FOV</span>
                <input
                  type="range"
                  min={20}
                  max={120}
                  step={1}
                  value={activeCamera.fov}
                  onChange={(e) => setActiveCameraFov(Number(e.target.value))}
                  className="flex-1 accent-violet-400"
                />
                <span className="w-8 text-right font-mono text-[10px] text-white/70">{Math.round(activeCamera.fov)}°</span>
              </div>
              <div className="flex items-center gap-1 px-1">
                {ASPECT_RATIOS.map((ar) => (
                  <button
                    key={ar}
                    type="button"
                    onClick={() => setActiveCameraAspect(ar)}
                    className={`flex-1 rounded px-1 py-0.5 text-[10px] transition ${
                      activeCamera.aspect === ar
                        ? 'bg-violet-500/25 text-violet-100'
                        : 'text-white/50 hover:bg-white/[0.06] hover:text-white'
                    }`}
                  >
                    {ar}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* armed 阶段:画面右下浮出 neowow 同款提示,锚定在确认按钮旁边. */}
      {confirmStage === 'armed' ? (
        <div className="pointer-events-none absolute bottom-16 right-4 z-10 flex max-w-[420px] items-center gap-2 rounded-md border border-amber-300/40 bg-amber-400/15 px-3 py-2 text-[12px] text-amber-50 shadow-[0_8px_24px_-12px_rgba(245,158,11,0.5)] backdrop-blur-md">
          <Camera className="h-3.5 w-3.5 text-amber-200" />
          <span>
            {language === 'zh'
              ? <>已自动选中「<span className="font-medium text-white">{activeCamera?.label ?? '机位1'}</span>」的视角进行构图,再次点击确认</>
              : <>Locked view to <span className="font-medium text-white">{activeCamera?.label ?? 'Camera 1'}</span> — click 确认 again to finalize</>
            }
          </span>
        </div>
      ) : null}

      {/* 底栏工具组的弹层(全景背景 / 标签 / 出图比例)。 */}
      {envPopover === 'panorama' ? (
        <PanoramaPanel
          settings={stageSettings}
          onPatch={patchStageSettings}
          onClose={() => setEnvPopover(null)}
          hasRefLayer={!!refLayer}
          onRemoveRefLayer={() => setRefLayer(null)}
        />
      ) : null}

      {/* AI识图:生成站位参考弹窗(参考样式)。 */}
      {aiVisionOpen ? (
        <StageVisionModal
          onClose={() => setAiVisionOpen(false)}
          onGenerate={(p) => {
            applyReferenceLayer(p);
            setAiVisionOpen(false);
          }}
        />
      ) : null}
      {envPopover === 'labels' ? (
        <LabelsPanel settings={stageSettings} onPatch={patchStageSettings} onClose={() => setEnvPopover(null)} />
      ) : null}
      {envPopover === 'aspect' ? (
        <AspectPanel
          current={activeCamera?.aspect ?? '16:9'}
          onPick={(ar) => { setActiveCameraAspect(ar); setEnvPopover(null); }}
          onClose={() => setEnvPopover(null)}
        />
      ) : null}

      {/* 底部状态栏 + 确认. */}
      <div className="flex items-center justify-between border-t border-white/[0.06] px-4 py-3">
        <div className="text-[11px] text-white/40">
          {language === 'zh'
            ? `${actors.length} 角色 · ${cameras.length} 机位 · 确认两次派生「构图预览」节点 · 从节点直接拉线 = 退出时镜头`
            : `${actors.length} actors · ${cameras.length} cameras · confirm twice to spawn previews · direct wire = exit view`}
        </div>
        <div className="flex items-center gap-2">
          {/* 全景背景 / 标签 / 出图比例(参考底栏右侧工具组)。 */}
          <button
            type="button"
            onClick={() => setEnvPopover((p) => (p === 'panorama' ? null : 'panorama'))}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition ${
              envPopover === 'panorama'
                ? 'border-violet-300/50 bg-violet-500/20 text-violet-100'
                : 'border-white/12 bg-white/[0.04] text-white/70 hover:border-white/20 hover:bg-white/[0.08]'
            }`}
          >
            <Globe2 className="h-3.5 w-3.5" />
            {language === 'zh' ? '全景' : 'Backdrop'}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
          <button
            type="button"
            onClick={() => setEnvPopover((p) => (p === 'labels' ? null : 'labels'))}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition ${
              envPopover === 'labels'
                ? 'border-violet-300/50 bg-violet-500/20 text-violet-100'
                : 'border-white/12 bg-white/[0.04] text-white/70 hover:border-white/20 hover:bg-white/[0.08]'
            }`}
          >
            <Type className="h-3.5 w-3.5" />
            {language === 'zh' ? '标签' : 'Labels'}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
          <button
            type="button"
            onClick={() => setEnvPopover((p) => (p === 'aspect' ? null : 'aspect'))}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] transition ${
              envPopover === 'aspect'
                ? 'border-violet-300/50 bg-violet-500/20 text-violet-100'
                : 'border-white/12 bg-white/[0.04] text-white/70 hover:border-white/20 hover:bg-white/[0.08]'
            }`}
            title={language === 'zh' ? '活跃机位的出图比例' : 'Active camera export ratio'}
          >
            <Monitor className="h-3.5 w-3.5" />
            <span className="font-mono">{activeCamera?.aspect ?? '16:9'}</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
          <div className="mx-1 h-5 w-px bg-white/10" />
          {/* 动画(BATE):占位按钮,功能待定(按参考先摆上)。 */}
          <button
            type="button"
            title={language === 'zh' ? '即将上线' : 'Coming soon'}
            className="flex cursor-default items-center gap-1.5 rounded-md border border-white/12 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-white/50"
          >
            <Film className="h-3.5 w-3.5" />
            {language === 'zh' ? '动画(BATE)' : 'Animation (BETA)'}
          </button>
          <div className="mx-1 h-5 w-px bg-white/10" />
          <button
            type="button"
            onClick={closeWithSnapshot}
            className="rounded-md border border-white/12 bg-white/[0.04] px-3 py-1.5 text-[12px] text-white/70 transition hover:border-white/20 hover:bg-white/[0.08]"
          >
            {language === 'zh' ? '取消' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={capturing}
            className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] transition disabled:opacity-50 ${
              confirmStage === 'armed'
                ? 'border-amber-300/60 bg-amber-400/[0.22] text-amber-50 hover:border-amber-300/90 hover:bg-amber-400/[0.34]'
                : 'border-violet-400/30 bg-violet-500/[0.16] text-violet-50 hover:border-violet-400/60 hover:bg-violet-500/[0.28]'
            }`}
          >
            {capturing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
            {capturing
              ? (language === 'zh' ? '正在派生预览…' : 'Spawning…')
              : confirmStage === 'armed'
                ? (language === 'zh' ? `再次确认 → 派生 ${cameras.length} 个预览` : `Confirm again → spawn ${cameras.length}`)
                : (language === 'zh' ? '确认构图' : 'Confirm composition')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** ============================================================
 *  ActorPanel —— 选中演员时右侧弹出的「属性 / 姿势」双 Tab 面板
 *  ============================================================ */

function ActorPanel({
  actor, onUpdate, onApplyPreset, onUpdatePose, onDuplicate, onDelete, disableDelete,
}: {
  actor: ActorTransform;
  onUpdate: (patch: Partial<ActorTransform>) => void;
  onApplyPreset: (name: string) => void;
  onUpdatePose: (patch: Partial<ActorPose>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  disableDelete: boolean;
}) {
  const language = useStore((s) => s.language);
  const [mainTab, setMainTab] = useState<'properties' | 'pose'>('properties');
  const [poseTab, setPoseTab] = useState<'preset' | 'manual'>('preset');

  return (
    <div className="absolute right-4 top-4 z-30 flex w-[280px] flex-col gap-2 rounded-md border border-white/12 bg-black/80 p-3 backdrop-blur-xl">
      {/* Tab header. */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] pb-2">
        <button
          type="button"
          onClick={() => setMainTab('properties')}
          className={`rounded px-2 py-1 text-[12px] transition ${
            mainTab === 'properties'
              ? 'bg-white/[0.08] font-semibold text-white'
              : 'text-white/55 hover:bg-white/[0.04] hover:text-white'
          }`}
        >
          {language === 'zh' ? '属性' : 'Props'}
        </button>
        <button
          type="button"
          onClick={() => setMainTab('pose')}
          className={`rounded px-2 py-1 text-[12px] transition ${
            mainTab === 'pose'
              ? 'bg-white/[0.08] font-semibold text-white'
              : 'text-white/55 hover:bg-white/[0.04] hover:text-white'
          }`}
        >
          {language === 'zh' ? '姿势' : 'Pose'}
        </button>
        <div className="ml-auto flex items-center gap-1 text-white/40">
          <Lock className="h-3.5 w-3.5 cursor-not-allowed opacity-50" />
        </div>
      </div>

      {mainTab === 'properties'
        ? <ActorPropertiesContent actor={actor} onUpdate={onUpdate} />
        : <ActorPoseContent
            actor={actor}
            poseTab={poseTab}
            setPoseTab={setPoseTab}
            onApplyPreset={onApplyPreset}
            onUpdatePose={onUpdatePose}
          />
      }

      {/* 底部:复制 / 删除 - 不论哪个 tab 都常驻. */}
      <div className="mt-1 grid grid-cols-2 gap-2 border-t border-white/[0.06] pt-2">
        <button
          type="button"
          onClick={onDuplicate}
          className="rounded border border-white/12 bg-white/[0.04] px-2 py-1.5 text-[11.5px] text-white/80 transition hover:border-white/30 hover:bg-white/[0.08] hover:text-white"
        >
          {language === 'zh' ? '复制' : 'Duplicate'}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={disableDelete}
          className="rounded border border-rose-400/30 bg-rose-500/[0.10] px-2 py-1.5 text-[11.5px] text-rose-200 transition hover:border-rose-400/60 hover:bg-rose-500/[0.22] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {language === 'zh' ? '删除' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

/** 属性 Tab 内容 —— 名称 / 位置 / 旋转 / 缩放 / 体型 / 颜色. */
function ActorPropertiesContent({ actor, onUpdate }: {
  actor: ActorTransform;
  onUpdate: (patch: Partial<ActorTransform>) => void;
}) {
  const language = useStore((s) => s.language);
  const bt = bodyTypeOf(actor.assetId);
  const color = actor.color || bt.defaultColor;
  const rotation = actor.rotation ?? [0, actor.rotationY, 0];
  const scale: [number, number, number] = actor.scaleXYZ ?? [actor.scale, actor.scale, actor.scale];
  const uniformScale = scale[0]; // 显示给 uniform slider

  const radToDeg = (r: number) => Math.round((r * 180) / PI);
  const degToRad = (d: number) => (d * PI) / 180;

  return (
    <div className="flex max-h-[520px] flex-col gap-3 overflow-y-auto pr-1">
      {/* 名称 */}
      <Field label={language === 'zh' ? '名称' : 'Name'}>
        <input
          type="text"
          value={actor.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          className="w-full rounded border border-white/12 bg-white/[0.03] px-2 py-1.5 text-[12px] text-white/90 outline-none focus:border-violet-400/60"
        />
      </Field>

      {/* 位置 */}
      <Field label={language === 'zh' ? '位置' : 'Position'}>
        <Vec3Input
          value={actor.position}
          onChange={(v) => onUpdate({ position: v })}
          step={0.1}
        />
      </Field>

      {/* 旋转 (度) */}
      <Field label={language === 'zh' ? '旋转 (°)' : 'Rotation (°)'}>
        <Vec3Input
          value={[radToDeg(rotation[0]), radToDeg(rotation[1]), radToDeg(rotation[2])]}
          onChange={(v) => onUpdate({ rotation: [degToRad(v[0]), degToRad(v[1]), degToRad(v[2])] })}
          step={1}
        />
      </Field>

      {/* 统一缩放 (uniform slider) */}
      <Field label={language === 'zh' ? '统一缩放' : 'Uniform Scale'}>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0.3}
            max={4}
            step={0.05}
            value={uniformScale}
            onChange={(e) => {
              const v = Number(e.target.value);
              onUpdate({ scale: v, scaleXYZ: [v, v, v] });
            }}
            className="flex-1 accent-violet-400"
          />
          <span className="w-10 text-right font-mono text-[11px] text-white/70">{uniformScale.toFixed(1)}</span>
        </div>
      </Field>

      {/* 缩放 (xyz 独立) */}
      <Field label={language === 'zh' ? '缩放' : 'Scale'}>
        <Vec3Input
          value={scale}
          onChange={(v) => onUpdate({ scaleXYZ: v, scale: v[0] })}
          step={0.1}
        />
      </Field>

      {/* 体型 */}
      <Field label={language === 'zh' ? '体型' : 'Body type'}>
        <div className="grid grid-cols-2 gap-1.5">
          {BODY_TYPE_IDS.map((id) => {
            const meta = BODY_TYPES[id];
            const active = actor.assetId === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onUpdate({ assetId: id })}
                className={`flex items-center justify-center gap-1 rounded border px-2 py-1.5 text-[11px] transition ${
                  active
                    ? 'border-violet-400/60 bg-violet-500/[0.18] text-white'
                    : 'border-white/12 bg-white/[0.03] text-white/70 hover:border-white/30 hover:bg-white/[0.08] hover:text-white'
                }`}
              >
                <PersonStanding className={`h-3 w-3 ${active ? 'text-violet-200' : 'text-white/40'}`} />
                {meta.label}
              </button>
            );
          })}
        </div>
      </Field>

      {/* 颜色 */}
      <Field label={language === 'zh' ? '颜色' : 'Color'}>
        <div className="flex items-center gap-2">
          <label className="relative h-7 w-9 cursor-pointer overflow-hidden rounded border border-white/15">
            <input
              type="color"
              value={color}
              onChange={(e) => onUpdate({ color: e.target.value })}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
            <div className="h-full w-full" style={{ background: color }} />
          </label>
          <input
            type="text"
            value={color.toUpperCase()}
            onChange={(e) => {
              const v = e.target.value;
              if (/^#?[0-9A-Fa-f]{6}$/.test(v)) {
                onUpdate({ color: v.startsWith('#') ? v : `#${v}` });
              }
            }}
            className="flex-1 rounded border border-white/12 bg-white/[0.03] px-2 py-1.5 font-mono text-[12px] text-white/85 outline-none focus:border-violet-400/60"
          />
        </div>
      </Field>
    </div>
  );
}

/** 姿势 Tab 内容 —— 与原 PosePanel 内容一致, 抽出来当 ActorPanel 子页. */
function ActorPoseContent({
  actor, poseTab, setPoseTab, onApplyPreset, onUpdatePose,
}: {
  actor: ActorTransform;
  poseTab: 'preset' | 'manual';
  setPoseTab: (t: 'preset' | 'manual') => void;
  onApplyPreset: (name: string) => void;
  onUpdatePose: (patch: Partial<ActorPose>) => void;
}) {
  const language = useStore((s) => s.language);
  const pose = { ...DEFAULT_POSE, ...(actor.pose ?? {}) };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[11px] text-white/55">
        <PersonStanding className="h-3.5 w-3.5 text-violet-300" />
        <span>{language === 'zh' ? '姿势' : 'Pose'}</span>
        <button
          type="button"
          onClick={() => setPoseTab(poseTab === 'preset' ? 'manual' : 'preset')}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] hover:bg-white/[0.06] hover:text-white"
        >
          <Settings2 className="h-3 w-3" />
          {poseTab === 'preset' ? (language === 'zh' ? '微调' : 'Manual') : (language === 'zh' ? '预设' : 'Presets')}
        </button>
      </div>

      {poseTab === 'preset' ? (
        <div className="grid max-h-[420px] grid-cols-3 gap-1 overflow-y-auto pr-1">
          {PRESET_KEYS.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => onApplyPreset(name)}
              className="rounded border border-white/10 bg-white/[0.02] px-1.5 py-1 text-[10.5px] text-white/75 transition hover:border-white/30 hover:bg-white/[0.08] hover:text-white"
            >
              {name}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex max-h-[420px] flex-col gap-2 overflow-y-auto pr-1">
          <PoseSection title={language === 'zh' ? '躯干' : 'Torso'}>
            <PoseSlider label={language === 'zh' ? '前倾' : 'Pitch'} min={-30} max={45} value={pose.torso[0]} onChange={(v) => onUpdatePose({ torso: [v, pose.torso[1], pose.torso[2]] })} />
            <PoseSlider label={language === 'zh' ? '转身' : 'Yaw'} min={-45} max={45} value={pose.torso[1]} onChange={(v) => onUpdatePose({ torso: [pose.torso[0], v, pose.torso[2]] })} />
            <PoseSlider label={language === 'zh' ? '侧倾' : 'Roll'} min={-30} max={30} value={pose.torso[2]} onChange={(v) => onUpdatePose({ torso: [pose.torso[0], pose.torso[1], v] })} />
          </PoseSection>
          <PoseSection title={language === 'zh' ? '头部' : 'Head'}>
            <PoseSlider label={language === 'zh' ? '点头' : 'Nod'} min={-40} max={40} value={pose.head[0]} onChange={(v) => onUpdatePose({ head: [v, pose.head[1], pose.head[2]] })} />
            <PoseSlider label={language === 'zh' ? '转头' : 'Yaw'} min={-70} max={70} value={pose.head[1]} onChange={(v) => onUpdatePose({ head: [pose.head[0], v, pose.head[2]] })} />
            <PoseSlider label={language === 'zh' ? '歪头' : 'Tilt'} min={-35} max={35} value={pose.head[2]} onChange={(v) => onUpdatePose({ head: [pose.head[0], pose.head[1], v] })} />
          </PoseSection>
          <PoseSection title={language === 'zh' ? '左臂' : 'Left Arm'}>
            <PoseSlider label={language === 'zh' ? '前举' : 'Lift'} value={pose.shoulderL[0]} onChange={(v) => onUpdatePose({ shoulderL: [v, pose.shoulderL[1], pose.shoulderL[2]] })} />
            <PoseSlider label={language === 'zh' ? '外展' : 'Abduct'} value={pose.shoulderL[2]} onChange={(v) => onUpdatePose({ shoulderL: [pose.shoulderL[0], pose.shoulderL[1], v] })} />
            <PoseSlider label={language === 'zh' ? '肘弯' : 'Elbow'} min={0} max={150} value={pose.elbowL[0]} onChange={(v) => onUpdatePose({ elbowL: [v, pose.elbowL[1], pose.elbowL[2]] })} />
            <PoseSlider label={language === 'zh' ? '手腕' : 'Wrist'} min={-60} max={60} value={pose.wristL[0]} onChange={(v) => onUpdatePose({ wristL: [v, pose.wristL[1], pose.wristL[2]] })} />
          </PoseSection>
          <PoseSection title={language === 'zh' ? '右臂' : 'Right Arm'}>
            <PoseSlider label={language === 'zh' ? '前举' : 'Lift'} value={pose.shoulderR[0]} onChange={(v) => onUpdatePose({ shoulderR: [v, pose.shoulderR[1], pose.shoulderR[2]] })} />
            <PoseSlider label={language === 'zh' ? '外展' : 'Abduct'} value={pose.shoulderR[2]} onChange={(v) => onUpdatePose({ shoulderR: [pose.shoulderR[0], pose.shoulderR[1], v] })} />
            <PoseSlider label={language === 'zh' ? '肘弯' : 'Elbow'} min={0} max={150} value={pose.elbowR[0]} onChange={(v) => onUpdatePose({ elbowR: [v, pose.elbowR[1], pose.elbowR[2]] })} />
            <PoseSlider label={language === 'zh' ? '手腕' : 'Wrist'} min={-60} max={60} value={pose.wristR[0]} onChange={(v) => onUpdatePose({ wristR: [v, pose.wristR[1], pose.wristR[2]] })} />
          </PoseSection>
          <PoseSection title={language === 'zh' ? '左腿' : 'Left Leg'}>
            <PoseSlider label={language === 'zh' ? '抬腿' : 'Lift'} min={-120} max={30} value={pose.hipL[0]} onChange={(v) => onUpdatePose({ hipL: [v, pose.hipL[1], pose.hipL[2]] })} />
            <PoseSlider label={language === 'zh' ? '膝弯' : 'Knee'} min={0} max={140} value={pose.kneeL[0]} onChange={(v) => onUpdatePose({ kneeL: [v, pose.kneeL[1], pose.kneeL[2]] })} />
            <PoseSlider label={language === 'zh' ? '脚踝' : 'Ankle'} min={-45} max={30} value={pose.ankleL[0]} onChange={(v) => onUpdatePose({ ankleL: [v, pose.ankleL[1], pose.ankleL[2]] })} />
          </PoseSection>
          <PoseSection title={language === 'zh' ? '右腿' : 'Right Leg'}>
            <PoseSlider label={language === 'zh' ? '抬腿' : 'Lift'} min={-120} max={30} value={pose.hipR[0]} onChange={(v) => onUpdatePose({ hipR: [v, pose.hipR[1], pose.hipR[2]] })} />
            <PoseSlider label={language === 'zh' ? '膝弯' : 'Knee'} min={0} max={140} value={pose.kneeR[0]} onChange={(v) => onUpdatePose({ kneeR: [v, pose.kneeR[1], pose.kneeR[2]] })} />
            <PoseSlider label={language === 'zh' ? '脚踝' : 'Ankle'} min={-45} max={30} value={pose.ankleR[0]} onChange={(v) => onUpdatePose({ ankleR: [v, pose.ankleR[1], pose.ankleR[2]] })} />
          </PoseSection>
          <button
            type="button"
            onClick={() => onApplyPreset('站立')}
            className="rounded border border-white/12 bg-white/[0.03] px-2 py-1 text-[10.5px] text-white/70 transition hover:bg-white/[0.08] hover:text-white"
          >
            {language === 'zh' ? '重置所有关节' : 'Reset all joints'}
          </button>
        </div>
      )}
    </div>
  );
}

/** 表单字段标题包装. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-white/45">{label}</div>
      {children}
    </div>
  );
}

/** 三轴 (x/y/z) 数字输入组件. step 控制每步增量. */
function Vec3Input({ value, onChange, step }: {
  value: [number, number, number];
  onChange: (v: [number, number, number]) => void;
  step: number;
}) {
  const setAxis = (axis: 0 | 1 | 2, n: number) => {
    const next: [number, number, number] = [...value] as [number, number, number];
    next[axis] = n;
    onChange(next);
  };
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {(['x', 'y', 'z'] as const).map((label, idx) => (
        <div key={label} className="relative">
          <span className="pointer-events-none absolute left-1.5 top-1.5 font-mono text-[9px] uppercase text-white/35">
            {label}
          </span>
          <input
            type="number"
            step={step}
            value={Number.isFinite(value[idx]) ? Number(value[idx].toFixed(2)) : 0}
            onChange={(e) => setAxis(idx as 0 | 1 | 2, Number(e.target.value) || 0)}
            className="w-full rounded border border-white/10 bg-white/[0.03] py-1.5 pl-5 pr-1.5 text-right font-mono text-[11px] text-white/85 outline-none focus:border-violet-400/60"
          />
        </div>
      ))}
    </div>
  );
}

function PoseSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] font-medium text-white/50">{title}</div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

/** 滑杆值是欧拉角度,显示成度数(°),内部存弧度.
 *  min/max = 该关节该轴的人体活动度（ROM）——肘/膝只能往生理方向弯,
 *  「动作合理」由输入端保证,不靠用户自觉. */
function PoseSlider({ label, value, onChange, min = -180, max = 180 }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const deg = Math.round((value * 180) / PI);
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <span className="w-10 shrink-0 text-white/50">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={Math.max(min, Math.min(max, deg))}
        onChange={(e) => onChange((Number(e.target.value) * PI) / 180)}
        className="flex-1 accent-violet-400"
      />
      <span className="w-9 text-right font-mono text-white/60">{deg}°</span>
    </div>
  );
}

/** 选中相机时右侧弹出的"详情 + 应用视图到此机位"面板. */
function CameraDetailPanel({ camera, isActive, onApplyViewToCamera, onSwitchToCamera, applied }: {
  camera: CameraSpec;
  isActive: boolean;
  onApplyViewToCamera: () => void;
  onSwitchToCamera: () => void;
  applied: boolean;
}) {
  const language = useStore((s) => s.language);
  return (
    <div className="absolute right-4 top-4 z-30 flex w-[260px] flex-col gap-2 rounded-md border border-amber-300/30 bg-black/80 p-3 backdrop-blur-xl">
      <div className="flex items-center gap-2 text-[11.5px] text-white/80">
        <VideoIcon className="h-3.5 w-3.5 text-amber-300" />
        <span className="font-medium">{camera.label}</span>
        {isActive ? (
          <span className="rounded bg-violet-500/30 px-1.5 py-px text-[9px] text-violet-100">
            {language === 'zh' ? '当前主视图' : 'main view'}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 text-[10px] text-white/60">
        <div>FOV: {Math.round(camera.fov)}° · {camera.aspect}</div>
        <div>pos: ({camera.position.map((n) => n.toFixed(2)).join(', ')})</div>
        <div>lookAt: ({camera.lookAt.map((n) => n.toFixed(2)).join(', ')})</div>
      </div>
      <button
        type="button"
        onClick={onApplyViewToCamera}
        className="flex items-center justify-center gap-1.5 rounded border border-amber-300/40 bg-amber-400/10 px-2 py-1.5 text-[11px] text-amber-100 transition hover:border-amber-300/70 hover:bg-amber-400/20"
      >
        <Eye className="h-3 w-3" />
        {language === 'zh' ? '应用视图到此机位' : 'Apply view to this camera'}
        {applied ? <span className="text-emerald-300">✓</span> : null}
      </button>
      {!isActive ? (
        <button
          type="button"
          onClick={onSwitchToCamera}
          className="flex items-center justify-center gap-1.5 rounded border border-white/12 bg-white/[0.04] px-2 py-1.5 text-[11px] text-white/70 transition hover:border-white/30 hover:bg-white/[0.08]"
        >
          <ChevronDown className="h-3 w-3 rotate-90" />
          {language === 'zh' ? '切换到此机位' : 'Switch to this camera'}
        </button>
      ) : null}
    </div>
  );
}

/* ─── 场景大纲 / 资产库 / 操作指南（2026-07 参考样式三面板）──────────── */

/** 大纲行的公共样式。 */
function OutlineRow({ active, onClick, icon: Icon, label, badge }: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11.5px] transition ${
        active ? 'bg-violet-500/25 text-violet-100' : 'text-white/70 hover:bg-white/[0.06] hover:text-white'
      }`}
    >
      <Icon className="h-3 w-3 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? <span className="shrink-0 rounded bg-violet-500/30 px-1 py-px text-[9px] text-violet-100">{badge}</span> : null}
    </button>
  );
}

function OutlineSection({ icon: Icon, title, children }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5 px-1 py-1 text-[10.5px] font-medium text-white/50">
        <Icon className="h-3 w-3" />
        <span>{title}</span>
      </div>
      {children}
    </div>
  );
}

/** 场景大纲 —— 导演台里全部资产（人物 / 道具 / 机位）的统计与直选。 */
function OutlinePanel({ actors, stageProps, cameras, activeCameraId, selection, onSelectEntity, onAddActor, onAddCamera, onAddCrowd, onClose }: {
  actors: ActorTransform[];
  stageProps: PropTransform[];
  cameras: CameraSpec[];
  activeCameraId: string;
  selection: Selection | null;
  onSelectEntity: (kind: SelectionKind, id: string) => void;
  onAddActor: () => void;
  onAddCamera: () => void;
  onAddCrowd: (n: number) => void;
  onClose: () => void;
}) {
  const language = useStore((s) => s.language);
  const zh = language === 'zh';
  return (
    <div className="flex max-h-[70vh] w-[250px] flex-col gap-2 overflow-y-auto rounded-md border border-white/12 bg-black/80 p-3 backdrop-blur-xl">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-white/85">{zh ? '场景大纲' : 'Scene outline'}</span>
        <button type="button" onClick={onClose} className="rounded p-0.5 text-white/40 transition hover:bg-white/[0.08] hover:text-white">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <OutlineSection icon={Users} title={`${zh ? '人物' : 'Actors'} (${actors.length})`}>
        {actors.map((a) => (
          <OutlineRow
            key={a.id}
            active={selection?.kind === 'actor' && selection.id === a.id}
            onClick={() => onSelectEntity('actor', a.id)}
            icon={User}
            label={a.label}
          />
        ))}
      </OutlineSection>
      <OutlineSection icon={Boxes} title={`${zh ? '道具' : 'Props'} (${stageProps.length})`}>
        {stageProps.length === 0 ? (
          <div className="px-2 py-1 text-[10.5px] text-white/35">{zh ? '从「资产」面板添加' : 'Add from the Assets panel'}</div>
        ) : stageProps.map((p) => (
          <OutlineRow
            key={p.id}
            active={selection?.kind === 'prop' && selection.id === p.id}
            onClick={() => onSelectEntity('prop', p.id)}
            icon={Boxes}
            label={p.label}
          />
        ))}
      </OutlineSection>
      <OutlineSection icon={VideoIcon} title={`${zh ? '机位' : 'Cameras'} (${cameras.length})`}>
        {cameras.map((c) => (
          <OutlineRow
            key={c.id}
            active={selection?.kind === 'camera' && selection.id === c.id}
            onClick={() => onSelectEntity('camera', c.id)}
            icon={VideoIcon}
            label={c.label}
            badge={c.id === activeCameraId ? (zh ? '当前' : 'active') : undefined}
          />
        ))}
      </OutlineSection>
      <div className="mt-1 grid grid-cols-2 gap-1.5">
        <button type="button" onClick={onAddActor} className="rounded border border-white/12 bg-white/[0.03] px-2 py-1.5 text-[10.5px] text-white/75 transition hover:border-white/30 hover:text-white">
          + {zh ? '人物' : 'Actor'}
        </button>
        <button type="button" onClick={onAddCamera} className="rounded border border-white/12 bg-white/[0.03] px-2 py-1.5 text-[10.5px] text-white/75 transition hover:border-white/30 hover:text-white">
          + {zh ? '机位' : 'Camera'}
        </button>
      </div>
      <button
        type="button"
        onClick={() => onAddCrowd(3)}
        className="flex items-center justify-center gap-1.5 rounded border border-dashed border-white/20 px-2 py-1.5 text-[10.5px] text-white/60 transition hover:border-white/40 hover:text-white"
      >
        <Users className="h-3 w-3" />
        <span>+ {zh ? '群众阵列' : 'Crowd row'}</span>
      </button>
    </div>
  );
}

/** 资产库 —— 道具 / 人物 / 机位 三个标签页，点击条目即放置到舞台。 */
function AssetLibraryPanel({ tab, setTab, query, setQuery, onAddProp, onAddActorType, onAddCrowd, onAddCameraFromView, onAddCameraPreset, onClose }: {
  tab: 'props' | 'actors' | 'cameras';
  setTab: (t: 'props' | 'actors' | 'cameras') => void;
  query: string;
  setQuery: (q: string) => void;
  onAddProp: (assetId: string) => void;
  onAddActorType: (assetId: string) => void;
  onAddCrowd: (n: number) => void;
  onAddCameraFromView: () => void;
  onAddCameraPreset: (presetId: string) => void;
  onClose: () => void;
}) {
  const language = useStore((s) => s.language);
  const zh = language === 'zh';
  const filteredProps = PROP_DEFS.filter((d) => !query.trim() || d.zh.includes(query.trim()) || d.en.toLowerCase().includes(query.trim().toLowerCase()));
  const filteredPresets = CAMERA_PRESETS.filter((p) => !query.trim() || p.zh.includes(query.trim()) || p.en.toLowerCase().includes(query.trim().toLowerCase()));
  const actorEntries = [
    ...BODY_TYPE_IDS.map((id) => ({ id, title: BODY_TYPES[id].label, sub: zh ? '关节人偶素体 · 可摆姿势' : 'Articulated mannequin', crowd: 0 })),
    { id: 'crowd-3', title: zh ? '群众 (3人)' : 'Crowd (3)', sub: zh ? '一排 3 个素体人偶' : 'Row of 3 mannequins', crowd: 3 },
    { id: 'crowd-5', title: zh ? '群众 (5人)' : 'Crowd (5)', sub: zh ? '一排 5 个素体人偶' : 'Row of 5 mannequins', crowd: 5 },
  ].filter((e) => !query.trim() || e.title.includes(query.trim()));
  const tabs: Array<{ key: typeof tab; zh: string; en: string }> = [
    { key: 'props', zh: '道具', en: 'Props' },
    { key: 'actors', zh: '人物', en: 'Actors' },
    { key: 'cameras', zh: '机位', en: 'Cameras' },
  ];
  return (
    <div className="flex max-h-[70vh] w-[268px] flex-col gap-2 rounded-md border border-white/12 bg-black/80 p-3 backdrop-blur-xl">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-white/85">{zh ? '资产库' : 'Asset library'}</span>
        <button type="button" onClick={onClose} className="rounded p-0.5 text-white/40 transition hover:bg-white/[0.08] hover:text-white">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex gap-1 border-b border-white/[0.08] pb-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded px-2.5 py-1 text-[11px] transition ${
              tab === t.key ? 'bg-white/12 text-white' : 'text-white/55 hover:bg-white/[0.06] hover:text-white'
            }`}
          >
            {zh ? t.zh : t.en}
          </button>
        ))}
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-white/35" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={zh ? '搜索资产…' : 'Search assets…'}
          className="w-full rounded border border-white/10 bg-white/[0.03] py-1.5 pl-7 pr-2 text-[11px] text-white/85 outline-none placeholder:text-white/30 focus:border-violet-400/60"
        />
      </div>
      <div className="flex-1 overflow-y-auto pr-0.5">
        {tab === 'props' ? (
          <div className="grid grid-cols-2 gap-1.5">
            {filteredProps.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => onAddProp(d.id)}
                title={zh ? `添加${d.zh}` : `Add ${d.en}`}
                className="flex flex-col items-center gap-1.5 rounded border border-white/10 bg-white/[0.02] px-2 py-3 text-[10.5px] text-white/75 transition hover:border-white/30 hover:bg-white/[0.07] hover:text-white"
              >
                <Boxes className="h-4 w-4 opacity-70" />
                <span className="max-w-full truncate">{zh ? d.zh : d.en}</span>
              </button>
            ))}
          </div>
        ) : tab === 'actors' ? (
          <div className="flex flex-col gap-1.5">
            {actorEntries.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => (e.crowd ? onAddCrowd(e.crowd) : onAddActorType(e.id))}
                className="flex items-center gap-2.5 rounded border border-white/10 bg-white/[0.02] px-2.5 py-2 text-left transition hover:border-white/30 hover:bg-white/[0.07]"
              >
                {e.crowd ? <Users className="h-4 w-4 shrink-0 text-white/60" /> : <PersonStanding className="h-4 w-4 shrink-0 text-white/60" />}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[11.5px] text-white/85">{e.title}</span>
                  <span className="truncate text-[10px] text-white/40">{e.sub}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={onAddCameraFromView}
              className="flex items-center gap-2.5 rounded border border-white/10 bg-white/[0.02] px-2.5 py-2 text-left transition hover:border-white/30 hover:bg-white/[0.07]"
            >
              <VideoIcon className="h-4 w-4 shrink-0 text-amber-300/80" />
              <span className="flex min-w-0 flex-col">
                <span className="text-[11.5px] text-white/85">{zh ? '从当前视角新建机位' : 'Camera from current view'}</span>
                <span className="text-[10px] text-white/40">{zh ? '记录此刻的位置与朝向' : 'Snapshots position & look-at'}</span>
              </span>
            </button>
            {/* 机位预设(参考:正面中景 / 过肩 / 荷兰角……),按演员质心自动取景。 */}
            <div className="grid grid-cols-2 gap-1.5">
              {filteredPresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onAddCameraPreset(p.id)}
                  title={zh ? `新建「${p.zh}」机位` : `Add ${p.en} camera`}
                  className="flex flex-col items-center gap-1.5 rounded border border-white/10 bg-white/[0.02] px-2 py-3 text-[10.5px] text-white/75 transition hover:border-white/30 hover:bg-white/[0.07] hover:text-white"
                >
                  <Camera className="h-4 w-4 opacity-70" />
                  <span className="max-w-full truncate">{zh ? p.zh : p.en}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 操作指南面板 —— 文档化真实按键/手势（不是愿望清单）。 */
function StageHelpPanel({ onClose }: { onClose: () => void }) {
  const language = useStore((s) => s.language);
  const zh = language === 'zh';
  const Key = ({ children }: { children: React.ReactNode }) => (
    <span className="rounded border border-white/15 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/85">{children}</span>
  );
  const Row = ({ label, keys }: { label: string; keys: React.ReactNode }) => (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[11px] text-white/60">{label}</span>
      <span className="flex shrink-0 items-center gap-1">{keys}</span>
    </div>
  );
  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="flex flex-col gap-0.5">
      <div className="pb-1 pt-2 text-[11.5px] font-medium text-white/85 first:pt-0">{title}</div>
      {children}
    </div>
  );
  return (
    <div className="absolute bottom-16 left-4 w-[290px] rounded-lg border border-white/12 bg-black/85 p-4 backdrop-blur-xl">
      <div className="flex items-center justify-between pb-1">
        <span className="text-[12.5px] font-medium text-white">{zh ? '操作指南' : 'Controls'}</span>
        <button type="button" onClick={onClose} className="rounded p-0.5 text-white/40 transition hover:bg-white/[0.08] hover:text-white">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <Section title={zh ? '视角' : 'View'}>
        <Row label={zh ? '选中' : 'Select'} keys={<Key>{zh ? '左键' : 'LMB'}</Key>} />
        <Row label={zh ? '环视' : 'Orbit'} keys={<Key>{zh ? '右键 / 中键拖拽' : 'R/M drag'}</Key>} />
        <Row label={zh ? '移动' : 'Move'} keys={<><Key>W</Key><Key>A</Key><Key>S</Key><Key>D</Key></>} />
        <Row label={zh ? '升降' : 'Up / Down'} keys={<><Key>E</Key><Key>Q</Key></>} />
        <Row label={zh ? '加速' : 'Sprint'} keys={<Key>Shift</Key>} />
        <Row label={zh ? '转向' : 'Turn'} keys={<><Key>←</Key><Key>→</Key><Key>↑</Key><Key>↓</Key></>} />
        <Row label={zh ? '聚焦选中' : 'Focus'} keys={<Key>F</Key>} />
        <Row label={zh ? '调整焦距' : 'FOV'} keys={<><Key>[</Key><Key>]</Key></>} />
        <Row label={zh ? '回到原点' : 'Home'} keys={<Key>0</Key>} />
        <Row label={zh ? '缩放' : 'Zoom'} keys={<Key>{zh ? '滚轮' : 'Wheel'}</Key>} />
      </Section>
      <Section title={zh ? '编辑' : 'Edit'}>
        <Row label={zh ? '移动 / 旋转 / 缩放' : 'Gizmo modes'} keys={<Key>{zh ? '底栏按钮' : 'Toolbar'}</Key>} />
        <Row label={zh ? '吸附开关' : 'Snap'} keys={<Key>X</Key>} />
        <Row label={zh ? '俯视 / 正面' : 'Top / Front'} keys={<><Key>T</Key><Key>Y</Key></>} />
        <Row label={zh ? '撤销 / 重做' : 'Undo / Redo'} keys={<><Key>⌘Z</Key><Key>⌘⇧Z</Key></>} />
        <Row label={zh ? '删除选中' : 'Delete selection'} keys={<><Key>Del</Key><Key>⌫</Key></>} />
        <Row label={zh ? '取消选中 / 退出' : 'Deselect / Exit'} keys={<Key>Esc</Key>} />
      </Section>
      <Section title={zh ? '机位' : 'Cameras'}>
        <Row label={zh ? '应用当前视角到机位' : 'Apply view to camera'} keys={<Key>C</Key>} />
        <Row label={zh ? '确认构图 · 派生预览' : 'Confirm & derive previews'} keys={<Key>{zh ? '确认构图 ×2' : 'Confirm ×2'}</Key>} />
        <Row label={zh ? '直接从节点拉线' : 'Wire node directly'} keys={<Key>{zh ? '输出退出时镜头' : 'Exit-view output'}</Key>} />
      </Section>
    </div>
  );
}

/** 底栏弹层的公共外壳(锚在底栏上方,右对齐)。 */
function EnvPopoverShell({ title, onClose, width = 'w-[280px]', children }: {
  title: string;
  onClose: () => void;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`absolute bottom-14 right-4 z-30 flex ${width} flex-col gap-2.5 rounded-lg border border-white/12 bg-[#0b0c10]/95 p-3.5 backdrop-blur-xl`}>
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-white/85">{title}</span>
        <button type="button" onClick={onClose} className="rounded p-0.5 text-white/40 transition hover:bg-white/[0.08] hover:text-white">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {children}
    </div>
  );
}

/** 开/关 胶囊(标签面板里的显隐类设置)。 */
function TogglePill({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`rounded-full border px-2.5 py-0.5 text-[10.5px] transition ${
        on
          ? 'border-violet-300/50 bg-violet-500/25 text-violet-100'
          : 'border-white/15 bg-white/[0.04] text-white/55 hover:border-white/30 hover:text-white'
      }`}
    >
      {on ? '开' : '关'}
    </button>
  );
}

/** AI识图弹窗 —— 上传图片生成「站位参考层」(参考样式:本地上传/历史记录
 *  两个页签 + 插入/覆盖单选)。生成 = 把图半透明平铺在舞台地面辅助摆位。 */
function StageVisionModal({ onClose, onGenerate }: {
  onClose: () => void;
  onGenerate: (p: { image: string; width: number; height: number; overwrite: boolean }) => void;
}) {
  const language = useStore((s) => s.language);
  const zh = language === 'zh';
  const [tab, setTab] = useState<'upload' | 'history'>('upload');
  const [img, setImg] = useState<{ src: string; width: number; height: number } | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const readFile = (f: File | undefined | null) => {
    if (!f || !f.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const probe = new window.Image();
      probe.onload = () => setImg({ src, width: probe.naturalWidth, height: probe.naturalHeight });
      probe.src = src;
    };
    reader.readAsDataURL(f);
  };

  const RadioCard = ({ active, title, sub, onPick }: { active: boolean; title: string; sub: string; onPick: () => void }) => (
    <button
      type="button"
      onClick={onPick}
      className={`flex flex-1 flex-col gap-1 rounded-lg border px-3.5 py-3 text-left transition ${
        active ? 'border-violet-400/60 bg-violet-500/[0.10]' : 'border-white/10 bg-white/[0.02] hover:border-white/25'
      }`}
    >
      <span className="flex items-center gap-2 text-[12.5px] text-white/90">
        <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${active ? 'border-violet-300' : 'border-white/30'}`}>
          {active ? <span className="h-1.5 w-1.5 rounded-full bg-violet-300" /> : null}
        </span>
        {title}
      </span>
      <span className="pl-5.5 text-[10.5px] leading-relaxed text-white/45">{sub}</span>
    </button>
  );

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-[600px] rounded-xl border border-white/10 bg-[#101114] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between pb-3">
          <span className="text-[14px] font-medium text-white">{zh ? '生成站位参考' : 'Blocking reference'}</span>
          <button type="button" onClick={onClose} className="rounded p-1 text-white/40 transition hover:bg-white/[0.08] hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-4 border-b border-white/[0.08] pb-2">
          {(['upload', 'history'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`relative pb-1 text-[12.5px] transition ${tab === t ? 'text-white' : 'text-white/45 hover:text-white/80'}`}
            >
              {t === 'upload' ? (zh ? '本地上传' : 'Upload') : (zh ? '历史记录' : 'History')}
              {tab === t ? <span className="absolute -bottom-[9px] left-0 right-0 h-px bg-white" /> : null}
            </button>
          ))}
        </div>

        {tab === 'upload' ? (
          <div
            className="mt-4 flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-white/15 bg-white/[0.015] px-6 py-8 text-center transition hover:border-white/30"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); readFile(e.dataTransfer.files?.[0]); }}
          >
            {img ? (
              <>
                <img src={img.src} alt="站位参考" className="max-h-[180px] max-w-full rounded object-contain" />
                <span className="text-[10.5px] text-white/40">{zh ? '点击或拖拽可重新选择' : 'Click or drop to replace'}</span>
              </>
            ) : (
              <>
                <UploadCloud className="h-6 w-6 text-white/30" />
                <span className="text-[12.5px] text-white/80">
                  <span className="underline underline-offset-2">{zh ? '点击上传' : 'Click to upload'}</span>
                  {zh ? ' 或 拖拽本地图片至此上传' : ' or drop an image here'}
                </span>
                <span className="text-[10.5px] text-white/35">{zh ? '生成后作为半透明参考层平铺在舞台地面' : 'Placed on the stage floor as a translucent layer'}</span>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }}
            />
          </div>
        ) : (
          <div className="mt-4 flex min-h-[220px] items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.015] text-[11.5px] text-white/35">
            {zh ? '暂无识图记录' : 'No history yet'}
          </div>
        )}

        <div className="mt-4">
          <div className="pb-2 text-[11.5px] text-white/60">{zh ? '选择是否覆盖场景' : 'Overwrite scene?'}</div>
          <div className="flex gap-2.5">
            <RadioCard
              active={!overwrite}
              onPick={() => setOverwrite(false)}
              title={zh ? '插入当前导演台' : 'Insert into stage'}
              sub={zh ? '作为站位参考层插入,不覆盖当前全景、角色和机位' : 'Adds the reference layer, keeps backdrop, actors and cameras'}
            />
            <RadioCard
              active={overwrite}
              onPick={() => setOverwrite(true)}
              title={zh ? '覆盖当前导演台' : 'Overwrite stage'}
              sub={zh ? '作为站位参考层插入,覆盖当前全景、角色和机位' : 'Adds the layer and resets backdrop, actors and cameras'}
            />
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-white/[0.06] pt-3">
          <span className="text-[10.5px] text-white/35">
            {zh ? '生成后可在「全景」面板移除站位参考层' : 'Remove the layer later from the Backdrop panel'}
          </span>
          <button
            type="button"
            disabled={!img}
            onClick={() => img && onGenerate({ image: img.src, width: img.width, height: img.height, overwrite })}
            className="flex items-center gap-1.5 rounded-md border border-violet-400/40 bg-violet-500/[0.18] px-3.5 py-1.5 text-[12px] text-violet-50 transition hover:border-violet-400/70 hover:bg-violet-500/[0.3] disabled:cursor-default disabled:opacity-40"
          >
            {zh ? '生成站位参考' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 全景背景面板 —— 天空颜色 / 地面透明度 / 地面高度 / 显隐(参考图样式)。 */
function PanoramaPanel({ settings, onPatch, onClose, hasRefLayer = false, onRemoveRefLayer }: {
  settings: StageSettings;
  onPatch: (p: Partial<StageSettings>) => void;
  onClose: () => void;
  hasRefLayer?: boolean;
  onRemoveRefLayer?: () => void;
}) {
  const language = useStore((s) => s.language);
  const zh = language === 'zh';
  return (
    <EnvPopoverShell title={zh ? '全景背景' : 'Backdrop'} onClose={onClose}>
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-[10.5px] text-white/50">{zh ? '天空颜色' : 'Sky'}</span>
        <div className="grid flex-1 grid-cols-5 gap-1.5">
          {SKY_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onPatch({ skyColor: c })}
              title={c}
              className={`h-5 w-5 rounded-full border transition ${
                settings.skyColor === c ? 'border-violet-300 ring-1 ring-violet-300/60' : 'border-white/20 hover:border-white/50'
              }`}
              style={{ background: c }}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={() => onPatch({ skyColor: DEFAULT_STAGE_SETTINGS.skyColor })}
          className="shrink-0 rounded border border-white/12 bg-white/[0.03] px-1.5 py-1 text-[10px] text-white/60 transition hover:border-white/30 hover:text-white"
        >
          {zh ? '重置' : 'Reset'}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-[10.5px] text-white/50">{zh ? '地面透明度' : 'Ground α'}</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(settings.groundOpacity * 100)}
          onChange={(e) => onPatch({ groundOpacity: Number(e.target.value) / 100 })}
          className="flex-1 accent-violet-400"
        />
        <span className="w-9 text-right font-mono text-[10px] text-white/70">{Math.round(settings.groundOpacity * 100)}%</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-14 shrink-0 text-[10.5px] text-white/50">{zh ? '地面高度' : 'Ground Y'}</span>
        <input
          type="range"
          min={-2}
          max={2}
          step={0.05}
          value={settings.groundY}
          onChange={(e) => onPatch({ groundY: Number(e.target.value) })}
          className="flex-1 accent-violet-400"
        />
        <span className="w-9 text-right font-mono text-[10px] text-white/70">{settings.groundY.toFixed(1)}</span>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onPatch({ groundVisible: !settings.groundVisible })}
          className="flex-1 rounded border border-white/12 bg-white/[0.03] px-2 py-1.5 text-[10.5px] text-white/70 transition hover:border-white/30 hover:text-white"
        >
          {settings.groundVisible ? (zh ? '隐藏地面' : 'Hide ground') : (zh ? '显示地面' : 'Show ground')}
        </button>
        <button
          type="button"
          onClick={() => onPatch({ groundY: 0 })}
          className="flex-1 rounded border border-white/12 bg-white/[0.03] px-2 py-1.5 text-[10.5px] text-white/70 transition hover:border-white/30 hover:text-white"
        >
          {zh ? '重置高度' : 'Reset height'}
        </button>
      </div>
      {hasRefLayer && onRemoveRefLayer ? (
        <button
          type="button"
          onClick={onRemoveRefLayer}
          className="rounded border border-rose-400/25 bg-rose-500/[0.06] px-2 py-1.5 text-[10.5px] text-rose-200/90 transition hover:border-rose-400/50 hover:bg-rose-500/[0.12]"
        >
          {zh ? '移除站位参考层' : 'Remove blocking layer'}
        </button>
      ) : null}
    </EnvPopoverShell>
  );
}

/** 标签面板 —— 显示标签 / 字体大小 / 相机参考线(参考图样式)。 */
function LabelsPanel({ settings, onPatch, onClose }: {
  settings: StageSettings;
  onPatch: (p: Partial<StageSettings>) => void;
  onClose: () => void;
}) {
  const language = useStore((s) => s.language);
  const zh = language === 'zh';
  return (
    <EnvPopoverShell title={zh ? '标签' : 'Labels'} onClose={onClose} width="w-[248px]">
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] text-white/60">{zh ? '显示标签' : 'Show labels'}</span>
        <TogglePill on={settings.labelsVisible} onToggle={() => onPatch({ labelsVisible: !settings.labelsVisible })} />
      </div>
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[10.5px] text-white/60">{zh ? '字体大小' : 'Font size'}</span>
        <input
          type="range"
          min={10}
          max={32}
          step={1}
          value={settings.labelFontSize}
          onChange={(e) => onPatch({ labelFontSize: Number(e.target.value) })}
          className="flex-1 accent-violet-400"
        />
        <span className="w-6 text-right font-mono text-[10px] text-white/70">{settings.labelFontSize}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[10.5px] text-white/60">{zh ? '相机参考线' : 'Camera guides'}</span>
        <TogglePill on={settings.cameraGuides} onToggle={() => onPatch({ cameraGuides: !settings.cameraGuides })} />
      </div>
    </EnvPopoverShell>
  );
}

/** 出图比例面板 —— 设置活跃机位的 aspect(导出 / 预览都按它出图)。 */
function AspectPanel({ current, onPick, onClose }: {
  current: AspectRatio;
  onPick: (ar: AspectRatio) => void;
  onClose: () => void;
}) {
  const language = useStore((s) => s.language);
  const zh = language === 'zh';
  return (
    <EnvPopoverShell title={zh ? '出图比例' : 'Export ratio'} onClose={onClose} width="w-[188px]">
      <div className="flex flex-col gap-1">
        {ASPECT_RATIOS.map((ar) => (
          <button
            key={ar}
            type="button"
            onClick={() => onPick(ar)}
            className={`flex items-center justify-between rounded border px-2.5 py-1.5 text-[11px] transition ${
              current === ar
                ? 'border-violet-400/60 bg-violet-500/15 text-violet-100'
                : 'border-white/10 bg-white/[0.02] text-white/70 hover:border-white/25 hover:bg-white/[0.06]'
            }`}
          >
            <span className="font-mono">{ar}</span>
            <span
              className="block rounded-[2px] border border-current opacity-60"
              style={{ width: 22, aspectRatio: aspectRatioToCss(ar), maxHeight: 22 }}
            />
          </button>
        ))}
      </div>
    </EnvPopoverShell>
  );
}

function Hint({ k, v }: { k: string; v: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="rounded border border-white/12 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-white/70">{k}</span>
      <span className="text-white/50">{v}</span>
    </span>
  );
}

function ModeButton({ active, onClick, hint, icon: Icon, label }: {
  active: boolean;
  onClick: () => void;
  hint: string;
  icon: typeof Move3D;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition ${
        active
          ? 'bg-violet-500/25 text-violet-100'
          : 'text-white/60 hover:bg-white/[0.06] hover:text-white'
      }`}
    >
      <Icon className="h-3 w-3" />
      {label ? <span>{label}</span> : null}
      {hint ? <span className="font-mono text-[10px] text-white/40">{hint}</span> : null}
    </button>
  );
}
