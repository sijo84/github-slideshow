// stub (W0): replaced by task W5
import type { SeatIndex } from '@poker/engine';
import type { Vec3 } from '../anim/tween.js';
import type { Scene } from './sceneContext.js';

export function seatPosition(_seat: SeatIndex, _maxSeats: number, _mySeat: SeatIndex | null): Vec3 {
  throw new Error('not implemented');
}

export function betPosition(_seat: SeatIndex, _maxSeats: number, _mySeat: SeatIndex | null): Vec3 {
  throw new Error('not implemented');
}

export function buttonPosition(_seat: SeatIndex, _maxSeats: number, _mySeat: SeatIndex | null): Vec3 {
  throw new Error('not implemented');
}

export function potPosition(_index: number): Vec3 {
  throw new Error('not implemented');
}

export function boardPosition(_index: number): Vec3 {
  throw new Error('not implemented');
}

/** Placeholder value; W5 sets the real position. */
export const dealerPosition: Vec3 = [0, 0, 0];

/** Placeholder value; W5 sets the real position. */
export const muckPosition: Vec3 = [0, 0, 0];

export function makeScene(_maxSeats: number, _mySeat: SeatIndex | null): Scene {
  throw new Error('not implemented');
}

export function cameraFor(_aspect: number): { position: Vec3; fov: number; lookAt: Vec3 } {
  throw new Error('not implemented');
}
