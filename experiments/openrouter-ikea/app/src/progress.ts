export interface SavedPositions { version: 1; positions: Record<string, string> }
export function readPositions(raw: string | null): SavedPositions {
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null');
    if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1 || !('positions' in parsed)) return { version: 1, positions: {} };
    const positions = parsed.positions;
    if (!positions || typeof positions !== 'object' || Array.isArray(positions)) return { version: 1, positions: {} };
    return { version: 1, positions: Object.fromEntries(Object.entries(positions).filter(([_, value]) => typeof value === 'string')) };
  } catch { return { version: 1, positions: {} }; }
}
export function resumeIndex(ids: readonly string[], savedId: string | undefined) {
  const index = savedId ? ids.indexOf(savedId) : -1;
  return index < 0 ? 0 : index;
}
export function moveIndex(index: number, delta: number, count: number) {
  return Math.max(0, Math.min(Math.max(0, count - 1), index + delta));
}
