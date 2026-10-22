import { forwardRef, useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * 导演台道具库 —— 全部程序化 three.js 基元拼装（零外部资源，不增打包体积）。
 * 与素体同一套交互约定：点击选中、TransformControls 变换、脚下指示圈。
 * 配色走低饱和石墨灰 + 少量哑光材质色（木/叶/玻璃），贴合参考的近黑舞台。
 */

export type PropTransform = {
  id: string;
  /** PROP_DEFS 里的 id，如 'chair' / 'table-square' / 'tree-small'。 */
  assetId: string;
  label: string;
  position: [number, number, number];
  rotationY: number;
  scale: number;
  rotation?: [number, number, number];
  scaleXYZ?: [number, number, number];
};

export const PROP_DEFS: { id: string; zh: string; en: string }[] = [
  { id: 'chair', zh: '椅子', en: 'Chair' },
  { id: 'table-square', zh: '方桌', en: 'Square table' },
  { id: 'table-round', zh: '圆桌', en: 'Round table' },
  { id: 'sofa', zh: '沙发', en: 'Sofa' },
  { id: 'wall-2m', zh: '墙段 2m', en: 'Wall 2m' },
  { id: 'wall-3m', zh: '墙段 3m', en: 'Wall 3m' },
  { id: 'column', zh: '柱子', en: 'Column' },
  { id: 'stairs', zh: '楼梯段', en: 'Stairs' },
  { id: 'tree-small', zh: '小树', en: 'Small tree' },
  { id: 'tree-big', zh: '大树', en: 'Big tree' },
  { id: 'rock', zh: '石头', en: 'Rock' },
  { id: 'bush', zh: '灌木', en: 'Bush' },
  { id: 'car', zh: '轿车', en: 'Car' },
  { id: 'bicycle', zh: '自行车', en: 'Bicycle' },
  { id: 'streetlamp', zh: '路灯', en: 'Street lamp' },
  { id: 'bench', zh: '长椅', en: 'Bench' },
  { id: 'trashbin', zh: '垃圾桶', en: 'Trash bin' },
  { id: 'arrow', zh: '方向箭头', en: 'Arrow marker' },
];

export function propDefOf(assetId: string) {
  return PROP_DEFS.find((d) => d.id === assetId) ?? PROP_DEFS[0];
}

// 低饱和舞台配色。
const C = {
  body: '#8f959d',      // 主体灰
  deep: '#6b7077',      // 深灰（腿/底座）
  light: '#aab0b8',     // 亮灰（台面）
  wood: '#8a7f6f',      // 哑光木
  leaf: '#5c7360',      // 去饱和叶绿
  trunk: '#6e604f',     // 树干
  glass: '#39434f',     // 车窗
  metal: '#7d838c',     // 金属杆件
  lamp: '#e8e2cf',      // 灯头暖白
  arrow: '#c9ced6',     // 地面箭头
};

function Mat({ color, roughness = 0.6 }: { color: string; roughness?: number }) {
  return <meshStandardMaterial color={color} roughness={roughness} metalness={0.05} />;
}

/* ─── 家具 ──────────────────────────────────────────────────────────── */

function Chair() {
  const leg = (x: number, z: number) => (
    <mesh key={`${x}${z}`} position={[x, 0.225, z]} castShadow>
      <boxGeometry args={[0.04, 0.45, 0.04]} />
      <Mat color={C.deep} />
    </mesh>
  );
  return (
    <group>
      {leg(-0.19, -0.19)}{leg(0.19, -0.19)}{leg(-0.19, 0.19)}{leg(0.19, 0.19)}
      <mesh position={[0, 0.47, 0]} castShadow>
        <boxGeometry args={[0.46, 0.05, 0.46]} />
        <Mat color={C.wood} />
      </mesh>
      <mesh position={[0, 0.82, -0.21]} castShadow>
        <boxGeometry args={[0.46, 0.65, 0.045]} />
        <Mat color={C.wood} />
      </mesh>
    </group>
  );
}

function TableSquare() {
  const leg = (x: number, z: number) => (
    <mesh key={`${x}${z}`} position={[x, 0.36, z]} castShadow>
      <boxGeometry args={[0.06, 0.72, 0.06]} />
      <Mat color={C.deep} />
    </mesh>
  );
  return (
    <group>
      {leg(-0.54, -0.34)}{leg(0.54, -0.34)}{leg(-0.54, 0.34)}{leg(0.54, 0.34)}
      <mesh position={[0, 0.75, 0]} castShadow>
        <boxGeometry args={[1.2, 0.06, 0.8]} />
        <Mat color={C.light} roughness={0.5} />
      </mesh>
    </group>
  );
}

function TableRound() {
  return (
    <group>
      <mesh position={[0, 0.04, 0]} castShadow>
        <cylinderGeometry args={[0.28, 0.32, 0.08, 24]} />
        <Mat color={C.deep} />
      </mesh>
      <mesh position={[0, 0.4, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.05, 0.7, 16]} />
        <Mat color={C.deep} />
      </mesh>
      <mesh position={[0, 0.77, 0]} castShadow>
        <cylinderGeometry args={[0.5, 0.5, 0.05, 32]} />
        <Mat color={C.light} roughness={0.5} />
      </mesh>
    </group>
  );
}

function Sofa() {
  return (
    <group>
      <mesh position={[0, 0.22, 0]} castShadow>
        <boxGeometry args={[1.8, 0.42, 0.85]} />
        <Mat color={C.body} />
      </mesh>
      <mesh position={[0, 0.62, -0.34]} castShadow>
        <boxGeometry args={[1.8, 0.55, 0.18]} />
        <Mat color={C.body} />
      </mesh>
      <mesh position={[-0.85, 0.5, 0]} castShadow>
        <boxGeometry args={[0.14, 0.35, 0.85]} />
        <Mat color={C.deep} />
      </mesh>
      <mesh position={[0.85, 0.5, 0]} castShadow>
        <boxGeometry args={[0.14, 0.35, 0.85]} />
        <Mat color={C.deep} />
      </mesh>
    </group>
  );
}

/* ─── 建筑 ──────────────────────────────────────────────────────────── */

function Wall({ width }: { width: number }) {
  return (
    <mesh position={[0, 1.3, 0]} castShadow>
      <boxGeometry args={[width, 2.6, 0.12]} />
      <Mat color={C.body} roughness={0.75} />
    </mesh>
  );
}

function Column() {
  return (
    <group>
      <mesh position={[0, 0.06, 0]} castShadow>
        <boxGeometry args={[0.52, 0.12, 0.52]} />
        <Mat color={C.deep} />
      </mesh>
      <mesh position={[0, 1.4, 0]} castShadow>
        <cylinderGeometry args={[0.18, 0.2, 2.68, 20]} />
        <Mat color={C.body} roughness={0.7} />
      </mesh>
      <mesh position={[0, 2.76, 0]} castShadow>
        <boxGeometry args={[0.52, 0.12, 0.52]} />
        <Mat color={C.deep} />
      </mesh>
    </group>
  );
}

function Stairs() {
  const steps = 6;
  return (
    <group>
      {Array.from({ length: steps }, (_, i) => (
        <mesh key={i} position={[0, 0.09 + i * 0.18, -i * 0.28]} castShadow>
          <boxGeometry args={[1.2, 0.18, 0.28]} />
          <Mat color={C.body} roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

/* ─── 自然 ──────────────────────────────────────────────────────────── */

function TreeSmall() {
  return (
    <group>
      <mesh position={[0, 0.5, 0]} castShadow>
        <cylinderGeometry args={[0.05, 0.08, 1.0, 10]} />
        <Mat color={C.trunk} roughness={0.8} />
      </mesh>
      <mesh position={[0, 1.45, 0]} castShadow>
        <coneGeometry args={[0.55, 1.5, 12]} />
        <Mat color={C.leaf} roughness={0.8} />
      </mesh>
    </group>
  );
}

function TreeBig() {
  return (
    <group>
      <mesh position={[0, 1.1, 0]} castShadow>
        <cylinderGeometry args={[0.11, 0.18, 2.2, 12]} />
        <Mat color={C.trunk} roughness={0.8} />
      </mesh>
      <mesh position={[0, 2.7, 0]} castShadow scale={[1, 0.9, 1]}>
        <sphereGeometry args={[1.0, 16, 14]} />
        <Mat color={C.leaf} roughness={0.85} />
      </mesh>
      <mesh position={[-0.6, 2.2, 0.25]} castShadow>
        <sphereGeometry args={[0.55, 14, 12]} />
        <Mat color={C.leaf} roughness={0.85} />
      </mesh>
      <mesh position={[0.55, 2.3, -0.3]} castShadow>
        <sphereGeometry args={[0.6, 14, 12]} />
        <Mat color={C.leaf} roughness={0.85} />
      </mesh>
    </group>
  );
}

function Rock() {
  return (
    <mesh position={[0, 0.22, 0]} castShadow scale={[1.2, 0.75, 1]} rotation={[0, 0.6, 0]}>
      <dodecahedronGeometry args={[0.35, 0]} />
      <Mat color={C.deep} roughness={0.9} />
    </mesh>
  );
}

function Bush() {
  return (
    <group>
      <mesh position={[0, 0.28, 0]} castShadow scale={[1.2, 0.85, 1]}>
        <sphereGeometry args={[0.32, 14, 12]} />
        <Mat color={C.leaf} roughness={0.9} />
      </mesh>
      <mesh position={[-0.28, 0.2, 0.1]} castShadow>
        <sphereGeometry args={[0.22, 12, 10]} />
        <Mat color={C.leaf} roughness={0.9} />
      </mesh>
      <mesh position={[0.26, 0.22, -0.08]} castShadow>
        <sphereGeometry args={[0.24, 12, 10]} />
        <Mat color={C.leaf} roughness={0.9} />
      </mesh>
    </group>
  );
}

/* ─── 交通 / 街道 ───────────────────────────────────────────────────── */

function Car() {
  const wheel = (x: number, z: number) => (
    <mesh key={`${x}${z}`} position={[x, 0.3, z]} rotation={[0, 0, Math.PI / 2]} castShadow>
      <cylinderGeometry args={[0.3, 0.3, 0.2, 20]} />
      <Mat color={'#2c3138'} roughness={0.9} />
    </mesh>
  );
  return (
    <group>
      {/* 车身 + 座舱（前挡略收） */}
      <mesh position={[0, 0.55, 0]} castShadow>
        <boxGeometry args={[4.2, 0.5, 1.75]} />
        <Mat color={C.body} roughness={0.4} />
      </mesh>
      <mesh position={[-0.25, 0.98, 0]} castShadow scale={[1, 1, 0.94]}>
        <boxGeometry args={[2.1, 0.42, 1.75]} />
        <Mat color={C.glass} roughness={0.25} />
      </mesh>
      {wheel(-1.35, 0.85)}{wheel(1.35, 0.85)}{wheel(-1.35, -0.85)}{wheel(1.35, -0.85)}
    </group>
  );
}

function Bicycle() {
  const wheel = (x: number) => (
    <mesh key={x} position={[x, 0.34, 0]} rotation={[0, 0, 0]} castShadow>
      <torusGeometry args={[0.32, 0.025, 10, 28]} />
      <Mat color={'#3a4048'} roughness={0.8} />
    </mesh>
  );
  return (
    <group rotation={[0, 0, 0]}>
      {wheel(-0.52)}{wheel(0.52)}
      {/* 车架三角 */}
      <mesh position={[-0.05, 0.55, 0]} rotation={[0, 0, 0.55]} castShadow>
        <cylinderGeometry args={[0.02, 0.02, 0.62, 8]} />
        <Mat color={C.metal} />
      </mesh>
      <mesh position={[0.22, 0.55, 0]} rotation={[0, 0, -0.5]} castShadow>
        <cylinderGeometry args={[0.02, 0.02, 0.6, 8]} />
        <Mat color={C.metal} />
      </mesh>
      <mesh position={[0.08, 0.72, 0]} rotation={[0, 0, 1.57]} castShadow>
        <cylinderGeometry args={[0.02, 0.02, 0.5, 8]} />
        <Mat color={C.metal} />
      </mesh>
      {/* 车把 + 座垫 */}
      <mesh position={[0.5, 0.92, 0]} rotation={[1.57, 0, 0]} castShadow>
        <cylinderGeometry args={[0.018, 0.018, 0.36, 8]} />
        <Mat color={C.metal} />
      </mesh>
      <mesh position={[-0.28, 0.9, 0]} castShadow scale={[1.6, 0.5, 1]}>
        <sphereGeometry args={[0.07, 12, 10]} />
        <Mat color={'#2c3138'} />
      </mesh>
    </group>
  );
}

function StreetLamp() {
  return (
    <group>
      <mesh position={[0, 0.04, 0]} castShadow>
        <cylinderGeometry args={[0.16, 0.2, 0.08, 16]} />
        <Mat color={C.deep} />
      </mesh>
      <mesh position={[0, 1.8, 0]} castShadow>
        <cylinderGeometry args={[0.045, 0.06, 3.6, 12]} />
        <Mat color={C.metal} roughness={0.5} />
      </mesh>
      <mesh position={[0.3, 3.58, 0]} rotation={[0, 0, 1.57]} castShadow>
        <cylinderGeometry args={[0.035, 0.035, 0.6, 10]} />
        <Mat color={C.metal} roughness={0.5} />
      </mesh>
      <mesh position={[0.6, 3.5, 0]} castShadow>
        <boxGeometry args={[0.28, 0.12, 0.18]} />
        <meshStandardMaterial color={C.lamp} roughness={0.4} emissive={C.lamp} emissiveIntensity={0.35} />
      </mesh>
    </group>
  );
}

function Bench() {
  const leg = (x: number) => (
    <mesh key={x} position={[x, 0.2, 0]} castShadow>
      <boxGeometry args={[0.05, 0.4, 0.5]} />
      <Mat color={C.deep} />
    </mesh>
  );
  return (
    <group>
      {leg(-0.7)}{leg(0.7)}
      {[-0.14, 0, 0.14].map((z) => (
        <mesh key={z} position={[0, 0.42, z]} castShadow>
          <boxGeometry args={[1.6, 0.045, 0.1]} />
          <Mat color={C.wood} roughness={0.7} />
        </mesh>
      ))}
      {[0.62, 0.76].map((y) => (
        <mesh key={y} position={[0, y, -0.22]} rotation={[-0.22, 0, 0]} castShadow>
          <boxGeometry args={[1.6, 0.045, 0.1]} />
          <Mat color={C.wood} roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

function TrashBin() {
  return (
    <group>
      <mesh position={[0, 0.38, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.18, 0.75, 18]} />
        <Mat color={C.body} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.78, 0]} castShadow>
        <cylinderGeometry args={[0.24, 0.24, 0.05, 18]} />
        <Mat color={C.deep} />
      </mesh>
    </group>
  );
}

function ArrowMarker() {
  // 平贴地面的方向箭头（构图走位标记）。
  return (
    <group position={[0, 0.012, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.18, 0.7]} />
        <meshBasicMaterial color={C.arrow} transparent opacity={0.85} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, 0, -0.5]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.24, 3]} />
        <meshBasicMaterial color={C.arrow} transparent opacity={0.85} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/* ─── 渲染入口 ──────────────────────────────────────────────────────── */

function PropBody({ assetId }: { assetId: string }) {
  switch (assetId) {
    case 'chair': return <Chair />;
    case 'table-square': return <TableSquare />;
    case 'table-round': return <TableRound />;
    case 'sofa': return <Sofa />;
    case 'wall-2m': return <Wall width={2} />;
    case 'wall-3m': return <Wall width={3} />;
    case 'column': return <Column />;
    case 'stairs': return <Stairs />;
    case 'tree-small': return <TreeSmall />;
    case 'tree-big': return <TreeBig />;
    case 'rock': return <Rock />;
    case 'bush': return <Bush />;
    case 'car': return <Car />;
    case 'bicycle': return <Bicycle />;
    case 'streetlamp': return <StreetLamp />;
    case 'bench': return <Bench />;
    case 'trashbin': return <TrashBin />;
    case 'arrow': return <ArrowMarker />;
    default: return <Rock />;
  }
}

export const PropMesh = forwardRef<THREE.Group, {
  prop: PropTransform;
  selected: boolean;
  onSelect: (id: string, obj: THREE.Object3D) => void;
}>(function PropMesh({ prop, selected, onSelect }, _ref) {
  const groupRef = useRef<THREE.Group>(null);
  const rotation: [number, number, number] = prop.rotation ?? [0, prop.rotationY, 0];
  const scale: [number, number, number] = prop.scaleXYZ ?? [prop.scale, prop.scale, prop.scale];
  return (
    <group
      ref={groupRef}
      name={`stage-prop-${prop.id}`}
      position={prop.position}
      rotation={rotation}
      scale={scale}
      onPointerDown={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        if (groupRef.current) onSelect(prop.id, groupRef.current);
      }}
    >
      <PropBody assetId={prop.assetId} />
      {/* 脚下指示圈 —— 与素体同款交互语言，用青灰区分道具。 */}
      <mesh position={[0, 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={selected ? [0.24, 0.3, 32] : [0.24, 0.27, 32]} />
        <meshBasicMaterial
          color={selected ? '#9fb3c8' : '#64748b'}
          transparent
          opacity={selected ? 0.85 : 0.35}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
});
