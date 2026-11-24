import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { GameSettingsSchema, type GameSettings } from '@poker/protocol';
import {
  SettingsForm,
  convertKind,
  defaultSettings,
  standardStructure,
  validateSettings,
} from '../src/ui/SettingsForm.js';

afterEach(() => cleanup());

/** Renders a controlled SettingsForm and exposes the latest value. */
function renderForm(initial: GameSettings, locked?: { kind?: boolean; maxSeats?: boolean }) {
  const latest: { value: GameSettings } = { value: initial };
  const onChange = vi.fn((next: GameSettings) => {
    latest.value = next;
  });
  function Harness() {
    const [value, setValue] = useState(initial);
    return (
      <SettingsForm
        value={value}
        locked={locked}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  return { latest, onChange };
}

function levelRows(): HTMLElement[] {
  const table = screen.getByRole('table');
  return within(table).getAllByRole('row').slice(1); // skip the header row
}

describe('defaultSettings', () => {
  it('is valid for both kinds', () => {
    for (const kind of ['cash', 'tournament'] as const) {
      const s = defaultSettings(kind);
      expect(s.kind).toBe(kind);
      expect(GameSettingsSchema.safeParse(s).success).toBe(true);
      expect(validateSettings(s).ok).toBe(true);
    }
    expect(defaultSettings('cash').levels).toHaveLength(1);
    expect(defaultSettings('cash').autoStart).toBe(true);
  });
});

describe('standardStructure', () => {
  it('gives the standard blinds', () => {
    const levels = standardStructure({ levels: 8, minutes: 12, bbAnteFromLevel4: false });
    expect(levels.map((l) => [l.smallBlind, l.bigBlind])).toEqual([
      [25, 50],
      [50, 100],
      [75, 150],
      [100, 200],
      [150, 300],
      [200, 400],
      [300, 600],
      [400, 800],
    ]);
    expect(levels.map((l) => l.level)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(levels.every((l) => l.durationMinutes === 12 && l.ante === 0 && l.anteKind === 'none')).toBe(true);
  });

  it('adds a big blind ante from level 4 when asked', () => {
    const levels = standardStructure({ levels: 6, minutes: 15, bbAnteFromLevel4: true });
    expect(levels.slice(0, 3).every((l) => l.ante === 0 && l.anteKind === 'none')).toBe(true);
    for (const l of levels.slice(3)) {
      expect(l.anteKind).toBe('bigBlind');
      expect(l.ante).toBe(l.bigBlind);
    }
  });

  it('keeps growing past the table and validates', () => {
    const levels = standardStructure({ levels: 25, minutes: 10, bbAnteFromLevel4: true });
    expect(levels).toHaveLength(25);
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]!.bigBlind).toBeGreaterThan(levels[i - 1]!.bigBlind);
    }
    const s = { ...defaultSettings('tournament'), levels };
    expect(validateSettings(s).ok).toBe(true);
  });
});

describe('SettingsForm', () => {
  it('shows small blind / big blind / ante for a cash game and no level table', () => {
    renderForm(defaultSettings('cash'));
    expect(screen.queryByRole('table')).toBeNull();
    const sb = screen.getByLabelText('Small blind') as HTMLInputElement;
    expect(sb.type).toBe('number');
    expect(sb.inputMode).toBe('numeric');
    expect(sb.value).toBe('1');
    expect((screen.getByLabelText('Big blind') as HTMLInputElement).value).toBe('2');
    expect(screen.getByLabelText('Ante')).toBeTruthy();
    expect(screen.getByLabelText(/Deal hands automatically/)).toBeTruthy();
    expect(screen.getAllByText(/play money/i).length).toBeGreaterThan(0);
  });

  it('edits a cash blind', () => {
    const { latest } = renderForm(defaultSettings('cash'));
    fireEvent.change(screen.getByLabelText('Big blind'), { target: { value: '4' } });
    expect(latest.value.levels[0]!.bigBlind).toBe(4);
    expect(validateSettings(latest.value).ok).toBe(true);
  });

  it('adds and removes level rows', () => {
    const initial = { ...defaultSettings('tournament'), levels: standardStructure({ levels: 3, minutes: 15, bbAnteFromLevel4: false }) };
    const { latest } = renderForm(initial);
    expect(levelRows()).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Add level' }));
    expect(levelRows()).toHaveLength(4);
    expect(latest.value.levels).toHaveLength(4);
    expect(latest.value.levels[3]).toMatchObject({ level: 4, smallBlind: 150, bigBlind: 300 });
    expect(validateSettings(latest.value).ok).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Remove level 2' }));
    expect(levelRows()).toHaveLength(3);
    expect(latest.value.levels.map((l) => l.level)).toEqual([1, 2, 3]);
    expect(latest.value.levels.map((l) => l.smallBlind)).toEqual([25, 75, 150]);

    // Cell inputs are labelled by their row and column headers.
    const cell = screen.getByRole('spinbutton', { name: 'Level 2 Small blind' }) as HTMLInputElement;
    expect(cell.value).toBe('75');
  });

  it('generates the standard structure from the preset controls', () => {
    const initial = { ...defaultSettings('tournament'), levels: standardStructure({ levels: 2, minutes: 15, bbAnteFromLevel4: false }) };
    const { latest } = renderForm(initial);
    fireEvent.change(screen.getByLabelText('Number of levels'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Minutes per level'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use standard structure' }));
    expect(levelRows()).toHaveLength(5);
    expect(latest.value.levels).toEqual(standardStructure({ levels: 5, minutes: 20, bbAnteFromLevel4: true }));
  });

  it('applies payout presets', () => {
    const { latest } = renderForm(defaultSettings('tournament'));
    fireEvent.click(screen.getByRole('button', { name: 'Winner takes all' }));
    expect(latest.value.payouts).toEqual([100]);
    expect(screen.getByRole('button', { name: 'Winner takes all' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '65 / 35' }));
    expect(latest.value.payouts).toEqual([65, 35]);
    expect((screen.getByLabelText('2nd place %') as HTMLInputElement).value).toBe('35');
    fireEvent.click(screen.getByRole('button', { name: '50 / 30 / 20' }));
    expect(latest.value.payouts).toEqual([50, 30, 20]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows messages for payouts not summing to 100 and reports not ok', () => {
    const { latest } = renderForm(defaultSettings('tournament'));
    fireEvent.change(screen.getByLabelText('1st place %'), { target: { value: '60' } });
    expect(latest.value.payouts).toEqual([60, 30, 20]);
    const result = validateSettings(latest.value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.payouts).toMatch(/sum to 100/);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Payouts: .*sum to 100/);
    expect(screen.getByText('Total: 110%')).toBeTruthy();
  });

  it('shows a message next to min buy-in when it exceeds max buy-in', () => {
    const { latest } = renderForm(defaultSettings('cash'));
    const min = screen.getByLabelText('Min buy-in') as HTMLInputElement;
    fireEvent.change(min, { target: { value: '500' } });
    expect(latest.value.minBuyIn).toBe(500);
    expect(validateSettings(latest.value).ok).toBe(false);
    expect(min.getAttribute('aria-invalid')).toBe('true');
    const describedBy = min.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? '')?.textContent).toMatch(/minBuyIn must be <= maxBuyIn/);
    expect(screen.getByRole('alert').textContent).toMatch(/Min buy-in/);
  });

  it('reports a non-integer entry as invalid', () => {
    const { latest } = renderForm(defaultSettings('cash'));
    fireEvent.change(screen.getByLabelText('Turn time (seconds)'), { target: { value: '' } });
    expect(Number.isNaN(latest.value.turnSeconds)).toBe(true);
    const r = validateSettings(latest.value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toContain('turnSeconds');
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('switches kind without losing valid data', () => {
    const cash = { ...defaultSettings('cash'), maxSeats: 6, turnSeconds: 30, minBuyIn: 100, maxBuyIn: 300 };
    const { latest } = renderForm(cash);
    const kind = screen.getByLabelText('Game type');
    fireEvent.change(kind, { target: { value: 'tournament' } });
    expect(latest.value.kind).toBe('tournament');
    expect(latest.value.maxSeats).toBe(6);
    expect(latest.value.turnSeconds).toBe(30);
    expect(latest.value.levels.length).toBeGreaterThan(1);
    expect(validateSettings(latest.value).ok).toBe(true);
    expect(screen.getByRole('table')).toBeTruthy();

    // Edit the tournament structure, go back to cash, then return: the levels come back.
    fireEvent.click(screen.getByRole('button', { name: 'Add level' }));
    const tournamentLevels = latest.value.levels;
    fireEvent.change(kind, { target: { value: 'cash' } });
    expect(latest.value.kind).toBe('cash');
    expect(latest.value.levels).toHaveLength(1);
    expect(latest.value.minBuyIn).toBe(100);
    expect(latest.value.maxBuyIn).toBe(300);
    expect(validateSettings(latest.value).ok).toBe(true);
    fireEvent.change(kind, { target: { value: 'tournament' } });
    expect(latest.value.levels).toEqual(tournamentLevels);
  });

  it('convertKind keeps the first level for cash', () => {
    const t = defaultSettings('tournament');
    const c = convertKind(t, 'cash');
    expect(c.levels).toEqual([{ ...t.levels[0]!, level: 1 }]);
    expect(validateSettings(c).ok).toBe(true);
  });

  it('locks kind and seats', () => {
    renderForm(defaultSettings('cash'), { kind: true, maxSeats: true });
    expect((screen.getByLabelText('Game type') as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText('Seats') as HTMLInputElement).disabled).toBe(true);
  });

  it('shows external errors by dotted path', () => {
    render(
      <SettingsForm
        value={defaultSettings('cash')}
        onChange={() => {}}
        errors={{ turnSeconds: 'Server says no' }}
      />,
    );
    expect(screen.getByText('Server says no')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Turn time: Server says no/);
  });
});
