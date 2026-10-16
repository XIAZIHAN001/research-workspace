/**
 * Random identifier for projects and papers. `randomUUID` needs a secure context,
 * which both Vite's localhost server and Tauri's http://tauri.localhost origin are.
 */
export function makeId(): string {
  return crypto.randomUUID();
}
