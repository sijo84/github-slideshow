/**
 * Collusion detection over stored hand records.
 *
 * This module only raises flags for the game host to review. It never bans, blocks or
 * otherwise acts against anyone: every heuristic here has innocent explanations.
 *
 * Heuristics
 * ----------
 * chipDumping (ordered pair A -> B, reported with `players` sorted):
 *   - A "strong fold" is when A folds on the turn or river to a bet/raise from B, where B is
 *     the last aggressor on that street at the moment A folds, A's hole cards plus the board
 *     dealt so far (6 cards on the turn, 7 on the river) beat B's on the same board
 *     (evaluate7), and the pot at that moment (every chip put in during the hand so far,
 *     antes and blinds included, the bet faced included) is >= MIN_STRONG_FOLD_POT_BB big blinds.
 *   - Net flow A -> B: in hands where exactly A and B saw the flop, if A lost chips
 *     (start stack - end stack > 0) and B won chips, the flow is A's loss capped by B's gain.
 *   - Flag when strongFolds >= STRONG_FOLD_FLAG, or when the net flow is
 *     >= NET_FLOW_FLAG_BB big blinds together with strongFolds >= NET_FLOW_MIN_STRONG_FOLDS.
 *   - Score = strongFolds + netBB / NET_FLOW_FLAG_BB. Evidence = strong-fold hands, then
 *     heads-up hands with a positive flow.
 *
 * softPlay (unordered pair):
 *   - Postflop aggression ratio = (bets + raises) / (calls + checks). An all-in counts as a
 *     bet/raise when it exceeds the highest contribution on the street so far, otherwise as a
 *     call. Folds are not counted.
 *   - A ratio with a zero denominator counts as its numerator (e.g. 3 bets and no calls or
 *     checks = 3), so purely aggressive play still yields a finite, large ratio.
 *   - ratio_vs_each_other uses both players' combined postflop actions in hands where exactly
 *     these two saw the flop. Each player's ratio_vs_others uses their postflop actions in all
 *     other hands where they saw the flop.
 *   - Flag when heads-up hands >= SOFT_PLAY_MIN_HANDS and
 *     ratio_vs_each_other < SOFT_PLAY_FACTOR * min(ratio_vs_others of each player).
 *     If either player has no postflop actions against others, the pair is not flagged.
 *   - Score = 1 - ratio_vs_each_other / min(ratio_vs_others). Evidence = the heads-up hands.
 *
 * sharedNetwork:
 *   - Two different players with the same IP -> sharedIp; same device id (other than
 *     'unknown') -> sharedDevice. Score 1. Loopback IPs are ignored for sharedIp.
 *
 * All flags: `players` sorted ascending, evidence = distinct hand ids (max MAX_EVIDENCE),
 * results sorted by score descending.
 */
import { compare, evaluate7 } from './evaluator.js';
import type { Card, Chips, HandRecord, SeatIndex } from './types.js';

export type FlagKind = 'chipDumping' | 'softPlay' | 'sharedIp' | 'sharedDevice';

export interface IntegrityFlag { kind: FlagKind; players: [string, string]; score: number; evidenceHandIds: string[]; summary: string }

/** Strong folds A -> B needed on their own to flag chip dumping. */
const STRONG_FOLD_FLAG = 3;
/** Net heads-up flow (in big blinds) that, with enough strong folds, flags chip dumping. */
const NET_FLOW_FLAG_BB = 50;
/** Strong folds required alongside the net-flow condition. */
const NET_FLOW_MIN_STRONG_FOLDS = 2;
/** Minimum pot (in big blinds) for a fold to count as a strong fold. */
const MIN_STRONG_FOLD_POT_BB = 10;
/** Heads-up postflop pots between the pair needed before soft play is considered. */
const SOFT_PLAY_MIN_HANDS = 15;
/** Soft play when the pair's mutual ratio is below this fraction of their ratio vs others. */
const SOFT_PLAY_FACTOR = 0.25;
const MAX_EVIDENCE = 20;
const LOOPBACK_IPS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

interface Aggression { aggressive: number; passive: number }

interface HandSummary {
  handId: string;
  /** seats that were still in when the flop was dealt */
  sawFlop: string[];
  /** strong folds in this hand: folder -> aggressor */
  strongFolds: { from: string; to: string }[];
  /** chip result (end - start) per player */
  result: Map<string, number>;
  /** postflop aggression counts per player */
  postflop: Map<string, Aggression>;
}

function ratio(a: Aggression): number {
  return a.passive === 0 ? a.aggressive : a.aggressive / a.passive;
}

function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function pairKey(a: string, b: string): string {
  const [x, y] = sortedPair(a, b);
  return JSON.stringify([x, y]);
}

function evidence(ids: string[]): string[] {
  return [...new Set(ids)].slice(0, MAX_EVIDENCE);
}

function bump(m: Map<string, Aggression>, player: string, aggressive: boolean): void {
  const cur = m.get(player) ?? { aggressive: 0, passive: 0 };
  if (aggressive) cur.aggressive++;
  else cur.passive++;
  m.set(player, cur);
}

function summarise(record: HandRecord, bigBlind: Chips): HandSummary {
  const playerOf = new Map<SeatIndex, string>();
  for (const [seat, id] of Object.entries(record.playerIds)) playerOf.set(Number(seat), id);
  const start = new Map<string, number>();
  const end = new Map<string, number>();
  const folded = new Set<SeatIndex>();
  const streetContrib = new Map<SeatIndex, Chips>();
  const board: Card[] = [];
  const summary: HandSummary = { handId: record.handId, sawFlop: [], strongFolds: [], result: new Map(), postflop: new Map() };
  let street: string = 'preflop';
  let pot = 0;
  let lastAggressor: SeatIndex | null = null;

  const highest = (): Chips => Math.max(0, ...streetContrib.values());
  const pid = (seat: SeatIndex): string => playerOf.get(seat) ?? `seat${seat}`;

  for (const ev of record.events) {
    switch (ev.type) {
      case 'handStarted':
        for (const s of ev.seats) {
          playerOf.set(s.seat, s.playerId);
          start.set(s.playerId, s.stack);
        }
        break;
      case 'postAnte':
        pot += ev.amount;
        break;
      case 'postBlind':
        pot += ev.amount;
        streetContrib.set(ev.seat, (streetContrib.get(ev.seat) ?? 0) + ev.amount);
        break;
      case 'street':
        street = ev.street;
        board.push(...ev.cards);
        streetContrib.clear();
        lastAggressor = null;
        if (ev.street === 'flop') {
          for (const seat of playerOf.keys()) if (!folded.has(seat)) summary.sawFlop.push(pid(seat));
        }
        break;
      case 'uncalledReturned':
        pot -= ev.amount;
        break;
      case 'action': {
        const postflop = street === 'flop' || street === 'turn' || street === 'river';
        if (ev.kind === 'fold') {
          folded.add(ev.seat);
          if ((street === 'turn' || street === 'river') && lastAggressor !== null && lastAggressor !== ev.seat) {
            const mine = record.hole[ev.seat];
            const theirs = record.hole[lastAggressor];
            if (mine?.length === 2 && theirs?.length === 2 && pot >= MIN_STRONG_FOLD_POT_BB * bigBlind) {
              const cmp = compare(evaluate7([...mine, ...board]), evaluate7([...theirs, ...board]));
              if (cmp > 0) summary.strongFolds.push({ from: pid(ev.seat), to: pid(lastAggressor) });
            }
          }
          break;
        }
        if (ev.kind === 'check') {
          if (postflop) bump(summary.postflop, pid(ev.seat), false);
          break;
        }
        const prev = streetContrib.get(ev.seat) ?? 0;
        const aggressive = ev.kind === 'bet' || ev.kind === 'raise' || (ev.kind === 'allIn' && ev.amount > highest());
        pot += Math.max(0, ev.amount - prev);
        streetContrib.set(ev.seat, Math.max(prev, ev.amount));
        if (aggressive) lastAggressor = ev.seat;
        if (postflop) bump(summary.postflop, pid(ev.seat), aggressive);
        break;
      }
      case 'handEnded':
        for (const s of ev.stacks) end.set(pid(s.seat), s.stack);
        break;
      default:
        break;
    }
  }
  for (const [player, s] of start) {
    const e = end.get(player);
    if (e !== undefined) summary.result.set(player, e - s);
  }
  return summary;
}

interface DumpStats { from: string; to: string; strongFoldHands: string[]; flow: number; flowHands: string[] }
interface SoftStats { players: [string, string]; hands: string[]; combined: Aggression; per: Map<string, Aggression> }

function bigBlindText(bb: number): string {
  return Number.isInteger(bb) ? String(bb) : bb.toFixed(1);
}

export function analyse(records: HandRecord[], bigBlind: Chips): IntegrityFlag[] {
  const dump = new Map<string, DumpStats>();
  const soft = new Map<string, SoftStats>();
  const totals = new Map<string, Aggression>();

  const dumpOf = (from: string, to: string): DumpStats => {
    const key = JSON.stringify([from, to]);
    let d = dump.get(key);
    if (!d) { d = { from, to, strongFoldHands: [], flow: 0, flowHands: [] }; dump.set(key, d); }
    return d;
  };

  for (const record of records) {
    const h = summarise(record, bigBlind);
    for (const sf of h.strongFolds) dumpOf(sf.from, sf.to).strongFoldHands.push(h.handId);
    for (const [player, agg] of h.postflop) {
      const t = totals.get(player) ?? { aggressive: 0, passive: 0 };
      t.aggressive += agg.aggressive;
      t.passive += agg.passive;
      totals.set(player, t);
    }
    const [p, q] = h.sawFlop;
    if (h.sawFlop.length !== 2 || p === undefined || q === undefined || p === q) continue;

    // Net flow between the two heads-up players.
    const rp = h.result.get(p) ?? 0;
    const rq = h.result.get(q) ?? 0;
    if (rp < 0 && rq > 0) { const d = dumpOf(p, q); d.flow += Math.min(-rp, rq); d.flowHands.push(h.handId); }
    if (rq < 0 && rp > 0) { const d = dumpOf(q, p); d.flow += Math.min(-rq, rp); d.flowHands.push(h.handId); }

    // Mutual aggression between the pair.
    const key = pairKey(p, q);
    let s = soft.get(key);
    if (!s) { s = { players: sortedPair(p, q), hands: [], combined: { aggressive: 0, passive: 0 }, per: new Map() }; soft.set(key, s); }
    s.hands.push(h.handId);
    for (const player of [p, q]) {
      const agg = h.postflop.get(player);
      if (!agg) continue;
      s.combined.aggressive += agg.aggressive;
      s.combined.passive += agg.passive;
      const per = s.per.get(player) ?? { aggressive: 0, passive: 0 };
      per.aggressive += agg.aggressive;
      per.passive += agg.passive;
      s.per.set(player, per);
    }
  }

  const flags: IntegrityFlag[] = [];

  for (const d of dump.values()) {
    const strongFolds = d.strongFoldHands.length;
    const netBB = bigBlind > 0 ? d.flow / bigBlind : 0;
    const flagged = strongFolds >= STRONG_FOLD_FLAG
      || (netBB >= NET_FLOW_FLAG_BB && strongFolds >= NET_FLOW_MIN_STRONG_FOLDS);
    if (!flagged) continue;
    const times = strongFolds === 1 ? 'once' : `${strongFolds} times`;
    let summary = `${d.from} folded a stronger hand to ${d.to}'s bet ${times} on the turn or river.`;
    if (netBB > 0) summary += ` ${d.from} also lost ${bigBlindText(netBB)} big blinds to ${d.to} in pots only they played after the flop.`;
    flags.push({
      kind: 'chipDumping',
      players: sortedPair(d.from, d.to),
      score: strongFolds + netBB / NET_FLOW_FLAG_BB,
      evidenceHandIds: evidence([...d.strongFoldHands, ...d.flowHands]),
      summary,
    });
  }

  for (const s of soft.values()) {
    if (s.hands.length < SOFT_PLAY_MIN_HANDS) continue;
    const others: number[] = [];
    for (const player of s.players) {
      const total = totals.get(player) ?? { aggressive: 0, passive: 0 };
      const mutual = s.per.get(player) ?? { aggressive: 0, passive: 0 };
      const rest = { aggressive: total.aggressive - mutual.aggressive, passive: total.passive - mutual.passive };
      if (rest.aggressive + rest.passive === 0) break;
      others.push(ratio(rest));
    }
    if (others.length !== 2) continue;
    const minOther = Math.min(...others);
    const mutualRatio = ratio(s.combined);
    if (!(mutualRatio < SOFT_PLAY_FACTOR * minOther)) continue;
    const [a, b] = s.players;
    flags.push({
      kind: 'softPlay',
      players: s.players,
      score: 1 - mutualRatio / minOther,
      evidenceHandIds: evidence(s.hands),
      summary: `${a} and ${b} rarely bet or raise against each other after the flop (${s.hands.length} heads-up pots), but both play aggressively against others.`,
    });
  }

  return sortFlags(flags);
}

function sortFlags(flags: IntegrityFlag[]): IntegrityFlag[] {
  return flags.sort((x, y) => y.score - x.score
    || x.kind.localeCompare(y.kind)
    || x.players[0].localeCompare(y.players[0])
    || x.players[1].localeCompare(y.players[1]));
}

export function sharedNetwork(sessions: { playerId: string; ip: string; deviceId: string }[]): IntegrityFlag[] {
  const byIp = new Map<string, Set<string>>();
  const byDevice = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, key: string, player: string): void => {
    const set = m.get(key) ?? new Set<string>();
    set.add(player);
    m.set(key, set);
  };
  for (const s of sessions) {
    if (!LOOPBACK_IPS.has(s.ip)) add(byIp, s.ip, s.playerId);
    if (s.deviceId !== 'unknown') add(byDevice, s.deviceId, s.playerId);
  }

  const flags: IntegrityFlag[] = [];
  const seen = new Set<string>();
  const emit = (kind: FlagKind, groups: Map<string, Set<string>>, what: string): void => {
    for (const group of groups.values()) {
      const players = [...group].sort();
      for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
          const a = players[i]!, b = players[j]!;
          const key = `${kind}:${pairKey(a, b)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          flags.push({ kind, players: [a, b], score: 1, evidenceHandIds: [], summary: `${a} and ${b} connected from the same ${what}.` });
        }
      }
    }
  };
  emit('sharedIp', byIp, 'IP address');
  emit('sharedDevice', byDevice, 'device');
  return sortFlags(flags);
}
