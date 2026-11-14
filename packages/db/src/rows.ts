/** Converts a snake_case row from `pg` to the camelCase record types below. */
export function camel<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = v;
  return out as T;
}

export function camelRows<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((r) => camel<T>(r));
}

export type JobKind = 'prepare_upload' | 'generate_revision' | 'package_release';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface User {
  id: string;
  externalId: string;
  displayName: string | null;
  preferences: Record<string, unknown>;
  createdAt: Date;
}

export interface Project {
  id: string;
  ownerId: string;
  title: string;
  currentReleaseId: string | null;
  lastOpenedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UploadStatus = 'receiving' | 'stored' | 'ready' | 'rejected' | 'failed';
export interface Upload {
  id: string;
  ownerId: string;
  projectId: string | null;
  objectKey: string;
  filename: string | null;
  mediaType: string;
  byteSize: number | null;
  sha256: string | null;
  status: UploadStatus;
  error: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  projectId: string;
  ownerId: string;
  role: 'user' | 'assistant' | 'system';
  body: string;
  attachmentIds: string[];
  jobId: string | null;
  createdAt: Date;
}

export interface Revision {
  id: string;
  projectId: string;
  number: number;
  baseRevisionId: string | null;
  definition: unknown;
  formatVersion: number;
  minimumRuntimeVersion: string | null;
  validationStatus: 'valid' | 'invalid';
  validationIssues: unknown[];
  source: 'client' | 'model';
  jobId: string | null;
  createdAt: Date;
}
export type RevisionSummary = Omit<Revision, 'definition'>;

export type ReleaseStatus = 'pending' | 'ready' | 'superseded' | 'failed';
export interface Release {
  id: string;
  projectId: string;
  revisionId: string;
  baseReleaseId: string | null;
  status: ReleaseStatus;
  packageKey: string | null;
  packageSha256: string | null;
  packageBytes: number | null;
  minimumRuntimeVersion: string | null;
  error: unknown;
  createdAt: Date;
  readyAt: Date | null;
}

export interface Job {
  id: string;
  ownerId: string;
  projectId: string | null;
  kind: JobKind;
  status: JobStatus;
  input: Record<string, unknown>;
  result: unknown;
  error: JobErrorInfo | null;
  progress: unknown;
  usage: unknown;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  cancelRequested: boolean;
  idempotencyKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface JobErrorInfo {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export interface Device {
  id: string;
  ownerId: string;
  label: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export interface StateBackup {
  id: string;
  projectId: string;
  deviceId: string;
  operationId: string;
  sequence: number;
  revisionId: string | null;
  schemaVersion: number;
  expectedServerVersion: number;
  snapshot: unknown;
  outcome: 'accepted' | 'conflict' | 'stale';
  serverVersion: number | null;
  createdAt: Date;
}
