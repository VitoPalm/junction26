/** Authoring budgets, not claims about what physically fits on the display. */
export const COPY_LIMITS = {
  title: 32,
  label: 28,
  body: 120,
  hint: 48,
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

/** Split copy without dropping words; hosts use these chunks as discrete pages. */
export function paginateText(text: string, limit: number = COPY_LIMITS.body): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Page copy limit must be a positive integer.');
  const pages: string[] = [];
  let remaining = Array.from(text.trim());
  while (remaining.length > limit) {
    let end = limit;
    while (end > 0 && !/\s/u.test(remaining[end])) end--;
    if (!end) end = limit;
    pages.push(remaining.slice(0, end).join('').trim());
    remaining = Array.from(remaining.slice(end).join('').trim());
  }
  if (remaining.length) pages.push(remaining.join(''));
  return pages;
}

export function pageItems<T>(items: readonly T[], page: number, size = 3): readonly T[] {
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(size) || size < 1) throw new Error('Invalid collection page.');
  return items.slice(page * size, (page + 1) * size);
}
