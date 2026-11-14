import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Job, ProjectListItem, Project, Release, Revision, RevisionSummary, Upload, Device, Message } from '@junction26/db';
import { ApiError, badRequest } from './errors.ts';

export const uuid = z.uuid();

export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('The request body must be JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw badRequest(
      'The request body is invalid',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}

export function param(c: Context, name: string): string {
  const v = c.req.param(name);
  if (!v || !uuid.safeParse(v).success) throw new ApiError(404, 'not_found', 'Resource not found');
  return v;
}

/**
 * Reads the Idempotency-Key header. Retrying a request with the same key
 * returns the original result instead of creating a second job.
 */
export function idempotencyKey(c: Context, required: boolean): string | null {
  const key = c.req.header('idempotency-key') ?? null;
  if (key === null) {
    if (required) throw badRequest('Send an Idempotency-Key header (any unique string, e.g. a UUID) so retries are safe');
    return null;
  }
  if (!/^[\x21-\x7e]{8,128}$/.test(key)) throw badRequest('Idempotency-Key must be 8-128 printable ASCII characters');
  return key;
}

/** Fingerprint of a request body, stored with the job to detect key reuse with different content. */
export function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function etagMatches(c: Context, etag: string): boolean {
  const header = c.req.header('if-none-match');
  if (!header) return false;
  return header.split(',').some((t) => t.trim() === etag || t.trim() === `W/${etag}` || t.trim() === '*');
}

// ---------------------------------------------------------------- views
// Public JSON shapes. Internal fields (object keys, lease owners, hashes of
// secrets) never leave the server.

export const projectView = (p: Project | ProjectListItem) => ({
  id: p.id,
  title: p.title,
  currentReleaseId: p.currentReleaseId,
  ...('currentRelease' in p ? { currentRelease: p.currentRelease } : {}),
  lastOpenedAt: p.lastOpenedAt,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

export const uploadView = (u: Upload) => ({
  id: u.id,
  projectId: u.projectId,
  filename: u.filename,
  mediaType: u.mediaType,
  byteSize: u.byteSize,
  sha256: u.sha256,
  status: u.status,
  error: u.error,
  createdAt: u.createdAt,
});

export const jobView = (j: Job) => ({
  id: j.id,
  kind: j.kind,
  projectId: j.projectId,
  status: j.status,
  progress: j.progress,
  result: j.result,
  error: j.error,
  usage: j.usage,
  attempts: j.attempts,
  maxAttempts: j.maxAttempts,
  cancelRequested: j.cancelRequested,
  createdAt: j.createdAt,
  updatedAt: j.updatedAt,
  finishedAt: j.finishedAt,
});

export const revisionSummaryView = (r: RevisionSummary) => ({
  id: r.id,
  projectId: r.projectId,
  number: r.number,
  baseRevisionId: r.baseRevisionId,
  formatVersion: r.formatVersion,
  minimumRuntimeVersion: r.minimumRuntimeVersion,
  validationStatus: r.validationStatus,
  validationIssues: r.validationIssues,
  source: r.source,
  jobId: r.jobId,
  createdAt: r.createdAt,
});

export const revisionView = (r: Revision) => ({ ...revisionSummaryView(r), definition: r.definition });

export const releaseView = (r: Release) => ({
  id: r.id,
  projectId: r.projectId,
  revisionId: r.revisionId,
  baseReleaseId: r.baseReleaseId,
  status: r.status,
  packageSha256: r.packageSha256,
  packageBytes: r.packageBytes,
  minimumRuntimeVersion: r.minimumRuntimeVersion,
  packageUrl: r.status === 'ready' ? `/v1/releases/${r.id}/package` : null,
  error: r.error,
  createdAt: r.createdAt,
  readyAt: r.readyAt,
});

export const deviceView = (d: Device) => ({
  id: d.id,
  label: d.label,
  createdAt: d.createdAt,
  lastSeenAt: d.lastSeenAt,
  revokedAt: d.revokedAt,
});

export const messageView = (m: Message) => ({
  id: m.id,
  role: m.role,
  body: m.body,
  attachmentIds: m.attachmentIds,
  jobId: m.jobId,
  createdAt: m.createdAt,
});
