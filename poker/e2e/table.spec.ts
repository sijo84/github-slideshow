/**
 * W-E2E-2: the poker table, end to end (I-11 "DOM facts", "Trace check", "E2E setup"; F4, F5, F18).
 * Setup goes through the REST API (e2e/helpers.ts); the table itself is driven through the UI only.
 * Seat numbers below are 0-based seat indexes: `seat-<n>` in the DOM, "Sit at seat <n+1>" on the button.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  actWhenMyTurn,
  befriend,
  boardCards,
  checkTrace,
  chipsOnTable,
  createCashGame,
  createPlayers,
  enabledActionBar,
  formatViolations,
  handLog,
  mySeat,
  openTable,
  pageWithTurn,
  readTrace,
  sitDown,
  traceSeries,
  type Player,
} from './helpers';

const VERIFIED = '✓ Cards verified';
const HAND_TIMEOUT = 45_000;

const CALL_OR_CHECK = [/^Call \$/, /^Check$/];
const CHECK_OR_CALL = [/^Check$/, /^Call \$/];

/** Waits until one page has an enabled action bar (returns its index) or `done(pages)` holds (returns -1). */
async function nextTurn(pages: Page[], done: () => Promise<boolean>, timeout = HAND_TIMEOUT): Promise<number> {
  let result = -2;
  await expect
    .poll(
      async () => {
        // The end is checked first, so a turn of the next hand is never taken for one of this hand.
        if (await done()) result = -1;
        else {
          const i = await pageWithTurn(pages);
          result = i >= 0 ? i : -2;
        }
        return result;
      },
      { timeout, intervals: [100, 200, 250], message: 'nobody got a turn and the hand did not end' },
    )
    .toBeGreaterThanOrEqual(-1);
  return result;
}

/** (c): on every page exactly one seat is active, and it is `seat`. */
async function expectOnlyActive(pages: Page[], seat: number): Promise<void> {
  for (const page of pages) {
    await expect(page.locator('[data-active="true"]')).toHaveCount(1);
    await expect(page.getByTestId(`seat-${seat}`)).toHaveAttribute('data-active', 'true');
  }
}

async function closeAll(players: Player[]): Promise<void> {
  await Promise.all(players.map((p) => p.context.close()));
}

test('three players play a hand', async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now() % 100_000;
  const [ana, ben, cleo] = await createPlayers(browser, [`Ana ${stamp}`, `Ben ${stamp}`, `Cleo ${stamp}`]);
  if (!ana || !ben || !cleo) throw new Error('createPlayers returned too few players');
  const players = [ana, ben, cleo];
  const pages = players.map((p) => p.page);
  await befriend(ana, ben);
  await befriend(ana, cleo);
  const gameId = await createCashGame(ana, { name: `Table ${stamp}`, invitees: [ben, cleo] });

  for (const p of players) await openTable(p.page, gameId);

  // Before the start: Ben sits, leaves, and sits elsewhere (F5: seats must glide, checked through the trace).
  await sitDown(ben.page, 1, 1000, ben.name);
  await ben.page.getByRole('button', { name: 'Leave table', exact: true }).click();
  const confirmLeave = ben.page.getByRole('group', { name: 'Leave table?', exact: true });
  await expect(confirmLeave.getByRole('button', { name: 'Stay', exact: true })).toBeVisible();
  await confirmLeave.getByRole('button', { name: 'Leave now', exact: true }).click();
  await expect(ben.page.getByRole('button', { name: 'Sit at seat 2', exact: true })).toBeVisible();
  await expect(ben.page.locator('[data-me="true"]')).toHaveCount(0);

  // Ana opens and closes the host panel.
  const panel = ana.page.getByTestId('host-panel');
  await ana.page.getByRole('button', { name: 'Host panel', exact: true }).click();
  await expect(panel).toHaveAttribute('data-open', 'true');
  // The open slide-over covers the "Host panel" toggle (intended), so it is closed with its own button.
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toHaveAttribute('data-open', 'false');

  // Everyone sits with 1,000.
  const seats = { ana: 0, ben: 3, cleo: 5 };
  await sitDown(ana.page, seats.ana, 1000, ana.name);
  await sitDown(ben.page, seats.ben, 1000, ben.name);
  await sitDown(cleo.page, seats.cleo, 1000, cleo.name);
  const seatOf = new Map<Page, number>([
    [ana.page, seats.ana],
    [ben.page, seats.ben],
    [cleo.page, seats.cleo],
  ]);
  const occupied = [
    { seat: seats.ana, name: ana.name },
    { seat: seats.ben, name: ben.name },
    { seat: seats.cleo, name: cleo.name },
  ];
  for (const page of pages) {
    for (const o of occupied) await expect(page.getByTestId(`seat-${o.seat}`)).toContainText(o.name);
    expect(await mySeat(page)).toBe(seatOf.get(page));
  }

  await ana.page.getByRole('button', { name: 'Start game', exact: true }).click();

  // Play one hand: preflop calls (the big blind checks), then checks on flop, turn and river.
  const verifiedEverywhere = async (): Promise<boolean> => {
    for (const page of pages) if ((await handLog(page).getByText(VERIFIED).count()) === 0) return false;
    return true;
  };
  let firstTurnChecked = false;
  let sawRiver = false;
  let actions = 0;
  for (;;) {
    const i = await nextTurn(pages, verifiedEverywhere);
    if (i < 0) break;
    const actor = pages[i]!;
    const actorSeat = seatOf.get(actor)!;

    // (c) exactly one active seat on each page, the one whose bar is enabled; nobody else's bar is enabled.
    await expectOnlyActive(pages, actorSeat);
    for (const page of pages) if (page !== actor) await expect(enabledActionBar(page)).toHaveCount(0);

    if (!firstTurnChecked) {
      firstTurnChecked = true;
      for (const page of pages) {
        const me = seatOf.get(page)!;
        for (const o of occupied) {
          // (a) the avatar of every occupied seat is visible.
          await expect(page.getByTestId(`seat-${o.seat}`).getByRole('img', { name: o.name, exact: true })).toBeVisible();
          if (o.seat === me) continue;
          // (b) the others' cards are face down, with no card labels.
          const hole = page.getByTestId(`hole-${o.seat}`);
          await expect(hole).toHaveAttribute('data-face', 'down');
          await expect(hole.locator('[data-card]')).toHaveCount(0);
          // (d) no equity badge on anyone else's seat.
          await expect(page.getByTestId(`equity-${o.seat}`)).not.toBeVisible();
        }
        // (b) my own two cards, face up.
        await expect(page.getByTestId('my-hole').locator('[data-card]')).toHaveCount(2);
        // (d) "Win nn%" on my seat.
        const equity = page.getByTestId(`equity-${me}`);
        await expect(equity).toBeVisible();
        await expect(equity).toHaveText(/Win \d+%/);
      }
    }

    const onBoard = await boardCards(actor).count();
    if (onBoard === 5 && !sawRiver) {
      sawRiver = true;
      for (const page of pages) await expect(boardCards(page)).toHaveCount(5);
    }
    await actWhenMyTurn(actor, onBoard === 0 ? CALL_OR_CHECK : CHECK_OR_CALL);
    actions += 1;
    expect(actions, 'too many actions for one hand of calls and checks').toBeLessThanOrEqual(12);
  }

  // (g) the hand log says the cards were verified, on each page.
  for (const page of pages) await expect(handLog(page)).toContainText(VERIFIED);
  // The board reached the river.
  expect(sawRiver, 'the board never showed 5 cards while a decision was pending').toBe(true);
  // Three players, checked down: 3 preflop actions (two calls, the big blind's check) + 3 checks on each of
  // flop, turn and river = 12.
  expect(actions).toBe(12);

  // (f) the chips on display add up to the 3,000 bought in (stacks, plus bets and pots in case the next hand
  // has already posted its blinds; the stack labels count with a tween, hence the poll).
  for (const page of pages) {
    await expect.poll(async () => (await chipsOnTable(page)).total, { timeout: 15_000 }).toBe(3000);
  }

  // (e) the animation trace: every change was a tween within its curve's bound, and the expected series exist.
  const traceProblems: string[] = [];
  for (const player of players) {
    const page = player.page;
    const { samples, dropped } = await readTrace(page);
    if ((dropped ?? 0) !== 0) traceProblems.push(`${player.name}: ${dropped} trace samples were dropped`);
    const violations = checkTrace(samples);
    if (violations.length > 0) {
      traceProblems.push(`${player.name}: ${violations.length} trace violations\n${formatViolations(violations, 15, samples)}`);
    }
    const ids = [...traceSeries(samples)];
    const wanted = ['obj:card:', 'obj:chips:', 'obj:seat:'];
    if (page === ana.page) wanted.push('obj:panel:host');
    for (const prefix of wanted) {
      if (!ids.some((id) => id.startsWith(prefix))) traceProblems.push(`${player.name}: no ${prefix}* series in the trace`);
    }
  }
  expect(traceProblems, traceProblems.join('\n\n')).toEqual([]);

  await closeAll(players);
});

test('all-in preflop shows both equities', async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now() % 100_000;
  const [ana, ben] = await createPlayers(browser, [`Ana ${stamp}`, `Ben ${stamp}`]);
  if (!ana || !ben) throw new Error('createPlayers returned too few players');
  const players = [ana, ben];
  const pages = players.map((p) => p.page);
  await befriend(ana, ben);
  const gameId = await createCashGame(ana, { name: `All-in ${stamp}`, invitees: [ben] });
  for (const p of players) await openTable(p.page, gameId);

  const seats = [0, 2];
  await sitDown(ana.page, seats[0]!, 1000, ana.name);
  await sitDown(ben.page, seats[1]!, 1000, ben.name);
  await ana.page.getByRole('button', { name: 'Start game', exact: true }).click();

  // The first to act moves all in: the "All-in" preset sets Amount to the maximum, then the button reads "All-in $…".
  const first = await nextTurn(pages, async () => false);
  const shover = pages[first]!;
  const caller = pages[1 - first]!;
  const shoveBar = enabledActionBar(shover);
  await shoveBar.getByRole('button', { name: 'All-in', exact: true }).click();
  await expect(shoveBar.getByRole('button', { name: /^All-in \$/ })).toBeVisible();
  await actWhenMyTurn(shover, /^All-in \$/);
  await actWhenMyTurn(caller, [/^Call \$/, /^All-in \$/]);

  // Before the board is complete (ideally before the flop), both seats show an equity badge on both pages.
  let state: 'waiting' | 'ok' | 'missed' = 'waiting';
  await expect
    .poll(
      async () => {
        let all = true;
        for (const page of pages) {
          if ((await boardCards(page).count()) >= 5) {
            state = 'missed';
            return state;
          }
          for (const seat of seats) {
            const badge = page.getByTestId(`equity-${seat}`);
            if (!(await badge.isVisible()) || !/Win \d+%/.test((await badge.textContent()) ?? '')) all = false;
          }
        }
        state = all ? 'ok' : 'waiting';
        return state;
      },
      { timeout: HAND_TIMEOUT, intervals: [100, 200, 250], message: 'equity badges never showed on both seats' },
    )
    .not.toBe('waiting');
  expect(state, 'the board reached 5 cards before both equity badges showed on both pages').toBe('ok');

  for (const page of pages) await expect(handLog(page)).toContainText(VERIFIED, { timeout: HAND_TIMEOUT });
  for (const page of pages) {
    await expect.poll(async () => (await chipsOnTable(page)).total, { timeout: 15_000 }).toBe(2000);
  }

  await closeAll(players);
});
