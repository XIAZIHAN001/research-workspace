import { AVATAR_ACCEPTED_TYPES, AVATAR_MAX_BYTES, AVATAR_STORAGE_KEY } from '../app/config';
import { readItem, removeItem, writeItem } from './storage';

export type AvatarProblem = 'type' | 'size' | 'empty' | 'read' | 'save';

const STORED_AVATAR = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

export function checkAvatarFile(file: Pick<File, 'type' | 'size'>): AvatarProblem | null {
  if (!AVATAR_ACCEPTED_TYPES.has(file.type)) return 'type';
  // A 0-byte file would save as "data:...;base64," which loadAvatar refuses to read back.
  if (file.size === 0) return 'empty';
  if (file.size > AVATAR_MAX_BYTES) return 'size';
  return null;
}

export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Unexpected FileReader result'));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('FileReader failed'));
    };
    reader.readAsDataURL(file);
  });
}

/** Only accepts what we wrote ourselves; anything else in the slot is ignored. */
export function loadAvatar(): string | null {
  const stored = readItem(AVATAR_STORAGE_KEY);
  return stored !== null && STORED_AVATAR.test(stored) ? stored : null;
}

export function saveAvatar(dataUrl: string): boolean {
  return writeItem(AVATAR_STORAGE_KEY, dataUrl);
}

export function clearAvatar(): void {
  removeItem(AVATAR_STORAGE_KEY);
}
