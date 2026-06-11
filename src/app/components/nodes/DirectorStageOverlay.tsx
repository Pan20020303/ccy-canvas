import { Suspense, forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Canvas, ThreeEvent, useThree } from '@react-three/fiber';
import { CameraControls, Grid, TransformControls } from '@react-three/drei';
import {
  X, Camera, Loader2, Move3D, RotateCw, Maximize2, Plus, Video as VideoIcon, Trash2, UserPlus,
  RefreshCw, PersonStanding, Settings2, ChevronDown, Eye,
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
  assetId: string;
  label: string;
  position: [number, number, number];
  rotationY: number;
  scale: number;
  pose?: ActorPose;
};

type CameraSpec = {
  id: string;
  label: string;
  position: [number, number, number];
  lookAt: [number, number, number];
  fov: number;
  aspect: AspectRatio;
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

/** 姿势预设 —— 用 Math.PI 表达的关节欧拉角. 不追求 100% 解剖学正确,只追求
 *  "一眼能看出是哪个姿势". 用户可以再用滑杆微调. */
const PI = Math.PI;
const POSE_PRESETS: Record<string, ActorPose> = {
  '站立': DEFAULT_POSE,
  'T型': { ...DEFAULT_POSE, shoulderL: [0, 0, PI / 2], shoulderR: [0, 0, -PI / 2] },
  '行走': {
    ...DEFAULT_POSE,
    shoulderL: [PI / 5, 0, 0], shoulderR: [-PI / 5, 0, 0],
    hipL: [-PI / 6, 0, 0], hipR: [PI / 6, 0, 0],
    kneeL: [PI / 12, 0, 0], kneeR: [0, 0, 0],
  },
  '跑步': {
    ...DEFAULT_POSE,
    torso: [PI / 14, 0, 0],
    shoulderL: [PI / 2.2, 0, 0], shoulderR: [-PI / 2.2, 0, 0],
    elbowL: [PI / 2, 0, 0], elbowR: [PI / 2, 0, 0],
    hipL: [-PI / 4, 0, 0], hipR: [PI / 3, 0, 0],
    kneeL: [PI / 3, 0, 0], kneeR: [PI / 6, 0, 0],
  },
  '坐姿': {
    ...DEFAULT_POSE,
    hipL: [-PI / 2, 0, 0], hipR: [-PI / 2, 0, 0],
    kneeL: [PI / 2, 0, 0], kneeR: [PI / 2, 0, 0],
  },
  '蹲下': {
    ...DEFAULT_POSE,
    hipL: [-PI / 1.5, 0, 0], hipR: [-PI / 1.5, 0, 0],
    kneeL: [PI / 1.2, 0, 0], kneeR: [PI / 1.2, 0, 0],
    torso: [PI / 6, 0, 0],
  },
  '招手': {
    ...DEFAULT_POSE,
    shoulderR: [0, 0, -PI * 0.85],
    elbowR: [0, 0, -PI / 4],
  },
  '举手': {
    ...DEFAULT_POSE,
    shoulderR: [0, 0, -PI],
  },
  '叉腰': {
    ...DEFAULT_POSE,
    shoulderL: [0, 0, PI / 3], shoulderR: [0, 0, -PI / 3],
    elbowL: [0, -PI / 2.3, 0], elbowR: [0, PI / 2.3, 0],
  },
  '思考': {
    ...DEFAULT_POSE,
    shoulderR: [0, 0, -PI * 0.45], elbowR: [0, 0, -PI * 0.6],
    head: [PI / 14, PI / 14, 0],
  },
  '拍照': {
    ...DEFAULT_POSE,
    shoulderL: [PI / 2.5, 0, PI / 8], shoulderR: [PI / 2.5, 0, -PI / 8],
    elbowL: [PI / 3, 0, 0], elbowR: [PI / 3, 0, 0],
  },
  '指向': {
    ...DEFAULT_POSE,
    shoulderR: [-PI / 5, 0, -PI / 2.5],
  },
};

const PRESET_KEYS = Object.keys(POSE_PRESETS);

/** ============================================================
 *  Mannequin —— 程序化关节素体
 *  ============================================================
 *  以髋为根,层级:pelvis → (torso → (chest → neck → head + shoulders → arms))
 *                       → hips → legs. 每个关节是一个 <group>,姿势数据是
 *  各关节的欧拉角. T-pose 时所有角度都是 0,人物自然下垂站立. */

const POSE_MAT = '#bdbdc1';
const POSE_MAT_DEEP = '#a8a8ac';

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

  return (
    <group
      ref={setRef}
      position={actor.position}
      rotation={[0, actor.rotationY, 0]}
      scale={actor.scale}
      onClick={handleClick}
    >
      {/* 髋部根 (y=0.92 是站立髋高度) */}
      <group position={[0, 0.92, 0]}>
        {/* 髋盆 mesh */}
        <mesh castShadow>
          <boxGeometry args={[0.3, 0.2, 0.16]} />
          <meshStandardMaterial color={POSE_MAT_DEEP} roughness={0.7} />
        </mesh>

        {/* 躯干 (relative to pelvis top) */}
        <group position={[0, 0.1, 0]} rotation={p.torso}>
          {/* 上躯干 mesh */}
          <mesh position={[0, 0.13, 0]} castShadow>
            <boxGeometry args={[0.36, 0.34, 0.18]} />
            <meshStandardMaterial color={POSE_MAT} roughness={0.7} />
          </mesh>

          {/* 颈+头 */}
          <group position={[0, 0.34, 0]}>
            <mesh position={[0, 0.04, 0]} castShadow>
              <cylinderGeometry args={[0.05, 0.06, 0.08, 12]} />
              <meshStandardMaterial color="#cfcfd2" roughness={0.6} />
            </mesh>
            <group position={[0, 0.04, 0]} rotation={p.head}>
              <mesh position={[0, 0.18, 0]} castShadow>
                <sphereGeometry args={[0.13, 16, 16]} />
                <meshStandardMaterial color="#cfcfd2" roughness={0.6} />
              </mesh>
              <Billboard text={actor.label} position={[0, 0.42, 0]} />
            </group>
          </group>

          {/* 左肩 → 左臂 */}
          <group position={[-0.18, 0.24, 0]} rotation={p.shoulderL}>
            <mesh position={[0, -0.18, 0]} castShadow>
              <cylinderGeometry args={[0.05, 0.045, 0.36, 12]} />
              <meshStandardMaterial color={POSE_MAT} roughness={0.7} />
            </mesh>
            <group position={[0, -0.36, 0]} rotation={p.elbowL}>
              <mesh position={[0, -0.16, 0]} castShadow>
                <cylinderGeometry args={[0.045, 0.04, 0.32, 12]} />
                <meshStandardMaterial color={POSE_MAT_DEEP} roughness={0.7} />
              </mesh>
            </group>
          </group>

          {/* 右肩 → 右臂 */}
          <group position={[0.18, 0.24, 0]} rotation={p.shoulderR}>
            <mesh position={[0, -0.18, 0]} castShadow>
              <cylinderGeometry args={[0.05, 0.045, 0.36, 12]} />
              <meshStandardMaterial color={POSE_MAT} roughness={0.7} />
            </mesh>
            <group position={[0, -0.36, 0]} rotation={p.elbowR}>
              <mesh position={[0, -0.16, 0]} castShadow>
                <cylinderGeometry args={[0.045, 0.04, 0.32, 12]} />
                <meshStandardMaterial color={POSE_MAT_DEEP} roughness={0.7} />
              </mesh>
            </group>
          </group>
        </group>

        {/* 左髋 → 左腿 */}
        <group position={[-0.08, 0, 0]} rotation={p.hipL}>
          <mesh position={[0, -0.25, 0]} castShadow>
            <cylinderGeometry args={[0.065, 0.05, 0.5, 12]} />
            <meshStandardMaterial color={POSE_MAT} roughness={0.7} />
          </mesh>
          <group position={[0, -0.5, 0]} rotation={p.kneeL}>
            <mesh position={[0, -0.16, 0]} castShadow>
              <cylinderGeometry args={[0.05, 0.04, 0.32, 12]} />
              <meshStandardMaterial color={POSE_MAT_DEEP} roughness={0.7} />
            </mesh>
          </group>
        </group>

        {/* 右髋 → 右腿 */}
        <group position={[0.08, 0, 0]} rotation={p.hipR}>
          <mesh position={[0, -0.25, 0]} castShadow>
            <cylinderGeometry args={[0.065, 0.05, 0.5, 12]} />
            <meshStandardMaterial color={POSE_MAT} roughness={0.7} />
          </mesh>
          <group position={[0, -0.5, 0]} rotation={p.kneeR}>
            <mesh position={[0, -0.16, 0]} castShadow>
              <cylinderGeometry args={[0.05, 0.04, 0.32, 12]} />
              <meshStandardMaterial color={POSE_MAT_DEEP} roughness={0.7} />
            </mesh>
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

  // refs
  const cameraControlsRef = useRef<any>(null);
  const transformControlsRef = useRef<any>(null);
  const captureRef = useRef<CaptureFn | null>(null);
  const multiCaptureRef = useRef<MultiCaptureFn | null>(null);

  const [capturing, setCapturing] = useState(false);

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
    setCameras((prev) => prev.map((c) => c.id === cameraId ? {
      ...c,
      position: [pos.x, pos.y, pos.z],
      lookAt: [tgt.x, tgt.y, tgt.z],
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
    const cam: CameraSpec = {
      id,
      label: `机位${nextIndex}`,
      position: [pos.x, pos.y, pos.z],
      lookAt: [tgt.x, tgt.y, tgt.z],
      fov: 50,
      aspect: '16:9',
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

  const onConfirm = useCallback(async () => {
    if (!nodeId) return;
    setCapturing(true);
    try {
      // 先把当前视口写入活跃机位 (用户可能正在调主视图).
      let updatedCameras = cameras;
      const cc = cameraControlsRef.current;
      if (cc) {
        const pos = new THREE.Vector3();
        const tgt = new THREE.Vector3();
        cc.getPosition(pos);
        cc.getTarget(tgt);
        updatedCameras = cameras.map((c) => c.id === activeCameraId ? {
          ...c,
          position: [pos.x, pos.y, pos.z] as [number, number, number],
          lookAt: [tgt.x, tgt.y, tgt.z] as [number, number, number],
        } : c);
        setCameras(updatedCameras);
      }
      // 逐机位渲染 + 截图.
      const captures: Record<string, string> = await (multiCaptureRef.current?.(updatedCameras) ?? Promise.resolve({} as Record<string, string>));
      const lastCaptures: Record<string, { image: string; timestamp: number }> = {};
      const ts = Date.now();
      for (const [camId, img] of Object.entries(captures)) {
        lastCaptures[camId] = { image: img, timestamp: ts };
      }
      const activeImg = captures[activeCameraId];
      const patch: Partial<DirectorStageData> = {
        status: 'done',
        characters: actors,
        cameras: updatedCameras,
        activeCameraId,
        lastCaptures,
        // 也写一份 lastCapture 兼容老的单 source handle 用法.
        lastCapture: activeImg ? {
          cameraId: activeCameraId,
          image: activeImg,
          timestamp: ts,
        } : undefined,
      };
      updateNodeData(nodeId, patch as Record<string, unknown>);
    } finally {
      setCapturing(false);
      close();
    }
  }, [nodeId, updateNodeData, close, activeCameraId, actors, cameras]);

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
          <ambientLight intensity={0.45} />
          <directionalLight
            position={[4, 6, 3]}
            intensity={1.1}
            castShadow
            shadow-mapSize-width={1024}
            shadow-mapSize-height={1024}
          />
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
            <axesHelper args={[3]} />
            {actors.map((a) => (
              <Mannequin
                key={a.id}
                actor={a}
                selected={selection?.kind === 'actor' && selection.id === a.id}
                onSelect={onSelectActor}
              />
            ))}
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

        {/* 右侧:选中演员时,姿势面板 */}
        {selectedActor ? (
          <PosePanel
            actor={selectedActor}
            onApplyPreset={(name) => applyPosePreset(selectedActor.id, name)}
            onUpdatePose={(patch) => updateActorPose(selectedActor.id, patch)}
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

      {/* 底部状态栏 + 确认. */}
      <div className="flex items-center justify-between border-t border-white/[0.06] px-4 py-3">
        <div className="text-[11px] text-white/40">
          {language === 'zh'
            ? `${actors.length} 角色 · ${cameras.length} 机位 · 确认时按机位逐张出图,每张图独立连线`
            : `${actors.length} actors · ${cameras.length} cameras · captures one image per camera on confirm`}
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
            className="flex items-center gap-1.5 rounded-md border border-violet-400/30 bg-violet-500/[0.16] px-3 py-1.5 text-[12px] text-violet-50 transition hover:border-violet-400/60 hover:bg-violet-500/[0.28] disabled:opacity-50"
          >
            {capturing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
            {language === 'zh' ? `确认构图 (×${cameras.length})` : `Capture (×${cameras.length})`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** ============================================================
 *  PosePanel —— 选中演员时右侧弹出的姿势 / 关节面板
 *  ============================================================ */

function PosePanel({ actor, onApplyPreset, onUpdatePose }: {
  actor: ActorTransform;
  onApplyPreset: (name: string) => void;
  onUpdatePose: (patch: Partial<ActorPose>) => void;
}) {
  const language = useStore((s) => s.language);
  const pose = { ...DEFAULT_POSE, ...(actor.pose ?? {}) };
  const [tab, setTab] = useState<'preset' | 'manual'>('preset');

  return (
    <div className="absolute right-4 top-4 flex w-[260px] flex-col gap-2 rounded-md border border-white/12 bg-black/80 p-3 backdrop-blur-xl">
      <div className="flex items-center gap-2 text-[11.5px] text-white/80">
        <PersonStanding className="h-3.5 w-3.5 text-violet-300" />
        <span className="font-medium">{actor.label}</span>
        <span className="text-white/30">·</span>
        <span className="text-white/50">{language === 'zh' ? '姿势' : 'Pose'}</span>
        <button
          type="button"
          onClick={() => setTab(tab === 'preset' ? 'manual' : 'preset')}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-white/60 hover:bg-white/[0.06] hover:text-white"
        >
          <Settings2 className="h-3 w-3" />
          {tab === 'preset' ? (language === 'zh' ? '微调' : 'Manual') : (language === 'zh' ? '预设' : 'Presets')}
        </button>
      </div>

      {tab === 'preset' ? (
        <div className="grid grid-cols-3 gap-1 max-h-[420px] overflow-y-auto pr-1">
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
