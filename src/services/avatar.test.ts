import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AVATAR_ACCEPTED_TYPES,
  AVATAR_MAX_BYTES,
  AVATAR_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
} from '../app/config';
import { checkAvatarFile, clearAvatar, loadAvatar, readFileAsDataUrl, saveAvatar } from './avatar';

const PNG_URL = 'data:image/png;base64,iVBORw0KGgo=';

afterEach(() => {
  vi.unstubAllGlobals();
});

// avatar.ts always goes through the default store, so storage failures are
// simulated on window.localStorage itself. Each helper restores before returning,
// which keeps the shared afterEach in src/test/setup.ts safe to call localStorage.clear().
function withBlockedLocalStorage<T>(run: () => T): T {
  const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
    throw new DOMException('Access is denied for this document.', 'SecurityError');
  });
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

function withFullLocalStorage<T>(run: () => T): T {
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  });
  try {
    return run();
  } finally {
    spy.mockRestore();
  }
}

interface ReaderOutcome {
  event: 'load' | 'error';
  result?: unknown;
  error?: unknown;
}

/** Replaces FileReader with a fake that finishes with the given outcome. */
function stubFileReader(outcome: ReaderOutcome): void {
  class FakeFileReader {
    result: unknown = null;
    error: unknown = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    readAsDataURL(): void {
      queueMicrotask(() => {
        this.result = outcome.result ?? null;
        this.error = outcome.error ?? null;
        (outcome.event === 'load' ? this.onload : this.onerror)?.();
      });
    }
  }
  vi.stubGlobal('FileReader', FakeFileReader);
}

describe('checkAvatarFile', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])(
    'accepts %s within the size limit',
    (type) => {
      expect(checkAvatarFile({ type, size: 1024 })).toBeNull();
    },
  );

  it.each(['image/gif', 'image/bmp', 'image/avif', 'application/pdf', 'text/html', ''])(
    'rejects the type "%s"',
    (type) => {
      expect(checkAvatarFile({ type, size: 1024 })).toBe('type');
    },
  );

  it('accepts a file of exactly the maximum size', () => {
    expect(checkAvatarFile({ type: 'image/png', size: AVATAR_MAX_BYTES })).toBeNull();
  });

  it('rejects a file one byte over the maximum size', () => {
    expect(checkAvatarFile({ type: 'image/png', size: AVATAR_MAX_BYTES + 1 })).toBe('size');
  });

  it('reports the type problem first when both type and size are wrong', () => {
    expect(checkAvatarFile({ type: 'image/gif', size: AVATAR_MAX_BYTES + 1 })).toBe('type');
  });

  it('accepts every configured type', () => {
    for (const type of AVATAR_ACCEPTED_TYPES) {
      expect(checkAvatarFile({ type, size: 1 })).toBeNull();
    }
  });

  it('rejects an empty file', () => {
    expect(checkAvatarFile({ type: 'image/png', size: 0 })).toBe('empty');
  });

  it('reports the type problem first for an empty file of the wrong type', () => {
    expect(checkAvatarFile({ type: 'image/gif', size: 0 })).toBe('type');
  });

  // The type whitelist in config and the stored-value pattern in avatar.ts are
  // maintained separately; this keeps them from drifting apart.
  it.each([...AVATAR_ACCEPTED_TYPES])('stores and reloads a minimal %s file', async (type) => {
    const file = new File(['x'], 'a', { type });
    expect(checkAvatarFile(file)).toBeNull();
    const dataUrl = await readFileAsDataUrl(file);
    expect(saveAvatar(dataUrl)).toBe(true);
    expect(loadAvatar()).toBe(dataUrl);
  });
});

describe('saveAvatar, loadAvatar and clearAvatar', () => {
  it('loads nothing when nothing is stored', () => {
    expect(loadAvatar()).toBeNull();
  });

  it('round-trips a data URL and clears it again', () => {
    expect(saveAvatar(PNG_URL)).toBe(true);
    expect(loadAvatar()).toBe(PNG_URL);
    clearAvatar();
    expect(loadAvatar()).toBeNull();
  });

  it('writes only its own storage key', () => {
    saveAvatar(PNG_URL);
    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.getItem(AVATAR_STORAGE_KEY)).toBe(PNG_URL);
    expect(window.localStorage.getItem(PROJECTS_STORAGE_KEY)).toBeNull();
  });

  it.each([
    { label: 'plain text', value: 'hello' },
    { label: 'a remote URL', value: 'https://example.com/a.png' },
    { label: 'a javascript: URL', value: 'javascript:alert(1)' },
    { label: 'an unsupported image type', value: 'data:image/gif;base64,R0lGODlh' },
    { label: 'a data URL that is not base64', value: 'data:image/png,abc' },
    { label: 'a data URL followed by extra characters', value: `${PNG_URL}"onerror="x` },
    { label: 'an empty string', value: '' },
  ])('ignores a stored value that is $label', ({ value }) => {
    window.localStorage.setItem(AVATAR_STORAGE_KEY, value);
    expect(loadAvatar()).toBeNull();
  });

  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])(
    'loads a stored %s data URL',
    (type) => {
      const url = `data:${type};base64,AAAA`;
      window.localStorage.setItem(AVATAR_STORAGE_KEY, url);
      expect(loadAvatar()).toBe(url);
    },
  );

  it('reports failure when the storage is full and keeps the old picture', () => {
    saveAvatar(PNG_URL);
    withFullLocalStorage(() => {
      expect(saveAvatar('data:image/png;base64,QUJD')).toBe(false);
    });
    expect(loadAvatar()).toBe(PNG_URL);
  });

  it('degrades quietly when localStorage is blocked', () => {
    withBlockedLocalStorage(() => {
      expect(loadAvatar()).toBeNull();
      expect(saveAvatar(PNG_URL)).toBe(false);
      expect(() => {
        clearAvatar();
      }).not.toThrow();
    });
  });
});

describe('readFileAsDataUrl', () => {
  it('resolves with the data URL a real FileReader produces', async () => {
    const file = new File(['abc'], 'a.png', { type: 'image/png' });
    await expect(readFileAsDataUrl(file)).resolves.toBe('data:image/png;base64,YWJj');
  });

  it('resolves with the string result of the reader', async () => {
    stubFileReader({ event: 'load', result: PNG_URL });
    await expect(readFileAsDataUrl(new Blob(['x']))).resolves.toBe(PNG_URL);
  });

  it('rejects with the reader error', async () => {
    const failure = new DOMException('unreadable', 'NotReadableError');
    stubFileReader({ event: 'error', error: failure });
    await expect(readFileAsDataUrl(new Blob(['x']))).rejects.toBe(failure);
  });

  it('rejects when the reader finishes with a non-string result', async () => {
    stubFileReader({ event: 'load', result: new ArrayBuffer(1) });
    await expect(readFileAsDataUrl(new Blob(['x']))).rejects.toThrow(
      'Unexpected FileReader result',
    );
  });

  it('rejects with a generic error when the reader fails without details', async () => {
    stubFileReader({ event: 'error' });
    await expect(readFileAsDataUrl(new Blob(['x']))).rejects.toThrow('FileReader failed');
  });
});
