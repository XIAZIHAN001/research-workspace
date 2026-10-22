/**
 * Starts a plain-text download from memory.
 *
 * The same element-and-object-URL dance the backup exporter uses, kept behind one call: the
 * URL has to be revoked after the click, and forgetting that leaks the whole document for the
 * lifetime of the page.
 */
export function downloadTextFile(
  fileName: string,
  text: string,
  mime = 'text/plain;charset=utf-8',
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 30_000);
}
