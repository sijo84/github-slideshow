/**
 * Private player notes (W10, PLAN I-11). REST contract: apps/server/src/routes/notes.ts.
 *
 * - `useNotes()`: one shared `GET /api/notes` for the whole app (module cache + subscribers through
 *   `useSyncExternalStore`), as `Record<playerId, { text, color }>`. A note with no text and no colour is absent.
 *   The map changes at once when the popover saves, so seat colour dots follow without a refetch.
 * - `NotesPopover`: textarea + colour tag, autosaved with `PUT /api/notes/:subjectId` 600 ms after the last
 *   change; a pending change is flushed on close and on unmount. Escape closes.
 */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api/client.js';
import './chat.css';

export const NOTE_MAX = 2000;
export const NOTE_SAVE_DEBOUNCE_MS = 600;
export const NOTE_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
/** Swatch colours, for any component that shows a note's tag (e.g. the dot on a seat). */
export const NOTE_COLOR_HEX: Record<NoteColor, string> = {
  red: '#e0605a',
  orange: '#e8924a',
  yellow: '#e3c955',
  green: '#4fbf7f',
  blue: '#5b9be0',
  purple: '#a77de0',
};

const COLOR_LABEL: Record<NoteColor, string> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
};

export interface NoteEntry {
  text: string;
  color: string | null;
}

interface ApiNote {
  subjectId: string;
  text: string;
  color: string | null;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------------------------------------
// Shared notes map

type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

let notesMap: Record<string, NoteEntry> = {};
let loadState: LoadState = 'idle';
/** Subjects written locally since the fetch started: the fetch result must not overwrite them. */
const localWrites = new Set<string>();
const subscribers = new Set<() => void>();

function emit(): void {
  for (const s of [...subscribers]) s();
}

function ensureLoaded(): void {
  if (loadState !== 'idle') return;
  loadState = 'loading';
  api<{ notes: ApiNote[] }>('/api/notes').then(
    (res) => {
      if (loadState !== 'loading') return; // reset meanwhile (tests)
      const next: Record<string, NoteEntry> = {};
      for (const n of res.notes ?? []) {
        if (n.text !== '' || n.color !== null) next[n.subjectId] = { text: n.text, color: n.color };
      }
      for (const id of localWrites) {
        const local = notesMap[id];
        if (local) next[id] = local;
        else delete next[id];
      }
      notesMap = next;
      loadState = 'loaded';
      emit();
    },
    () => {
      if (loadState !== 'loading') return;
      loadState = 'error';
      emit();
    },
  );
}

function setNote(subjectId: string, entry: NoteEntry): void {
  localWrites.add(subjectId);
  const next = { ...notesMap };
  if (entry.text === '' && entry.color === null) delete next[subjectId];
  else next[subjectId] = entry;
  notesMap = next;
  emit();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  ensureLoaded();
  return () => {
    subscribers.delete(cb);
  };
}

const getNotes = (): Record<string, NoteEntry> => notesMap;
const getLoadState = (): LoadState => loadState;

/** Every note I wrote, by player id. Fetched once for the whole app. */
export function useNotes(): Record<string, NoteEntry> {
  return useSyncExternalStore(subscribe, getNotes, getNotes);
}

function useNotesLoadState(): LoadState {
  return useSyncExternalStore(subscribe, getLoadState, getLoadState);
}

/** Test helper: forgets the cache so the next subscriber fetches again. */
export function __resetNotesForTests(): void {
  notesMap = {};
  loadState = 'idle';
  localWrites.clear();
}

// ---------------------------------------------------------------------------------------------------------
// Popover

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };

export function NotesPopover({ subjectId, name, onClose }: { subjectId: string; name: string; onClose: () => void }) {
  const notes = useNotes();
  const loaded = useNotesLoadState();
  const existing = notes[subjectId];

  const [text, setText] = useState(existing?.text ?? '');
  const [color, setColor] = useState<string | null>(existing?.color ?? null);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const touchedRef = useRef(false);
  const pendingRef = useRef<NoteEntry | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const headingId = useId();
  const fieldId = useId();
  const radioName = useId();

  // The map loads after the popover opened: adopt the stored note unless the user already typed.
  useEffect(() => {
    if (touchedRef.current) return;
    setText(existing?.text ?? '');
    setColor(existing?.color ?? null);
  }, [loaded, existing?.text, existing?.color]);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const entry = pendingRef.current;
    if (!entry) return;
    pendingRef.current = null;
    setNote(subjectId, entry);
    const seq = ++seqRef.current;
    if (mountedRef.current) setSave({ kind: 'saving' });
    api<ApiNote>(`/api/notes/${encodeURIComponent(subjectId)}`, {
      method: 'PUT',
      body: { text: entry.text, color: entry.color },
    }).then(
      () => {
        if (mountedRef.current && seq === seqRef.current) setSave({ kind: 'saved' });
      },
      (err: unknown) => {
        const message = err instanceof Error && err.message ? err.message : 'Could not save the note';
        if (mountedRef.current && seq === seqRef.current) setSave({ kind: 'error', message });
      },
    );
  }, [subjectId]);

  const schedule = (entry: NoteEntry) => {
    touchedRef.current = true;
    pendingRef.current = entry;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, NOTE_SAVE_DEBOUNCE_MS);
  };

  const close = useCallback(() => {
    flush();
    onCloseRef.current();
  }, [flush]);

  // Flush a pending change on unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flush();
    };
  }, [flush]);

  useEffect(() => {
    textareaRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <div className="notes-popover card" role="dialog" aria-labelledby={headingId}>
      <div className="notes-head">
        <h3 id={headingId}>Notes on {name}</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={close}>
          Close
        </button>
      </div>
      <div className="field">
        <label htmlFor={fieldId}>Private note</label>
        <textarea
          id={fieldId}
          ref={textareaRef}
          rows={4}
          maxLength={NOTE_MAX}
          value={text}
          onChange={(e) => {
            const v = e.target.value.slice(0, NOTE_MAX);
            setText(v);
            schedule({ text: v, color });
          }}
        />
        <small className="muted">Only you can see this</small>
      </div>
      <fieldset className="notes-colors">
        <legend className="small muted">Colour tag</legend>
        <label className="notes-color" title="No colour">
          <input
            type="radio"
            name={radioName}
            checked={color === null}
            onChange={() => {
              setColor(null);
              schedule({ text, color: null });
            }}
            aria-label="No colour"
          />
          <span className="notes-swatch notes-swatch-none" aria-hidden="true" />
        </label>
        {NOTE_COLORS.map((c) => (
          <label key={c} className="notes-color" title={COLOR_LABEL[c]}>
            <input
              type="radio"
              name={radioName}
              checked={color === c}
              onChange={() => {
                setColor(c);
                schedule({ text, color: c });
              }}
              aria-label={COLOR_LABEL[c]}
            />
            <span className="notes-swatch" style={{ background: NOTE_COLOR_HEX[c] }} aria-hidden="true" />
          </label>
        ))}
      </fieldset>
      <div className="notes-status small">
        {save.kind === 'error' ? (
          <span role="alert" className="notes-error">
            {save.message}
          </span>
        ) : (
          <span role="status" className="muted">
            {save.kind === 'saving' ? 'Saving…' : save.kind === 'saved' ? 'Saved' : ''}
          </span>
        )}
      </div>
    </div>
  );
}
