/**
 * Shared helpers for the table e2e specs (W-E2E-2; reused by later history and tournament specs).
 *
 * Accounts, friendships, the game, invites and opening the table go through the REST API (I-11 "E2E setup").
 * Each player gets their own browser context; the context's own `request` registers the account, so the
 * `sid` session cookie lands in that context's cookie jar and the pages are signed in. State-changing API
 * calls carry `Origin: http://localhost:5173` (the server's CSRF check, checkpoint 7 notes).
 */
import { expect, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

export const BASE_URL = 'http://localhost:5173';
export const ORIGIN = 'http://localhost:5173';
export const PASSWORD = 'correct horse battery staple';

const JSON_HEADERS = { Origin: ORIGIN, 'Content-Type': 'application/json' };

export interface Player {
  /** Display name (also the avatar's alt text). */
  name: string;
  email: string;
  id: string;
  context: BrowserContext;
  page: Page;
  /** The context's request object: shares the context's cookies. */
  request: APIRequestContext;
}

async function expectStatus(res: APIResponse, ok: number[], what: string): Promise<void> {
  if (!ok.includes(res.status())) {
    throw new Error(`${what}: HTTP ${res.status()} ${await res.text()}`);
  }
}

export async function apiPost(request: APIRequestContext, path: string, data: unknown, ok: number[], what: string): Promise<unknown> {
  const res = await request.post(path, { data: data ?? {}, headers: JSON_HEADERS });
  await expectStatus(res, ok, what);
  return res.json();
}

function uniqueEmail(name: string): string {
  const local = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'player';
  return `${local}+${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}@test.local`;
}

/**
 * For each name: a fresh browser context (trace on, see `__POKER_TRACE__`) with one page, and a new account
 * registered through that context's request object, so the session cookie belongs to the context.
 * Display names are used as given (2–24 characters).
 */
export async function createPlayers(browser: Browser, names: string[]): Promise<Player[]> {
  const players: Player[] = [];
  for (const name of names) {
    const context = await browser.newContext({ baseURL: BASE_URL, timezoneId: 'UTC' });
    await context.addInitScript(() => {
      const w = window as unknown as { __POKER_TRACE__?: boolean; __e2eBarDisabled?: number };
      w.__POKER_TRACE__ = true;
      // Counts how often an action bar switches to data-enabled="false", so `actWhenMyTurn` can tell that
      // its click was taken even when the same player is to act again right away.
      w.__e2eBarDisabled = 0;
      new MutationObserver((records) => {
        for (const r of records) {
          const el = r.target as Element;
          if (el.getAttribute('data-testid') === 'action-bar' && el.getAttribute('data-enabled') !== 'true' && r.oldValue === 'true') {
            w.__e2eBarDisabled = (w.__e2eBarDisabled ?? 0) + 1;
          }
        }
      }).observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-enabled'] });
    });
    const request = context.request;
    const email = uniqueEmail(name);
    const user = (await apiPost(
      request,
      '/api/auth/register',
      { email, password: PASSWORD, displayName: name },
      [201],
      `register ${name}`,
    )) as { id: string };
    const me = await request.get('/api/auth/me');
    await expectStatus(me, [200], `session cookie for ${name}`);
    const page = await context.newPage();
    players.push({ name, email, id: user.id, context, page, request });
  }
  return players;
}

/** a sends a friend request to b, b accepts. */
export async function befriend(a: Player, b: Player): Promise<void> {
  await apiPost(a.request, '/api/friends/requests', { email: b.email }, [200, 201], `${a.name} → ${b.name} friend request`);
  await apiPost(b.request, `/api/friends/requests/${a.id}/accept`, {}, [200], `${b.name} accepts ${a.name}`);
}

/** The settings W-E2E-2 plays with: cash, 6 seats, 5/10 no ante, buy-in 200–2000, no auto-start. */
export function cashSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'cash',
    maxSeats: 6,
    levels: [{ level: 1, smallBlind: 5, bigBlind: 10, ante: 0, anteKind: 'none', durationMinutes: 60 }],
    minBuyIn: 200,
    maxBuyIn: 2000,
    startingStack: 1000,
    turnSeconds: 30,
    timeBankSeconds: 30,
    timeBankTopUpSeconds: 10,
    rebuys: { allowed: false, untilLevel: 0 },
    payouts: [100],
    seatApproval: false,
    autoStart: false,
    showAllInEquity: true,
    ...overrides,
  };
}

/**
 * Creates a cash game starting now, invites `invitees` (each must already be the host's friend) and opens the
 * table. Returns the game id.
 */
export async function createCashGame(
  host: Player,
  opts: { name: string; invitees: Player[]; settings?: Record<string, unknown> },
): Promise<string> {
  const game = (await apiPost(
    host.request,
    '/api/games',
    { name: opts.name, startsAt: new Date().toISOString(), settings: cashSettings(opts.settings) },
    [201],
    `create game ${opts.name}`,
  )) as { id: string };
  if (opts.invitees.length > 0) {
    await apiPost(host.request, `/api/games/${game.id}/invites`, { userIds: opts.invitees.map((p) => p.id) }, [200], 'invite players');
  }
  const opened = (await apiPost(host.request, `/api/games/${game.id}/open`, {}, [200], 'open table')) as { status: string };
  expect(opened.status).toBe('open');
  return game.id;
}

/** Opens `/table/<id>` and checks the page was not sent to `/login`. */
export async function openTable(page: Page, gameId: string): Promise<void> {
  await page.goto(`/table/${gameId}`);
  await expect(page).toHaveURL(new RegExp(`/table/${gameId}$`));
}

/** Fills a field that may be a number/text input or a range slider (fill() refuses range inputs). */
export async function setFieldValue(field: Locator, value: number): Promise<void> {
  const type = await field.getAttribute('type');
  if (type === 'range') {
    await field.evaluate((el, v) => {
      const input = el as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, String(v));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  } else {
    await field.fill(String(value));
  }
}

/**
 * Sits the page's player at `seat` (0-based seat index: the button is "Sit at seat <seat+1>", the HUD is
 * `seat-<seat>`), with `buyIn` chips. Waits until that seat shows the viewer (`data-me="true"`, and the name
 * when given).
 */
export async function sitDown(page: Page, seat: number, buyIn: number, name?: string): Promise<void> {
  await page.getByRole('button', { name: `Sit at seat ${seat + 1}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sit down' });
  await expect(dialog).toBeVisible();
  await setFieldValue(dialog.getByLabel('Buy-in', { exact: true }), buyIn);
  await dialog.getByRole('button', { name: 'Sit down', exact: true }).click();
  const hud = page.getByTestId(`seat-${seat}`);
  await expect(hud).toHaveAttribute('data-me', 'true');
  if (name) await expect(hud).toContainText(name);
}

export function actionBar(page: Page): Locator {
  return page.getByTestId('action-bar');
}

export function enabledActionBar(page: Page): Locator {
  return page.locator('[data-testid="action-bar"][data-enabled="true"]');
}

async function barDisabledCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __e2eBarDisabled?: number }).__e2eBarDisabled ?? 0);
}

/**
 * Waits for this page's action bar to be enabled, clicks the first button whose accessible name matches
 * (in the order given), and waits until the bar has switched off again (the action was taken).
 */
export async function actWhenMyTurn(page: Page, buttonName: RegExp | RegExp[], timeout = 45_000): Promise<string> {
  const bar = enabledActionBar(page);
  await expect(bar).toBeVisible({ timeout });
  const before = await barDisabledCount(page);
  const names = Array.isArray(buttonName) ? buttonName : [buttonName];
  let clicked: string | null = null;
  for (const n of names) {
    const button = bar.getByRole('button', { name: n });
    if ((await button.count()) > 0 && (await button.first().isEnabled())) {
      clicked = (await button.first().textContent())?.trim() ?? String(n);
      await button.first().click();
      break;
    }
  }
  if (clicked === null) {
    const available = await bar.getByRole('button').allTextContents();
    throw new Error(`no button matching ${names.join(' or ')} in the action bar; buttons: ${available.join(' | ')}`);
  }
  await expect.poll(() => barDisabledCount(page), { timeout, message: `action bar never switched off after "${clicked}"` }).toBeGreaterThan(before);
  return clicked;
}

/** Index of the first page whose action bar is enabled, or -1. */
export async function pageWithTurn(pages: Page[]): Promise<number> {
  for (let i = 0; i < pages.length; i++) {
    if ((await enabledActionBar(pages[i]!).count()) > 0) return i;
  }
  return -1;
}

/** Parses play dollars like `$1,250` (or `1,250`) into 1250. */
export function parseMoney(text: string | null): number {
  const digits = (text ?? '').replace(/[^0-9]/g, '');
  if (digits === '') throw new Error(`not an amount: ${JSON.stringify(text)}`);
  return Number(digits);
}

/** Sum of every chip amount on display: stacks, bets and pots. */
export async function chipsOnTable(page: Page): Promise<{ stacks: number; total: number }> {
  const read = async (prefix: string): Promise<number> => {
    const texts = await page.locator(`[data-testid^="${prefix}"]`).allTextContents();
    return texts.filter((t) => /\d/.test(t)).reduce((sum, t) => sum + parseMoney(t), 0);
  };
  const stacks = await read('stack-');
  const bets = await read('bet-');
  const pots = await read('pot-');
  return { stacks, total: stacks + bets + pots };
}

/** The seat index the page's viewer sits at (from `data-me="true"`), or null. */
export async function mySeat(page: Page): Promise<number | null> {
  const me = page.locator('[data-testid^="seat-"][data-me="true"]');
  if ((await me.count()) === 0) return null;
  const id = await me.first().getAttribute('data-testid');
  return id ? Number(id.slice('seat-'.length)) : null;
}

export function boardCards(page: Page): Locator {
  return page.getByTestId('board').locator('[data-card]');
}

export function handLog(page: Page): Locator {
  return page.getByTestId('hand-log');
}

// ---------------------------------------------------------------------------
// Animation trace (I-11 "Trace check", F5, checkpoint 7 decisions)
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];
export type TraceValue = number | Vec3;

/** Same shape as `TraceSample` in apps/web/src/anim/tween.ts (not imported: the spec never loads app code). */
export interface TraceSample {
  id: string;
  t: number;
  value: TraceValue;
  from?: TraceValue;
  to?: TraceValue;
  durationMs?: number;
  active?: boolean;
  tween?: string;
  ease?: string;
}

/** Copied from apps/web/src/anim/easing.ts (`EASE_PEAK_SLOPE`; easeOutBack c = 1.6). */
export const EASE_PEAK_SLOPE: Record<string, number> = {
  linear: 1,
  easeInOutCubic: 1.5,
  easeOutCubic: 3,
  easeOutQuart: 4,
  easeInOutSine: Math.PI / 2,
  easeOutBack: 1.6 + 3,
};

/** ε in world units for vector series, and for scalar series (counting numbers). */
export const TRACE_EPSILON_VECTOR = 0.02;
export const TRACE_EPSILON_SCALAR = 1;
/** Head-room over the curve's peak slope. */
export const TRACE_SLOPE_FACTOR = 1.25;

export interface TraceViolation {
  series: string;
  /** Index of the later sample within its series. */
  index: number;
  t: number;
  dtMs: number;
  delta: number;
  bound: number;
  reason: string;
  prev: TraceValue;
  value: TraceValue;
  tween?: string;
  ease?: string;
  durationMs?: number;
}

export interface Trace {
  samples: TraceSample[];
  dropped: number | undefined;
}

export async function readTrace(page: Page): Promise<Trace> {
  return page.evaluate(() => {
    const w = window as unknown as { __animTrace?: unknown[]; __animTraceDropped?: number };
    return { samples: (w.__animTrace ?? []) as TraceSample[], dropped: w.__animTraceDropped };
  });
}

function distance(a: TraceValue, b: TraceValue): number {
  if (typeof a === 'number' || typeof b === 'number') {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b);
    return Number.POSITIVE_INFINITY; // a series that switches between scalar and vector is broken
  }
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * The I-11 trace check. Samples are grouped by series id (tween ids and `obj:<id>`), kept in recording order.
 * For every pair of consecutive samples of a series whose value changed:
 *  - the later sample must have `active: true` (a change with no tween driving it is a jump);
 *  - |Δ| ≤ 1.25 × EASE_PEAK_SLOPE[ease] × (|to − from| × Δt / durationMs) + ε, with `from`/`to`/`durationMs`/`ease`
 *    read from the later sample (so a pair spanning the end of one tween and the start of the next is judged by
 *    the later one), Δt the real time between the two samples, |·| the Euclidean length for vectors, and
 *    ε = 0.02 for vectors, 1 for scalars.
 * A zero-duration tween gets no slope allowance (bound = ε). An unknown ease name is a violation.
 */
export function checkTrace(samples: TraceSample[]): TraceViolation[] {
  const series = new Map<string, TraceSample[]>();
  for (const s of samples) {
    let list = series.get(s.id);
    if (!list) series.set(s.id, (list = []));
    list.push(s);
  }
  const violations: TraceViolation[] = [];
  for (const [id, list] of series) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const cur = list[i]!;
      const delta = distance(prev.value, cur.value);
      if (delta === 0) continue;
      const eps = typeof cur.value === 'number' ? TRACE_EPSILON_SCALAR : TRACE_EPSILON_VECTOR;
      const dtMs = cur.t - prev.t;
      const base = {
        series: id,
        index: i,
        t: cur.t,
        dtMs,
        delta,
        prev: prev.value,
        value: cur.value,
        tween: cur.tween,
        ease: cur.ease,
        durationMs: cur.durationMs,
      };
      if (cur.active !== true) {
        violations.push({ ...base, bound: 0, reason: 'value changed without an active tween' });
        continue;
      }
      if (cur.from === undefined || cur.to === undefined || cur.durationMs === undefined) {
        violations.push({ ...base, bound: 0, reason: 'active sample without from/to/durationMs' });
        continue;
      }
      const slope = cur.ease !== undefined ? EASE_PEAK_SLOPE[cur.ease] : undefined;
      if (slope === undefined) {
        violations.push({ ...base, bound: 0, reason: `unknown ease ${JSON.stringify(cur.ease)}` });
        continue;
      }
      const span = distance(cur.from, cur.to);
      const allowance = cur.durationMs > 0 ? TRACE_SLOPE_FACTOR * slope * ((span * Math.max(0, dtMs)) / cur.durationMs) : 0;
      const bound = allowance + eps;
      if (!(delta <= bound)) {
        violations.push({ ...base, bound, reason: cur.durationMs > 0 ? 'step larger than the curve allows' : 'zero-duration tween' });
      }
    }
  }
  return violations;
}

function fmtValue(v: TraceValue): string {
  return typeof v === 'number' ? v.toFixed(3) : `[${v.map((x) => x.toFixed(3)).join(', ')}]`;
}

/** A readable list of the first `max` violations, for assertion messages. */
export function formatViolations(violations: TraceViolation[], max = 15): string {
  const lines = violations.slice(0, max).map(
    (v) =>
      `${v.series} #${v.index} t=${v.t.toFixed(1)} Δt=${v.dtMs.toFixed(1)}ms: ${v.reason}; |Δ|=${v.delta.toFixed(4)} bound=${v.bound.toFixed(4)} ` +
      `${fmtValue(v.prev)} → ${fmtValue(v.value)} (tween=${v.tween ?? '-'}, ease=${v.ease ?? '-'}, durationMs=${v.durationMs ?? '-'})`,
  );
  if (violations.length > max) lines.push(`… and ${violations.length - max} more`);
  return lines.join('\n');
}

/** Series ids present in a trace. */
export function traceSeries(samples: TraceSample[]): Set<string> {
  return new Set(samples.map((s) => s.id));
}
