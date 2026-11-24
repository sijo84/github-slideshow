/**
 * Player statistics computed from stored hand records.
 *
 * Definitions (all ratios are plain fractions 0..1, except AF which can exceed 1;
 * every ratio is 0 when its denominator is 0):
 *
 * - hands: records in which the player was dealt in (appears in `handStarted.seats`
 *   or `playerIds`). Records without the player are ignored entirely.
 * - vpip: hands where the player voluntarily put money in preflop (call, bet, raise,
 *   or an allIn of either kind) / hands. Posting blinds or antes and checking the big
 *   blind do not count.
 * - pfr: hands with a preflop raise (raise, bet, or aggressive allIn) by the player / hands.
 * - af: (postflop bets + raises) / postflop calls, over all postflop streets of all hands.
 *   With zero postflop calls, af = bets + raises.
 * - wtsd: hands where the player went to showdown / hands where the player saw the flop.
 *   "Went to showdown" = the hand has a showdown (at least one `showCards` or `muck`
 *   event) and the player had not folded. "Saw the flop" = a flop `street` event
 *   occurred and the player had not folded before it.
 * - wonAtShowdown: showdowns in which the player won at least one pot (appears in a
 *   `potAwarded.seats` with amount > 0) / showdowns the player went to.
 * - netChips: sum over hands of (stack in `handEnded.stacks` - starting stack in
 *   `handStarted.seats`). A hand with no `handEnded` (or no entry for the seat) adds 0.
 *
 * Action classification: before the first `street` event the hand is preflop. `bet` and
 * `raise` are aggressive, `call` is a call. An `allIn` is aggressive when its amount
 * (the player's total street contribution) exceeds the current highest street
 * contribution, otherwise it is a call. Preflop the highest contribution starts at the
 * largest blind posted; it resets to 0 on each new street.
 */
import type { HandRecord, SeatIndex } from './types.js';

export interface PlayerStats { hands: number; vpip: number; pfr: number; af: number; wtsd: number; wonAtShowdown: number; netChips: number }

interface HandTally {
  vpip: boolean;
  pfr: boolean;
  postflopAggressive: number;
  postflopCalls: number;
  sawFlop: boolean;
  wentToShowdown: boolean;
  wonAtShowdown: boolean;
  net: number;
}

function findSeat(record: HandRecord, playerId: string): SeatIndex | null {
  for (const e of record.events) {
    if (e.type === 'handStarted') {
      const s = e.seats.find((x) => x.playerId === playerId);
      if (s) return s.seat;
    }
  }
  for (const [seat, id] of Object.entries(record.playerIds)) {
    if (id === playerId) return Number(seat);
  }
  return null;
}

function tallyHand(record: HandRecord, seat: SeatIndex): HandTally {
  const t: HandTally = {
    vpip: false, pfr: false, postflopAggressive: 0, postflopCalls: 0,
    sawFlop: false, wentToShowdown: false, wonAtShowdown: false, net: 0,
  };
  let preflop = true;
  let highest = 0;
  let folded = false;
  let showdown = false;
  let wonPot = false;
  let startStack: number | null = null;
  let endStack: number | null = null;

  for (const e of record.events) {
    switch (e.type) {
      case 'handStarted': {
        const s = e.seats.find((x) => x.seat === seat);
        if (s) startStack = s.stack;
        break;
      }
      case 'postBlind':
        if (preflop) highest = Math.max(highest, e.amount);
        break;
      case 'street':
        if (e.street === 'flop' && !folded) t.sawFlop = true;
        preflop = false;
        highest = 0;
        break;
      case 'action': {
        let aggressive = false;
        let call = false;
        if (e.kind === 'bet' || e.kind === 'raise') aggressive = true;
        else if (e.kind === 'call') call = true;
        else if (e.kind === 'allIn') {
          if (e.amount > highest) aggressive = true;
          else call = true;
        }
        if (e.kind !== 'fold' && e.kind !== 'check') highest = Math.max(highest, e.amount);
        if (e.seat !== seat) break;
        if (e.kind === 'fold') folded = true;
        if (preflop) {
          if (aggressive || call) t.vpip = true;
          if (aggressive) t.pfr = true;
        } else {
          if (aggressive) t.postflopAggressive++;
          if (call) t.postflopCalls++;
        }
        break;
      }
      case 'showCards':
      case 'muck':
        showdown = true;
        break;
      case 'potAwarded':
        e.seats.forEach((s, i) => {
          if (s === seat && (e.amounts[i] ?? 0) > 0) wonPot = true;
        });
        break;
      case 'handEnded': {
        const s = e.stacks.find((x) => x.seat === seat);
        if (s) endStack = s.stack;
        break;
      }
      default:
        break;
    }
  }

  t.wentToShowdown = showdown && !folded;
  t.wonAtShowdown = t.wentToShowdown && wonPot;
  if (startStack !== null && endStack !== null) t.net = endStack - startStack;
  return t;
}

const ratio = (num: number, den: number): number => (den === 0 ? 0 : num / den);

export function computeStats(records: HandRecord[], playerId: string): PlayerStats {
  let hands = 0;
  let vpip = 0;
  let pfr = 0;
  let aggressive = 0;
  let calls = 0;
  let sawFlop = 0;
  let showdowns = 0;
  let wonShowdowns = 0;
  let netChips = 0;

  for (const record of records) {
    const seat = findSeat(record, playerId);
    if (seat === null) continue;
    const t = tallyHand(record, seat);
    hands++;
    if (t.vpip) vpip++;
    if (t.pfr) pfr++;
    aggressive += t.postflopAggressive;
    calls += t.postflopCalls;
    if (t.sawFlop) sawFlop++;
    if (t.wentToShowdown) showdowns++;
    if (t.wonAtShowdown) wonShowdowns++;
    netChips += t.net;
  }

  return {
    hands,
    vpip: ratio(vpip, hands),
    pfr: ratio(pfr, hands),
    af: calls === 0 ? aggressive : aggressive / calls,
    wtsd: ratio(showdowns, sawFlop),
    wonAtShowdown: ratio(wonShowdowns, showdowns),
    netChips,
  };
}
