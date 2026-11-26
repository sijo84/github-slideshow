/**
 * Chips (W7). Renders the store's `chips: ChipEntity[]` inside the r3f Canvas, declaratively (PLAN I-11):
 * one group per entity, at the position `useTweenedPosition` gives it, with the tween chosen by the pure
 * `chipMotion`. Bets and pots carry an amount label (`DomAnchor`, StrictMode-safe) that counts with `useTween`.
 */
import { formatPlayMoney, type Chips as ChipCount } from '@poker/engine';
import { useEffect, useMemo } from 'react';
import { CylinderGeometry, MeshStandardMaterial } from 'three';
import { useTween, useTweenedPosition } from '../anim/tween.js';
import { chipLabel, chipMotion } from './chipMotion.js';
import { DomAnchor } from './DomAnchor.js';
import { CHIP_DENOMS, chipStacks } from './chipStacks.js';
import { useScene } from './sceneContext.js';
import { useTable } from './storeContext.js';
import type { ChipEntity } from './types.js';
import './chips.css';

export const CHIP_RADIUS = 0.11;
export const CHIP_HEIGHT = 0.022;
/** Centre-to-centre distance between neighbouring stacks. */
export const STACK_SPACING = CHIP_RADIUS * 2 + 0.02;
/** Chips sit this far above the felt (the felt top is y = 0). */
const FELT_Y = 0.005;

interface ChipKit {
  geometry: CylinderGeometry;
  materials: Map<string, MeshStandardMaterial>;
}

/** x offset of stack `i` of `n`, so the stacks sit side by side centred on the entity's position. */
export function stackOffsetX(i: number, n: number): number {
  return (i - (n - 1) / 2) * STACK_SPACING;
}

export function Chips() {
  const chips = useTable((s) => s.chips);
  const bigBlind = useTable((s) => s.level?.bigBlind ?? 0);

  const kit = useMemo<ChipKit>(
    () => ({
      geometry: new CylinderGeometry(CHIP_RADIUS, CHIP_RADIUS, CHIP_HEIGHT, 28),
      materials: new Map(
        CHIP_DENOMS.map(({ color }) => [color, new MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05 })]),
      ),
    }),
    [],
  );
  useEffect(
    () => () => {
      kit.geometry.dispose();
      for (const m of kit.materials.values()) m.dispose();
    },
    [kit],
  );

  return (
    <group name="chips">
      {chips.map((entity) => (
        <ChipEntityView key={entity.id} entity={entity} bigBlind={bigBlind} kit={kit} />
      ))}
    </group>
  );
}

function ChipEntityView({ entity, bigBlind, kit }: { entity: ChipEntity; bigBlind: ChipCount; kit: ChipKit }) {
  const scene = useScene();
  const motion = chipMotion(entity, scene);
  const position = useTweenedPosition(entity.id, motion.to, {
    from: motion.from,
    delayMs: motion.delayMs,
    durationMs: motion.durationMs,
    ease: motion.ease,
  });
  const stacks = useMemo(() => chipStacks(entity.amount, bigBlind), [entity.amount, bigBlind]);
  const label = chipLabel(entity);
  const halfWidth = stacks.length > 0 ? stackOffsetX(stacks.length - 1, stacks.length) + CHIP_RADIUS : 0;

  return (
    <group position={position} name={entity.id}>
      {stacks.map((stack, i) => (
        <group key={`${stack.denom}:${i}`} position={[stackOffsetX(i, stacks.length), 0, 0]}>
          {Array.from({ length: stack.count }, (_, k) => (
            <mesh
              key={k}
              geometry={kit.geometry}
              material={kit.materials.get(stack.color)}
              position={[0, FELT_Y + CHIP_HEIGHT / 2 + k * CHIP_HEIGHT, 0]}
              castShadow
              receiveShadow
            />
          ))}
        </group>
      ))}
      {label && (
        <group position={[halfWidth + 0.18, 0.06, 0]}>
          <DomAnchor zIndex={15} pointerEvents="none" className={label.prefix ? 'chip-label chip-label--pot' : 'chip-label'}>
            <ChipAmountLabel id={entity.id} testId={label.testId} prefix={label.prefix} amount={entity.amount} />
          </DomAnchor>
        </group>
      )}
    </group>
  );
}

/** The DOM label text (exported for tests and the replayer; no Canvas needed). Counts up/down with a tween.
 *  The pill styling (`.chip-label`) sits on the DomAnchor wrapper around it. */
export function ChipAmountLabel({
  id,
  testId,
  prefix,
  amount,
}: {
  id: string;
  testId: string;
  prefix: string;
  amount: ChipCount;
}) {
  const shown = Math.round(useTween(amount, { id: 'amount:' + id, durationMs: 300 }));
  const money = formatPlayMoney(shown);
  return (
    <span data-testid={testId}>
      {prefix ? (
        <>
          <span className="chip-label__prefix">{prefix}</span> {money}
        </>
      ) : (
        money
      )}
    </span>
  );
}
