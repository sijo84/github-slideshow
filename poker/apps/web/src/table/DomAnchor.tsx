/**
 * DomAnchor (W8, shared): plain DOM pinned to a point of the 3D scene, as a StrictMode-safe stand-in for drei
 * `<Html center>`.
 *
 * Use it as a child of any r3f group (anywhere inside the `<Canvas>`). It renders `children` in screen space,
 * centred on the group's world position, in its own React root, inside the Canvas' DOM container. It hides itself
 * while that point is behind the camera, and moves with the group (after every React commit and on every
 * drawn frame).
 *
 * **Contexts.** Its children are in a separate React root, so React context from outside does not reach them.
 * By default (`bridge`, true) DomAnchor re-provides the three table contexts: the table store
 * (`TableStoreContext`, so `useTable` works), the scene (`SceneContext`, so `useScene` works) and the seat actions
 * (`SeatActionsContext`). Any other context the children need, the caller must read outside and provide again
 * inside `children`. `TableContextBridge` and `useTableContexts` are exported for doing the same elsewhere.
 *
 * **Why not drei `<Html>`.** drei creates its React root in a layout effect and unmounts it synchronously in that
 * effect's cleanup, on one container element kept for its whole life. Under React StrictMode (main.tsx) every
 * layout effect runs, is cleaned up and runs again on mount. So each `<Html>` logged "Attempted to synchronously
 * unmount a root while React was already rendering", and the deferred unmount of the first root raced the second
 * root on the same element, sometimes leaving one HUD empty and missing from the DOM. The same happens when its
 * mount target changes (r3f sets `events.connected` after the first commit). Here every mount gets a fresh
 * container element and its own root, and the old root is unmounted after the commit (`setTimeout`), so no two
 * roots share an element and nothing unmounts during a render.
 *
 * Example:
 *   <group position={pos}>
 *     <DomAnchor zIndex={15} pointerEvents="none" className="chip-label">
 *       <span data-testid="pot-0">{formatPlayMoney(amount)}</span>
 *     </DomAnchor>
 *   </group>
 */
import { useFrame, useThree } from '@react-three/fiber';
import {
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Vector3, type Group } from 'three';
import type { StoreApi } from 'zustand';
import { SceneContext, SeatActionsContext, type Scene, type SeatActions } from './sceneContext.js';
import { TableStoreContext } from './storeContext.js';
import type { TableState } from './types.js';

/** The table contexts DomAnchor carries into its own React root. */
export interface TableContexts {
  store: StoreApi<TableState> | null;
  scene: Scene | null;
  seatActions: SeatActions;
}

/** Reads the table store, scene and seat-action contexts where it is called (none of them is required). */
export function useTableContexts(): TableContexts {
  return {
    store: useContext(TableStoreContext),
    scene: useContext(SceneContext),
    seatActions: useContext(SeatActionsContext),
  };
}

/** Provides contexts read with `useTableContexts` again, e.g. inside another React root. */
export function TableContextBridge({ contexts, children }: { contexts: TableContexts; children?: ReactNode }) {
  return (
    <TableStoreContext.Provider value={contexts.store}>
      <SceneContext.Provider value={contexts.scene}>
        <SeatActionsContext.Provider value={contexts.seatActions}>{children}</SeatActionsContext.Provider>
      </SceneContext.Provider>
    </TableStoreContext.Provider>
  );
}

export interface DomAnchorProps {
  /** DOM content, centred on the parent group's world position. */
  children?: ReactNode;
  /** z-index of the anchor's container inside the Canvas' DOM container (default 10). The Canvas wrapper is its
   *  own stacking context, so this only orders anchors among themselves; all stay below Table3D's overlay. */
  zIndex?: number;
  /** Pointer events on the content (default 'auto'). Use 'none' for labels that must not block clicks. */
  pointerEvents?: 'auto' | 'none';
  /** Class name of the centred wrapper around `children`. */
  className?: string;
  /** Extra inline style of the centred wrapper (its `position`/`transform` are set by DomAnchor). */
  style?: CSSProperties;
  /** Re-provide the table store, scene and seat-action contexts inside the anchor's root (default true). */
  bridge?: boolean;
}

export function DomAnchor({
  children,
  zIndex = 10,
  pointerEvents = 'auto',
  className,
  style,
  bridge = true,
}: DomAnchorProps) {
  const camera = useThree((s) => s.camera);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const connected = useThree((s) => s.events.connected as unknown);
  const canvasParent = useThree((s) => s.gl.domElement.parentNode);
  const target =
    connected instanceof HTMLElement ? connected : canvasParent instanceof HTMLElement ? canvasParent : null;
  const contexts = useTableContexts();
  const group = useRef<Group>(null);
  const holder = useRef<{ el: HTMLDivElement; root: Root } | null>(null);
  const last = useRef({ x: NaN, y: NaN, hidden: false });
  const sizeRef = useRef({ width, height });
  sizeRef.current = { width, height };

  const place = useCallback(() => {
    const h = holder.current;
    const g = group.current;
    if (!h || !g) return;
    g.updateWorldMatrix(true, false);
    const v = new Vector3().setFromMatrixPosition(g.matrixWorld).project(camera);
    const hidden = v.z < -1 || v.z > 1; // behind the camera or past the far plane
    const x = (v.x * 0.5 + 0.5) * sizeRef.current.width;
    const y = (-v.y * 0.5 + 0.5) * sizeRef.current.height;
    const l = last.current;
    if (hidden !== l.hidden) h.el.style.display = hidden ? 'none' : 'block';
    if (Number.isNaN(l.x) || Math.abs(x - l.x) > 0.01 || Math.abs(y - l.y) > 0.01) {
      h.el.style.transform = `translate3d(${x}px,${y}px,0)`;
    }
    last.current = { x, y, hidden };
  }, [camera]);

  // One fresh container + root per mount; the old root is unmounted after the commit, never during it.
  useLayoutEffect(() => {
    if (!target) return;
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;top:0;left:0;transform-origin:0 0;z-index:${zIndex};`;
    target.appendChild(el);
    const root = createRoot(el);
    holder.current = { el, root };
    last.current = { x: NaN, y: NaN, hidden: false };
    place();
    return () => {
      if (holder.current?.root === root) holder.current = null;
      el.remove();
      setTimeout(() => root.unmount(), 0);
    };
  }, [target, zIndex, place]);

  // Re-render the children into the root on every commit (like drei).
  useLayoutEffect(() => {
    const content = (
      <div
        className={className}
        style={{ ...style, position: 'absolute', transform: 'translate3d(-50%,-50%,0)', pointerEvents }}
      >
        {children}
      </div>
    );
    holder.current?.root.render(bridge ? <TableContextBridge contexts={contexts}>{content}</TableContextBridge> : content);
  });

  // Re-place after every commit (the group moved, the canvas resized) and on every drawn frame (camera moves).
  useLayoutEffect(() => {
    place();
  });
  useFrame(place);

  return <group ref={group} />;
}
