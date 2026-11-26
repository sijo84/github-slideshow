/**
 * The table itself (W5): an oval felt inside a raised, rounded rail, on a dark base, with a soft contact
 * shadow below it and a gentle vignette baked into the felt texture. Rendered inside the Canvas by Table3D.
 * Colours: a felt green a little richer than theme.css --felt (#1f6b47) so it reads on the dark page, a dark
 * leather rail with a satin highlight, a charcoal base. The base sits below y = 0 so it never covers the felt.
 */
import { ContactShadows } from '@react-three/drei';
import { useEffect, useMemo } from 'react';
import { CanvasTexture, ExtrudeGeometry, Path, SRGBColorSpace, Shape, ShapeGeometry, type Texture } from 'three';
import { FELT_RX, FELT_RZ, RIM_RX, RIM_RZ } from './layout.js';

const FELT_CENTRE = '#2b8a5b';
const FELT_MID = '#25804f';
const FELT_EDGE = '#1a5f3b';
const RAIL_COLOUR = '#3a2518';
const TRIM_COLOUR = '#8a6238';
const BASE_COLOUR = '#151816';

const RAIL_HEIGHT = 0.16;
const BASE_DEPTH = 0.45;

function ellipseShape(rx: number, rz: number): Shape {
  const s = new Shape();
  s.absellipse(0, 0, rx, rz, 0, Math.PI * 2, false, 0);
  return s;
}

function ellipsePath(rx: number, rz: number): Path {
  const p = new Path();
  p.absellipse(0, 0, rx, rz, 0, Math.PI * 2, true, 0);
  return p;
}

/** Radial felt gradient (lighter centre, darker edge: the vignette) with a little grain. Null without a 2D canvas. */
function makeFeltTexture(): Texture | null {
  if (typeof document === 'undefined') return null;
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, FELT_CENTRE);
  g.addColorStop(0.7, FELT_MID);
  g.addColorStop(1, FELT_EDGE);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Grain: deterministic speckle so the felt does not look like plastic.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(rand() * size, rand() * size, 1.5, 1.5);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

export function Felt() {
  const feltGeometry = useMemo(() => {
    const geo = new ShapeGeometry(ellipseShape(RIM_RX - 0.05, RIM_RZ - 0.05), 96);
    // Map UVs to the ellipse's bounding box so the radial texture follows the oval.
    const pos = geo.attributes.position!;
    const uv = geo.attributes.uv!;
    for (let i = 0; i < pos.count; i++) {
      uv.setXY(i, pos.getX(i) / (2 * FELT_RX) + 0.5, pos.getY(i) / (2 * FELT_RZ) + 0.5);
    }
    uv.needsUpdate = true;
    return geo;
  }, []);

  const railGeometry = useMemo(() => {
    const ring = ellipseShape(RIM_RX, RIM_RZ);
    ring.holes.push(ellipsePath(FELT_RX, FELT_RZ));
    return new ExtrudeGeometry(ring, {
      depth: RAIL_HEIGHT,
      bevelEnabled: true,
      bevelThickness: 0.08,
      bevelSize: 0.1,
      bevelSegments: 5,
      curveSegments: 96,
    });
  }, []);

  const trimGeometry = useMemo(() => {
    const ring = ellipseShape(FELT_RX + 0.02, FELT_RZ + 0.02);
    ring.holes.push(ellipsePath(FELT_RX - 0.16, FELT_RZ - 0.16));
    return new ExtrudeGeometry(ring, { depth: 0.03, bevelEnabled: false, curveSegments: 96 });
  }, []);

  const baseGeometry = useMemo(
    () =>
      new ExtrudeGeometry(ellipseShape(RIM_RX - 0.15, RIM_RZ - 0.15), {
        depth: BASE_DEPTH,
        bevelEnabled: true,
        bevelThickness: 0.05,
        bevelSize: 0.05,
        bevelSegments: 2,
        curveSegments: 64,
      }),
    [],
  );

  const feltTexture = useMemo(makeFeltTexture, []);

  useEffect(
    () => () => {
      feltGeometry.dispose();
      railGeometry.dispose();
      trimGeometry.dispose();
      baseGeometry.dispose();
      feltTexture?.dispose();
    },
    [feltGeometry, railGeometry, trimGeometry, baseGeometry, feltTexture],
  );

  return (
    <group name="table">
      {/* Shapes are drawn in XY; rotating −90° about x lays them in XZ (shape y → −z, extrusion → +y). */}
      <mesh geometry={feltGeometry} rotation-x={-Math.PI / 2} receiveShadow>
        <meshStandardMaterial
          color={feltTexture ? '#ffffff' : FELT_MID}
          map={feltTexture}
          roughness={0.92}
          metalness={0}
        />
      </mesh>
      <mesh geometry={railGeometry} rotation-x={-Math.PI / 2} castShadow receiveShadow>
        <meshStandardMaterial color={RAIL_COLOUR} roughness={0.38} metalness={0.05} />
      </mesh>
      {/* A thin wooden trim where the rail meets the felt. */}
      <mesh geometry={trimGeometry} rotation-x={-Math.PI / 2} receiveShadow>
        <meshStandardMaterial color={TRIM_COLOUR} roughness={0.45} metalness={0.1} />
      </mesh>
      {/* The base's top bevel reaches 0.05 above its origin: keep it all under the felt. */}
      <mesh geometry={baseGeometry} rotation-x={Math.PI / 2} position-y={-0.12} castShadow>
        <meshStandardMaterial color={BASE_COLOUR} roughness={0.8} />
      </mesh>
      <ContactShadows position={[0, -0.7, 0]} scale={[12, 8]} far={2} blur={2.6} opacity={0.6} frames={1} resolution={512} />
    </group>
  );
}
