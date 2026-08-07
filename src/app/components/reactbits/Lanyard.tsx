/* eslint-disable react/no-unknown-property */
import { useEffect, useRef, useState } from 'react';
import { Canvas, extend, useFrame } from '@react-three/fiber';
import { useGLTF, useTexture, Environment, Lightformer } from '@react-three/drei';
import { BallCollider, CuboidCollider, Physics, RigidBody, useRopeJoint, useSphericalJoint, type RapierRigidBody } from '@react-three/rapier';
import { MeshLineGeometry, MeshLineMaterial } from 'meshline';
import * as THREE from 'three';

import { useStore } from '../../store';
import cardGLB from './lanyard/card.glb';
import frontDarkImage from './lanyard/front.png';
import frontLightImage from './lanyard/front-light.png';
import bandDarkImage from './lanyard/band-dark.png';
import bandLightImage from './lanyard/band-light.png';
import './Lanyard.css';

/** React Bits "Lanyard" (JS + CSS variant), typed for this codebase.
 *  A physics-simulated hanging badge (rapier rope joints + meshline band).
 *  Port changes: the card's texture atlas is REPLACED with our branded front
 *  face (front = left half of the atlas, back = right half, measured from
 *  card.glb), the strap wears a generated CCY webbing texture, both come in a
 *  dark and a light colorway following the app theme — and the badge doubles
 *  as a pull-cord switch: yank it down and the theme toggles. */

extend({ MeshLineGeometry, MeshLineMaterial });

// Per the React Bits TS guidance these stay loosely typed — meshline's own
// class types demand constructor args the JSX runtime never passes.
declare module '@react-three/fiber' {
  interface ThreeElements {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshLineGeometry: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meshLineMaterial: any;
  }
}

// Card atlas UV rects (measured from card.glb): front face = left half,
// back face = right half.
const FRONT_UV_RECT = { x: 0, y: 0, w: 0.5, h: 0.755 };
const BACK_UV_RECT = { x: 0.5, y: 0, w: 0.5, h: 0.757 };

// Pull-cord switch: dragging the badge this many world units DOWN from where
// it was grabbed clicks the theme toggle (once per grab, like a real cord —
// the viewport is ~10.6 units tall at fov 20 / z 30, so this is a firm yank).
const PULL_TOGGLE_DISTANCE = 1.6;

export default function Lanyard({
  position = [0, 0, 30] as readonly [number, number, number],
  gravity = [0, -40, 0] as readonly [number, number, number],
  fov = 20,
  transparent = true,
}: {
  position?: readonly [number, number, number];
  gravity?: readonly [number, number, number];
  fov?: number;
  transparent?: boolean;
}) {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="lanyard-wrapper">
      <Canvas
        camera={{ position: [...position], fov }}
        dpr={[1, isMobile ? 1.5 : 2]}
        gl={{ alpha: transparent }}
        onCreated={({ gl }) => gl.setClearColor(new THREE.Color(0x000000), transparent ? 0 : 1)}
      >
        <ambientLight intensity={Math.PI} />
        <Physics gravity={[...gravity]} timeStep={isMobile ? 1 / 30 : 1 / 60}>
          <Band isMobile={isMobile} />
        </Physics>
        <Environment blur={0.75}>
          <Lightformer intensity={2} color="white" position={[0, -1, 5]} rotation={[0, 0, Math.PI / 3]} scale={[100, 0.1, 1]} />
          <Lightformer intensity={3} color="white" position={[-1, -1, 1]} rotation={[0, 0, Math.PI / 3]} scale={[100, 0.1, 1]} />
          <Lightformer intensity={3} color="white" position={[1, 1, 1]} rotation={[0, 0, Math.PI / 3]} scale={[100, 0.1, 1]} />
          <Lightformer intensity={10} color="white" position={[-10, 0, 14]} rotation={[0, Math.PI / 2, Math.PI / 3]} scale={[100, 10, 1]} />
        </Environment>
      </Canvas>
    </div>
  );
}

function Band({ maxSpeed = 50, minSpeed = 0, isMobile = false }: { maxSpeed?: number; minSpeed?: number; isMobile?: boolean }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const band = useRef<any>(null);
  const fixed = useRef<RapierRigidBody>(null!);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j1 = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j2 = useRef<any>(null);
  const j3 = useRef<RapierRigidBody>(null!);
  const card = useRef<RapierRigidBody>(null!);
  const vec = new THREE.Vector3();
  const ang = new THREE.Vector3();
  const rot = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const segmentProps = { type: 'dynamic' as const, canSleep: true, colliders: false as const, angularDamping: 4, linearDamping: 4 };
  const { nodes, materials } = useGLTF(cardGLB) as unknown as {
    nodes: Record<string, THREE.Mesh>;
    materials: Record<string, THREE.MeshStandardMaterial & { map: THREE.Texture }>;
  };
  // Both colorways load up front so the pull-toggle swaps without a suspense
  // hiccup mid-drag.
  const bandDarkTex = useTexture(bandDarkImage);
  const bandLightTex = useTexture(bandLightImage);
  const frontDarkTex = useTexture(frontDarkImage);
  const frontLightTex = useTexture(frontLightImage);
  const isLight = useStore((state) => state.theme) === 'light';
  const bandTexture = isLight ? bandLightTex : bandDarkTex;

  // Composite our branded face(s) into the card's texture atlas: keep the
  // baked atlas for card edges (whitened in the light colorway so the card
  // rim matches), draw the CCY front into the left half and a dimmed copy
  // into the right half (the back face).
  const [cardMap, setCardMap] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    const baseMap = materials.base.map;
    const baseImg = baseMap.image as HTMLImageElement | undefined;
    const frontTex = isLight ? frontLightTex : frontDarkTex;
    const faceImg = frontTex.image as HTMLImageElement | undefined;
    if (!baseImg || !faceImg) return;
    const W = baseImg.width;
    const H = baseImg.height;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(baseImg, 0, 0, W, H);
    if (isLight) {
      ctx.fillStyle = 'rgba(244,245,247,0.9)';
      ctx.fillRect(0, 0, W, H);
    }

    const drawCover = (img: HTMLImageElement, rect: { x: number; y: number; w: number; h: number }, alpha = 1) => {
      const rx = rect.x * W;
      const ry = rect.y * H;
      const rw = rect.w * W;
      const rh = rect.h * H;
      const scale = Math.max(rw / img.width, rh / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, rx + (rw - dw) / 2, ry + (rh - dh) / 2, dw, dh);
      ctx.restore();
    };
    drawCover(faceImg, FRONT_UV_RECT);
    drawCover(faceImg, BACK_UV_RECT, 0.92);

    const composite = new THREE.CanvasTexture(canvas);
    composite.colorSpace = THREE.SRGBColorSpace;
    composite.flipY = baseMap.flipY;
    composite.anisotropy = 16;
    composite.needsUpdate = true;
    setCardMap(composite);
    return () => composite.dispose();
  }, [materials.base.map, frontDarkTex, frontLightTex, isLight]);

  const [curve] = useState(
    () => new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]),
  );
  const [dragged, drag] = useState<false | THREE.Vector3>(false);
  const [hovered, hover] = useState(false);
  // Pull-cord bookkeeping: the card's world Y when grabbed, and whether this
  // grab already clicked the switch (one toggle per pull, like a real cord).
  const pullStartY = useRef(0);
  const pullLatched = useRef(false);

  useRopeJoint(fixed, j1, [[0, 0, 0], [0, 0, 0], 1]);
  useRopeJoint(j1, j2, [[0, 0, 0], [0, 0, 0], 1]);
  useRopeJoint(j2, j3, [[0, 0, 0], [0, 0, 0], 1]);
  useSphericalJoint(j3, card, [[0, 0, 0], [0, 1.5, 0]]);

  useEffect(() => {
    if (hovered) {
      document.body.style.cursor = dragged ? 'grabbing' : 'grab';
      return () => void (document.body.style.cursor = 'auto');
    }
  }, [hovered, dragged]);

  useFrame((state, delta) => {
    if (dragged) {
      vec.set(state.pointer.x, state.pointer.y, 0.5).unproject(state.camera);
      dir.copy(vec).sub(state.camera.position).normalize();
      vec.add(dir.multiplyScalar(state.camera.position.length()));
      [card, j1, j2, j3, fixed].forEach((ref) => ref.current?.wakeUp());
      card.current?.setNextKinematicTranslation({ x: vec.x - dragged.x, y: vec.y - dragged.y, z: vec.z - dragged.z });
      // Pull-cord switch: a firm downward yank clicks the theme toggle.
      if (!pullLatched.current && pullStartY.current - (vec.y - dragged.y) > PULL_TOGGLE_DISTANCE) {
        pullLatched.current = true;
        useStore.getState().toggleTheme();
      }
    }
    if (fixed.current && j1.current && j2.current && j3.current && card.current && band.current) {
      [j1, j2].forEach((ref) => {
        if (!ref.current.lerped) ref.current.lerped = new THREE.Vector3().copy(ref.current.translation());
        const clampedDistance = Math.max(0.1, Math.min(1, ref.current.lerped.distanceTo(ref.current.translation())));
        ref.current.lerped.lerp(ref.current.translation(), delta * (minSpeed + clampedDistance * (maxSpeed - minSpeed)));
      });
      curve.points[0].copy(j3.current.translation());
      curve.points[1].copy(j2.current.lerped);
      curve.points[2].copy(j1.current.lerped);
      curve.points[3].copy(fixed.current.translation());
      band.current.geometry.setPoints(curve.getPoints(isMobile ? 16 : 32));
      ang.copy(card.current.angvel());
      rot.copy(card.current.rotation() as unknown as THREE.Vector3);
      card.current.setAngvel({ x: ang.x, y: ang.y - rot.y * 0.25, z: ang.z }, true);
    }
  });

  curve.curveType = 'chordal';
  bandDarkTex.wrapS = bandDarkTex.wrapT = THREE.RepeatWrapping;
  bandLightTex.wrapS = bandLightTex.wrapT = THREE.RepeatWrapping;

  return (
    <>
      <group position={[0, 4, 0]}>
        <RigidBody ref={fixed} {...segmentProps} type="fixed" />
        <RigidBody position={[0.5, 0, 0]} ref={j1} {...segmentProps}>
          <BallCollider args={[0.1]} />
        </RigidBody>
        <RigidBody position={[1, 0, 0]} ref={j2} {...segmentProps}>
          <BallCollider args={[0.1]} />
        </RigidBody>
        <RigidBody position={[1.5, 0, 0]} ref={j3} {...segmentProps}>
          <BallCollider args={[0.1]} />
        </RigidBody>
        <RigidBody position={[2, 0, 0]} ref={card} {...segmentProps} type={dragged ? 'kinematicPosition' : 'dynamic'}>
          <CuboidCollider args={[0.8, 1.125, 0.01]} />
          <group
            scale={2.25}
            position={[0, -1.2, -0.05]}
            onPointerOver={() => hover(true)}
            onPointerOut={() => hover(false)}
            onPointerUp={(e) => {
              (e.target as Element).releasePointerCapture(e.pointerId);
              drag(false);
            }}
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              pullStartY.current = card.current!.translation().y;
              pullLatched.current = false;
              drag(new THREE.Vector3().copy(e.point).sub(vec.copy(card.current!.translation() as unknown as THREE.Vector3)));
            }}
          >
            <mesh geometry={nodes.card.geometry}>
              <meshPhysicalMaterial
                map={cardMap ?? materials.base.map}
                map-anisotropy={16}
                clearcoat={isMobile ? 0 : 1}
                clearcoatRoughness={0.15}
                roughness={0.9}
                metalness={0.8}
              />
            </mesh>
            <mesh geometry={nodes.clip.geometry} material={materials.metal} material-roughness={0.3} />
            <mesh geometry={nodes.clamp.geometry} material={materials.metal} />
          </group>
        </RigidBody>
      </group>
      <mesh ref={band}>
        <meshLineGeometry />
        {/* key remounts the material on theme flips — meshline keeps its map
            as a shader uniform, so a fresh material is the reliable swap. */}
        <meshLineMaterial
          key={isLight ? 'band-light' : 'band-dark'}
          color="white"
          depthTest={false}
          resolution={isMobile ? [1000, 2000] : [1000, 1000]}
          useMap={1}
          map={bandTexture}
          repeat={[-4, 1]}
          lineWidth={1}
        />
      </mesh>
    </>
  );
}
