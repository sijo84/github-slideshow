import { type RefObject, useLayoutEffect, useRef } from 'react';
import { easeOutCubic, prefersReducedMotion, tween, type Vec3 } from '../anim/tween.js';

export const PAGE_ENTER_MS = 220;
export const PAGE_ENTER_RISE_PX = 8;

/** [opacity, translateY px, unused] */
const FROM: Vec3 = [0, PAGE_ENTER_RISE_PX, 0];
const TO: Vec3 = [1, 0, 0];

function apply(el: HTMLElement, value: Vec3): void {
  el.style.opacity = String(value[0]);
  el.style.transform = value[1] === 0 ? '' : `translateY(${value[1]}px)`;
}

function clear(el: HTMLElement): void {
  el.style.opacity = '';
  el.style.transform = '';
}

/**
 * Page-enter transition: opacity 0 → 1 and an 8 px rise over 220 ms (easeOutCubic), driven by the shared tween loop.
 * Attach the returned ref to the page container. The element is fully visible when the tween finishes, is cancelled
 * (unmount) or cannot start, and when reduced motion is requested.
 */
export function usePageEnter<E extends HTMLElement = HTMLDivElement>(name: string): RefObject<E | null> {
  const ref = useRef<E | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) return;
    let handle: { cancel(): void } | undefined;
    let finished = false;
    const finish = (): void => {
      finished = true;
      clear(el);
    };
    // Safety net: if the animation loop never runs (no rAF, mocked tween), the page still ends up visible.
    const fallback = setTimeout(finish, PAGE_ENTER_MS + 200);
    try {
      apply(el, FROM);
      handle = tween<Vec3>({
        id: `page:${name}`,
        from: FROM,
        to: TO,
        durationMs: PAGE_ENTER_MS,
        ease: easeOutCubic,
        onUpdate: (v) => {
          if (!finished) apply(el, v);
        },
        onDone: finish,
      });
    } catch {
      finish();
    }
    return () => {
      clearTimeout(fallback);
      handle?.cancel();
      finish();
    };
  }, [name]);

  return ref;
}
