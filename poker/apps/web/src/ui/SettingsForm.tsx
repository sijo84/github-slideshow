import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react';
import { formatPlayMoney } from '@poker/engine';
import { GameSettingsSchema, type AnteKind, type BlindLevel, type GameSettings } from '@poker/protocol';
import './settingsForm.css';

type Kind = GameSettings['kind'];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Small blinds of the standard structure; the big blind is always twice the small blind. */
const STANDARD_SMALL_BLINDS = [25, 50, 75, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1500, 2000, 3000, 4000, 5000];

function standardSmallBlind(index: number): number {
  if (index < STANDARD_SMALL_BLINDS.length) return STANDARD_SMALL_BLINDS[index] ?? 25;
  const last = STANDARD_SMALL_BLINDS[STANDARD_SMALL_BLINDS.length - 1] ?? 5000;
  return last * 2 ** (index - STANDARD_SMALL_BLINDS.length + 1);
}

/** A tournament blind schedule: 25/50, 50/100, 75/150, 100/200, 150/300, 200/400, 300/600, ... */
export function standardStructure(opts: { levels: number; minutes: number; bbAnteFromLevel4: boolean }): BlindLevel[] {
  const count = Math.max(1, Math.floor(opts.levels));
  const minutes = Math.max(1, Math.floor(opts.minutes));
  const out: BlindLevel[] = [];
  for (let i = 0; i < count; i++) {
    const smallBlind = standardSmallBlind(i);
    const bigBlind = smallBlind * 2;
    const ante = opts.bbAnteFromLevel4 && i >= 3;
    out.push({
      level: i + 1,
      smallBlind,
      bigBlind,
      ante: ante ? bigBlind : 0,
      anteKind: ante ? 'bigBlind' : 'none',
      durationMinutes: minutes,
    });
  }
  return out;
}

export const PAYOUT_PRESETS: { label: string; payouts: number[] }[] = [
  { label: 'Winner takes all', payouts: [100] },
  { label: '65 / 35', payouts: [65, 35] },
  { label: '50 / 30 / 20', payouts: [50, 30, 20] },
];

/** Default settings for a new game of the given kind; valid per GameSettingsSchema. */
export function defaultSettings(kind: Kind): GameSettings {
  const common = {
    maxSeats: 9,
    turnSeconds: 20,
    timeBankSeconds: 60,
    timeBankTopUpSeconds: 10,
    seatApproval: false,
    autoStart: true,
    showAllInEquity: true as const,
  };
  if (kind === 'cash') {
    return {
      ...common,
      kind: 'cash',
      levels: [{ level: 1, smallBlind: 1, bigBlind: 2, ante: 0, anteKind: 'none', durationMinutes: 60 }],
      minBuyIn: 40,
      maxBuyIn: 200,
      startingStack: 200,
      rebuys: { allowed: true, untilLevel: 0 },
      payouts: [100],
    };
  }
  return {
    ...common,
    kind: 'tournament',
    levels: standardStructure({ levels: 10, minutes: 15, bbAnteFromLevel4: true }),
    minBuyIn: 5000,
    maxBuyIn: 5000,
    startingStack: 5000,
    rebuys: { allowed: false, untilLevel: 0 },
    payouts: [50, 30, 20],
  };
}

/** Validates with GameSettingsSchema; errors are keyed by the dotted zod issue path ('' for the root). */
export function validateSettings(
  s: unknown,
): { ok: true; settings: GameSettings } | { ok: false; errors: Record<string, string> } {
  const res = GameSettingsSchema.safeParse(s);
  if (res.success) return { ok: true, settings: res.data };
  const errors: Record<string, string> = {};
  for (const issue of res.error.issues) {
    const key = issue.path.map((p) => String(p)).join('.');
    errors[key] = errors[key] ? `${errors[key]}; ${issue.message}` : issue.message;
  }
  return { ok: false, errors };
}

function renumber(levels: BlindLevel[]): BlindLevel[] {
  return levels.map((l, i) => ({ ...l, level: i + 1 }));
}

/** Next level after `last`: blinds and ante doubled, same ante kind and duration. */
function nextLevel(last: BlindLevel | undefined): BlindLevel {
  if (!last) return { level: 1, smallBlind: 25, bigBlind: 50, ante: 0, anteKind: 'none', durationMinutes: 15 };
  return {
    level: last.level + 1,
    smallBlind: last.smallBlind * 2,
    bigBlind: last.bigBlind * 2,
    ante: last.ante * 2,
    anteKind: last.anteKind,
    durationMinutes: last.durationMinutes,
  };
}

/**
 * Converts settings to another kind, keeping everything that still makes sense.
 * `stashedLevels` are tournament levels to restore when going back to a tournament.
 */
export function convertKind(s: GameSettings, kind: Kind, stashedLevels?: BlindLevel[]): GameSettings {
  if (s.kind === kind) return s;
  if (kind === 'cash') {
    const first: BlindLevel | undefined = s.levels[0];
    const level: BlindLevel = first ? { ...first, level: 1 } : nextLevel(undefined);
    return { ...s, kind: 'cash', levels: [level] };
  }
  const levels =
    stashedLevels && stashedLevels.length > 1
      ? stashedLevels
      : standardStructure({ levels: 10, minutes: 15, bbAnteFromLevel4: true });
  const payouts = s.payouts.reduce((a, b) => a + b, 0) === 100 ? s.payouts : [50, 30, 20];
  return { ...s, kind: 'tournament', levels: renumber(levels), payouts };
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Human names for the dotted error paths in the summary. */
function fieldName(path: string): string {
  const names: Record<string, string> = {
    kind: 'Game type',
    maxSeats: 'Seats',
    levels: 'Blind levels',
    minBuyIn: 'Min buy-in',
    maxBuyIn: 'Max buy-in',
    startingStack: 'Starting stack',
    turnSeconds: 'Turn time',
    timeBankSeconds: 'Time bank',
    timeBankTopUpSeconds: 'Time bank top-up',
    'rebuys.untilLevel': 'Rebuys until level',
    payouts: 'Payouts',
  };
  if (names[path]) return names[path];
  const lvl = /^levels\.(\d+)\.(\w+)$/.exec(path);
  if (lvl) return `Level ${Number(lvl[1]) + 1} ${lvl[2]}`;
  const pay = /^payouts\.(\d+)$/.exec(path);
  if (pay) return `${ordinal(Number(pay[1]) + 1)} place`;
  return path === '' ? 'Settings' : path;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function parseIntOrNaN(text: string): number {
  return /^-?\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
}

/** Integer input that keeps the raw text while typing; reports NaN while the text is not an integer. */
function NumberInput(props: {
  id?: string;
  value: number;
  onChange(n: number): void;
  min?: number;
  max?: number;
  disabled?: boolean;
  labelledBy?: string;
  describedBy?: string;
  invalid?: boolean;
}): JSX.Element {
  const [text, setText] = useState(() => (Number.isFinite(props.value) ? String(props.value) : ''));
  const last = useRef(props.value);
  useEffect(() => {
    // Sync from outside only when the prop moved away from what the text means.
    if (!Object.is(props.value, last.current) && !Object.is(props.value, parseIntOrNaN(text))) {
      setText(Number.isFinite(props.value) ? String(props.value) : '');
    }
    last.current = props.value;
  }, [props.value, text]);
  return (
    <input
      id={props.id}
      type="number"
      inputMode="numeric"
      step={1}
      min={props.min}
      max={props.max}
      value={text}
      disabled={props.disabled}
      aria-labelledby={props.labelledBy}
      aria-describedby={props.describedBy}
      aria-invalid={props.invalid ? true : undefined}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const n = parseIntOrNaN(t);
        last.current = n;
        props.onChange(n);
      }}
    />
  );
}

function FieldError({ id, message }: { id: string; message: string | undefined }): JSX.Element | null {
  if (!message) return null;
  return (
    <span id={id} className="settings-error">
      {message}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export function SettingsForm(props: {
  value: GameSettings;
  onChange(next: GameSettings): void;
  locked?: { kind?: boolean; maxSeats?: boolean };
  errors?: Record<string, string>;
}): JSX.Element {
  const { value: s, onChange, locked } = props;
  const uid = useId();
  const id = (name: string): string => `${uid}-${name}`;
  const stash = useRef<BlindLevel[] | undefined>(s.kind === 'tournament' ? s.levels : undefined);
  const [presetLevels, setPresetLevels] = useState(10);
  const [presetMinutes, setPresetMinutes] = useState(15);
  const [presetAnte, setPresetAnte] = useState(true);

  const validation = validateSettings(s);
  const errors: Record<string, string> = { ...(validation.ok ? {} : validation.errors), ...(props.errors ?? {}) };
  const err = (path: string): string | undefined => errors[path];

  const set = <K extends keyof GameSettings>(key: K, v: GameSettings[K]): void => onChange({ ...s, [key]: v });
  const setLevels = (levels: BlindLevel[]): void => {
    if (s.kind === 'tournament') stash.current = levels;
    onChange({ ...s, levels });
  };
  const setLevel = (index: number, patch: Partial<BlindLevel>): void =>
    setLevels(s.levels.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const field = (
    name: string,
    label: string,
    path: string,
    v: number,
    on: (n: number) => void,
    extra?: { min?: number; max?: number; disabled?: boolean; hint?: ReactNode },
  ): JSX.Element => (
    <div className="field">
      <label htmlFor={id(name)}>{label}</label>
      <NumberInput
        id={id(name)}
        value={v}
        onChange={on}
        min={extra?.min}
        max={extra?.max}
        disabled={extra?.disabled}
        invalid={Boolean(err(path))}
        describedBy={err(path) ? id(`${name}-err`) : undefined}
      />
      {extra?.hint}
      <FieldError id={id(`${name}-err`)} message={err(path)} />
    </div>
  );

  const levelErrorKeys = Object.keys(errors).filter((k) => k === 'levels' || k.startsWith('levels.'));
  const payoutErrorKeys = Object.keys(errors).filter((k) => k === 'payouts' || k.startsWith('payouts.'));
  const payoutSum = s.payouts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const errorKeys = Object.keys(errors);
  const money = (n: number): string => (Number.isSafeInteger(n) ? formatPlayMoney(n) : '—');
  const level0 = s.levels[0];

  return (
    <div className="settings-form stack">
      <fieldset className="settings-group">
        <legend>Game</legend>
        <div className="settings-grid">
          <div className="field">
            <label htmlFor={id('kind')}>Game type</label>
            <select
              id={id('kind')}
              value={s.kind}
              disabled={locked?.kind}
              onChange={(e) => {
                const kind = e.target.value as Kind;
                if (s.kind === 'tournament') stash.current = s.levels;
                onChange(convertKind(s, kind, stash.current));
              }}
            >
              <option value="cash">Cash game</option>
              <option value="tournament">Tournament</option>
            </select>
            <FieldError id={id('kind-err')} message={err('kind')} />
          </div>
          {field('seats', 'Seats', 'maxSeats', s.maxSeats, (n) => set('maxSeats', n), {
            min: 2,
            max: 9,
            disabled: locked?.maxSeats,
          })}
        </div>
      </fieldset>

      {s.kind === 'cash' ? (
        <fieldset className="settings-group">
          <legend>Blinds</legend>
          <div className="settings-grid">
            {field('cash-sb', 'Small blind', 'levels.0.smallBlind', level0?.smallBlind ?? Number.NaN, (n) =>
              setLevel(0, { smallBlind: n }),
            )}
            {field('cash-bb', 'Big blind', 'levels.0.bigBlind', level0?.bigBlind ?? Number.NaN, (n) =>
              setLevel(0, { bigBlind: n }),
            )}
            {field('cash-ante', 'Ante', 'levels.0.ante', level0?.ante ?? 0, (n) => setLevel(0, { ante: n }))}
            <div className="field">
              <label htmlFor={id('cash-antekind')}>Ante kind</label>
              <AnteKindSelect
                id={id('cash-antekind')}
                value={level0?.anteKind ?? 'none'}
                onChange={(k) => setLevel(0, { anteKind: k })}
              />
            </div>
          </div>
          {err('levels') && <p className="settings-error">{err('levels')}</p>}
        </fieldset>
      ) : (
        <fieldset className="settings-group">
          <legend>Blind levels</legend>
          <div className="settings-table-scroll">
            <table className="table settings-levels">
              <thead>
                <tr>
                  <th id={id('col-level')} scope="col">Level</th>
                  <th id={id('col-sb')} scope="col">Small blind</th>
                  <th id={id('col-bb')} scope="col">Big blind</th>
                  <th id={id('col-ante')} scope="col">Ante</th>
                  <th id={id('col-antekind')} scope="col">Ante kind</th>
                  <th id={id('col-min')} scope="col">Minutes</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.levels.map((l, i) => {
                  const row = id(`lvl-${i}`);
                  const cellErr = (k: string): boolean => Boolean(err(`levels.${i}.${k}`));
                  return (
                    <tr key={i}>
                      <th id={row} scope="row">
                        Level {i + 1}
                      </th>
                      <td>
                        <NumberInput
                          value={l.smallBlind}
                          labelledBy={`${row} ${id('col-sb')}`}
                          invalid={cellErr('smallBlind')}
                          onChange={(n) => setLevel(i, { smallBlind: n })}
                        />
                      </td>
                      <td>
                        <NumberInput
                          value={l.bigBlind}
                          labelledBy={`${row} ${id('col-bb')}`}
                          invalid={cellErr('bigBlind')}
                          onChange={(n) => setLevel(i, { bigBlind: n })}
                        />
                      </td>
                      <td>
                        <NumberInput
                          value={l.ante}
                          labelledBy={`${row} ${id('col-ante')}`}
                          invalid={cellErr('ante')}
                          onChange={(n) => setLevel(i, { ante: n })}
                        />
                      </td>
                      <td>
                        <AnteKindSelect
                          value={l.anteKind}
                          labelledBy={`${row} ${id('col-antekind')}`}
                          onChange={(k) => setLevel(i, { anteKind: k })}
                        />
                      </td>
                      <td>
                        <NumberInput
                          value={l.durationMinutes}
                          labelledBy={`${row} ${id('col-min')}`}
                          invalid={cellErr('durationMinutes')}
                          onChange={(n) => setLevel(i, { durationMinutes: n })}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          aria-label={`Remove level ${i + 1}`}
                          disabled={s.levels.length <= 1}
                          onClick={() => setLevels(renumber(s.levels.filter((_, j) => j !== i)))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() => setLevels(renumber([...s.levels, nextLevel(s.levels[s.levels.length - 1])]))}
            >
              Add level
            </button>
          </div>
          {levelErrorKeys.length > 0 && (
            <ul className="settings-error-list">
              {levelErrorKeys.map((k) => (
                <li key={k} className="settings-error">
                  {k === 'levels' ? errors[k] : `${fieldName(k)}: ${errors[k]}`}
                </li>
              ))}
            </ul>
          )}
          <div className="settings-preset card">
            <p className="muted">Standard structure: blinds roughly double each level (25/50, 50/100, 75/150, ...).</p>
            <div className="settings-grid">
              <div className="field">
                <label htmlFor={id('preset-levels')}>Number of levels</label>
                <NumberInput id={id('preset-levels')} value={presetLevels} min={1} max={40} onChange={setPresetLevels} />
              </div>
              <div className="field">
                <label htmlFor={id('preset-minutes')}>Minutes per level</label>
                <NumberInput id={id('preset-minutes')} value={presetMinutes} min={1} onChange={setPresetMinutes} />
              </div>
              <Checkbox label="Big blind ante from level 4" checked={presetAnte} onChange={(v) => setPresetAnte(v)} />
            </div>
            <button
              type="button"
              className="btn"
              disabled={!Number.isSafeInteger(presetLevels) || presetLevels < 1 || !Number.isSafeInteger(presetMinutes) || presetMinutes < 1}
              onClick={() =>
                setLevels(
                  standardStructure({
                    levels: Math.min(presetLevels, 40),
                    minutes: presetMinutes,
                    bbAnteFromLevel4: presetAnte,
                  }),
                )
              }
            >
              Use standard structure
            </button>
          </div>
        </fieldset>
      )}

      <fieldset className="settings-group">
        <legend>
          Buy-in <span className="badge">play money</span>
        </legend>
        <div className="settings-grid">
          {s.kind === 'cash' ? (
            <>
              {field('minbuyin', 'Min buy-in', 'minBuyIn', s.minBuyIn, (n) => set('minBuyIn', n), {
                min: 0,
                hint: <span className="muted">{money(s.minBuyIn)}</span>,
              })}
              {field('maxbuyin', 'Max buy-in', 'maxBuyIn', s.maxBuyIn, (n) => set('maxBuyIn', n), {
                min: 0,
                hint: <span className="muted">{money(s.maxBuyIn)}</span>,
              })}
            </>
          ) : (
            <>
              {field('stack', 'Starting stack', 'startingStack', s.startingStack, (n) => set('startingStack', n), {
                min: 1,
                hint: <span className="muted">{money(s.startingStack)} buy-in</span>,
              })}
              {err('minBuyIn') && <p className="settings-error">{err('minBuyIn')}</p>}
            </>
          )}
        </div>
        <Checkbox label="Allow rebuys" checked={s.rebuys.allowed} onChange={(v) => set('rebuys', { ...s.rebuys, allowed: v })} />
        {s.kind === 'tournament' &&
          s.rebuys.allowed &&
          field('rebuy-until', 'Rebuys until level', 'rebuys.untilLevel', s.rebuys.untilLevel, (n) =>
            set('rebuys', { ...s.rebuys, untilLevel: n }),
          { min: 0 })}
      </fieldset>

      <fieldset className="settings-group">
        <legend>Timers</legend>
        <div className="settings-grid">
          {field('turn', 'Turn time (seconds)', 'turnSeconds', s.turnSeconds, (n) => set('turnSeconds', n), {
            max: 120,
          })}
          {field('bank', 'Time bank (seconds)', 'timeBankSeconds', s.timeBankSeconds, (n) => set('timeBankSeconds', n), {
            min: 0,
            max: 600,
          })}
          {field(
            'topup',
            'Time bank top-up (seconds)',
            'timeBankTopUpSeconds',
            s.timeBankTopUpSeconds,
            (n) => set('timeBankTopUpSeconds', n),
            { min: 0, max: 120 },
          )}
        </div>
      </fieldset>

      {s.kind === 'tournament' && (
        <fieldset className="settings-group">
          <legend>Payouts</legend>
          <div className="row settings-presets">
            {PAYOUT_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className="btn"
                aria-pressed={JSON.stringify(p.payouts) === JSON.stringify(s.payouts)}
                onClick={() => set('payouts', [...p.payouts])}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="settings-grid">
            {s.payouts.map((pct, i) =>
              field(`payout-${i}`, `${ordinal(i + 1)} place %`, `payouts.${i}`, pct, (n) =>
                set(
                  'payouts',
                  s.payouts.map((v, j) => (j === i ? n : v)),
                ),
              { min: 1, max: 100 }),
            )}
          </div>
          <div className="row">
            <button type="button" className="btn btn-ghost" onClick={() => set('payouts', [...s.payouts, 1])}>
              Add place
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={s.payouts.length <= 1}
              onClick={() => set('payouts', s.payouts.slice(0, -1))}
            >
              Remove place
            </button>
            <span className={payoutSum === 100 ? 'muted' : 'settings-error'}>Total: {payoutSum}%</span>
          </div>
          {payoutErrorKeys
            .filter((k) => k === 'payouts')
            .map((k) => (
              <p key={k} className="settings-error">
                {errors[k]}
              </p>
            ))}
        </fieldset>
      )}

      <fieldset className="settings-group">
        <legend>Table</legend>
        <Checkbox label="Host approves each seat" checked={s.seatApproval} onChange={(v) => set('seatApproval', v)} />
        {s.kind === 'cash' && (
          <Checkbox label="Deal hands automatically when two players are seated" checked={s.autoStart} onChange={(v) => set('autoStart', v)} />
        )}
      </fieldset>

      {errorKeys.length > 0 && (
        <div role="alert" className="alert settings-summary">
          <p>Please fix these settings:</p>
          <ul>
            {errorKeys.map((k) => (
              <li key={k}>
                {fieldName(k)}: {errors[k]}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function AnteKindSelect(props: {
  id?: string;
  value: AnteKind;
  labelledBy?: string;
  onChange(k: AnteKind): void;
}): JSX.Element {
  return (
    <select
      id={props.id}
      value={props.value}
      aria-labelledby={props.labelledBy}
      onChange={(e) => props.onChange(e.target.value as AnteKind)}
    >
      <option value="none">None</option>
      <option value="every">Every player</option>
      <option value="bigBlind">Big blind ante</option>
    </select>
  );
}

/** A left-aligned checkbox row; the whole label (box and text) is the click target. */
function Checkbox(props: { label: string; checked: boolean; onChange(v: boolean): void }): JSX.Element {
  return (
    <label className="field-inline settings-check">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}
