/**
 * Interim structural check for applet definitions.
 *
 * The real validation pipeline (JSON Schema, referential integrity, copy
 * budgets, op type checks, WebMCP names, measured fit) belongs to
 * `packages/applet-format` (milestone M1, see docs/implementation-plan.md).
 * Until that exists, the backend stores definitions as opaque JSON and only
 * enforces what every format version must satisfy, so the persistence,
 * publication and sync paths can be built and tested now.
 *
 * Swap callers to the applet-format validator when it lands; the result shape
 * here (`ok` + issue list with JSON paths) is meant to match it.
 */

export interface DefinitionIssue {
  path: string;
  code: string;
  message: string;
}

export type DefinitionCheck =
  | { ok: true; formatVersion: number; minimumRuntimeVersion: string | null; title: string }
  | { ok: false; issues: DefinitionIssue[] };

export const SUPPORTED_FORMAT_VERSIONS: readonly number[] = [1, 2];

export function checkDefinition(definition: unknown, maxBytes: number): DefinitionCheck {
  const issues: DefinitionIssue[] = [];
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return { ok: false, issues: [{ path: '$', code: 'not_object', message: 'Definition must be a JSON object' }] };
  }
  const bytes = Buffer.byteLength(JSON.stringify(definition));
  if (bytes > maxBytes) {
    issues.push({ path: '$', code: 'too_large', message: `Definition is ${bytes} bytes; the limit is ${maxBytes}` });
  }
  const d = definition as Record<string, unknown>;
  const fv = d.formatVersion;
  if (typeof fv !== 'number' || !Number.isInteger(fv)) {
    issues.push({ path: '$.formatVersion', code: 'required', message: 'formatVersion must be an integer' });
  } else if (!SUPPORTED_FORMAT_VERSIONS.includes(fv)) {
    issues.push({ path: '$.formatVersion', code: 'unsupported', message: `formatVersion ${fv} is not supported` });
  }
  const title = d.title;
  if (typeof title !== 'string' || title.trim() === '') {
    issues.push({ path: '$.title', code: 'required', message: 'title must be a non-empty string' });
  } else if (title.length > 32) {
    issues.push({ path: '$.title', code: 'too_long', message: 'title must be at most 32 characters' });
  }
  const mrv = d.minimumRuntimeVersion;
  if (mrv !== undefined && (typeof mrv !== 'string' || !/^\d+\.\d+\.\d+$/.test(mrv))) {
    issues.push({ path: '$.minimumRuntimeVersion', code: 'invalid', message: 'minimumRuntimeVersion must be a semver string' });
  }
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    formatVersion: fv as number,
    minimumRuntimeVersion: (mrv as string | undefined) ?? null,
    title: title as string,
  };
}
