/**
 * Scene context (W0, final; PLAN I-11 item 4). World positions of everything on the table. The table lies in
 * the XZ plane, y is up, centre at [0, 0, 0]. `makeScene` (W5 layout.ts) builds the real one.
 */
import type { SeatIndex } from '@poker/engine';
import { createContext, useContext } from 'react';
import type { Vec3 } from '../anim/tween.js';
import type { CardPlace, ChipPlace } from './types.js';

export interface Scene {
  maxSeats: number;
  mySeat: SeatIndex | null;
  seatPosition(seat: SeatIndex): Vec3;
  betPosition(seat: SeatIndex): Vec3;
  potPosition(index: number): Vec3;
  boardPosition(index: number): Vec3;
  buttonPosition(seat: SeatIndex): Vec3;
  dealerPosition: Vec3;
  muckPosition: Vec3;
}

export const SceneContext = createContext<Scene | null>(null);

/** The scene from the nearest `SceneContext` provider; throws without one. */
export function useScene(): Scene {
  const scene = useContext(SceneContext);
  if (!scene) throw new Error('useScene must be used inside a SceneContext provider (Table3D)');
  return scene;
}

/**
 * Hole cards are anchored at their seat point (W6, lead decision at checkpoint 8): the seat HUD is DOM drawn on
 * top of the canvas, so `Cards.tsx` draws hole cards as DOM too, above the HUDs, at a screen-space offset from
 * this anchor (beside the viewer's HUD, over the top edge of an opponent's). These constants shift the anchor
 * itself and are 0.
 */
/** Half the gap between a seat's two hole-card anchors, on x. */
export const HOLE_CARD_OFFSET_X = 0;
/** How far a seat's hole-card anchor sits from the seat toward the table centre (fraction of the distance). */
export const HOLE_CARD_INSET = 0;
/** Height of the hole-card anchor above the felt. */
export const HOLE_CARD_Y = 0.02;

export function cardPlacePosition(scene: Scene, place: CardPlace): Vec3 {
  switch (place.at) {
    case 'deck':
      return scene.dealerPosition;
    case 'board':
      return scene.boardPosition(place.index);
    case 'muck':
      return scene.muckPosition;
    case 'seat': {
      const [x, , z] = scene.seatPosition(place.seat);
      const k = 1 - HOLE_CARD_INSET; // HOLE_CARD_INSET of the way toward [0, 0, 0]
      const dx = place.index === 0 ? -HOLE_CARD_OFFSET_X : HOLE_CARD_OFFSET_X;
      return [x * k + dx, HOLE_CARD_Y, z * k];
    }
  }
}

export function chipPlacePosition(scene: Scene, place: ChipPlace): Vec3 {
  switch (place.at) {
    case 'seat':
      return scene.seatPosition(place.seat);
    case 'bet':
      return scene.betPosition(place.seat);
    case 'pot':
      return scene.potPosition(place.index);
  }
}

export interface SeatActions {
  onSit(seat: SeatIndex): void;
  onOpenNotes(playerId: string, name: string): void;
}

/** Seat callbacks the page provides (W8's empty-seat button calls `onSit`). Defaults are inert. */
export const SeatActionsContext = createContext<SeatActions>({
  onSit: () => {},
  onOpenNotes: () => {},
});

export function useSeatActions(): SeatActions {
  return useContext(SeatActionsContext);
}
