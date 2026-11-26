import '@testing-library/jest-dom/vitest';
import type { LegalActions } from '@poker/engine';
import type { SeatView } from '@poker/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';
import type { TableState } from '../src/table/types.js';

const fake = vi.hoisted(() => {
  const emit = vi.fn();
  return { emit, socket: { emit } };
});

vi.mock('../src/api/socket.js', () => ({
  getSocket: () => fake.socket,
  disconnectSocket: vi.fn(),
  joinTable: vi.fn(),
  leaveTableRoom: vi.fn(),
  onRejoin: () => () => undefined,
}));

const { ActionBar, potSizedTo } = await import('../src/table/ActionBar.js');
const { TableStoreProvider, createBareTableStore } = await import('../src/table/storeContext.js');
const { __resetForTests, __setRafForTests } = await import('../src/anim/tween.js');

const GAME = '11111111-1111-4111-8111-111111111111';
const HAND = '22222222-2222-4222-8222-222222222222';
const HAND2 = '33333333-3333-4333-8333-333333333333';
const ME = 2;

function seat(n: number, over: Partial<SeatView> = {}): SeatView {
  return {
    seat: n,
    playerId: `0000000${n}-0000-4000-8000-000000000000`,
    name: `P${n}`,
    avatarUrl: null,
    stack: 1000,
    bet: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    cardsVisible: null,
    hasCards: true,
    ...over,
  } as SeatView;
}

function legalOf(over: Partial<LegalActions> = {}): LegalActions {
  return {
    seat: ME,
    canFold: true,
    canCheck: false,
    callAmount: 0,
    canBet: false,
    canRaise: false,
    minTo: 0,
    maxTo: 0,
    ...over,
  };
}

/** Facing a bet of 100 (my bet 0) with 150 in the middle: call 100, raise to 200..1000. */
const FACING = legalOf({ canFold: true, callAmount: 100, canRaise: true, minTo: 200, maxTo: 1000 });
const CHECKABLE = legalOf({ canFold: false, canCheck: true, canBet: true, minTo: 20, maxTo: 1000 });

let store: StoreApi<TableState>;

function setup(over: Partial<TableState> = {}) {
  store = createBareTableStore({
    gameId: GAME,
    handId: HAND,
    mySeat: ME,
    toAct: ME,
    legal: FACING,
    seats: [seat(0, { bet: 100, stack: 900 }), seat(ME)],
    pots: [{ amount: 150, eligible: [0, ME] }],
    ...over,
  });
  const user = userEvent.setup();
  render(
    <TableStoreProvider store={store}>
      <ActionBar gameId={GAME} />
    </TableStoreProvider>,
  );
  return user;
}

const amountField = () => screen.getByRole('spinbutton', { name: 'Amount' }) as HTMLInputElement;
const sent = () => fake.emit.mock.calls.filter((c) => c[0] === 'table:action').map((c) => c[1] as unknown);

function expectAllAmountsInBounds(legal: LegalActions) {
  for (const p of sent() as { amount?: number }[]) {
    if (p.amount !== undefined) {
      expect(p.amount).toBeGreaterThanOrEqual(legal.minTo);
      expect(p.amount).toBeLessThanOrEqual(legal.maxTo);
    }
  }
}

beforeEach(() => {
  fake.emit.mockClear();
});

afterEach(() => {
  cleanup();
  __resetForTests();
});

describe('ActionBar rendering', () => {
  it('renders nothing when I am not seated', () => {
    setup({ mySeat: null, toAct: 0 });
    expect(screen.queryByTestId('action-bar')).toBeNull();
  });

  it('check allowed: Check and Bet, no Fold, no Call', () => {
    setup({ legal: CHECKABLE, seats: [seat(0), seat(ME)] });
    const bar = screen.getByTestId('action-bar');
    expect(bar).toHaveAttribute('data-enabled', 'true');
    expect(screen.getByRole('button', { name: 'Check' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bet $20' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fold' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Call/ })).toBeNull();
    expect(amountField().value).toBe('20');
    expect(screen.getByRole('slider', { name: 'Amount slider' })).toHaveAttribute('min', '20');
    expect(screen.getByRole('slider', { name: 'Amount slider' })).toHaveAttribute('max', '1000');
  });

  it('facing a bet: Fold, Call $100, Raise to $200', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Fold' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call $100' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Raise to $200' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check' })).toBeNull();
  });

  it('cannot raise: Fold and Call only, no amount controls', () => {
    setup({ legal: legalOf({ callAmount: 1500, canRaise: false }), seats: [seat(0), seat(ME, { stack: 5000 })] });
    expect(screen.getByRole('button', { name: 'Fold' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call $1,500' })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'Amount' })).toBeNull();
    expect(screen.queryByRole('button', { name: '½ pot' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Bet|Raise)/ })).toBeNull();
  });

  it('all-in only: the call that takes my whole stack is named All-in', async () => {
    const user = setup({ legal: legalOf({ callAmount: 300 }), seats: [seat(0), seat(ME, { stack: 300 })] });
    expect(screen.getByRole('button', { name: 'Fold' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All-in $300' }));
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'call' }]);
  });

  it('all-in only as a raise: minTo = maxTo names the raise All-in and sends allIn', async () => {
    const user = setup({ legal: legalOf({ callAmount: 100, canRaise: true, minTo: 450, maxTo: 450 }) });
    await user.click(screen.getByRole('button', { name: 'All-in $450' }));
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'allIn' }]);
  });

  it('is disabled and shows no action buttons when it is not my turn', () => {
    setup({ toAct: 0, legal: legalOf({ seat: 0 }) });
    expect(screen.getByTestId('action-bar')).toHaveAttribute('data-enabled', 'false');
    expect(screen.queryByRole('button', { name: 'Fold' })).toBeNull();
  });
});

describe('ActionBar amounts', () => {
  it('typing below minTo then blurring clamps to minTo and never sends below it', async () => {
    const user = setup();
    await user.clear(amountField());
    await user.type(amountField(), '5');
    await user.tab();
    expect(amountField().value).toBe('200');
    await user.click(screen.getByRole('button', { name: 'Raise to $200' }));
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'raise', amount: 200 }]);
  });

  it('typing above maxTo and pressing Enter sends allIn, not an out-of-range amount', async () => {
    const user = setup();
    await user.clear(amountField());
    await user.type(amountField(), '999999{Enter}');
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'allIn' }]);
    expectAllAmountsInBounds(FACING);
  });

  it('typing below minTo and pressing Enter sends minTo', async () => {
    const user = setup();
    await user.clear(amountField());
    await user.type(amountField(), '3{Enter}');
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'raise', amount: 200 }]);
  });

  it('a valid typed amount is sent as typed, and the button name follows it', async () => {
    const user = setup();
    await user.clear(amountField());
    await user.type(amountField(), '640');
    expect(screen.getByRole('button', { name: 'Raise to $640' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Raise to $640' }));
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'raise', amount: 640 }]);
  });

  it('the slider and the field stay in sync', () => {
    setup();
    const slider = screen.getByRole('slider', { name: 'Amount slider' }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: '500' } });
    expect(amountField().value).toBe('500');
    expect(screen.getByRole('button', { name: 'Raise to $500' })).toBeInTheDocument();
  });

  it('presets size from the pot and only set the amount', async () => {
    // pot = 150 + bets 100 = 250; call 100; pot after call 350; my bet 0.
    const user = setup();
    await user.click(screen.getByRole('button', { name: '½ pot' }));
    expect(amountField().value).toBe('275'); // 100 + 175
    await user.click(screen.getByRole('button', { name: '¾ pot' }));
    expect(amountField().value).toBe('363'); // 100 + 262.5 → 363
    await user.click(screen.getByRole('button', { name: 'Pot' }));
    expect(amountField().value).toBe('450');
    await user.click(screen.getByRole('button', { name: 'All-in' }));
    expect(amountField().value).toBe('1000');
    expect(screen.getByRole('button', { name: 'All-in $1,000' })).toBeInTheDocument();
    expect(sent()).toEqual([]);
  });

  it('presets clamp to the bounds', async () => {
    // Tiny pot: ½ pot would be below minTo; big pot: Pot would be above maxTo.
    const low = setup({ pots: [], seats: [seat(0, { bet: 10 }), seat(ME, { stack: 1000 })], legal: FACING });
    await low.click(screen.getByRole('button', { name: '½ pot' }));
    expect(amountField().value).toBe('200');
    cleanup();
    const high = setup({ pots: [{ amount: 50_000, eligible: [0, ME] }] });
    await high.click(screen.getByRole('button', { name: 'Pot' }));
    expect(amountField().value).toBe('1000');
    await high.click(screen.getByRole('button', { name: 'All-in $1,000' }));
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'allIn' }]);
  });

  it('potSizedTo counts my current street bet', () => {
    const legal = legalOf({ callAmount: 200, canRaise: true, minTo: 500, maxTo: 5000 });
    // pot 1000 incl. bets, my bet 100, call 200: pot after call 1200 → 100 + 200 + 1200 = 1500.
    expect(potSizedTo(1, legal, 1000, 100)).toBe(1500);
  });

  it('the default amount resets to minTo when a new turn starts', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Pot' }));
    expect(amountField().value).toBe('450');
    act(() => store.setState({ legal: { ...FACING, minTo: 300 } }));
    expect(amountField().value).toBe('300');
  });
});

describe('ActionBar sending', () => {
  it('sends fold, check, call, bet with handId', async () => {
    let user = setup();
    await user.click(screen.getByRole('button', { name: 'Fold' }));
    cleanup();
    user = setup();
    await user.click(screen.getByRole('button', { name: 'Call $100' }));
    cleanup();
    user = setup({ legal: CHECKABLE });
    await user.click(screen.getByRole('button', { name: 'Check' }));
    cleanup();
    user = setup({ legal: CHECKABLE });
    await user.click(screen.getByRole('button', { name: 'Bet $20' }));
    expect(sent()).toEqual([
      { gameId: GAME, handId: HAND, kind: 'fold' },
      { gameId: GAME, handId: HAND, kind: 'call' },
      { gameId: GAME, handId: HAND, kind: 'check' },
      { gameId: GAME, handId: HAND, kind: 'bet', amount: 20 },
    ]);
  });

  it('a double click sends once, and the bar stays disabled until legal changes', async () => {
    const user = setup();
    const call = screen.getByRole('button', { name: 'Call $100' });
    await user.dblClick(call);
    fireEvent.click(call);
    expect(sent()).toHaveLength(1);
    expect(screen.getByTestId('action-bar')).toHaveAttribute('data-enabled', 'false');
    expect(call).toBeDisabled();
    act(() => store.setState({ legal: { ...FACING } }));
    expect(screen.getByTestId('action-bar')).toHaveAttribute('data-enabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Call $100' }));
    expect(sent()).toHaveLength(2);
  });

  it('sends nothing when handId is null', async () => {
    const user = setup({ handId: null });
    expect(screen.getByTestId('action-bar')).toHaveAttribute('data-enabled', 'false');
    await user.keyboard('fc');
    await user.click(screen.getByRole('button', { name: 'Call $100' }));
    expect(sent()).toEqual([]);
  });

  it('sends nothing on shortcuts when it is not my turn', async () => {
    const user = setup({ toAct: 0, legal: legalOf({ seat: 0, canCheck: true }) });
    await user.keyboard('fc{Enter}');
    expect(sent()).toEqual([]);
  });

  it('"Use time bank" emits table:useTimeBank and hides while the bank is in use', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Use time bank' }));
    expect(fake.emit).toHaveBeenCalledWith('table:useTimeBank', { gameId: GAME });
    expect(screen.queryByRole('button', { name: 'Use time bank' })).toBeNull();
    cleanup();
    setup({ timeBank: { seat: ME, ms: 30_000, using: true } });
    expect(screen.queryByRole('button', { name: 'Use time bank' })).toBeNull();
  });
});

describe('ActionBar shortcuts', () => {
  it('F folds', async () => {
    const user = setup();
    await user.keyboard('f');
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'fold' }]);
  });

  it('C calls, and checks when check is allowed', async () => {
    let user = setup();
    await user.keyboard('c');
    cleanup();
    user = setup({ legal: CHECKABLE });
    await user.keyboard('C');
    expect(sent()).toEqual([
      { gameId: GAME, handId: HAND, kind: 'call' },
      { gameId: GAME, handId: HAND, kind: 'check' },
    ]);
  });

  it('R focuses the amount field; letters typed there are not shortcuts; Enter sends', async () => {
    const user = setup();
    await user.keyboard('r');
    expect(amountField()).toHaveFocus();
    await user.keyboard('fc');
    expect(sent()).toEqual([]);
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('480{Enter}');
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'raise', amount: 480 }]);
  });

  it('Enter with nothing focused sends the bet/raise at the chosen amount', async () => {
    const user = setup();
    await user.keyboard('{Enter}');
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'raise', amount: 200 }]);
  });

  it('shortcuts are ignored while focus is in a textarea elsewhere', async () => {
    const user = setup();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    await user.keyboard('fc{Enter}');
    expect(sent()).toEqual([]);
    ta.remove();
  });
});

describe('ActionBar pre-actions', () => {
  const waiting = { toAct: 0, legal: legalOf({ seat: 0, canCheck: true }) };

  it('shows the pre-action checkboxes only when I am in the hand and it is not my turn', () => {
    setup(waiting);
    expect(screen.getByRole('checkbox', { name: 'Check/Fold' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Call any' })).toBeInTheDocument();
    cleanup();
    setup({ ...waiting, seats: [seat(0), seat(ME, { folded: true })] });
    expect(screen.queryByRole('checkbox', { name: 'Check/Fold' })).toBeNull();
  });

  it('Check/Fold folds once when facing a bet, then unticks', async () => {
    const user = setup(waiting);
    await user.click(screen.getByRole('checkbox', { name: 'Check/Fold' }));
    act(() => store.setState({ toAct: ME, legal: FACING }));
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'fold' }]);
    act(() => store.setState({ toAct: 0, legal: legalOf({ seat: 0 }) }));
    expect(screen.getByRole('checkbox', { name: 'Check/Fold' })).not.toBeChecked();
    act(() => store.setState({ toAct: ME, legal: { ...FACING } }));
    expect(sent()).toHaveLength(1);
  });

  it('Check/Fold checks when check is allowed', async () => {
    const user = setup(waiting);
    await user.click(screen.getByRole('checkbox', { name: 'Check/Fold' }));
    act(() => store.setState({ toAct: ME, legal: CHECKABLE }));
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'check' }]);
  });

  it('Call any calls once', async () => {
    const user = setup(waiting);
    await user.click(screen.getByRole('checkbox', { name: 'Call any' }));
    act(() => store.setState({ toAct: ME, legal: FACING }));
    expect(sent()).toEqual([{ gameId: GAME, handId: HAND, kind: 'call' }]);
    act(() => store.setState({ toAct: 0, legal: legalOf({ seat: 0 }) }));
    expect(screen.getByRole('checkbox', { name: 'Call any' })).not.toBeChecked();
  });

  it('ticking one unticks the other, and a new hand unticks both', async () => {
    const user = setup(waiting);
    await user.click(screen.getByRole('checkbox', { name: 'Check/Fold' }));
    await user.click(screen.getByRole('checkbox', { name: 'Call any' }));
    expect(screen.getByRole('checkbox', { name: 'Check/Fold' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Call any' })).toBeChecked();
    act(() => store.setState({ handId: HAND2 }));
    expect(screen.getByRole('checkbox', { name: 'Call any' })).not.toBeChecked();
    act(() => store.setState({ toAct: ME, legal: FACING }));
    expect(sent()).toEqual([]);
  });
});

describe('ActionBar slide', () => {
  it('slides up over 200 ms with easeOutCubic when my turn starts, recorded in the trace', () => {
    let time = 1000;
    const pending = new Map<number, (t: number) => void>();
    let next = 1;
    __setRafForTests(
      (cb) => {
        const h = next++;
        pending.set(h, cb);
        return h;
      },
      (h) => {
        pending.delete(h);
      },
      () => time,
    );
    const tw = window as unknown as { __POKER_TRACE__?: boolean; __animTrace?: { id: string; ease?: string; durationMs?: number }[] };
    tw.__POKER_TRACE__ = true;
    tw.__animTrace = [];
    const frames = (n: number) =>
      act(() => {
        for (let i = 0; i < n; i++) {
          time += 16;
          const cbs = [...pending.values()];
          pending.clear();
          for (const cb of cbs) cb(time);
        }
      });
    try {
      setup({ toAct: 0, legal: legalOf({ seat: 0 }) });
      const bar = screen.getByTestId('action-bar');
      expect(bar.style.transform).toBe('translateY(28px)');
      act(() => store.setState({ toAct: ME, legal: FACING }));
      frames(3);
      const mid = Number(/translateY\(([-\d.]+)px\)/.exec(bar.style.transform)?.[1]);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(28);
      frames(15);
      expect(bar.style.transform).toBe('translateY(0px)');
      const samples = (tw.__animTrace ?? []).filter((s) => s.id === 'obj:panel:actionbar' && s.ease);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples[0]!.ease).toBe('easeOutCubic');
      expect(samples[0]!.durationMs).toBe(200);
    } finally {
      delete tw.__POKER_TRACE__;
      delete tw.__animTrace;
    }
  });
});
