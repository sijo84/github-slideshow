import type { BlindLevel, Chips, SeatIndex, SeatInput, Stakes } from './types.js';

/**
 * Blinds, button movement, forced bets and the tournament blind clock.
 *
 * Button rule: this is a simplified "moving button". Each hand the button moves to
 * the next occupied seat clockwise (clockwise = increasing seat index, wrapping
 * around at maxSeats). There is NO dead-button rule: the button never stays on an
 * empty seat, and a player may occasionally skip or pay the big blind twice when
 * players bust or leave. This is intentional for simplicity.
 */

/** Distance going clockwise from `from` to `to` (1..maxSeats; `to === from` gives maxSeats). */
function clockwiseDistance(from: SeatIndex, to: SeatIndex, maxSeats: number): number {
  const d = (((to - from) % maxSeats) + maxSeats) % maxSeats;
  return d === 0 ? maxSeats : d;
}

/** First seat of `seats` strictly clockwise after `from` (may wrap back to `from` itself). */
function nextClockwise(from: SeatIndex, seats: SeatIndex[], maxSeats: number): SeatIndex {
  let best: SeatIndex | undefined;
  let bestDist = Infinity;
  for (const s of seats) {
    const d = clockwiseDistance(from, s, maxSeats);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  if (best === undefined) throw new Error('no seats');
  return best;
}

export function nextButton(prevButton: SeatIndex | null, occupied: SeatIndex[], maxSeats: number): SeatIndex {
  if (occupied.length === 0) throw new Error('nextButton: no occupied seats');
  if (prevButton === null) return Math.min(...occupied);
  return nextClockwise(prevButton, occupied, maxSeats);
}

export function blindSeats(
  button: SeatIndex,
  dealtIn: SeatIndex[],
  maxSeats: number,
): { sb: SeatIndex; bb: SeatIndex; firstToActPreflop: SeatIndex; firstToActPostflop: SeatIndex } {
  if (dealtIn.length < 2) throw new Error('blindSeats: at least two players must be dealt in');
  if (!dealtIn.includes(button)) throw new Error(`blindSeats: button seat ${button} is not dealt in`);
  if (dealtIn.length === 2) {
    // Heads-up: the button posts the small blind and acts first preflop, last postflop.
    const bb = nextClockwise(button, dealtIn, maxSeats);
    return { sb: button, bb, firstToActPreflop: button, firstToActPostflop: bb };
  }
  const sb = nextClockwise(button, dealtIn, maxSeats);
  const bb = nextClockwise(sb, dealtIn, maxSeats);
  const firstToActPreflop = nextClockwise(bb, dealtIn, maxSeats);
  return { sb, bb, firstToActPreflop, firstToActPostflop: sb };
}

export function forcedBets(
  stakes: Stakes,
  button: SeatIndex,
  dealtIn: SeatInput[],
  maxSeats: number,
): { antes: { seat: SeatIndex; amount: Chips }[]; blinds: { seat: SeatIndex; blind: 'small' | 'big'; amount: Chips }[] } {
  const { sb, bb } = blindSeats(
    button,
    dealtIn.map((s) => s.seat),
    maxSeats,
  );
  const remaining = new Map<SeatIndex, Chips>(dealtIn.map((s) => [s.seat, s.stack]));
  const stackOf = (seat: SeatIndex): Chips => remaining.get(seat) ?? 0;

  const antes: { seat: SeatIndex; amount: Chips }[] = [];
  const blinds: { seat: SeatIndex; blind: 'small' | 'big'; amount: Chips }[] = [];
  const anteActive = stakes.anteKind !== 'none' && stakes.ante > 0;

  if (anteActive && stakes.anteKind === 'every') {
    // Clockwise starting left of the button (the button posts last).
    const ordered = [...dealtIn].sort(
      (a, b) => clockwiseDistance(button, a.seat, maxSeats) - clockwiseDistance(button, b.seat, maxSeats),
    );
    for (const s of ordered) {
      const amount = Math.min(stakes.ante, stackOf(s.seat));
      if (amount > 0) {
        antes.push({ seat: s.seat, amount });
        remaining.set(s.seat, stackOf(s.seat) - amount);
      }
    }
  }

  // Big blind ante (TDA Rule 4 variant chosen by this plan): a short BB fills the blind
  // first and only the remainder goes to the ante. The ante is still listed (and posted)
  // before the blind in event order.
  let bbAmount = Math.min(stakes.bigBlind, stackOf(bb));
  if (anteActive && stakes.anteKind === 'bigBlind') {
    const anteAmount = Math.min(stakes.ante, stackOf(bb) - bbAmount);
    if (anteAmount > 0) antes.push({ seat: bb, amount: anteAmount });
    remaining.set(bb, stackOf(bb) - anteAmount);
    bbAmount = Math.min(stakes.bigBlind, stackOf(bb));
  }

  const sbAmount = Math.min(stakes.smallBlind, stackOf(sb));
  if (sbAmount > 0) blinds.push({ seat: sb, blind: 'small', amount: sbAmount });
  if (bbAmount > 0) blinds.push({ seat: bb, blind: 'big', amount: bbAmount });
  return { antes, blinds };
}

/**
 * Current blind level given the clock. Paused time is excluded from elapsed time.
 * Once the last level's duration has run out, the clock stays on the last level and
 * reports msLeft = 0, meaning "last level, no further increase".
 */
export function levelAt(levels: BlindLevel[], startedAtMs: number, nowMs: number, pausedMs: number): { index: number; msLeft: number } {
  if (levels.length === 0) throw new Error('levelAt: no levels');
  const elapsed = Math.max(0, nowMs - startedAtMs - pausedMs);
  let end = 0;
  for (let i = 0; i < levels.length; i++) {
    end += levels[i]!.durationMinutes * 60_000;
    if (elapsed < end) return { index: i, msLeft: end - elapsed };
  }
  return { index: levels.length - 1, msLeft: 0 };
}

/** [] if valid; otherwise one human-readable message per violation. */
export function validateLevels(levels: BlindLevel[]): string[] {
  const errors: string[] = [];
  if (levels.length === 0) return ['The schedule must have at least one level.'];
  levels.forEach((l, i) => {
    const name = `Level ${i + 1}`;
    const fields = ['level', 'smallBlind', 'bigBlind', 'ante', 'durationMinutes'] as const;
    let integers = true;
    for (const f of fields) {
      if (!Number.isSafeInteger(l[f])) {
        errors.push(`${name}: ${f} must be a whole number.`);
        integers = false;
      }
    }
    if (!integers) return;
    if (l.level !== i + 1) errors.push(`${name}: level number is ${l.level}, expected ${i + 1}.`);
    if (l.smallBlind < 1) errors.push(`${name}: small blind must be at least 1.`);
    if (l.bigBlind <= l.smallBlind) errors.push(`${name}: big blind must be greater than the small blind.`);
    const prev = i > 0 ? levels[i - 1] : undefined;
    if (prev && Number.isSafeInteger(prev.bigBlind) && l.bigBlind < prev.bigBlind) {
      errors.push(`${name}: big blind must not be lower than the previous level's.`);
    }
    if (l.ante < 0) errors.push(`${name}: ante must not be negative.`);
    if (l.durationMinutes < 1) errors.push(`${name}: duration must be at least 1 minute.`);
  });
  return errors;
}
