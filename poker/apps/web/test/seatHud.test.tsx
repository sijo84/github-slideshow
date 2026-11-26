import '@testing-library/jest-dom/vitest';
import { parseCard } from '@poker/engine';
import type { SeatView } from '@poker/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetForTests } from '../src/anim/tween.js';
import { SeatActionsContext, type SeatActions } from '../src/table/sceneContext.js';
import { SeatHudView } from '../src/table/SeatHud.js';
import { createBareTableStore, TableStoreProvider } from '../src/table/storeContext.js';
import type { TableState } from '../src/table/types.js';

function seatView(seat: number, over: Partial<SeatView> = {}): SeatView {
  return {
    seat,
    playerId: `00000000-0000-4000-8000-00000000000${seat}`,
    name: `Player ${seat}`,
    avatarUrl: `/avatars/p${seat}.png`,
    stack: 1000 + seat,
    bet: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    connected: true,
    cardsVisible: null,
    hasCards: true,
    ...over,
  };
}

const SEATS = [0, 1, 3, 5];

function setup(over: Partial<TableState> = {}, seatsToRender: number[] = [0, 1, 2, 3, 4, 5], actions?: Partial<SeatActions>) {
  const store = createBareTableStore({
    seats: SEATS.map((s) => seatView(s)),
    mySeat: 0,
    status: 'running',
    ...over,
  });
  const value: SeatActions = { onSit: vi.fn(), onOpenNotes: vi.fn(), ...actions };
  const wrap = (children: ReactNode) => (
    <TableStoreProvider store={store}>
      <SeatActionsContext.Provider value={value}>{children}</SeatActionsContext.Provider>
    </TableStoreProvider>
  );
  const utils = render(wrap(seatsToRender.map((s) => <SeatHudView key={s} seat={s} />)));
  return { store, actions: value, ...utils };
}

afterEach(() => {
  cleanup();
  __resetForTests();
});

describe('SeatHudView', () => {
  it('marks only the seat to act as active, with the turn ring', () => {
    setup({ toAct: 3, deadline: Date.now() + 20_000 });
    const active = document.querySelectorAll('[data-active="true"]');
    expect(active).toHaveLength(1);
    expect(active[0]).toHaveAttribute('data-testid', 'seat-3');
    expect(screen.getAllByTestId('turn-ring')).toHaveLength(1);
    expect(within(screen.getByTestId('seat-3')).getByTestId('turn-ring')).toBeInTheDocument();
    for (const s of [0, 1, 2, 4, 5]) expect(screen.getByTestId(`seat-${s}`)).toHaveAttribute('data-active', 'false');
  });

  it('marks my seat with data-me', () => {
    setup();
    expect(screen.getByTestId('seat-0')).toHaveAttribute('data-me', 'true');
    expect(screen.getByTestId('seat-1')).toHaveAttribute('data-me', 'false');
  });

  it('shows the avatar image with the name as alt, and an initials fallback', () => {
    const { store } = setup({}, [0, 1]);
    const img = screen.getByRole('img', { name: 'Player 1' });
    expect(img).toHaveAttribute('src', '/avatars/p1.png');
    expect(img).toHaveAttribute('data-fallback', 'false');

    // Image load failure falls back to initials.
    fireEvent.error(img);
    const failed = screen.getByRole('img', { name: 'Player 1' });
    expect(failed.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);

    // No avatar URL at all.
    act(() => store.setState({ seats: [seatView(0, { avatarUrl: null, name: 'Ann Lee' }), seatView(1)] }));
    const fallback = screen.getByRole('img', { name: 'Ann Lee' });
    expect(fallback).toHaveAttribute('data-fallback', 'true');
    const src = fallback.getAttribute('src') ?? '';
    expect(src).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(src)).toContain('>AL<');
  });

  it('shows the name and the stack in play dollars', () => {
    setup({ seats: [seatView(0, { stack: 1250, name: 'Alice' })] }, [0]);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByTestId('stack-0')).toHaveTextContent('$1,250');
  });

  it('shows status chips: Folded, All-in, Away', () => {
    setup({
      seats: [
        seatView(0),
        seatView(1, { folded: true, hasCards: false }),
        seatView(3, { allIn: true }),
        seatView(5, { connected: false }),
      ],
    });
    expect(within(screen.getByTestId('seat-1')).getByText('Folded')).toBeInTheDocument();
    expect(within(screen.getByTestId('seat-3')).getByText('All-in')).toBeInTheDocument();
    expect(within(screen.getByTestId('seat-5')).getByText('Away')).toBeInTheDocument();
    const mine = within(screen.getByTestId('seat-0'));
    expect(mine.queryByText('Folded')).toBeNull();
    expect(mine.queryByText('All-in')).toBeNull();
    expect(mine.queryByText('Away')).toBeNull();
  });

  it('shows the equity badge only on my seat when not all-in', () => {
    setup({ myEquity: { win: 0.634, tie: 0.001 } });
    expect(screen.getByTestId('equity-0')).toHaveTextContent('Win 63%');
    expect(screen.getByTestId('equity-0')).not.toHaveTextContent('Tie');
    for (const s of [1, 3, 5]) expect(screen.queryByTestId(`equity-${s}`)).toBeNull();
  });

  it('shows the equity badge on every listed seat during an all-in runout', () => {
    setup({
      myEquity: { win: 0.9, tie: 0 },
      allInEquity: { 0: { win: 0.45, tie: 0.05 }, 3: { win: 0.5, tie: 0.05 } },
    });
    expect(screen.getByTestId('equity-0')).toHaveTextContent('Win 45%');
    expect(screen.getByTestId('equity-0')).toHaveTextContent('Tie 5%');
    expect(screen.getByTestId('equity-3')).toHaveTextContent('Win 50%');
    expect(screen.queryByTestId('equity-1')).toBeNull();
    expect(screen.queryByTestId('equity-5')).toBeNull();
  });

  it('lists my hole cards and hides other seats until shown', () => {
    const { store } = setup({ myHole: [parseCard('As'), parseCard('Kd')] });
    const mine = screen.getByTestId('my-hole');
    const spans = mine.querySelectorAll('[data-card]');
    expect([...spans].map((s) => s.getAttribute('data-card'))).toEqual(['As', 'Kd']);
    for (const s of spans) expect(s).toHaveClass('sr-only');

    const other = screen.getByTestId('hole-3');
    expect(other).toHaveAttribute('data-face', 'down');
    expect(other.querySelectorAll('[data-card]')).toHaveLength(0);

    act(() =>
      store.setState((s) => ({
        seats: s.seats.map((p) => (p.seat === 3 ? { ...p, cardsVisible: [parseCard('Qh'), parseCard('Tc')] } : p)),
      })),
    );
    const shown = screen.getByTestId('hole-3');
    expect(shown).toHaveAttribute('data-face', 'up');
    expect([...shown.querySelectorAll('[data-card]')].map((s) => s.getAttribute('data-card'))).toEqual(['Qh', 'Tc']);
  });

  it('renders a sit button on empty seats that calls onSit, only while I am not seated', async () => {
    const user = userEvent.setup();
    const { actions, store } = setup({ mySeat: null });
    await user.click(screen.getByRole('button', { name: 'Sit at seat 3' }));
    expect(actions.onSit).toHaveBeenCalledWith(2);
    expect(screen.getByRole('button', { name: 'Sit at seat 5' })).toBeInTheDocument();

    act(() => store.setState({ mySeat: 0 }));
    expect(screen.queryByRole('button', { name: /^Sit at seat/ })).toBeNull();
    expect(screen.getByTestId('seat-2')).toHaveAttribute('data-empty', 'true');

    act(() => store.setState({ mySeat: null, status: 'finished' }));
    expect(screen.queryByRole('button', { name: /^Sit at seat/ })).toBeNull();
  });

  it('opens notes when another player is clicked, not for my own seat', async () => {
    const user = userEvent.setup();
    const { actions } = setup();
    await user.click(screen.getByRole('button', { name: 'Notes on Player 3' }));
    expect(actions.onOpenNotes).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000003', 'Player 3');
    expect(screen.queryByRole('button', { name: 'Notes on Player 0' })).toBeNull();
  });

  it('announces "Your turn" only when it is my turn', () => {
    const { store } = setup({ toAct: 3 });
    expect(screen.queryByText('Your turn')).toBeNull();
    act(() => store.setState({ toAct: 0, deadline: Date.now() + 10_000 }));
    const live = screen.getByText('Your turn');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(within(screen.getByTestId('seat-0')).getByTestId('turn-ring')).toBeInTheDocument();
  });

  it('turns the ring amber in the last 5 s and red on the time bank', () => {
    const { store } = setup({ toAct: 3, deadline: Date.now() + 3_000 });
    expect(screen.getByTestId('turn-ring')).toHaveAttribute('data-phase', 'warn');
    act(() => store.setState({ deadline: Date.now() + 15_000, timeBank: { seat: 3, ms: 15_000, using: true } }));
    expect(screen.getByTestId('turn-ring')).toHaveAttribute('data-phase', 'bank');
    expect(screen.getByText('Time bank')).toBeInTheDocument();
  });
});
