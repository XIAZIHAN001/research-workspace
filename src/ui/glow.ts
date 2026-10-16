import type { PointerEvent } from 'react';

/**
 * Props for any element that carries pointer-following light (see styles/glass.css).
 * The light is only a CSS variable update; nothing re-renders.
 */
export const glowProps = {
  'data-glow': '',
  onPointerMove(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === 'touch') return;
    const el = event.currentTarget;
    const box = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${event.clientX - box.left}px`);
    el.style.setProperty('--my', `${event.clientY - box.top}px`);
    el.style.setProperty('--glow', '1');
  },
  onPointerLeave(event: PointerEvent<HTMLElement>) {
    event.currentTarget.style.setProperty('--glow', '0');
  },
};
