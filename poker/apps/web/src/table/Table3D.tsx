/**
 * The 3D table (W5). Provides the scene (layout helpers for the store's seat count and viewer) to both the
 * r3f <Canvas> and the DOM `overlay` above it.
 *
 * - React context does not cross the Canvas boundary, so `ContextBridge` re-provides SceneContext,
 *   TableStoreContext and SeatActionsContext inside it.
 * - frameloop "demand" while idle; while any tween runs the loop switches to "always" (tween callbacks move
 *   objects outside React, so the canvas must keep drawing), and one last frame is drawn when they stop.
 * - The camera follows `cameraFor(aspect)` on every resize.
 * - Without WebGL (jsdom, very old browsers) the canvas is left out and only the overlay renders.
 */
import { Canvas, useThree } from '@react-three/fiber';
import { useContext, useLayoutEffect, useMemo, useEffect, useState, type ReactNode } from 'react';
import { PerspectiveCamera } from 'three';
import { activeTweenCount, onTweenActivity } from '../anim/tween.js';
import { Felt } from './Felt.js';
import { cameraFor, makeScene } from './layout.js';
import { SceneContext, SeatActionsContext, useSeatActions, type Scene, type SeatActions } from './sceneContext.js';
import { TableStoreContext, useTable } from './storeContext.js';
import type { StoreApi } from 'zustand';
import type { TableState } from './types.js';
import './table3d.css';

let webglSupport: boolean | null = null;

function hasWebGL(): boolean {
  if (webglSupport !== null) return webglSupport;
  try {
    // jsdom has no canvas backend: getContext is "not implemented" and returns null (logging to the console).
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return (webglSupport = false);
    const c = document.createElement('canvas');
    webglSupport = !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    webglSupport = false;
  }
  return webglSupport;
}

function ContextBridge({
  scene,
  store,
  seatActions,
  children,
}: {
  scene: Scene;
  store: StoreApi<TableState> | null;
  seatActions: SeatActions;
  children?: ReactNode;
}) {
  return (
    <TableStoreContext.Provider value={store}>
      <SceneContext.Provider value={scene}>
        <SeatActionsContext.Provider value={seatActions}>{children}</SeatActionsContext.Provider>
      </SceneContext.Provider>
    </TableStoreContext.Provider>
  );
}

/** Points the camera with `cameraFor` whenever the canvas size changes. */
function CameraRig() {
  const camera = useThree((s) => s.camera);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    if (width <= 0 || height <= 0) return;
    const c = cameraFor(width / height);
    camera.position.set(...c.position);
    camera.lookAt(...c.lookAt);
    if (camera instanceof PerspectiveCamera) {
      camera.fov = c.fov;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    invalidate();
  }, [camera, width, height, invalidate]);
  return null;
}

/** Keeps the canvas drawing while tweens run. */
function TweenFrameloop() {
  const setFrameloop = useThree((s) => s.setFrameloop);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const apply = (active: number) => {
      if (active > 0) {
        setFrameloop('always');
      } else {
        setFrameloop('demand');
        invalidate(); // draw the final resting frame
      }
    };
    apply(activeTweenCount());
    return onTweenActivity(apply);
  }, [setFrameloop, invalidate]);
  return null;
}

function Lights() {
  return (
    <>
      <hemisphereLight args={['#dfe9e3', '#0c0f0d', 0.55]} />
      <ambientLight intensity={0.25} />
      <directionalLight
        position={[2.5, 9, 4]}
        intensity={1.6}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={4}
        shadow-camera-bottom={-4}
        shadow-camera-near={1}
        shadow-camera-far={20}
        shadow-bias={-0.0005}
        shadow-radius={4}
      />
      {/* A soft warm pool of light over the centre of the felt. */}
      <spotLight position={[0, 7, 0]} angle={0.7} penumbra={1} intensity={30} decay={2} color="#fff3dc" />
    </>
  );
}

export function Table3D({ children, overlay }: { children?: ReactNode; overlay?: ReactNode }) {
  const maxSeats = useTable((s) => s.settings?.maxSeats ?? 9);
  const mySeat = useTable((s) => s.mySeat);
  const store = useContext(TableStoreContext);
  const seatActions = useSeatActions();
  const scene = useMemo(() => makeScene(maxSeats, mySeat), [maxSeats, mySeat]);
  const [webgl] = useState(hasWebGL);
  const initial = useMemo(() => cameraFor(16 / 10), []);

  return (
    <SceneContext.Provider value={scene}>
      <div className="table3d" data-testid="table-3d" data-webgl={webgl ? 'true' : 'false'}>
        {webgl && (
          <Canvas
            className="table3d-canvas"
            frameloop="demand"
            shadows
            dpr={[1, 2]}
            gl={{ antialias: true, alpha: true }}
            camera={{ fov: initial.fov, position: initial.position, near: 0.1, far: 200 }}
          >
            <ContextBridge scene={scene} store={store} seatActions={seatActions}>
              <CameraRig />
              <TweenFrameloop />
              <Lights />
              <Felt />
              {children}
            </ContextBridge>
          </Canvas>
        )}
        {overlay !== undefined && overlay !== null && <div className="table3d-overlay">{overlay}</div>}
      </div>
    </SceneContext.Provider>
  );
}
