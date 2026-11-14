/**
 * Pulls one JSON object out of a model reply. Tolerates code fences and prose
 * around it (models do this even in JSON mode). Returns undefined if none parses.
 */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]!);
    } catch {
      /* fall through */
    }
  }
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return undefined;
}
