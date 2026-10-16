import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom ships <dialog> without showModal()/close(). A minimal stand-in is enough here:
// the tests only need `open` to toggle and the `close` event to fire.
if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

// Vitest runs with globals off, so Testing Library cannot register its own
// auto-cleanup. Unmount rendered trees and wipe storage between tests.
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
