import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useLoader, useThree, type ThreeEvent } from '@react-three/fiber';
import { Grid } from '@react-three/drei';
import * as THREE from 'three';
import clsx from 'clsx';
import { ArrowUp, Camera, Check, ChevronDown, Lightbulb, Plus, RotateCcw, X } from 'lucide-react';

import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { toRenderableMediaUrl } from '../../reference-media';
import {
  ANGLE_STUDIO_PRESETS,
  LIGHT_PALETTE,
  LIGHT_RIG_PRESETS,
  aziTo360,
  clampStudio,
  defaultLightRig,
  makeLight,
  normalizeAzi,
  type StudioLight,
} from './precision-studio-data';

/**
 * 多角度 / 打光 3D 编辑器(2026-07 参考图重构):
 *   左 = 真 3D 场景(网格地台 + 立式原图 + 可拖拽的手电筒/摄像头 gizmo,
 *        灯光是真 spotLight,预览会被灯光颜色实时打亮);
 *   右 = 控制面板(布光模板 / 灯光列表自由增删 / 硬柔光 / 强度 / 调色板)。
 *   场景左键拖拽环视;点住 gizmo 拖拽改方位与仰角;左下参数条与右下 HUD 同步。
 */

type StudioDraft = {
  prompt: string;
  model?: string;
  anglePreset?: string;
  angleYaw?: number;
  anglePitch?: number;
  angleZoom?: number;
  lightingPreset?: string;
  lightingLights?: StudioLight[];
  lightingSelectedId?: string;
};

type PrecisionStudioProps = {
  mode: 'angles' | 'lighting';
  draft: StudioDraft;
  updateDraft: (patch: Partial<StudioDraft>) => void;
  sourceUrl: string;
  language: string;
  modelOptions: string[];
  defaultModel: string;
  busy: boolean;
  onGenerate: () => void;
};

const TARGET = new THREE.Vector3(0, 1, 0);
// 主体放大后灯/相机的环绕半径:让 gizmo 贴近主体但本身做小,比例更专业。
const LIGHT_ORBIT_R = 2.2;
// 场景相机距离:拉近让主体填满画面(参考图主体占比更大)。
const SCENE_CAM_R = 3.8;

function sphericalPosition(radius: number, aziDeg: number, eleDeg: number) {
  const ry = (aziDeg * Math.PI) / 180;
  const rp = (eleDeg * Math.PI) / 180;
  return new THREE.Vector3(
    TARGET.x + radius * Math.sin(ry) * Math.cos(rp),
    TARGET.y + radius * Math.sin(rp),
    TARGET.z + radius * Math.cos(ry) * Math.cos(rp),
  );
}

// ─── 场景相机(环视)──────────────────────────────────────────────────────────

function SceneRig({ yaw, pitch }: { yaw: number; pitch: number }) {
  const camera = useThree((state) => state.camera);
  useEffect(() => {
    const pos = sphericalPosition(SCENE_CAM_R, yaw, pitch);
    camera.position.copy(pos);
    camera.lookAt(TARGET);
  }, [camera, yaw, pitch]);
  return null;
}

// ─── 原图立牌 ────────────────────────────────────────────────────────────────

// useLoader 走 R3F 的 suspense + 缓存,避免手动 setState 时 map 属性
// 附着时序竞态(会出现整块白板/灰板)。TextureLoader 默认 crossOrigin
// = 'anonymous',配合 proxy-media 同源代理即可无污染贴到平面上。
function ImagePlaneInner({ url, lit }: { url: string; lit: boolean }) {
  const texture = useLoader(THREE.TextureLoader, toRenderableMediaUrl(url) || url);
  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);

  const image = texture.image as { width?: number; height?: number } | undefined;
  const aspect = image?.width && image.height ? image.width / image.height : 0.78;
  const height = 1.9;
  const width = clampStudio(height * aspect, 0.7, 3.2);

  return (
    <mesh position={[0, height / 2 + 0.02, 0]} castShadow>
      <planeGeometry args={[width, height]} />
      {lit ? (
        <meshStandardMaterial map={texture} roughness={0.85} metalness={0} side={THREE.DoubleSide} />
      ) : (
        <meshBasicMaterial map={texture} toneMapped={false} side={THREE.DoubleSide} />
      )}
    </mesh>
  );
}

function ImagePlane({ url, lit }: { url: string; lit: boolean }) {
  return (
    <Suspense
      fallback={(
        <mesh position={[0, 0.97, 0]}>
          <planeGeometry args={[1.4, 1.9]} />
          <meshBasicMaterial color="#242a33" side={THREE.DoubleSide} />
        </mesh>
      )}
    >
      <ImagePlaneInner url={url} lit={lit} />
    </Suspense>
  );
}

// ─── 手电筒 gizmo(打光)──────────────────────────────────────────────────────

function FlashlightGizmo({
  light,
  selected,
  onGrab,
}: {
  light: StudioLight;
  selected: boolean;
  onGrab: (event: ThreeEvent<PointerEvent>) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const position = useMemo(() => sphericalPosition(LIGHT_ORBIT_R, light.azi, light.ele), [light.azi, light.ele]);
  useEffect(() => {
    groupRef.current?.position.copy(position);
    groupRef.current?.lookAt(TARGET);
  }, [position]);

  const beamLength = LIGHT_ORBIT_R - 0.5;
  const beamRadius = light.kind === 'soft' ? 0.32 : 0.2;

  return (
    <group ref={groupRef}>
      {/* 手电筒头(白色喇叭口朝向主体)—— 缩小到与主体成比例 */}
      <mesh rotation={[Math.PI / 2, 0, 0]} onPointerDown={onGrab}>
        <cylinderGeometry args={[0.095, 0.062, 0.17, 14]} />
        <meshBasicMaterial color={selected ? '#ffffff' : '#d9dde3'} />
      </mesh>
      <mesh position={[0, 0, -0.13]} rotation={[Math.PI / 2, 0, 0]} onPointerDown={onGrab}>
        <cylinderGeometry args={[0.036, 0.036, 0.1, 10]} />
        <meshBasicMaterial color={selected ? '#e8ecf2' : '#aeb6c2'} />
      </mesh>
      {selected ? (
        <mesh>
          <torusGeometry args={[0.155, 0.01, 8, 28]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.85} />
        </mesh>
      ) : null}
      {/* 光锥(纯展示,不参与拾取) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, beamLength / 2 + 0.09]} raycast={() => undefined}>
        <coneGeometry args={[beamRadius, beamLength, 26, 1, true]} />
        <meshBasicMaterial color={light.color} transparent opacity={0.1 + light.intensity * 0.014} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

function RigSpotLights({ lights }: { lights: StudioLight[] }) {
  const target = useMemo(() => {
    const object = new THREE.Object3D();
    object.position.copy(TARGET);
    return object;
  }, []);
  return (
    <>
      <primitive object={target} />
      {lights.map((light) => (
        <spotLight
          key={light.id}
          position={sphericalPosition(LIGHT_ORBIT_R, light.azi, light.ele).toArray()}
          target={target}
          color={light.color}
          intensity={light.intensity * 0.55}
          angle={light.kind === 'soft' ? 0.62 : 0.34}
          penumbra={light.kind === 'soft' ? 1 : 0.15}
          distance={0}
          decay={0}
          castShadow
          shadow-mapSize-width={512}
          shadow-mapSize-height={512}
        />
      ))}
    </>
  );
}

// ─── 摄像头 gizmo(多角度)────────────────────────────────────────────────────

function CameraGizmo({
  yaw,
  pitch,
  zoom,
  onGrab,
}: {
  yaw: number;
  pitch: number;
  zoom: number;
  onGrab: (event: ThreeEvent<PointerEvent>) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const radius = 2.7 - (zoom / 100) * 1.3;
  const position = useMemo(() => sphericalPosition(radius, yaw, pitch), [radius, yaw, pitch]);
  useEffect(() => {
    groupRef.current?.position.copy(position);
    groupRef.current?.lookAt(TARGET);
  }, [position]);

  const frustumLength = Math.max(0.5, radius - 0.5);

  return (
    <group ref={groupRef}>
      {/* 摄像头本体 —— 缩小到与主体成比例 */}
      <mesh onPointerDown={onGrab}>
        <boxGeometry args={[0.23, 0.155, 0.13]} />
        <meshBasicMaterial color="#e8ecf2" />
      </mesh>
      <mesh position={[0, 0, 0.1]} rotation={[Math.PI / 2, 0, 0]} onPointerDown={onGrab}>
        <cylinderGeometry args={[0.052, 0.04, 0.09, 14]} />
        <meshBasicMaterial color="#ffffff" />
      </mesh>
      <mesh position={[0.065, 0.11, 0]} onPointerDown={onGrab}>
        <boxGeometry args={[0.078, 0.065, 0.078]} />
        <meshBasicMaterial color="#c7cdd6" />
      </mesh>
      {/* 视锥(四棱锥,提示取景方向) */}
      <mesh rotation={[-Math.PI / 2, 0, Math.PI / 4]} position={[0, 0, frustumLength / 2 + 0.13]} raycast={() => undefined}>
        <coneGeometry args={[0.4, frustumLength, 4, 1, true]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.09} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

// ─── 面板小部件 ──────────────────────────────────────────────────────────────

function PanelSlider({
  label,
  value,
  min,
  max,
  step = 1,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-2.5 text-[11px] text-neutral-300">
      <span className="w-8 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-white"
      />
      <span className="w-11 shrink-0 text-right font-mono text-[10px] text-neutral-400">{display ?? `${value}°`}</span>
    </div>
  );
}

function NudgeButton({ className, onClick, children }: { className: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClick}
      className={clsx('absolute z-20 flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-sm text-neutral-300 backdrop-blur-sm transition hover:bg-white/[0.12] hover:text-white', className)}
    >
      {children}
    </button>
  );
}

// ─── 主组件 ──────────────────────────────────────────────────────────────────

export function PrecisionStudio({
  mode,
  draft,
  updateDraft,
  sourceUrl,
  language,
  modelOptions,
  defaultModel,
  busy,
  onGenerate,
}: PrecisionStudioProps) {
  const zh = language === 'zh';
  const isLighting = mode === 'lighting';

  // 场景环视(纯查看辅助,不进提示词)
  const [sceneYaw, setSceneYaw] = useState(0);
  const [scenePitch, setScenePitch] = useState(16);

  // 打光状态取自 draft;缺省兜底(旧会话/异常路径)
  const lights = useMemo(
    () => (draft.lightingLights?.length ? draft.lightingLights : defaultLightRig()),
    [draft.lightingLights],
  );
  useEffect(() => {
    if (isLighting && !draft.lightingLights?.length) {
      updateDraft({ lightingLights: lights, lightingSelectedId: lights[0]?.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLighting]);
  const selectedId = draft.lightingSelectedId && lights.some((l) => l.id === draft.lightingSelectedId)
    ? draft.lightingSelectedId
    : lights[0]?.id;
  const selected = lights.find((l) => l.id === selectedId) ?? lights[0];

  const camYaw = draft.angleYaw ?? 0;
  const camPitch = draft.anglePitch ?? 0;
  const camZoom = draft.angleZoom ?? 50;

  const patchLight = (patch: Partial<StudioLight>) => {
    updateDraft({
      lightingLights: lights.map((l) => (l.id === selectedId ? { ...l, ...patch } : l)),
    });
  };

  // ─── 拖拽(gizmo 抓取 / 空白处环视场景)────────────────────────────────
  // window 级 move/up + 拖拽起点锚定;通过 ref 取最新 setter,避免闭包过期。
  const latest = useRef({ updateDraft, lights, selectedId, camYaw, camPitch });
  latest.current = { updateDraft, lights, selectedId, camYaw, camPitch };
  const dragRef = useRef<{ kind: 'scene' | 'light' | 'camera'; x: number; y: number; a: number; b: number } | null>(null);

  const beginDrag = (kind: 'scene' | 'light' | 'camera', clientX: number, clientY: number) => {
    const anchors = kind === 'scene'
      ? { a: sceneYaw, b: scenePitch }
      : kind === 'light'
        ? { a: selected?.azi ?? 0, b: selected?.ele ?? 0 }
        : { a: camYaw, b: camPitch };
    dragRef.current = { kind, x: clientX, y: clientY, ...anchors };
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (drag.kind === 'scene') {
        setSceneYaw(normalizeAzi(drag.a - dx * 0.45));
        setScenePitch(clampStudio(drag.b + dy * 0.3, 4, 78));
      } else if (drag.kind === 'light') {
        const { updateDraft: update, lights: current, selectedId: id } = latest.current;
        update({
          lightingLights: current.map((l) => (l.id === id
            ? { ...l, azi: normalizeAzi(drag.a + dx * 0.5), ele: clampStudio(drag.b - dy * 0.4, -10, 85) }
            : l)),
        });
      } else {
        latest.current.updateDraft({
          angleYaw: Math.round(normalizeAzi(drag.a + dx * 0.5)),
          anglePitch: Math.round(clampStudio(drag.b - dy * 0.4, -60, 60)),
          anglePreset: 'custom',
        });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const grabLight = (id: string) => (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    event.nativeEvent.stopPropagation();
    if (latest.current.selectedId !== id) updateDraft({ lightingSelectedId: id });
    // 抓取用被抓那盏灯的锚点(可能不是当前选中灯)
    const light = latest.current.lights.find((l) => l.id === id);
    dragRef.current = null;
    const anchors = { a: light?.azi ?? 0, b: light?.ele ?? 0 };
    dragRef.current = { kind: 'light', x: event.nativeEvent.clientX, y: event.nativeEvent.clientY, ...anchors };
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      latest.current.updateDraft({
        lightingLights: latest.current.lights.map((l) => (l.id === id
          ? { ...l, azi: normalizeAzi(drag.a + dx * 0.5), ele: clampStudio(drag.b - dy * 0.4, -10, 85) }
          : l)),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const grabCamera = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    event.nativeEvent.stopPropagation();
    beginDrag('camera', event.nativeEvent.clientX, event.nativeEvent.clientY);
  };

  // ─── 面板操作 ────────────────────────────────────────────────────────
  const applyRigPreset = (presetId: string) => {
    const preset = LIGHT_RIG_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const rig = preset.lights.map((l) => makeLight(l));
    updateDraft({ lightingPreset: preset.id, lightingLights: rig, lightingSelectedId: rig[0]?.id });
  };

  const addLight = () => {
    const last = lights[lights.length - 1];
    const light = makeLight({
      name: zh ? (lights.length === 1 ? '补光' : '灯光') : lights.length === 1 ? 'Fill' : 'Light',
      azi: normalizeAzi((last?.azi ?? 0) + 70),
      ele: 20,
      intensity: 4,
      color: '#FFFFFF',
      kind: 'soft',
    });
    updateDraft({ lightingLights: [...lights, light], lightingSelectedId: light.id });
  };

  const removeLight = (id: string) => {
    if (lights.length <= 1) return;
    const next = lights.filter((l) => l.id !== id);
    updateDraft({
      lightingLights: next,
      lightingSelectedId: selectedId === id ? next[0]?.id : selectedId,
    });
  };

  const resetAll = () => {
    setSceneYaw(0);
    setScenePitch(16);
    if (isLighting) {
      const rig = defaultLightRig();
      updateDraft({ lightingPreset: undefined, lightingLights: rig, lightingSelectedId: rig[0].id });
    } else {
      updateDraft({ anglePreset: 'custom', angleYaw: 0, anglePitch: 0, angleZoom: 50 });
    }
  };

  const anglePresetActive = ANGLE_STUDIO_PRESETS.some((p) => p.id === draft.anglePreset) ? draft.anglePreset : 'custom';
  const paletteMatch = (color: string) => selected && selected.color.toLowerCase() === color.toLowerCase();

  const hudRows: Array<[string, string]> = isLighting && selected
    ? [
        ['RGB', selected.color.toUpperCase()],
        ['AZI', `${aziTo360(selected.azi)}°`],
        ['ELE', `${Math.round(selected.ele)}°`],
        ['INT', String(selected.intensity)],
        ['TYPE', selected.kind === 'soft' ? 'SOFT' : 'HARD'],
      ]
    : [
        ['AZI', `${aziTo360(camYaw)}°`],
        ['ELE', `${Math.round(camPitch)}°`],
        ['ZOOM', `${Math.round(camZoom)}%`],
        ['TYPE', 'CAM'],
      ];

  const title = isLighting ? (zh ? '灯光调节' : 'Lighting') : (zh ? '机位调节' : 'Camera angle');
  const TitleIcon = isLighting ? Lightbulb : Camera;

  return (
    <div className="grid h-[min(80vh,760px)] grid-cols-1 md:grid-cols-[1.55fr_1fr]">
      {/* ─── 左:3D 场景 ─────────────────────────────────────────── */}
      <div
        className="relative min-h-[320px] cursor-grab touch-none select-none overflow-hidden bg-[#0c0f14] active:cursor-grabbing"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          beginDrag('scene', event.clientX, event.clientY);
        }}
      >
        <Canvas shadows dpr={[1, 1.75]} camera={{ fov: 38, position: [0, 2.1, 4.6] }}>
          <color attach="background" args={['#0c0f14']} />
          <SceneRig yaw={sceneYaw} pitch={scenePitch} />
          <ambientLight intensity={isLighting ? 0.32 : 1.15} />
          {!isLighting ? <directionalLight position={[3, 5, 4]} intensity={0.4} /> : null}
          <Grid
            position={[0, 0, 0]}
            args={[12, 12]}
            cellSize={0.42}
            cellThickness={0.6}
            cellColor="#1d2836"
            sectionSize={2.1}
            sectionThickness={1}
            sectionColor="#2b3d52"
            fadeDistance={11}
            fadeStrength={1.4}
            infiniteGrid
          />
          {/* 接影地板 */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow raycast={() => undefined}>
            <planeGeometry args={[16, 16]} />
            <shadowMaterial opacity={0.42} />
          </mesh>
          <ImagePlane url={sourceUrl} lit={isLighting} />
          {isLighting ? (
            <>
              <RigSpotLights lights={lights} />
              {lights.map((light) => (
                <FlashlightGizmo key={light.id} light={light} selected={light.id === selectedId} onGrab={grabLight(light.id)} />
              ))}
            </>
          ) : (
            <CameraGizmo yaw={camYaw} pitch={camPitch} zoom={camZoom} onGrab={grabCamera} />
          )}
        </Canvas>

        {/* 顶部提示 + 环视微调箭头 */}
        <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex flex-col items-center gap-1.5">
          <NudgeButton className="pointer-events-auto relative" onClick={() => setScenePitch((v) => clampStudio(v + 10, 4, 78))}>↑</NudgeButton>
          <div className="text-[11px] text-neutral-500">
            {zh
              ? `左键拖拽环视场景 · 点住${isLighting ? '灯光' : '相机'}拖拽调整位置`
              : `Drag to orbit · grab the ${isLighting ? 'light' : 'camera'} to reposition`}
          </div>
        </div>
        <NudgeButton className="left-3 top-1/2 -translate-y-1/2" onClick={() => setSceneYaw((v) => normalizeAzi(v - 20))}>←</NudgeButton>
        <NudgeButton className="right-3 top-1/2 -translate-y-1/2" onClick={() => setSceneYaw((v) => normalizeAzi(v + 20))}>→</NudgeButton>
        <NudgeButton className="bottom-3 left-1/2 -translate-x-1/2" onClick={() => setScenePitch((v) => clampStudio(v - 10, 4, 78))}>↓</NudgeButton>

        {/* 左下:当前对象参数条 */}
        <div
          className="absolute bottom-4 left-4 z-10 w-60 space-y-2 rounded-2xl border border-white/10 bg-black/62 p-3 backdrop-blur-md"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="flex items-center gap-2 text-xs text-neutral-100">
            <span className="h-2 w-2 rounded-full" style={{ background: isLighting ? selected?.color ?? '#fff' : '#fff' }} />
            {isLighting ? selected?.name ?? (zh ? '主光' : 'Key') : zh ? '相机' : 'Camera'}
          </div>
          <PanelSlider label={zh ? '场景' : 'Scene'} value={Math.round(normalizeAzi(sceneYaw))} min={-180} max={180} onChange={(v) => setSceneYaw(normalizeAzi(v))} />
          {isLighting && selected ? (
            <>
              <PanelSlider label={zh ? '水平' : 'Azi'} value={Math.round(selected.azi)} min={-180} max={180} onChange={(v) => patchLight({ azi: v })} />
              <PanelSlider label={zh ? '垂直' : 'Ele'} value={Math.round(selected.ele)} min={-10} max={85} onChange={(v) => patchLight({ ele: v })} />
            </>
          ) : (
            <>
              <PanelSlider label={zh ? '水平' : 'Yaw'} value={Math.round(camYaw)} min={-180} max={180} onChange={(v) => updateDraft({ angleYaw: v, anglePreset: 'custom' })} />
              <PanelSlider label={zh ? '垂直' : 'Pitch'} value={Math.round(camPitch)} min={-60} max={60} onChange={(v) => updateDraft({ anglePitch: v, anglePreset: 'custom' })} />
            </>
          )}
        </div>

        {/* 右下 HUD */}
        <div className="pointer-events-none absolute bottom-4 right-4 z-10 space-y-0.5 rounded-xl border border-white/8 bg-black/55 px-3 py-2 font-mono text-[10px] leading-4 text-neutral-400 backdrop-blur-md">
          {hudRows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-4">
              <span>{k}</span>
              <span className="flex items-center gap-1.5 text-neutral-200">
                {k === 'RGB' ? <span className="h-2 w-2 rounded-full border border-white/30" style={{ background: v }} /> : null}
                {v}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ─── 右:控制面板 ────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-col border-t border-white/8 md:border-l md:border-t-0">
        <div className="flex items-center gap-2 px-5 pb-3 pt-4 text-sm font-medium text-neutral-100">
          <TitleIcon className="h-4 w-4 text-neutral-300" />
          {title}
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-4">
          {isLighting ? (
            <>
              {/* 布光模板 */}
              <div className="grid grid-cols-3 gap-2">
                {LIGHT_RIG_PRESETS.map((preset) => {
                  const active = draft.lightingPreset === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => applyRigPreset(preset.id)}
                      className={clsx(
                        'rounded-xl px-2 py-2 text-xs transition',
                        active ? 'bg-white text-neutral-900' : 'bg-white/[0.06] text-neutral-200 hover:bg-white/[0.12]',
                      )}
                    >
                      {zh ? preset.labelZh : preset.labelEn}
                    </button>
                  );
                })}
              </div>

              {/* 灯光列表 */}
              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-neutral-200">
                  <span>{zh ? '灯光列表' : 'Lights'}</span>
                  <button
                    type="button"
                    onClick={addLight}
                    title={zh ? '添加灯光' : 'Add light'}
                    className="flex h-6 w-6 items-center justify-center rounded-md border border-white/12 bg-white/[0.05] text-neutral-300 transition hover:bg-white/[0.12] hover:text-white"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {lights.map((light) => {
                    const active = light.id === selectedId;
                    return (
                      <button
                        key={light.id}
                        type="button"
                        onClick={() => updateDraft({ lightingSelectedId: light.id })}
                        className={clsx(
                          'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition',
                          active ? 'border-white/70 bg-white/[0.1] text-white' : 'border-white/12 bg-white/[0.03] text-neutral-300 hover:border-white/30',
                        )}
                      >
                        <span className="h-2 w-2 rounded-full border border-black/20" style={{ background: light.color }} />
                        {light.name}
                        {active && lights.length > 1 ? (
                          <span
                            role="button"
                            title={zh ? '删除该灯' : 'Remove light'}
                            onClick={(event) => { event.stopPropagation(); removeLight(light.id); }}
                            className="-mr-1 ml-0.5 rounded-full p-0.5 text-neutral-400 hover:bg-white/15 hover:text-white"
                          >
                            <X className="h-3 w-3" />
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 灯光类型 */}
              <div>
                <div className="mb-2 text-xs text-neutral-200">{zh ? '灯光类型' : 'Light type'}</div>
                <div className="grid grid-cols-2 gap-2">
                  {(['hard', 'soft'] as const).map((kind) => {
                    const active = selected?.kind === kind;
                    return (
                      <button
                        key={kind}
                        type="button"
                        onClick={() => patchLight({ kind })}
                        className={clsx(
                          'rounded-full px-3 py-2 text-xs transition',
                          active ? 'bg-white font-medium text-neutral-900' : 'bg-white/[0.06] text-neutral-300 hover:bg-white/[0.12]',
                        )}
                      >
                        {kind === 'hard' ? (zh ? '硬光' : 'Hard') : zh ? '柔光' : 'Soft'}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 灯光强度 */}
              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-neutral-200">
                  <span>{zh ? '灯光强度' : 'Intensity'}</span>
                  <span className="font-mono text-neutral-400">{selected?.intensity ?? 5}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={selected?.intensity ?? 5}
                  onChange={(event) => patchLight({ intensity: Number(event.target.value) })}
                  className="h-1 w-full cursor-pointer accent-white"
                />
              </div>

              {/* 灯光颜色 */}
              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-neutral-200">
                  <span>{zh ? '灯光颜色' : 'Color'}</span>
                  <span className="font-mono text-neutral-400">{selected?.color.toUpperCase()}</span>
                </div>
                <div className="grid grid-cols-9 gap-1.5">
                  {LIGHT_PALETTE.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => patchLight({ color })}
                      className="flex h-6 items-center justify-center rounded-md border border-white/10 transition hover:scale-105"
                      style={{ background: color }}
                      title={color}
                    >
                      {paletteMatch(color) ? <Check className="h-3 w-3 text-black/70" /> : null}
                    </button>
                  ))}
                </div>
                <div className="mt-2.5 flex items-center gap-2.5 text-xs text-neutral-200">
                  <span className="shrink-0">{zh ? '自定义' : 'Custom'}</span>
                  <input
                    type="color"
                    value={selected?.color ?? '#ffffff'}
                    onChange={(event) => patchLight({ color: event.target.value.toUpperCase() })}
                    className="h-7 min-w-0 flex-1 cursor-pointer rounded-md border border-white/12 bg-transparent"
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              {/* 机位模板 */}
              <div className="grid grid-cols-3 gap-2">
                {ANGLE_STUDIO_PRESETS.map((preset) => {
                  const active = anglePresetActive === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => updateDraft({ anglePreset: preset.id, angleYaw: preset.yaw, anglePitch: preset.pitch, angleZoom: preset.zoom })}
                      className={clsx(
                        'rounded-xl px-2 py-2 text-xs transition',
                        active ? 'bg-white text-neutral-900' : 'bg-white/[0.06] text-neutral-200 hover:bg-white/[0.12]',
                      )}
                    >
                      {zh ? preset.labelZh : preset.labelEn}
                    </button>
                  );
                })}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-neutral-200">
                  <span>{zh ? '水平环绕' : 'Yaw'}</span>
                  <span className="font-mono text-neutral-400">{Math.round(camYaw)}°</span>
                </div>
                <input type="range" min={-180} max={180} value={camYaw} onChange={(e) => updateDraft({ angleYaw: Number(e.target.value), anglePreset: 'custom' })} className="h-1 w-full cursor-pointer accent-white" />
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-neutral-200">
                  <span>{zh ? '垂直俯仰' : 'Pitch'}</span>
                  <span className="font-mono text-neutral-400">{Math.round(camPitch)}°</span>
                </div>
                <input type="range" min={-60} max={60} value={camPitch} onChange={(e) => updateDraft({ anglePitch: Number(e.target.value), anglePreset: 'custom' })} className="h-1 w-full cursor-pointer accent-white" />
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-neutral-200">
                  <span>{zh ? '景别缩放' : 'Framing'}</span>
                  <span className="font-mono text-neutral-400">
                    {camZoom < 34 ? (zh ? '全景' : 'Wide') : camZoom > 66 ? (zh ? '近景' : 'Close') : zh ? '中景' : 'Medium'} {Math.round(camZoom)}%
                  </span>
                </div>
                <input type="range" min={0} max={100} value={camZoom} onChange={(e) => updateDraft({ angleZoom: Number(e.target.value), anglePreset: 'custom' })} className="h-1 w-full cursor-pointer accent-white" />
              </div>
            </>
          )}
        </div>

        {/* 底部操作条 */}
        <div className="flex items-center gap-2 border-t border-white/8 px-4 py-3.5">
          <Button
            variant="outline"
            onClick={resetAll}
            className="h-9 flex-1 rounded-full border-white/12 bg-white/[0.04] text-xs text-neutral-200 hover:bg-white/[0.1]"
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {zh ? '重置' : 'Reset'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-9 max-w-[150px] rounded-full border-white/12 bg-white/[0.04] text-xs text-neutral-200 hover:bg-white/[0.1]">
                <span className="truncate">{draft.model || defaultModel}</span>
                <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto border-white/10 bg-[#16181d] text-neutral-200">
              {modelOptions.map((model) => (
                <DropdownMenuItem
                  key={model}
                  onClick={() => updateDraft({ model })}
                  className={clsx('text-xs', (draft.model || defaultModel) === model && 'text-cyan-300')}
                >
                  {model}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/[0.06] px-2.5 py-1.5 text-[11px] text-amber-200/90" title={zh ? '每次生成消耗' : 'Cost per generation'}>
            ✦ 1
          </span>
          <button
            type="button"
            onClick={onGenerate}
            disabled={busy}
            title={zh ? '开始生成' : 'Generate'}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-neutral-900 transition hover:bg-neutral-200 disabled:opacity-50"
          >
            {busy ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-400 border-t-neutral-900" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
