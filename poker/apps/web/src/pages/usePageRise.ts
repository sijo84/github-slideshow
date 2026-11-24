import { useId, useLayoutEffect, useRef, type RefObject } from 'react';
import { easeOutCubic, prefersReducedMotion, tween } from '../anim/tween.js';

/**
 * Page-enter transition: opacity 0 -> 1 and an 8 px rise over 220 ms (easeOutCubic).
 * Styles are only written from onUpdate, so the page stays fully visible if the tween never runs.
 */
export function usePageRise<T extends HTMLElement = HTMLDivElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  const uid = useId();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const reset = (): void => {
      el.style.opacity = '';
      el.style.transform = '';
    };
    const handle = tween<number>({
      id: `page-rise:${uid}`,
      from: 0,
      to: 1,
      durationMs: 220,
      ease: easeOutCubic,
      onUpdate: (v) => {
        el.style.opacity = String(v);
        el.style.transform = `translateY(${((1 - v) * 8).toFixed(2)}px)`;
      },
      onDone: reset,
    });
    return () => {
      handle.cancel();
      reset();
    };
  }, [uid]);
  return ref;
}
