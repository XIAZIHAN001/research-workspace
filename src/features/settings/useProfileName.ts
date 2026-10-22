import { useCallback, useState } from 'react';
import { PROFILE_NAME_STORAGE_KEY } from '../../app/config';
import { readItem, removeItem, writeItem } from '../../services/storage';

/** What the sidebar shows before the reader has named themselves. */
export const DEFAULT_PROFILE_NAME = '本地工作区';
/** Long enough for a full name, short enough for the sidebar chip. */
export const PROFILE_NAME_MAX = 24;

/** Trimmed and capped. An empty result means "no name stored", never a blank label. */
export function normalizeProfileName(raw: string): string {
  return raw.trim().slice(0, PROFILE_NAME_MAX);
}

export function readProfileName(): string {
  return normalizeProfileName(readItem(PROFILE_NAME_STORAGE_KEY) ?? '') || DEFAULT_PROFILE_NAME;
}

/**
 * The local display name, kept in LocalStorage.
 *
 * It is not an account: nothing leaves the machine, and clearing the key returns the label to
 * its default. The value is written on every accepted change so closing the window without
 * blurring the field does not lose the name.
 */
export function useProfileName(): {
  name: string;
  /** Stores what was typed, trimmed. Empty input clears the key and returns the default. */
  save: (raw: string) => string;
} {
  const [name, setName] = useState(readProfileName);

  const save = useCallback((raw: string): string => {
    const normalized = normalizeProfileName(raw);
    if (normalized === '') {
      removeItem(PROFILE_NAME_STORAGE_KEY);
      setName(DEFAULT_PROFILE_NAME);
      return DEFAULT_PROFILE_NAME;
    }
    writeItem(PROFILE_NAME_STORAGE_KEY, normalized);
    setName(normalized);
    return normalized;
  }, []);

  return { name, save };
}
