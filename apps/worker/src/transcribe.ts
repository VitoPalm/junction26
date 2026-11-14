import { validateDefinition, type AppletDefinition } from '@junction26/applet-format';
import {
  failVoiceNoteTranscript,
  finishVoiceNoteTranscript,
  getReleaseById,
  getRevision,
  getVoiceNoteById,
  markVoiceNoteTranscribing,
  type VoiceNote,
} from '@junction26/db';
import { createTranscriptionRegistry, ModelError, type CompletionRequest, type FakeReply, type ModelRegistry, type TranscriptionRegistry, type TranscriptionRequest } from '@junction26/model';
import type { Config } from '@junction26/server-common';
import { JobError, type JobHandler, type WorkerDeps } from './types.ts';

/**
 * transcribe_voice_note (docs/voice-notes.md, docs/jobs.md): the final,
 * better transcript of one voice note. Input `{ noteId, sha256 }` names the
 * exact audio; a newer upload makes the job a no-op. Safe to run twice: the
 * transcript is written only for that hash and never over an edit.
 */

const MARK = 'You transcribe a voice note the wearer of smart glasses recorded about one page of a personal applet.';
const STOP_TAIL = /[\s,;:-]*\b(?:stop|stopped|stopping)\s+(?:the\s+)?recording\b[\s,.]*(?:meta|metta|metal|medal|matter|better|media|mehta)?[\s.!?]*$/i;
const MAX_VOCABULARY = 1500;

export const isTranscribeRequest = (req: CompletionRequest) => req.system.startsWith(MARK);

/** Words from the applet the wearer is likely to say (crochet terms, ingredients), as a spelling hint. */
export function vocabulary(def: AppletDefinition | null, note: Pick<VoiceNote, 'pageLabel' | 'noteLabel'>): string {
  return vocabularyList(def, note, MAX_VOCABULARY).join(', ');
}

/** The same hint as a list (for transcription APIs with context biasing). Longest, rarest-looking words first. */
export function vocabularyList(def: AppletDefinition | null, note: Pick<VoiceNote, 'pageLabel' | 'noteLabel'>, maxChars = 1200, maxItems = 100): string[] {
  const words = new Set<string>();
  const add = (s: string | undefined) => {
    if (s) for (const w of s.split(/[^\p{L}\p{N}'’-]+/u)) if (w.length > 2) words.add(w);
  };
  add(note.pageLabel);
  add(note.noteLabel ?? undefined);
  if (def) {
    add(def.title);
    add(def.summary);
    for (const f of def.state) {
      add(f.label);
      if (f.type === 'list') for (const item of f.default) for (const v of Object.values(item)) if (typeof v === 'string') add(v);
    }
    for (const v of def.views) {
      add(v.title);
      if (v.kind === 'text') add(v.text);
      if (v.kind === 'sequence') for (const s of v.steps) [s.title, s.text, s.hint].forEach(add);
    }
  }
  const out: string[] = [];
  let chars = 0;
  for (const w of words) {
    if (out.length >= maxItems || chars + w.length + 2 > maxChars) break;
    out.push(w);
    chars += w.length + 2;
  }
  return out;
}

export function buildTranscribeRequest(model: string, note: VoiceNote, def: AppletDefinition | null, audio: { format: 'wav' | 'mp3'; data: string }): CompletionRequest {
  const context = [
    `Applet: ${def?.title ?? 'unknown'}`,
    `Page: ${note.pageLabel}`,
    note.stateSnapshot ? `Values when recording started: ${JSON.stringify(note.stateSnapshot).slice(0, 600)}` : '',
    `Words that may appear (spelling hints only, they may not be said): ${vocabulary(def, note) || '(none)'}`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    model,
    system: `${MARK}
Write a faithful, verbatim English transcript of what the wearer says. Add punctuation and paragraph breaks; keep their words, including numbers as digits.
Do not summarise, answer, translate, or add anything that was not said. Leave out filler sounds (um, uh).
The recording usually ends with the command "stop recording meta", or a request to Meta such as "Hey Meta, stop the note": leave such commands out.
If nothing intelligible is said, return an empty transcript.
Reply with only the transcript text.`,
    messages: [{ role: 'user', content: [{ type: 'text', text: `${context}\n\nRecording:` }, { type: 'audio', format: audio.format, data: audio.data }] }],
    maxOutputTokens: 4000,
  };
}

/** Clean model output: no quotes/labels around it, and never the stop command at the end. */
export function cleanTranscript(text: string): string {
  let t = text.trim().replace(/^(?:transcript:\s*)/i, '').replace(/^["“](.*)["”]$/s, '$1').trim();
  t = t.replace(STOP_TAIL, '').trim();
  if (/^\(?(?:no (?:intelligible )?speech|silence|inaudible)\)?\.?$/i.test(t)) t = '';
  return t.slice(0, 20_000);
}

/**
 * Free "fake:" transcriber. It can't hear: a WAV whose bytes contain
 * "TRANSCRIPT:<text>" (terminated by a NUL) yields that text; anything else
 * yields a description of the clip.
 */
export function fakeTranscribe(req: CompletionRequest): FakeReply {
  const audio = req.messages.at(-1)?.content.find((p) => p.type === 'audio');
  if (!audio || audio.type !== 'audio') return '';
  const bytes = Buffer.from(audio.data, 'base64');
  const raw = bytes.toString('latin1');
  const at = raw.indexOf('TRANSCRIPT:');
  if (at >= 0) return raw.slice(at + 11, raw.indexOf('\0', at) >= 0 ? raw.indexOf('\0', at) : undefined);
  const seconds = Math.max(0, (bytes.length - 44) / 32_000);
  return `(Fake transcript of ${seconds.toFixed(1)} s of audio.)`;
}

/** Transcription registry from config: Mistral (Voxtral) plus the free fake. */
export function transcriptionRegistryFromConfig(config: Config): TranscriptionRegistry {
  return createTranscriptionRegistry({ openRouter: { apiKey: config.model.apiKey, baseUrl: config.model.baseUrl }, mistral: config.notes.mistral, fake: fakeTranscribeFile });
}

/** `fake:` for the transcription API: same rule as fakeTranscribe, on the raw file bytes. */
export function fakeTranscribeFile(req: TranscriptionRequest): string {
  const out = fakeTranscribe({ model: req.model, system: '', maxOutputTokens: 0, messages: [{ role: 'user', content: [{ type: 'audio', format: 'wav', data: Buffer.from(req.audio.data).toString('base64') }] }] });
  return typeof out === 'string' ? out : (out.text ?? '');
}

async function definitionFor(deps: WorkerDeps, note: VoiceNote): Promise<AppletDefinition | null> {
  if (!note.releaseId) return null;
  const release = await getReleaseById(deps.pool, note.releaseId);
  if (!release || release.projectId !== note.projectId) return null;
  const revision = await getRevision(deps.pool, note.projectId, release.revisionId);
  const parsed = revision ? validateDefinition(revision.definition) : null;
  return parsed?.ok ? parsed.definition : null;
}

export function transcribeVoiceNoteHandler(models: ModelRegistry, transcribers: TranscriptionRegistry = createTranscriptionRegistry({ fake: fakeTranscribeFile })): JobHandler {
  return {
    async run(job, { deps, signal, log }) {
      const noteId = job.input.noteId as string;
      const sha256 = job.input.sha256 as string;
      const note = await getVoiceNoteById(deps.pool, noteId);
      if (!note) return { result: { noteId, status: 'deleted' } };
      if (note.audioSha256 !== sha256 || !note.audioKey) return { result: { noteId, status: 'superseded' } };
      if (note.status === 'transcribed' && note.transcribedSha256 === sha256 && !job.input.force) return { result: { noteId, status: 'transcribed', replayed: true } };
      await markVoiceNoteTranscribing(deps.pool, noteId, sha256);

      const object = await deps.store.get(note.audioKey);
      if (!object) throw new JobError('audio_missing', 'The recording is missing from storage', { retryable: true });
      const chunks: Buffer[] = [];
      for await (const chunk of object.body) {
        signal.throwIfAborted();
        chunks.push(chunk as Buffer);
      }
      const bytes = Buffer.concat(chunks);
      const mediaType = note.audioMediaType === 'audio/mpeg' ? ('audio/mpeg' as const) : ('audio/wav' as const);
      const spec = deps.config.notes.transcribeModel;
      const def = await definitionFor(deps, note);
      const fail = (e: unknown): never => {
        if (e instanceof ModelError) throw new JobError(`model_${e.code}`, e.message, { retryable: e.retryable });
        throw e;
      };

      // Dedicated speech-to-text model (default), else a chat model with audio input.
      const stt = transcribers.resolve(spec);
      if (stt) {
        const r = await stt.provider
          .transcribe({ model: stt.model, audio: { data: bytes, mediaType }, language: note.language, vocabulary: vocabularyList(def, note), signal })
          .catch(fail);
        const transcript = cleanTranscript(r.text);
        const model = `${r.provider}:${r.model}`;
        const saved = await finishVoiceNoteTranscript(deps.pool, noteId, sha256, transcript, model);
        log.info('voice note transcribed', { noteId, saved, chars: transcript.length, model, audioSeconds: r.audioSeconds, costUsd: r.costUsd });
        return { result: { noteId, status: saved ? 'transcribed' : 'superseded', chars: transcript.length }, usage: { model, audioSeconds: r.audioSeconds, costUsd: r.costUsd } };
      }

      const audio = { format: mediaType === 'audio/mpeg' ? ('mp3' as const) : ('wav' as const), data: bytes.toString('base64') };
      const { provider, spec: s } = models.resolve(spec);
      if (!provider.capabilities(s.model).audio) throw new JobError('model_no_audio', `Model "${s.id}" doesn't accept audio; change NOTES_TRANSCRIBE_MODEL`);
      const out = await provider.complete({ ...buildTranscribeRequest(s.model, note, def, audio), signal }).catch(fail);
      if (out.finishReason === 'length') log.warn('voice note transcript truncated', { noteId });
      const transcript = cleanTranscript(out.text);
      const model = `${out.provider}:${out.model}`;
      const saved = await finishVoiceNoteTranscript(deps.pool, noteId, sha256, transcript, model);
      // Never log the transcript itself.
      log.info('voice note transcribed', { noteId, saved, chars: transcript.length, model, costUsd: out.usage.costUsd });
      return { result: { noteId, status: saved ? 'transcribed' : 'superseded', chars: transcript.length }, usage: { ...out.usage, model } };
    },
    async onFailed(job, error, deps) {
      await failVoiceNoteTranscript(deps.pool, job.input.noteId as string, (job.input.sha256 as string | undefined) ?? null, error);
    },
  };
}
