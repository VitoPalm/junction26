import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Api } from './api.ts';
import type { LiveMode, RecorderState } from './recorder.ts';

interface NativeBridge {
  start(options: { server: string; token: string; expiresAt: string; ownerId: string; liveMode: LiveMode }): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<RecorderState>;
  setMode(options: { liveMode: LiveMode }): Promise<void>;
  flush(): Promise<void>;
  addListener(name: 'state', cb: (state: RecorderState) => void): Promise<PluginListenerHandle>;
}
const bridge = registerPlugin<NativeBridge>('NoteRecorder');

/** Native owns SSE, audio, detection, disk queue and uploads while the web view is suspended. */
export class NativeNoteRecorder {
  state: RecorderState = { phase: 'off', connected: false, liveMode: 'auto', detector: null, note: null, message: null, pending: 0, lastSaved: null, micLabel: null };
  private listeners = new Set<(s: RecorderState) => void>();
  private api: Api;
  constructor(api: Api) {
    this.api = api;
    void bridge.addListener('state', s => this.set(s));
    void bridge.status().then(s => this.set(s)).catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void bridge.status().then(s => this.set(s)).catch(() => {});
    });
  }
  private set(s: RecorderState) { this.state = s; for (const fn of this.listeners) fn(s); }
  subscribe(fn: (s: RecorderState) => void) { this.listeners.add(fn); fn(this.state); return () => { this.listeners.delete(fn); }; }
  setLiveMode(liveMode: LiveMode) {
    this.set({ ...this.state, liveMode });
    void bridge.setMode({ liveMode }).catch(e => this.set({ ...this.state, message: e.message }));
  }
  async turnOn() {
    this.set({ ...this.state, phase: 'arming', message: null });
    try {
      const session = await this.api.nativeRecorderSession();
      await bridge.start({ server: this.api.recorderServer, ...session, liveMode: this.state.liveMode });
      this.set(await bridge.status());
    } catch (e) { this.set({ ...this.state, phase: 'error', message: (e as Error).message }); }
  }
  async turnOff() {
    await bridge.stop();
    await this.api.stopNativeRecorderSession().catch(() => {});
    this.set(await bridge.status());
  }
  async flush() { await bridge.flush(); }
}
