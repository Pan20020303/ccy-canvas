import React, { Suspense, forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Canvas, ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { CameraControls, Grid, TransformControls, useGLTF } from '@react-three/drei';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import {
  X, Camera, Loader2, Move3D, RotateCw, Maximize2, Plus, Video as VideoIcon, Trash2, UserPlus,
  RefreshCw, PersonStanding, Settings2, ChevronDown, Eye, Lock,
} from 'lucide-react';
import * as THREE from 'three';

import { useStore } from '../../store';
import type { DirectorStageData, ActorPose } from './DirectorStageNode';

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
const BODY_TYPES: Record<string, { label: string; defaultColor: string; widthMul: number; heightMul: number; headBoost: number; glbUrl: string }> = {
  'mannequin-standard': { label: '标准素体', defaultColor: '#d6cdbf', widthMul: 1.00, heightMul: 1.00, headBoost: 1.00, glbUrl: '/mannequins/standard.glb' },
  'mannequin-female':   { label: '女性素体', defaultColor: '#e0d4c4', widthMul: 0.92, heightMul: 0.96, headBoost: 1.00, glbUrl: '/mannequins/female.glb' },
  'mannequin-child':    { label: '儿童素体', defaultColor: '#dfc8b0', widthMul: 0.78, heightMul: 0.72, headBoost: 1.18, glbUrl: '/mannequins/child.glb' },
  'mannequin-sturdy':   { label: '壮实素体', defaultColor: '#c8bda8', widthMul: 1.14, heightMul: 1.02, headBoost: 0.98, glbUrl: '/mannequins/sturdy.glb' },
  'mannequin-slim':     { label: '纤细素体', defaultColor: '#dad0c0', widthMul: 0.88, heightMul: 1.04, headBoost: 1.00, glbUrl: '/mannequins/slim.glb' },
};
const BODY_TYPE_IDS = Object.keys(BODY_TYPES);
function bodyTypeOf(assetId: string) {
  return BODY_TYPES[assetId] ?? BODY_TYPES['mannequin-standard'];
}

type CameraSpec = {
  id: string;
  label: string;
  position: [number, number, number];
  lookAt: [number, number, number];
  fov: number;
  aspect: AspectRatio;
  /** "应用视图到此机位"时拍下的快照. 每个机位只保留一份,
   *  下次再 apply 直接覆盖. 显示在右下角面板里. */
  previewImage?: string;
};

type SelectionKind = 'actor' | 'camera';
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
};

const DEFAULT_ACTOR: ActorTransform = {
  id: 'actor-default',
  assetId: 'mannequin-standard',
  label: '角色A',
  position: [0, 0, 0],
  rotationY: 0,
  scale: 1,
  pose: DEFAULT_POSE,
};

const DEFAULT_CAMERA: CameraSpec = {
  id: 'cam-1',
  label: '机位1',
  position: [3.5, 2.2, 4.5],
  lookAt: [0, 1.2, 0],
  fov: 50,
  aspect: '16:9',
};

const ASPECT_RATIOS: AspectRatio[] = ['16:9', '9:16', '1:1', '4:3', '21:9'];

/** "16:9" → "16 / 9" 给 CSS aspect-ratio 用. */
function aspectRatioToCss(ar: AspectRatio): string {
  const [w, h] = ar.split(':');
  return `${w} / ${h}`;
}

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
 *  procedural 回落素体的 bind pose 是 arms-down,在它上面套这些值会有
 *  视觉偏差 —— 但 procedural 现在只是"GLB 缺失时的应急显示",不是主要
 *  目标体.
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
const POSE_MAT = '#d6cdbf';      // 主肢体表面色
const POSE_MAT_DEEP = '#b9b0a0'; // 关节/腹/下肢深一档
const POSE_HEAD = '#e1d6c4';     // 头/颈/手 略亮,做高光区

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
}>(function Mannequin({ actor, selected, onSelect }, ref) {
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
              <Billboard text={actor.label} position={[0, 0.4, 0]} />
            </group>
          </group>

          {/* 左肩 + 左臂 —— 单段上臂胶囊 (无凸起肌肉) + 肘关节球 + 前臂
              + 手. 主体用 capsule 而非 cylinder, 两端自然圆润. */}
          <group position={[-0.18, 0.22, 0]} rotation={p.shoulderL}>
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
            <group position={[0, -0.36, 0]} rotation={p.elbowL}>
              <mesh castShadow>
                <sphereGeometry args={[0.04, 14, 14]} />
                <meshStandardMaterial color={bodyColor} roughness={0.5} />
              </mesh>
              {/* 前臂 capsule —— 略细于上臂 */}
              <mesh position={[0, -0.17, 0]} castShadow>
                <capsuleGeometry args={[0.037, 0.24, 6, 16]} />
                <meshStandardMaterial color={bodyColor} roughness={0.55} />
              </mesh>
              {/* 手 —— 手掌 + 拇指 */}
              <group position={[0, -0.36, 0]}>
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
          <group position={[0.18, 0.22, 0]} rotation={p.shoulderR}>
            <mesh castShadow scale={[1.15, 1, 1.05]}>
              <sphereGeometry args={[0.062, 16, 16]} />
              <meshStandardMaterial color={bodyColor} roughness={0.5} />
            </mesh>
            <mesh position={[0, -0.19, 0]} castShadow>
              <capsuleGeometry args={[0.045, 0.28, 6, 16]} />
              <meshStandardMaterial color={bodyColor} roughness={0.55} />
            </mesh>
            <group position={[0, -0.36, 0]} rotation={p.elbowR}>
              <mesh castShadow>
                <sphereGeometry args={[0.04, 14, 14]} />
                <meshStandardMaterial color={bodyColor} roughness={0.5} />
              </mesh>
              <mesh position={[0, -0.17, 0]} castShadow>
                <capsuleGeometry args={[0.037, 0.24, 6, 16]} />
                <meshStandardMaterial color={bodyColor} roughness={0.55} />
              </mesh>
              <group position={[0, -0.36, 0]}>
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
            {/* 脚 —— 脚跟球 + 脚掌长椭球 */}
            <group position={[0, -0.32, 0]}>
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
            <group position={[0, -0.32, 0]}>
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
  torso:     ['Spine', 'Spine1', 'Spine2', 'spine', 'mixamorigSpine'],
  head:      ['Head', 'head', 'mixamorigHead'],
  shoulderL: ['LeftArm', 'arm_L', 'arm.L', 'LeftShoulder', 'mixamorigLeftArm'],
  shoulderR: ['RightArm', 'arm_R', 'arm.R', 'RightShoulder', 'mixamorigRightArm'],
  elbowL:    ['LeftForeArm', 'forearm_L', 'forearm.L', 'mixamorigLeftForeArm'],
  elbowR:    ['RightForeArm', 'forearm_R', 'forearm.R', 'mixamorigRightForeArm'],
  hipL:      ['LeftUpLeg', 'upper_leg_L', 'upper_leg.L', 'thigh_L', 'thigh.L', 'mixamorigLeftUpLeg'],
  hipR:      ['RightUpLeg', 'upper_leg_R', 'upper_leg.R', 'thigh_R', 'thigh.R', 'mixamorigRightUpLeg'],
  kneeL:     ['LeftLeg', 'lower_leg_L', 'lower_leg.L', 'shin_L', 'shin.L', 'mixamorigLeftLeg'],
  kneeR:     ['RightLeg', 'lower_leg_R', 'lower_leg.R', 'shin_R', 'shin.R', 'mixamorigRightLeg'],
};

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
  // pass 2: includes match (case-insensitive). Mixamo 喜欢加前缀 mixamorig 之类.
  const lowered = candidates.map((c) => c.toLowerCase());
  let hit: THREE.Bone | null = null;
  root.traverse((obj) => {
    if (hit) return;
    if ((obj as THREE.Bone).isBone) {
      const n = obj.name.toLowerCase();
      for (const c of lowered) {
        if (n.includes(c)) { hit = obj as THREE.Bone; return; }
      }
    }
  });
  return hit;
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
}>(function SkinnedMannequin({ actor, selected, onSelect }, ref) {
  const bt = bodyTypeOf(actor.assetId);
  // useGLTF 会 Suspense, 调用方需要在 <Suspense> 里包.
  const { scene } = useGLTF(bt.glbUrl);
  // 每个 actor 独立一份 clone, 避免共享 skeleton 一动全动.
  const cloned = useMemo(() => cloneSkeleton(scene), [scene]);
  const bones = useMemo(() => {
    const map: Partial<Record<keyof ActorPose, THREE.Bone>> = {};
    for (const key of Object.keys(BONE_NAME_PATTERNS) as Array<keyof Required<ActorPose>>) {
      const bone = findBoneInScene(cloned, BONE_NAME_PATTERNS[key]);
      if (bone) map[key] = bone;
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
      const bone = bones[key];
      const r = p[key];
      if (bone && r) bone.rotation.set(r[0], r[1], r[2]);
    }
  });

  const finalRotation: [number, number, number] = actor.rotation ?? [0, actor.rotationY, 0];
  const finalScale: [number, number, number] = actor.scaleXYZ ?? [actor.scale, actor.scale, actor.scale];

  return (
    <group
      ref={setRef}
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
      <Billboard text={actor.label} position={[0, 1.95, 0]} />
    </group>
  );
});

/** 文字浮标 —— 永远朝向相机. */
function Billboard({ text, position }: { text: string; position: [number, number, number] }) {
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
  return (
    <sprite position={position} scale={[0.45, 0.11, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

/** 场景里的相机标记物 —— 一个橙色相机外形,可点选,可 TransformControls 拖.
 *  active 那个机位不渲染(我们正在透过它看场景). */
const CameraMarker = forwardRef<THREE.Group, {
  camera: CameraSpec;
  isActive: boolean;
  selected: boolean;
  onSelect: (id: string, obj: THREE.Object3D) => void;
}>(function CameraMarker({ camera: cam, isActive, selected, onSelect }, ref) {
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

  if (isActive) return null;

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (gRef.current) onSelect(cam.id, gRef.current);
  };

  return (
    <group ref={setRef} position={cam.position} onClick={handleClick}>
      {/* 主体外壳 */}
      <mesh castShadow>
        <boxGeometry args={[0.22, 0.18, 0.3]} />
        <meshStandardMaterial
          color={selected ? '#fcd34d' : '#f59e0b'}
          emissive={selected ? '#fde68a' : '#f59e0b'}
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
      {/* 标签 */}
      <Billboard text={cam.label} position={[0, 0.3, 0]} />
    </group>
  );
});

/** 把 r3f 内部的 toDataURL 暴露给 overlay 外部.
 *  - `singleRef` 当前主视口截一帧 (用于"应用到机位"等流程)
 *  - `multiRef` 接收机位列表,**逐机位 setLookAt + 渲染 + 截图**,返回每个机位的 DataURL */
function CaptureBridge({
  singleRef,
  multiRef,
  cameraControlsRef,
}: {
  singleRef: React.MutableRefObject<CaptureFn | null>;
  multiRef: React.MutableRefObject<MultiCaptureFn | null>;
  cameraControlsRef: React.MutableRefObject<any>;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    singleRef.current = () => {
      gl.render(scene, camera);
      try {
        return gl.domElement.toDataURL('image/png');
      } catch (err) {
        console.error('[DirectorStage] capture failed', err);
        return null;
      }
    };
    multiRef.current = async (cams: CameraSpec[]) => {
      const cc = cameraControlsRef.current;
      const persp = camera as THREE.PerspectiveCamera;
      const results: Record<string, string> = {};
      if (!cc) return results;
      // 记录原始 FOV 以便最后恢复.
      const originalFov = persp.fov;
      for (const cam of cams) {
        cc.setLookAt(
          cam.position[0], cam.position[1], cam.position[2],
          cam.lookAt[0], cam.lookAt[1], cam.lookAt[2],
          false,
        );
        persp.fov = cam.fov;
        persp.updateProjectionMatrix();
        // 等一帧让 CameraControls 内部完成更新.
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        gl.render(scene, persp);
        try {
          results[cam.id] = gl.domElement.toDataURL('image/png');
        } catch (err) {
          console.error('[DirectorStage] multi-capture failed for', cam.id, err);
        }
      }
      persp.fov = originalFov;
      persp.updateProjectionMatrix();
      return results;
    };
    return () => {
      singleRef.current = null;
      multiRef.current = null;
    };
  }, [gl, scene, camera, singleRef, multiRef, cameraControlsRef]);

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

  // 选中态 (actor 或 camera).
  const [selection, setSelection] = useState<Selection | null>(null);
  const [mode, setMode] = useState<TransformMode>('translate');
  const [presetFlash, setPresetFlash] = useState<{ camId: string } | null>(null);

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

  const onDeselect = useCallback(() => setSelection(null), []);

  /** ====== Actor management ====== */

  const addActor = useCallback(() => {
    setActors((prev) => {
      const nextIndex = prev.length + 1;
      const labelChar = nextIndex <= 26 ? String.fromCharCode(64 + nextIndex) : null;
      const label = labelChar ? `角色${labelChar}` : `Actor-${nextIndex}`;
      const offsetX = (prev.length % 4) * 0.8 - 1.2;
      const offsetZ = Math.floor(prev.length / 4) * 0.8;
      const newActor: ActorTransform = {
        id: `actor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        assetId: 'mannequin-standard',
        label,
        position: [offsetX, 0, offsetZ],
        rotationY: 0,
        scale: 1,
        pose: DEFAULT_POSE,
      };
      return [...prev, newActor];
    });
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

  const switchToCamera = useCallback((id: string) => {
    const cam = cameras.find((c) => c.id === id);
    const cc = cameraControlsRef.current;
    if (!cam || !cc) return;
    setActiveCameraId(id);
    cc.setLookAt(
      cam.position[0], cam.position[1], cam.position[2],
      cam.lookAt[0], cam.lookAt[1], cam.lookAt[2],
      true,
    );
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
      DEFAULT_CAMERA.position[0], DEFAULT_CAMERA.position[1], DEFAULT_CAMERA.position[2],
      DEFAULT_CAMERA.lookAt[0], DEFAULT_CAMERA.lookAt[1], DEFAULT_CAMERA.lookAt[2],
      true,
    );
  }, []);

  useEffect(() => {
    if (!nodeId) return;
    const cc = cameraControlsRef.current;
    if (!cc || !activeCamera) return;
    const id = requestAnimationFrame(() => {
      const healthy = isCameraStateHealthy(activeCamera.position, activeCamera.lookAt);
      const p = healthy ? activeCamera.position : DEFAULT_CAMERA.position;
      const l = healthy ? activeCamera.lookAt : DEFAULT_CAMERA.lookAt;
      cc.setLookAt(p[0], p[1], p[2], l[0], l[1], l[2], false);
    });
    return () => cancelAnimationFrame(id);
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
        cameras,
        activeCameraId,
        editorPreview,
        lastCaptures,
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
  }, [nodeId, node, updateNodeData, close, activeCameraId, actors, cameras, addNode, onConnect]);

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
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') {
        if (selection) onDeselect();
        else close();
        return;
      }
      if (k === 'w') setMode('translate');
      else if (k === 'e' || k === 'r') setMode('rotate');
      else if (k === 's') setMode('scale');
      else if (k === 'c') applyViewToCamera(activeCameraId);
      else if ((k === 'delete' || k === 'backspace') && selection) {
        e.preventDefault();
        if (selection.kind === 'actor') removeActor(selection.id);
        else if (selection.kind === 'camera') removeCamera(selection.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nodeId, selection, close, onDeselect, applyViewToCamera, activeCameraId, removeActor, removeCamera]);

  if (!nodeId || !node) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-[#050507]">
      {/* 顶部操作提示栏 */}
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3 text-[12px] text-white/60">
        <div className="flex items-center gap-3">
          <span className="font-medium text-white/90">{language === 'zh' ? '导演台' : 'Director Stage'}</span>
          <span className="text-white/30">·</span>
          <span className="font-mono text-[11px] text-white/40">{node.id}</span>
        </div>
        <div className="hidden items-center gap-3 md:flex">
          <Hint k="左键拖拽" v={language === 'zh' ? '旋转' : 'Rotate'} />
          <Hint k="右键拖拽" v={language === 'zh' ? '平移' : 'Pan'} />
          <Hint k="滚轮" v={language === 'zh' ? '缩放' : 'Zoom'} />
          <Hint k="W / E / S" v={language === 'zh' ? '移动 / 旋转 / 缩放' : 'Move / Rotate / Scale'} />
          <Hint k="C" v={language === 'zh' ? '应用视图到活跃机位' : 'Apply view'} />
        </div>
        <button
          type="button"
          onClick={close}
          className="flex h-7 w-7 items-center justify-center rounded-md text-white/60 transition hover:bg-white/[0.06] hover:text-white"
          title="Esc"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 3D 视口 */}
      <div className="relative flex-1">
        <Canvas
          shadows
          dpr={[1, 2]}
          gl={{ preserveDrawingBuffer: true, antialias: true }}
          camera={{ position: [3.5, 2.2, 4.5], fov: 50 }}
          style={{ background: '#050507' }}
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
          {/* Rim / back light —— 背光勾出身体轮廓 */}
          <directionalLight position={[-1, 4, -4]} intensity={0.7} color="#d6c9b5" />
          <Suspense fallback={null}>
            <Grid
              args={[40, 40]}
              cellSize={0.5}
              cellThickness={0.5}
              cellColor="#1a1d24"
              sectionSize={2}
              sectionThickness={1}
              sectionColor="#2a2e38"
              fadeDistance={30}
              fadeStrength={1}
              infiniteGrid
            />
            {/* 坐标轴 —— 仅在有选中时(actor 或 camera)显示, 没选时
                场景干净, 跟最终出图风格一致. 0.5 长度刚好够辨认 X/Y/Z
                方向不喧宾夺主. */}
            {selection ? <axesHelper args={[0.5]} /> : null}
            {actors.map((a) => {
              const url = bodyTypeOf(a.assetId).glbUrl;
              const haveGLB = url ? glbAvailable[url] === true : false;
              const isSelected = selection?.kind === 'actor' && selection.id === a.id;
              const procedural = (
                <Mannequin
                  key={a.id}
                  actor={a}
                  selected={isSelected}
                  onSelect={onSelectActor}
                />
              );
              return haveGLB ? (
                <GLBErrorBoundary key={a.id} fallback={procedural}>
                  <SkinnedMannequin
                    actor={a}
                    selected={isSelected}
                    onSelect={onSelectActor}
                  />
                </GLBErrorBoundary>
              ) : procedural;
            })}
            {cameras.map((cam) => (
              <CameraMarker
                key={cam.id}
                camera={cam}
                isActive={cam.id === activeCameraId}
                selected={selection?.kind === 'camera' && selection.id === cam.id}
                onSelect={onSelectCamera}
              />
            ))}
            {selection ? (
              <TransformControls
                ref={transformControlsRef}
                object={selection.obj}
                mode={selection.kind === 'camera' ? 'translate' : mode}
                size={1.1}
              />
            ) : null}
          </Suspense>
          <CameraControls ref={cameraControlsRef} makeDefault />
          <CaptureBridge
            singleRef={captureRef}
            multiRef={multiCaptureRef}
            cameraControlsRef={cameraControlsRef}
          />
        </Canvas>

        {/* 左上工具栏 */}
        <div className="absolute left-4 top-4 flex items-center gap-2">
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
                    : cameras.find((c) => c.id === selection.id)?.label ?? selection.id}
                </span>
                <span className="text-white/30">·</span>
                <span className="inline-flex items-center gap-1 text-violet-200">
                  {(selection.kind === 'camera' ? 'translate' : mode) === 'translate' && <><Move3D className="h-3 w-3" /> {language === 'zh' ? '移动' : 'Move'}</>}
                  {mode === 'rotate' && selection.kind === 'actor' && <><RotateCw className="h-3 w-3" /> {language === 'zh' ? '旋转' : 'Rotate'}</>}
                  {mode === 'scale' && selection.kind === 'actor' && <><Maximize2 className="h-3 w-3" /> {language === 'zh' ? '缩放' : 'Scale'}</>}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (selection.kind === 'actor') removeActor(selection.id);
                  else if (selection.kind === 'camera') removeCamera(selection.id);
                }}
                disabled={selection.kind === 'actor' ? actors.length <= 1 : cameras.length <= 1}
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
                ? '点演员或相机选中,再拖 Gizmo 调位置'
                : 'Click an actor or camera to select, then drag the gizmo'}
            </div>
          )}
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

        {/* 左下:操作模式 + 应用到机位 + 重置. */}
        <div className="absolute bottom-4 left-4 flex gap-1 rounded-md border border-white/12 bg-black/70 p-1 backdrop-blur-md">
          <ModeButton active={mode === 'translate'} onClick={() => setMode('translate')} hint="W" icon={Move3D} />
          <ModeButton active={mode === 'rotate'} onClick={() => setMode('rotate')} hint="E" icon={RotateCw} />
          <ModeButton active={mode === 'scale'} onClick={() => setMode('scale')} hint="S" icon={Maximize2} />
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
          <button
            type="button"
            onClick={resetView}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.06] hover:text-white"
          >
            <RefreshCw className="h-3 w-3" />
            <span>{language === 'zh' ? '重置视图' : 'Reset'}</span>
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
                    if (!isActive) switchToCamera(cam.id);
                    // 同时选中场景里的相机标记物.
                    // (点击列表 = 关注这个机位.)
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
          {/* 活跃机位的预览快照 —— 「应用视图到此机位」时刚抓的那张.
              一个机位只保留一份 previewImage,新 apply 直接覆盖. */}
          {activeCamera ? (
            <div className="overflow-hidden rounded border border-white/10 bg-black/60">
              <div
                className="relative w-full bg-black"
                style={{ aspectRatio: aspectRatioToCss(activeCamera.aspect) }}
              >
                {activeCamera.previewImage ? (
                  <img
                    src={activeCamera.previewImage}
                    alt={`${activeCamera.label} preview`}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] text-white/35">
                    {language === 'zh' ? '点「应用到机位」抓取预览' : 'Click "Apply" to capture preview'}
                  </div>
                )}
                <span className="absolute left-1 top-1 rounded bg-black/55 px-1.5 py-px text-[9px] font-medium text-white/80 backdrop-blur-sm">
                  {activeCamera.label}
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

      {/* 底部状态栏 + 确认. */}
      <div className="flex items-center justify-between border-t border-white/[0.06] px-4 py-3">
        <div className="text-[11px] text-white/40">
          {language === 'zh'
            ? `${actors.length} 角色 · ${cameras.length} 机位 · 确认两次后按机位派生「构图预览」节点`
            : `${actors.length} actors · ${cameras.length} cameras · click confirm twice to spawn per-camera preview nodes`}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={close}
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
    <div className="absolute right-4 top-4 flex w-[280px] flex-col gap-2 rounded-md border border-white/12 bg-black/80 p-3 backdrop-blur-xl">
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
            <PoseSlider label={language === 'zh' ? '前倾' : 'Pitch'} value={pose.torso[0]} onChange={(v) => onUpdatePose({ torso: [v, pose.torso[1], pose.torso[2]] })} />
            <PoseSlider label={language === 'zh' ? '转身' : 'Yaw'} value={pose.torso[1]} onChange={(v) => onUpdatePose({ torso: [pose.torso[0], v, pose.torso[2]] })} />
            <PoseSlider label={language === 'zh' ? '侧倾' : 'Roll'} value={pose.torso[2]} onChange={(v) => onUpdatePose({ torso: [pose.torso[0], pose.torso[1], v] })} />
          </PoseSection>
          <PoseSection title={language === 'zh' ? '头部' : 'Head'}>
            <PoseSlider label={language === 'zh' ? '点头' : 'Nod'} value={pose.head[0]} onChange={(v) => onUpdatePose({ head: [v, pose.head[1], pose.head[2]] })} />
            <PoseSlider label={language === 'zh' ? '转头' : 'Yaw'} value={pose.head[1]} onChange={(v) => onUpdatePose({ head: [pose.head[0], v, pose.head[2]] })} />
            <PoseSlider label={language === 'zh' ? '歪头' : 'Tilt'} value={pose.head[2]} onChange={(v) => onUpdatePose({ head: [pose.head[0], pose.head[1], v] })} />
          </PoseSection>
          <PoseSection title={language === 'zh' ? '左臂' : 'Left Arm'}>
            <PoseSlider label={language === 'zh' ? '前举' : 'Lift'} value={pose.shoulderL[0]} onChange={(v) => onUpdatePose({ shoulderL: [v, pose.shoulderL[1], pose.shoulderL[2]] })} />
            <PoseSlider label={language === 'zh' ? '外展' : 'Abduct'} value={pose.shoulderL[2]} onChange={(v) => onUpdatePose({ shoulderL: [pose.shoulderL[0], pose.shoulderL[1], v] })} />
            <PoseSlider label={language === 'zh' ? '肘弯' : 'Elbow'} value={pose.elbowL[0]} onChange={(v) => onUpdatePose({ elbowL: [v, pose.elbowL[1], pose.elbowL[2]] })} />
          </PoseSection>
          <PoseSection title={language === 'zh' ? '右臂' : 'Right Arm'}>
            <PoseSlider label={language === 'zh' ? '前举' : 'Lift'} value={pose.shoulderR[0]} onChange={(v) => onUpdatePose({ shoulderR: [v, pose.shoulderR[1], pose.shoulderR[2]] })} />
            <PoseSlider label={language === 'zh' ? '外展' : 'Abduct'} value={pose.shoulderR[2]} onChange={(v) => onUpdatePose({ shoulderR: [pose.shoulderR[0], pose.shoulderR[1], v] })} />
            <PoseSlider label={language === 'zh' ? '肘弯' : 'Elbow'} value={pose.elbowR[0]} onChange={(v) => onUpdatePose({ elbowR: [v, pose.elbowR[1], pose.elbowR[2]] })} />
          </PoseSection>
          <PoseSection title={language === 'zh' ? '左腿' : 'Left Leg'}>
            <PoseSlider label={language === 'zh' ? '抬腿' : 'Lift'} value={pose.hipL[0]} onChange={(v) => onUpdatePose({ hipL: [v, pose.hipL[1], pose.hipL[2]] })} />
            <PoseSlider label={language === 'zh' ? '膝弯' : 'Knee'} value={pose.kneeL[0]} onChange={(v) => onUpdatePose({ kneeL: [v, pose.kneeL[1], pose.kneeL[2]] })} />
          </PoseSection>
          <PoseSection title={language === 'zh' ? '右腿' : 'Right Leg'}>
            <PoseSlider label={language === 'zh' ? '抬腿' : 'Lift'} value={pose.hipR[0]} onChange={(v) => onUpdatePose({ hipR: [v, pose.hipR[1], pose.hipR[2]] })} />
            <PoseSlider label={language === 'zh' ? '膝弯' : 'Knee'} value={pose.kneeR[0]} onChange={(v) => onUpdatePose({ kneeR: [v, pose.kneeR[1], pose.kneeR[2]] })} />
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

/** 滑杆值是欧拉角度,显示成度数(°),内部存弧度. */
function PoseSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const deg = Math.round((value * 180) / PI);
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <span className="w-10 shrink-0 text-white/50">{label}</span>
      <input
        type="range"
        min={-180}
        max={180}
        step={1}
        value={deg}
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
    <div className="absolute right-4 top-4 flex w-[260px] flex-col gap-2 rounded-md border border-amber-300/30 bg-black/80 p-3 backdrop-blur-xl">
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

function Hint({ k, v }: { k: string; v: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="rounded border border-white/12 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-white/70">{k}</span>
      <span className="text-white/50">{v}</span>
    </span>
  );
}

function ModeButton({ active, onClick, hint, icon: Icon }: {
  active: boolean;
  onClick: () => void;
  hint: string;
  icon: typeof Move3D;
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
      <span className="font-mono text-[10px] text-white/40">{hint}</span>
    </button>
  );
}
