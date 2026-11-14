/** Authoring budgets, not claims about what physically fits on the display. */
export const COPY_LIMITS = {
  title: 32,
  label: 28,
  body: 180,
  hint: 72,
  value: 12,
  actions: 2,
  items: 20,
} as const;

export interface ContentIssue { path: string; message: string }

export function checkCopy(path: string, text: string, limit: number): ContentIssue[] {
  const count = Array.from(text).length;
  if (!text.trim()) return [{ path, message: 'Provide non-empty text.' }];
  return count > limit
    ? [{ path, message: `Use at most ${limit} characters; received ${count}. Split this content into another screen.` }]
    : [];
}

export function checkIds(items: readonly { id: string }[]): ContentIssue[] {
  const seen = new Set<string>();
  return items.flatMap(({ id }, index) => {
    const invalid = !id.trim() || seen.has(id);
    seen.add(id);
    return invalid ? [{ path: `items[${index}].id`, message: 'Use a non-empty, unique, stable ID.' }] : [];
  });
}

export function assertContent(issues: readonly ContentIssue[]): void {
  if (issues.length) throw new Error(issues.map(i => `${i.path}: ${i.message}`).join('\n'));
}
