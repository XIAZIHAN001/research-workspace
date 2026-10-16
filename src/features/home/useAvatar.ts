import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_AVATAR_SRC } from '../../app/config';
import {
  checkAvatarFile,
  clearAvatar,
  loadAvatar,
  readFileAsDataUrl,
  saveAvatar,
  type AvatarProblem,
} from '../../services/avatar';

export const AVATAR_PROBLEM_TEXT: Record<AvatarProblem, string> = {
  type: '请选择 PNG、JPEG、WebP 或 SVG 图片。',
  size: '图片不能超过 1 MB。',
  empty: '图片是空的，请换一张。',
  read: '读取图片失败，请重试。',
  save: '浏览器存储空间不足，新形象没有保存。',
};

/** How long an upload problem stays on screen before it goes away on its own. */
export const AVATAR_NOTICE_MS = 8000;

/** `id` makes two identical problems in a row two notices, so each gets its full time. */
interface Notice {
  problem: AvatarProblem;
  id: number;
}

/** The user's figure: a stored custom image, or the bundled default. */
export function useAvatar() {
  const [custom, setCustom] = useState<string | null>(loadAvatar);
  const [notice, setNotice] = useState<Notice | null>(null);
  const lastId = useRef(0);

  const report = useCallback((problem: AvatarProblem) => {
    lastId.current += 1;
    setNotice({ problem, id: lastId.current });
  }, []);

  const dismiss = useCallback(() => {
    setNotice(null);
  }, []);

  // A problem is a passing message, not state to keep: it fades after a while.
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, AVATAR_NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  const upload = useCallback(
    async (file: File) => {
      const invalid = checkAvatarFile(file);
      if (invalid !== null) {
        report(invalid);
        return;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        if (!saveAvatar(dataUrl)) {
          report('save');
          return;
        }
        setCustom(dataUrl);
        setNotice(null);
      } catch {
        report('read');
      }
    },
    [report],
  );

  const reset = useCallback(() => {
    clearAvatar();
    setCustom(null);
    setNotice(null);
  }, []);

  return {
    src: custom ?? DEFAULT_AVATAR_SRC,
    isCustom: custom !== null,
    problem: notice?.problem ?? null,
    upload,
    reset,
    dismiss,
  };
}
