import '@testing-library/jest-dom/vitest';
import type { ChatMessage } from '@poker/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand';

const fake = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock('../src/api/socket.js', () => ({
  getSocket: () => ({ emit: fake.emit }),
  joinTable: vi.fn(),
  leaveTableRoom: vi.fn(),
  onRejoin: () => () => undefined,
  disconnectSocket: vi.fn(),
}));

const { ChatPanel } = await import('../src/table/ChatPanel.js');
const { TableStoreProvider, createBareTableStore } = await import('../src/table/storeContext.js');
const { __resetForTests, __setRafForTests } = await import('../src/anim/tween.js');
type TableState = import('../src/table/types.js').TableState;

const GAME = '11111111-1111-4111-8111-111111111111';
const PLAYER = '22222222-2222-4222-8222-222222222222';

function msg(id: string, text: string, name = 'Ann'): ChatMessage {
  return { gameId: GAME, id, playerId: PLAYER, name, text, at: 1_795_000_000_000 };
}

// Deterministic animation frames.
let time = 0;
let nextHandle = 1;
const pendingFrames = new Map<number, (t: number) => void>();
function frames(n: number, ms = 16.7): void {
  act(() => {
    for (let i = 0; i < n; i++) {
      time += ms;
      const cbs = [...pendingFrames.values()];
      pendingFrames.clear();
      for (const cb of cbs) cb(time);
    }
  });
}

let store: StoreApi<TableState>;
let setChatError: ReturnType<typeof vi.fn<(e: string | null) => void>>;

function renderChat(chat: ChatMessage[] = []) {
  setChatError = vi.fn<(e: string | null) => void>((e) => store.setState({ chatError: e }));
  store = createBareTableStore({ chat, setChatError });
  return render(
    <TableStoreProvider store={store}>
      <ChatPanel gameId={GAME} />
    </TableStoreProvider>,
  );
}

function addMessage(m: ChatMessage) {
  act(() => store.setState((s) => ({ chat: [...s.chat, m] })));
}

/** jsdom has no layout: give the list a fake scroll geometry. */
function fakeScroll(el: HTMLElement, geometry: { scrollHeight: number; clientHeight: number }) {
  let top = 0;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => geometry.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => geometry.clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, geometry.scrollHeight - geometry.clientHeight));
    },
  });
}

beforeEach(() => {
  fake.emit.mockReset();
  time = 1000;
  pendingFrames.clear();
  __setRafForTests(
    (cb) => {
      const h = nextHandle++;
      pendingFrames.set(h, cb);
      return h;
    },
    (h) => {
      pendingFrames.delete(h);
    },
    () => time,
  );
});

afterEach(() => {
  cleanup();
  __resetForTests();
});

describe('ChatPanel', () => {
  it('renders messages as text, never as HTML', () => {
    const evil = '<img src=x onerror=alert(1)>';
    renderChat([msg('m1', 'hello table'), msg('m2', evil, '<b>Bob</b>')]);
    const list = screen.getByTestId('chat-list');
    expect(list).toHaveTextContent('Ann hello table');
    expect(list).toHaveTextContent(evil);
    expect(list).toHaveTextContent('<b>Bob</b>');
    expect(list.querySelector('img')).toBeNull();
    expect(list.querySelector('b')).toBeNull();
    expect(list.querySelectorAll('li')).toHaveLength(2);
  });

  it('shows a character counter and caps the text at 200 characters', async () => {
    const user = userEvent.setup();
    renderChat();
    const field = screen.getByLabelText('Message');
    expect(screen.getByText('0/200')).toBeInTheDocument();
    await user.type(field, 'hello there!');
    expect(screen.getByText('12/200')).toBeInTheDocument();

    await user.clear(field);
    fireEvent.change(field, { target: { value: 'x'.repeat(250) } });
    expect(field).toHaveValue('x'.repeat(200));
    expect(screen.getByText('200/200')).toBeInTheDocument();
    expect(field).toHaveAttribute('maxLength', '200');
  });

  it('sends the trimmed text with the Send button and clears the field and the error', async () => {
    const user = userEvent.setup();
    renderChat();
    act(() => store.setState({ chatError: 'You are sending messages too fast' }));
    await user.type(screen.getByLabelText('Message'), '  nice hand  ');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(fake.emit).toHaveBeenCalledTimes(1);
    expect(fake.emit).toHaveBeenCalledWith('chat:send', { gameId: GAME, text: 'nice hand' });
    expect(screen.getByLabelText('Message')).toHaveValue('');
    expect(setChatError).toHaveBeenCalledWith(null);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends on Enter', async () => {
    const user = userEvent.setup();
    renderChat();
    await user.type(screen.getByLabelText('Message'), 'gg{Enter}');
    expect(fake.emit).toHaveBeenCalledWith('chat:send', { gameId: GAME, text: 'gg' });
    expect(screen.getByLabelText('Message')).toHaveValue('');
  });

  it('cannot send empty or blank text', async () => {
    const user = userEvent.setup();
    renderChat();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('Message'), '   ');
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText('Message'), '{Enter}');
    expect(fake.emit).not.toHaveBeenCalled();
  });

  it('shows the rate-limit error as an alert', () => {
    renderChat();
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => store.setState({ chatError: 'You are sending messages too fast' }));
    expect(screen.getByRole('alert')).toHaveTextContent('You are sending messages too fast');
  });

  it('slides new messages in with a tween; messages present on mount appear in place', () => {
    renderChat([msg('m1', 'old')]);
    const old = screen.getByText('old').closest('li')!;
    expect(old.style.opacity).toBe('1');

    addMessage(msg('m2', 'new'));
    const row = screen.getByText('new').closest('li')!;
    frames(1);
    const early = Number(row.style.opacity);
    expect(early).toBeLessThan(1);
    expect(row.style.transform).toMatch(/translateY\(/);

    frames(3);
    const mid = Number(row.style.opacity);
    expect(mid).toBeGreaterThan(early);
    expect(mid).toBeLessThan(1);

    frames(30);
    expect(row.style.opacity).toBe('1');
    expect(row.style.transform).toBe('');
  });

  it('sticks to the newest message unless the user scrolled up', async () => {
    const user = userEvent.setup();
    renderChat([msg('m1', 'one'), msg('m2', 'two')]);
    const list = screen.getByTestId('chat-list');
    const geometry = { scrollHeight: 600, clientHeight: 200 };
    fakeScroll(list, geometry);

    // At the bottom: a new message scrolls into view.
    geometry.scrollHeight = 650;
    addMessage(msg('m3', 'three'));
    expect(list.scrollTop).toBe(450);
    expect(screen.queryByRole('button', { name: 'New messages' })).toBeNull();

    // Scrolled up: the position is kept and a jump button appears.
    list.scrollTop = 100;
    fireEvent.scroll(list);
    geometry.scrollHeight = 700;
    addMessage(msg('m4', 'four'));
    expect(list.scrollTop).toBe(100);
    const jump = screen.getByRole('button', { name: 'New messages' });

    await user.click(jump);
    expect(list.scrollTop).toBe(500);
    expect(screen.queryByRole('button', { name: 'New messages' })).toBeNull();

    // Back at the bottom: sticks again.
    geometry.scrollHeight = 750;
    addMessage(msg('m5', 'five'));
    expect(list.scrollTop).toBe(550);
  });

  it('hides the jump button when the user scrolls back down by hand', () => {
    renderChat([msg('m1', 'one')]);
    const list = screen.getByTestId('chat-list');
    const geometry = { scrollHeight: 600, clientHeight: 200 };
    fakeScroll(list, geometry);
    list.scrollTop = 0;
    fireEvent.scroll(list);
    addMessage(msg('m2', 'two'));
    expect(screen.getByRole('button', { name: 'New messages' })).toBeInTheDocument();
    list.scrollTop = 400;
    fireEvent.scroll(list);
    expect(screen.queryByRole('button', { name: 'New messages' })).toBeNull();
  });
});
