/**
 * Table chat (W10, PLAN I-11). Plain DOM, in the table overlay.
 *
 * - Messages are rendered as text only (React escapes them; never `dangerouslySetInnerHTML`).
 * - A message that arrives while the panel is mounted slides in: opacity 0 → 1 and an 8 px rise, driven by
 *   `useTween` keyed by the message id (no CSS keyframes). Messages present on mount appear in place.
 * - The list sticks to the newest message unless the user has scrolled up; then a "New messages" button
 *   appears that jumps back down.
 * - Sending emits `chat:send` with the trimmed text; the server's `rate_limited` answer reaches the page,
 *   which sets `chatError` (shown here as an alert). Sending again clears it.
 */
import type { ChatMessage } from '@poker/protocol';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { easeOutCubic, useTween } from '../anim/tween.js';
import { getSocket } from '../api/socket.js';
import { useTable } from './storeContext.js';
import './chat.css';

export const CHAT_MAX = 200;
/** How close to the bottom (px) still counts as "at the bottom". */
const STICK_THRESHOLD_PX = 24;
const SLIDE_MS = 240;
const SLIDE_RISE_PX = 8;

function ChatRow({ message, animate }: { message: ChatMessage; animate: boolean }) {
  const [shown, setShown] = useState(!animate);
  useEffect(() => {
    setShown(true);
  }, []);
  const p = useTween(shown ? 1 : 0, { id: `chat:${message.id}`, durationMs: SLIDE_MS, ease: easeOutCubic });
  return (
    <li
      className="chat-msg"
      data-message-id={message.id}
      style={{ opacity: p, transform: p >= 1 ? undefined : `translateY(${((1 - p) * SLIDE_RISE_PX).toFixed(2)}px)` }}
    >
      <span className="chat-name">{message.name}</span> <span className="chat-text">{message.text}</span>
    </li>
  );
}

export function ChatPanel({ gameId }: { gameId: string }) {
  const chat = useTable((s) => s.chat);
  const chatError = useTable((s) => s.chatError);
  const setChatError = useTable((s) => s.setChatError);

  const [text, setText] = useState('');
  const [unseen, setUnseen] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const stuckRef = useRef(true);
  const lastCountRef = useRef(chat.length);
  /** Ids on display when the panel mounted: these do not slide in. */
  const initialIdsRef = useRef<Set<string> | null>(null);
  initialIdsRef.current ??= new Set(chat.map((m) => m.id));

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    stuckRef.current = true;
    setUnseen(false);
  }, []);

  // Before paint: keep the newest message in view, or flag unseen messages when the user scrolled up.
  useLayoutEffect(() => {
    const grew = chat.length > lastCountRef.current;
    lastCountRef.current = chat.length;
    if (stuckRef.current) {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    } else if (grew) {
      setUnseen(true);
    }
  }, [chat]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
    stuckRef.current = atBottom;
    if (atBottom) setUnseen(false);
  };

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= CHAT_MAX;

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    getSocket().emit('chat:send', { gameId, text: trimmed });
    setText('');
    setChatError(null);
    scrollToBottom();
  };

  return (
    <section className="chat-panel" aria-label="Chat">
      <div className="chat-scroll">
        <ol className="chat-list" data-testid="chat-list" ref={listRef} onScroll={onScroll} aria-live="polite">
          {chat.map((m) => (
            <ChatRow key={m.id} message={m} animate={!initialIdsRef.current?.has(m.id)} />
          ))}
        </ol>
        {unseen && (
          <button type="button" className="btn btn-sm chat-jump" onClick={scrollToBottom}>
            New messages
          </button>
        )}
      </div>
      {chatError && (
        <p role="alert" className="alert chat-error">
          {chatError}
        </p>
      )}
      <form className="chat-form" onSubmit={send}>
        <label htmlFor={`chat-input-${gameId}`} className="sr-only">
          Message
        </label>
        <input
          id={`chat-input-${gameId}`}
          className="chat-input"
          type="text"
          autoComplete="off"
          maxLength={CHAT_MAX}
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, CHAT_MAX))}
          aria-describedby={`chat-count-${gameId}`}
          placeholder="Say something…"
        />
        <span id={`chat-count-${gameId}`} className="chat-count small muted mono" aria-live="off">
          {text.length}/{CHAT_MAX}
        </span>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!canSend}>
          Send
        </button>
      </form>
    </section>
  );
}
