/**
 * Backend client. The base URL is the same origin on the web; native shells
 * (Capacitor) use the server chosen at sign-in or VITE_API_BASE. Auth is a
 * pluggable token source: fresh Clerk session JWTs on the web, or dev tokens
 * for local placeholder login. Callers do not manage token refresh.
 */
import { Capacitor } from '@capacitor/core';

const KEY = 'j26.session';

export interface Session {
  /** API origin, '' for same-origin. */
  server: string;
  token: string;
  name: string;
}

export const isNative = Capacitor.isNativePlatform();

export function defaultServer(): string {
  const env = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
  // Native without VITE_API_BASE: a prefill for local dev (the emulator reaches the host
  // API via `adb reverse tcp:8080 tcp:8080`). Release builds set VITE_API_BASE.
  if (!env && isNative) return 'http://localhost:8080';
  return env.replace(/\/$/, '');
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}

/** Dev sign-in: the backend trusts `dev:<name>` only when AUTH_MODE=dev (never in production). */
export function devToken(name: string): string {
  return `dev:${name.trim().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)}`;
}

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createApi(session: Session, getToken: () => Promise<string | null> = async () => session.token) {
  async function req<T>(method: string, path: string, opts: { body?: unknown; raw?: Blob; headers?: Record<string, string> } = {}): Promise<T> {
    const token = await getToken();
    if (!token) throw new ApiError(401, 'unauthenticated', 'Please sign in again.');
    const headers: Record<string, string> = { ...opts.headers, authorization: `Bearer ${token}` };
    let body: BodyInit | undefined;
    if (opts.raw) body = opts.raw;
    else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetch(`${session.server}${path}`, { method, headers, body });
    } catch {
      throw new ApiError(0, 'network', 'Can’t reach the server. Check your connection.');
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'http_error', json?.error?.message ?? `Request failed (${res.status})`, json?.error?.details);
    return json as T;
  }
  const key = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    me: () => req<{ principal: { userId: string } }>('GET', '/v1/me'),
    projects: () => req<{ projects: Project[] }>('GET', '/v1/projects'),
    createProject: (title: string) => req<{ project: Project }>('POST', '/v1/projects', { body: { title } }),
    project: (id: string) => req<{ project: Project }>('GET', `/v1/projects/${id}`),
    messages: (id: string) => req<{ messages: Message[] }>('GET', `/v1/projects/${id}/messages`),
    send: (id: string, text: string, attachmentIds: string[], model?: string) =>
      req<{ message: Message; job: Job }>('POST', `/v1/projects/${id}/messages`, { body: { text, attachmentIds, model }, headers: { 'idempotency-key': key() } }),
    revisions: (id: string) => req<{ revisions: RevisionSummary[] }>('GET', `/v1/projects/${id}/revisions`),
    revision: (id: string, rev: string) => req<{ revision: Revision }>('GET', `/v1/projects/${id}/revisions/${rev}`),
    releases: (id: string) => req<{ releases: Release[] }>('GET', `/v1/projects/${id}/releases`),
    publish: (id: string, revisionId: string, expectedCurrentReleaseId: string | null) =>
      req<{ release: Release; job: Job }>('POST', `/v1/projects/${id}/releases`, { body: { revisionId, expectedCurrentReleaseId }, headers: { 'idempotency-key': key() } }),
    job: (id: string) => req<{ job: Job }>('GET', `/v1/jobs/${id}`),
    cancelJob: (id: string) => req<{ job: Job }>('POST', `/v1/jobs/${id}/cancel`),
    upload: (file: File, projectId: string) =>
      req<{ upload: Upload; job: Job }>('POST', `/v1/uploads?projectId=${projectId}&filename=${encodeURIComponent(file.name)}`, {
        raw: file,
        headers: { 'content-type': guessType(file.name) !== 'application/octet-stream' ? guessType(file.name) : file.type || 'application/octet-stream' },
      }),
    models: () => req<{ default: string; models: ModelOption[] }>('GET', '/v1/authoring/models'),
    pairingCode: () => req<{ code: string; expiresAt: string; pairUrl: string }>('POST', '/v1/devices/pairing-codes'),
    devices: () => req<{ devices: Device[] }>('GET', '/v1/devices'),
    revokeDevice: (id: string) => req<{ device: Device }>('DELETE', `/v1/devices/${id}`),
    nativeRecorderSession: () => req<{ token: string; ownerId: string; expiresAt: string }>('POST', '/v1/notes/recorder/session'),
    stopNativeRecorderSession: () => req<{ ok: true }>('DELETE', '/v1/notes/recorder/session'),
    recorderServer: session.server,
    // Voice notes (docs/voice-notes.md)
    notes: (projectId: string) => req<{ notes: VoiceNote[] }>('GET', `/v1/notes?projectId=${projectId}`),
    editNote: (id: string, transcript: string) => req<{ note: VoiceNote }>('PATCH', `/v1/notes/${id}`, { body: { transcript } }),
    deleteNote: (id: string) => req<{ ok: true }>('DELETE', `/v1/notes/${id}`),
    retranscribe: (id: string) => req<{ note: VoiceNote; jobId: string }>('POST', `/v1/notes/${id}/transcribe`),
    noteRecording: (id: string) => req<{ note: VoiceNote }>('POST', `/v1/notes/${id}/recording`),
    discardNote: (id: string, reason: 'too_short' | 'interrupted' | 'disconnect' | 'phone') => req<{ note: VoiceNote }>('POST', `/v1/notes/${id}/discard`, { body: { reason } }),
    uploadNoteAudio: (id: string, wav: Blob, durationMs: number, endReason: string) =>
      req<{ note: VoiceNote; jobId: string }>('PUT', `/v1/notes/${id}/audio?durationMs=${Math.round(durationMs)}&endReason=${endReason}`, { raw: wav, headers: { 'content-type': 'audio/wav' } }),
    liveCheck: (id: string, wav: Blob) => req<{ stop: boolean; startSeconds: number | null }>('POST', `/v1/notes/${id}/live`, { raw: wav, headers: { 'content-type': 'audio/wav' } }),
    /** Raw fetch for binary/streaming endpoints (audio playback, recorder events). */
    async fetchRaw(path: string, init: RequestInit = {}): Promise<Response> {
      const token = await getToken();
      if (!token) throw new ApiError(401, 'unauthenticated', 'Please sign in again.');
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      const res = await fetch(`${session.server}${path}`, { ...init, headers });
      if (!res.ok) throw new ApiError(res.status, 'http_error', `Request failed (${res.status})`);
      return res;
    },
  };
}
export type Api = ReturnType<typeof createApi>;

function guessType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'csv' ? 'text/csv' : ext === 'json' ? 'application/json' : ext === 'html' || ext === 'htm' ? 'text/html' : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : ext === 'pdf' ? 'application/pdf' : ext === 'md' ? 'text/markdown' : ext === 'txt' ? 'text/plain' : ext === 'gif' ? 'image/gif' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
}

export interface Project {
  id: string;
  title: string;
  currentReleaseId: string | null;
  currentRelease?: { id: string; revisionId: string } | null;
  lastOpenedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  body: string;
  attachmentIds: string[];
  jobId: string | null;
  createdAt: string;
}
export interface Job {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: { stage?: string; model?: string } | null;
  result: any;
  error: { code: string; message: string } | null;
  usage: { costUsd?: number | null; model?: string } | null;
}
export interface RevisionSummary {
  id: string;
  number: number;
  baseRevisionId: string | null;
  validationStatus: 'valid' | 'invalid';
  source: 'client' | 'model';
  createdAt: string;
}
export interface Revision extends RevisionSummary {
  definition: unknown;
}
export interface Release {
  id: string;
  revisionId: string;
  status: 'pending' | 'ready' | 'superseded' | 'failed';
  createdAt: string;
}
export interface Upload {
  id: string;
  filename: string | null;
  mediaType: string;
  status: string;
}
export interface ModelOption {
  id: string;
  label: string;
  provider: string;
  free: boolean;
  default: boolean;
}
export interface Device {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface VoiceNote {
  id: string;
  projectId: string;
  viewId: string;
  stepId: string | null;
  pageLabel: string;
  noteLabel: string | null;
  stateSnapshot: Record<string, unknown> | null;
  status: 'starting' | 'recording' | 'uploaded' | 'transcribing' | 'transcribed' | 'failed' | 'discarded';
  endReason: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  audio: { url: string; mediaType: string; bytes: number; sha256: string } | null;
  transcript: string | null;
  transcriptEdited: boolean;
  transcriptModel: string | null;
  error: { code: string; message: string } | null;
}

/** Polls a job until it settles. */
export async function waitForJob(api: Api, id: string, onUpdate: (j: Job) => void, signal?: AbortSignal): Promise<Job> {
  for (let delay = 700; ; delay = Math.min(delay * 1.3, 2500)) {
    const { job } = await api.job(id);
    onUpdate(job);
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') return job;
    await new Promise((r) => setTimeout(r, delay));
    if (signal?.aborted) return job;
  }
}
