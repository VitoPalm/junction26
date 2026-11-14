import { Button, TextView, TextStyle } from '@wearables-ui-toolkit/mrbd';

/**
 * Voice note component (docs/voice-notes.md). One compact row under the page
 * content: a band-pinchable button plus one line of guidance. Recording itself
 * happens on the phone; this only shows status. Additive display: bright ink,
 * no plates or dimming.
 */
export type VoiceNoteStatus = 'idle' | 'starting' | 'recording' | 'saving' | 'saved' | 'unavailable' | 'error';

export const START_PHRASE = 'Hey Meta, record a note';
export const STOP_PHRASE = 'stop recording meta';

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The guidance line for each status. Short enough for one line at 600 px. */
export function voiceNoteLine(status: VoiceNoteStatus, elapsedMs = 0, message?: string): string {
  switch (status) {
    case 'idle':
      return `Say “${START_PHRASE}”`;
    case 'starting':
      return 'Starting on your phone…';
    case 'recording':
      return `${formatElapsed(elapsedMs)} · say “${STOP_PHRASE}”`;
    case 'saving':
      return 'Saving to your phone…';
    case 'saved':
      return message ?? 'Saved. See it in the phone app.';
    case 'unavailable':
      return message ?? 'Open Applets on your phone first';
    case 'error':
      return message ?? 'The note didn’t save. Try again.';
  }
}

export function VoiceNoteBar({ status, elapsedMs = 0, count = 0, message, onActivate }: {
  status: VoiceNoteStatus;
  elapsedMs?: number;
  /** Notes already on the phone for this page. Old notes are never shown on the glasses. */
  count?: number;
  message?: string;
  /** Pinch: start when idle, stop while recording. Omit for a non-interactive preview. */
  onActivate?: () => void;
}) {
  const live = status === 'recording' || status === 'starting';
  const label = live ? 'Stop note' : 'Record note';
  const subtitle = live ? undefined : count > 0 ? `${count} on phone` : undefined;
  const busy = status === 'saving';
  return <div className="g-voice-note" data-status={status} role="group" aria-label="Voice note">
    <Button title={label} subtitle={subtitle} alwaysShowText disabled={!onActivate || busy} onClick={() => onActivate?.()} />
    <TextView as="p" className="g-voice-note-line" textStyle={TextStyle.BODY2} aria-live="polite">
      {status === 'recording' && <span className="g-rec-dot" aria-label="Recording" />}
      {voiceNoteLine(status, elapsedMs, message)}
    </TextView>
  </div>;
}
