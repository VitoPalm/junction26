import { FIXTURES, RUNTIME_VERSION, validateDefinition, type AppletDefinition } from '@junction26/applet-format';
import { initialState, migrateState, type AppletState } from '@junction26/applet-runtime';
import { store, type InstalledApplet, type Pairing, type SavedState } from './store.ts';

/**
 * Library network code on the glasses. Runs on explicit actions (pair, sync),
 * never on open, navigation or state changes. Contract: docs/api.md. The one
 * exception is the opt-in voice bridge (voice.ts), which streams while an
 * applet is open and the app is visible.
 */

const API = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const res = await fetch(`${API}${path}`, { ...init, headers });
  if (res.status === 304) return { status: 304, body: undefined as T };
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new HttpError(res.status, body?.error?.code ?? 'http_error', body?.error?.message ?? `HTTP ${res.status}`);
  return { status: res.status, body };
}

export async function pairing(): Promise<Pairing | undefined> {
  return store.meta<Pairing>('pairing');
}

export async function pair(code: string): Promise<Pairing> {
  const { body } = await call<{ token: string; device: { id: string } }>('/v1/devices/pair', {
    method: 'POST',
    body: JSON.stringify({ code, label: 'Meta Ray-Ban Display' }),
  });
  const p: Pairing = { token: body.token, deviceId: body.device.id, pairedAt: new Date().toISOString() };
  await store.putMeta('pairing', p);
  // Demo applets make way for the wearer's own.
  for (const a of await store.applets()) if (a.demo) await store.deleteApplet(a.projectId);
  return p;
}

export async function unpair(): Promise<void> {
  await store.deleteMeta('pairing');
}

/** Bundled examples so the app is useful before pairing (and in the simulator). */
export async function installDemos(): Promise<void> {
  const existing = new Set((await store.applets()).map((a) => a.projectId));
  for (const [key, raw] of Object.entries(FIXTURES)) {
    const id = `demo-${key}`;
    if (existing.has(id)) continue;
    const r = validateDefinition(raw);
    if (!r.ok) continue;
    await store.putApplet({
      projectId: id,
      title: r.definition.title,
      releaseId: null,
      revisionId: null,
      sha256: null,
      definition: r.definition,
      installedAt: new Date().toISOString(),
      lastOpenedAt: null,
      openedSinceSync: false,
      demo: true,
    });
  }
}

/** Latest opened first, then newest installed. */
export async function library(): Promise<InstalledApplet[]> {
  const all = await store.applets();
  return all.sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '') || b.installedAt.localeCompare(a.installedAt));
}

/** State for an applet: saved (migrated to the installed revision) or fresh. */
export async function loadState(a: InstalledApplet): Promise<SavedState> {
  const saved = await store.state(a.projectId);
  const rev = a.revisionId ?? a.projectId;
  if (!saved) return { projectId: a.projectId, state: initialState(a.definition, rev), sequence: 0, dirty: false, serverVersion: 0, conflict: false };
  if (saved.state.revision === rev) return saved;
  return { ...saved, state: migrateState(a.definition, saved.state, rev), dirty: true };
}

export async function saveState(projectId: string, state: AppletState): Promise<void> {
  const prev = await store.state(projectId);
  await store.putState({
    projectId,
    state,
    sequence: (prev?.sequence ?? 0) + 1,
    dirty: true,
    serverVersion: prev?.serverVersion ?? 0,
    conflict: prev?.conflict ?? false,
  });
}

export async function markOpened(a: InstalledApplet): Promise<void> {
  await store.putApplet({ ...a, lastOpenedAt: new Date().toISOString(), openedSinceSync: true });
}

export interface SyncReport {
  installed: number;
  updated: number;
  backedUp: number;
  conflicts: number;
  failed: number;
  message: string;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  if (!crypto.subtle) return null; // insecure dev context; production is HTTPS
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface RemoteProject {
  id: string;
  title: string;
  currentRelease: { id: string; revisionId: string; packageSha256: string } | null;
}

/**
 * Explicit sync: library manifest → download changed packages (verify hash,
 * validate, then activate) → restore state for new installs → back up dirty
 * state → report last-opened times. The previous package stays active until
 * the new one is stored.
 */
export async function sync(): Promise<SyncReport> {
  const p = await pairing();
  if (!p) throw new Error('Not paired');
  const token = p.token;
  const report: SyncReport = { installed: 0, updated: 0, backedUp: 0, conflicts: 0, failed: 0, message: '' };

  const { body } = await call<{ projects: RemoteProject[] }>('/v1/projects', { token });
  const local = new Map((await store.applets()).map((a) => [a.projectId, a]));

  for (const proj of body.projects) {
    const rel = proj.currentRelease;
    if (!rel) continue;
    const have = local.get(proj.id);
    if (have?.releaseId === rel.id) continue;
    try {
      const res = await fetch(`${API}/v1/releases/${rel.id}/package`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`package ${res.status}`);
      const buf = await res.arrayBuffer();
      const hash = await sha256Hex(buf);
      if (hash && hash !== rel.packageSha256) throw new Error('hash mismatch');
      const pkg = JSON.parse(new TextDecoder().decode(buf)) as { definition: unknown; revisionId: string; minimumRuntimeVersion?: string | null };
      if (pkg.minimumRuntimeVersion && newer(pkg.minimumRuntimeVersion, RUNTIME_VERSION)) throw new Error('needs a newer app');
      const v = validateDefinition(pkg.definition);
      if (!v.ok) throw new Error('invalid definition');
      const applet: InstalledApplet = {
        projectId: proj.id,
        title: v.definition.title,
        releaseId: rel.id,
        revisionId: pkg.revisionId,
        sha256: rel.packageSha256,
        definition: v.definition,
        installedAt: have?.installedAt ?? new Date().toISOString(),
        lastOpenedAt: have?.lastOpenedAt ?? null,
        openedSinceSync: have?.openedSinceSync ?? false,
        demo: false,
      };
      if (!have) await restoreState(proj.id, v.definition, pkg.revisionId, token);
      await store.putApplet(applet);
      have ? report.updated++ : report.installed++;
    } catch (e) {
      console.warn('sync: package failed', proj.id, e);
      report.failed++;
    }
  }

  // Back up changed state, batched here rather than per action.
  for (const s of await store.states()) {
    if (!s.dirty || s.projectId.startsWith('demo-')) continue;
    const a = await store.applet(s.projectId);
    if (!a?.revisionId) continue;
    try {
      const { body: out } = await call<{ serverVersion: number }>(`/v1/projects/${s.projectId}/state`, {
        method: 'PUT',
        token,
        body: JSON.stringify({
          operationId: `${p.deviceId}:${s.projectId}:${s.sequence}`,
          sequence: s.sequence,
          revisionId: s.state.revision,
          schemaVersion: 1,
          expectedServerVersion: s.serverVersion,
          snapshot: s.state,
        }),
      });
      // Only clear `dirty` if nothing changed while the request was in flight.
      const latest = await store.state(s.projectId);
      if (latest) await store.putState({ ...latest, dirty: latest.sequence !== s.sequence, serverVersion: out.serverVersion, conflict: false });
      report.backedUp++;
    } catch (e) {
      if (e instanceof HttpError && (e.code === 'state_conflict' || e.code === 'state_stale')) {
        // Keep the local copy; the server kept ours too. No silent overwrite either way.
        const latest = await store.state(s.projectId);
        if (latest) await store.putState({ ...latest, conflict: true });
        report.conflicts++;
      } else report.failed++;
    }
  }

  // Voice notes: how many each page has on the phone, for the "N on phone" hint.
  for (const a of await store.applets()) {
    if (a.demo || !a.definition.views.some((v) => v.voiceNote)) continue;
    try {
      const { body: out } = await call<{ counts: { viewId: string; stepId: string | null; count: number }[] }>(`/v1/notes/counts?projectId=${a.projectId}`, { token });
      const c: Record<string, number> = {};
      for (const r of out.counts) c[r.stepId ? `${r.viewId}/${r.stepId}` : r.viewId] = r.count;
      await store.putMeta(`noteCounts:${a.projectId}`, c);
    } catch {
      /* next sync */
    }
  }

  for (const a of await store.applets()) {
    if (!a.openedSinceSync || a.demo || !a.lastOpenedAt) continue;
    try {
      await call(`/v1/projects/${a.projectId}`, { method: 'PATCH', token, body: JSON.stringify({ lastOpenedAt: a.lastOpenedAt }) });
      await store.putApplet({ ...a, openedSinceSync: false });
    } catch {
      /* next sync */
    }
  }

  const parts = [
    report.installed && `${report.installed} new`,
    report.updated && `${report.updated} updated`,
    report.conflicts && `${report.conflicts} need attention`,
    report.failed && `${report.failed} failed`,
  ].filter(Boolean);
  report.message = parts.length ? parts.join(', ') : 'Up to date';
  return report;
}

async function restoreState(projectId: string, def: AppletDefinition, revisionId: string, token: string) {
  if (await store.state(projectId)) return;
  try {
    const { body } = await call<{ snapshot: AppletState; serverVersion: number; sequence: number }>(`/v1/projects/${projectId}/state`, { token });
    const snap = body.snapshot;
    if (!snap || typeof snap !== 'object' || !('values' in snap)) return;
    await store.putState({
      projectId,
      state: migrateState(def, snap, revisionId),
      sequence: body.sequence,
      dirty: false,
      serverVersion: body.serverVersion,
      conflict: false,
    });
  } catch {
    /* no backup yet: start fresh */
  }
}

function newer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}
