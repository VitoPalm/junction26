import type { AppletDefinition } from '@junction26/applet-format';
import type { AppletState } from '@junction26/applet-runtime';

/**
 * Local persistence on the glasses (IndexedDB). Everything the wearer uses
 * lives here; the network is only for explicit sync. Quota and eviction on the
 * device are unverified (docs/glasses-platform.md), so the cloud backup is the
 * recovery path.
 */

export interface InstalledApplet {
  projectId: string;
  title: string;
  /** Null for bundled demo applets. */
  releaseId: string | null;
  revisionId: string | null;
  sha256: string | null;
  definition: AppletDefinition;
  installedAt: string;
  lastOpenedAt: string | null;
  /** Opened since the last sync (sent with the next sync, never per open). */
  openedSinceSync: boolean;
  demo: boolean;
}

export interface SavedState {
  projectId: string;
  state: AppletState;
  /** Monotonic per device. */
  sequence: number;
  /** Changed since the last accepted backup. */
  dirty: boolean;
  serverVersion: number;
  /** Set when the server refused a backup because another copy is newer. */
  conflict: boolean;
}

export interface Pairing {
  token: string;
  deviceId: string;
  pairedAt: string;
}

const DB = 'junction26-glasses';
const VERSION = 1;

let opening: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('applets')) d.createObjectStore('applets', { keyPath: 'projectId' });
      if (!d.objectStoreNames.contains('state')) d.createObjectStore('state', { keyPath: 'projectId' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(store, mode);
        const r = fn(t.objectStore(store));
        // Resolve on commit, not on request success: a write isn't durable before that.
        t.oncomplete = () => resolve(r ? r.result : (undefined as T));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const store = {
  applets: () => tx<InstalledApplet[]>('applets', 'readonly', (s) => s.getAll()),
  applet: (id: string) => tx<InstalledApplet | undefined>('applets', 'readonly', (s) => s.get(id)),
  putApplet: (a: InstalledApplet) => tx('applets', 'readwrite', (s) => void s.put(a)),
  deleteApplet: (id: string) => tx('applets', 'readwrite', (s) => void s.delete(id)),
  state: (id: string) => tx<SavedState | undefined>('state', 'readonly', (s) => s.get(id)),
  states: () => tx<SavedState[]>('state', 'readonly', (s) => s.getAll()),
  putState: (v: SavedState) => tx('state', 'readwrite', (s) => void s.put(v)),
  meta: <T>(key: string) => tx<T | undefined>('meta', 'readonly', (s) => s.get(key)),
  putMeta: (key: string, value: unknown) => tx('meta', 'readwrite', (s) => void s.put(value, key)),
  deleteMeta: (key: string) => tx('meta', 'readwrite', (s) => void s.delete(key)),
};

/** Ask the browser not to evict our data (best effort; unverified on the glasses). */
export async function requestPersistence(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* optional */
  }
}
