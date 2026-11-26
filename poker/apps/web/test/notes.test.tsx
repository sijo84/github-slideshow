import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => {
  class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return { api: vi.fn<(path: string, init?: { method?: string; body?: unknown }) => Promise<unknown>>(), ApiError };
});

vi.mock('../src/api/client.js', () => ({ api: client.api, ApiError: client.ApiError, deviceId: () => 'dev' }));

const { NotesPopover, useNotes, __resetNotesForTests } = await import('../src/table/NotesPopover.js');

const BOB = '33333333-3333-4333-8333-333333333333';
const CAROL = '44444444-4444-4444-8444-444444444444';

function serverNotes() {
  return {
    notes: [
      { subjectId: BOB, text: 'Bluffs the river', color: 'red', updatedAt: '2026-11-25T10:00:00.000Z' },
      { subjectId: CAROL, text: 'Tight', color: null, updatedAt: '2026-11-24T10:00:00.000Z' },
    ],
  };
}

function routeApi(opts: { putFails?: boolean } = {}) {
  client.api.mockImplementation((path, init) => {
    if (path === '/api/notes' && !init?.method) return Promise.resolve(serverNotes());
    if (init?.method === 'PUT') {
      if (opts.putFails) return Promise.reject(new client.ApiError(500, 'Server is down'));
      const body = init.body as { text: string; color: string | null };
      return Promise.resolve({ subjectId: path.split('/').pop(), ...body, updatedAt: '2026-11-26T10:00:00.000Z' });
    }
    return Promise.reject(new client.ApiError(404, `no route ${path}`));
  });
}

function NotesProbe() {
  const notes = useNotes();
  return <output data-testid="probe">{JSON.stringify(notes[BOB] ?? null)}</output>;
}

function Harness({ subjectId = BOB, name = 'Bob' }: { subjectId?: string; name?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <NotesProbe />
      {open ? (
        <NotesPopover subjectId={subjectId} name={name} onClose={() => setOpen(false)} />
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          Open notes
        </button>
      )}
    </>
  );
}

/** Let resolved promises run (fake timers do not touch microtasks). */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function puts() {
  return client.api.mock.calls.filter(([, init]) => init?.method === 'PUT');
}

beforeEach(() => {
  vi.useFakeTimers();
  client.api.mockReset();
  __resetNotesForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('NotesPopover', () => {
  it('is a dialog named after the player and loads the existing note', async () => {
    routeApi();
    render(<Harness />);
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'Notes on Bob' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText('Private note')).toHaveValue('Bluffs the river');
    expect(screen.getByRole('radio', { name: 'Red' })).toBeChecked();
    expect(screen.getByText('Only you can see this')).toBeInTheDocument();
    for (const n of ['No colour', 'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple']) {
      expect(screen.getByRole('radio', { name: n })).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Private note')).toHaveAttribute('maxLength', '2000');
    // One shared fetch.
    expect(client.api.mock.calls.filter(([p]) => p === '/api/notes')).toHaveLength(1);
  });

  it('starts empty for a player without a note', async () => {
    routeApi();
    render(<Harness subjectId="55555555-5555-4555-8555-555555555555" name="Dan" />);
    await settle();
    expect(screen.getByRole('dialog', { name: 'Notes on Dan' })).toBeInTheDocument();
    expect(screen.getByLabelText('Private note')).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'No colour' })).toBeChecked();
  });

  it('autosaves once, 600 ms after the last change, with the latest text and colour', async () => {
    routeApi();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);
    await settle();
    const field = screen.getByLabelText('Private note');
    await user.clear(field);
    await user.type(field, 'Calls too much');
    await user.click(screen.getByRole('radio', { name: 'Blue' }));

    act(() => vi.advanceTimersByTime(599));
    expect(puts()).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1));
    await settle();

    expect(puts()).toHaveLength(1);
    expect(puts()[0]).toEqual([`/api/notes/${BOB}`, { method: 'PUT', body: { text: 'Calls too much', color: 'blue' } }]);
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    // The shared map follows the save.
    expect(JSON.parse(screen.getByTestId('probe').textContent ?? 'null')).toEqual({
      text: 'Calls too much',
      color: 'blue',
    });

    act(() => vi.advanceTimersByTime(5000));
    expect(puts()).toHaveLength(1);
  });

  it('useNotes() shares one fetch across components', async () => {
    routeApi();
    render(
      <>
        <NotesProbe />
        <NotesProbe />
      </>,
    );
    await settle();
    expect(screen.getAllByTestId('probe')[0]).toHaveTextContent('Bluffs the river');
    expect(client.api).toHaveBeenCalledTimes(1);
  });

  it('Escape closes and flushes the pending change', async () => {
    routeApi();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);
    await settle();
    await user.type(screen.getByLabelText('Private note'), '!');
    expect(puts()).toHaveLength(0);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.[1]).toEqual({ method: 'PUT', body: { text: 'Bluffs the river!', color: 'red' } });
    await settle();
    expect(screen.getByTestId('probe')).toHaveTextContent('Bluffs the river!');
    act(() => vi.advanceTimersByTime(1000));
    expect(puts()).toHaveLength(1);
  });

  it('the Close button closes; nothing is saved without a change', async () => {
    routeApi();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);
    await settle();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(puts()).toHaveLength(0);
  });

  it('flushes a pending change on unmount', async () => {
    routeApi();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = render(<Harness />);
    await settle();
    await user.click(screen.getByRole('radio', { name: 'Green' }));
    unmount();
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.[1]).toEqual({ method: 'PUT', body: { text: 'Bluffs the river', color: 'green' } });
  });

  it('shows an error when the save fails', async () => {
    routeApi({ putFails: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Harness />);
    await settle();
    await user.type(screen.getByLabelText('Private note'), '?');
    act(() => vi.advanceTimersByTime(600));
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Server is down');
  });
});
