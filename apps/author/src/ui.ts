/** Small presentation helpers shared by the authoring screens. */

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Nov". */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** A stable tile tone (0–5) for a project, so each solution keeps its colour. */
export function toneFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 6;
}

export function initialOf(title: string): string {
  return (title.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '•').toUpperCase();
}

/**
 * Hand-off from the library composer to a freshly created project: the
 * project screen picks this up once, attaches the files and sends the text.
 * Kept in memory only (File objects), so a reload simply drops it.
 */
export interface StartRequest {
  projectId: string;
  text: string;
  files: File[];
}
let pending: StartRequest | null = null;
export function setStartRequest(r: StartRequest) {
  pending = r;
}
export function takeStartRequest(projectId: string): StartRequest | null {
  if (pending?.projectId !== projectId) return null;
  const r = pending;
  pending = null;
  return r;
}

export const FILE_ACCEPT =
  'application/pdf,image/gif,.gif,image/png,image/jpeg,image/webp,text/plain,text/markdown,text/csv,text/html,application/json,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.md,.txt,.csv,.json,.html,.docx';

export const SUGGESTIONS = [
  { text: 'A row counter for crochet', label: 'Crochet row counter' },
  { text: 'Track my D&D character: health, spell slots and inventory', label: 'D&D character sheet' },
  { text: 'A packing checklist for a weekend hike', label: 'Hiking checklist' },
  { text: 'Guide me step by step through making pancakes', label: 'Pancake guide' },
];
