import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { ModelError, type ModelRegistry } from '@junction26/model';
import type { AppEnv, Deps } from '../context.ts';
import { requireDevice } from '../auth.ts';
import { ApiError, forbidden } from '../errors.ts';
import { readJson } from '../http.ts';
import { resolveUtterance, type Utterance, type VoiceHub } from '../voice.ts';
import type { NoteHub } from '../notes.ts';

/** About 8 s of 16 kHz mono PCM16 WAV is 256 KB; leave headroom for 8 kHz stereo oddities. */
export const MAX_UTTERANCE_BYTES = 512 * 1024;
const MODEL_DEADLINE_MS = 10_000;
const HEARTBEAT_MS = 25_000;

const ToolDecl = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  description: z.string().max(1024),
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(z.string().regex(/^[A-Za-z0-9_]{1,64}$/), z.object({ type: z.string().max(16), description: z.string().max(256).optional() })),
    required: z.array(z.string()).max(32).optional(),
  }),
});

const ContextBody = z.object({
  projectId: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  view: z.string().max(128).nullable(),
  tools: z.array(ToolDecl).min(1).max(64),
  state: z.string().max(8000),
});

const TextUtterance = z.object({ id: z.string().regex(/^[\w-]{8,64}$/).optional(), text: z.string().trim().min(1).max(500) });

/** Routes under /v1/voice. Contract: docs/api.md, "Voice bridge". */
export function voiceRoutes(deps: Deps, hub: VoiceHub, models: ModelRegistry, notes?: NoteHub) {
  const app = new Hono<AppEnv>();

  /** Glasses: what is open now. Replaces the previous context; DELETE when the applet closes. */
  app.put('/context', async (c) => {
    const p = c.get('principal');
    requireDevice(p);
    const body = await readJson(c, ContextBody);
    hub.setContext(p.userId, p.deviceId, body);
    return c.json({ ok: true });
  });

  app.delete('/context', (c) => {
    const p = c.get('principal');
    requireDevice(p);
    hub.setContext(p.userId, p.deviceId, null);
    return c.json({ ok: true });
  });

  /** Glasses: server-sent `command` events. Close it when the app is hidden. */
  app.get('/events', (c) => {
    const p = c.get('principal');
    requireDevice(p);
    return streamSSE(c, async (stream) => {
      const queue: string[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = hub.subscribe(p.userId, p.deviceId, (e) => {
        queue.push(JSON.stringify(e));
        wake?.();
      });
      let open = true;
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      try {
        await stream.writeSSE({ event: 'ready', data: '{}' });
        while (open) {
          while (queue.length) await stream.writeSSE({ event: 'command', data: queue.shift()! });
          let timer: NodeJS.Timeout | undefined;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, HEARTBEAT_MS);
          });
          clearTimeout(timer);
          wake = null;
          if (open && !queue.length) await stream.write(': keepalive\n\n');
        }
      } finally {
        unsubscribe();
      }
    });
  });

  /**
   * Bridge (phone app, or a script): one utterance as `audio/wav` (or
   * `audio/mpeg`) bytes, or JSON `{ text }`. Optional `X-Utterance-Id` /
   * `id` makes retries safe. Answers once the action was delivered or dropped.
   */
  app.post('/utterances', async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'user' && p.kind !== 'device') throw forbidden('Voice needs a user or device session');
    const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    let utt: Utterance;
    let id = c.req.header('x-utterance-id');
    if (type === 'audio/wav' || type === 'audio/x-wav' || type === 'audio/wave' || type === 'audio/mpeg') {
      const length = Number(c.req.header('content-length') ?? '0');
      if (length > MAX_UTTERANCE_BYTES) throw new ApiError(413, 'payload_too_large', `Utterances are limited to ${MAX_UTTERANCE_BYTES} bytes`);
      const bytes = Buffer.from(await c.req.arrayBuffer());
      if (!bytes.length) throw new ApiError(400, 'invalid_request', 'The audio body is empty');
      if (bytes.length > MAX_UTTERANCE_BYTES) throw new ApiError(413, 'payload_too_large', `Utterances are limited to ${MAX_UTTERANCE_BYTES} bytes`);
      utt = { kind: 'audio', format: type === 'audio/mpeg' ? 'mp3' : 'wav', data: bytes.toString('base64') };
    } else if (type === 'application/json') {
      const body = await readJson(c, TextUtterance);
      utt = { kind: 'text', text: body.text };
      id ??= body.id;
    } else {
      throw new ApiError(415, 'unsupported_media_type', 'Send audio/wav, audio/mpeg or application/json { text }');
    }
    if (id !== undefined && !/^[\w-]{8,64}$/.test(id)) throw new ApiError(400, 'invalid_request', 'X-Utterance-Id must be 8-64 letters, digits, _ or -');
    id ??= randomUUID();

    const again = hub.recall(p.userId, id);
    if (again) return c.json(again);

    const log = c.get('log').child({ utteranceId: id, input: utt.kind });
    const started = performance.now();
    // Dictating a voice note must never trigger applet actions.
    if (notes?.isRecording(p.userId)) {
      const body = { id, outcome: 'paused' as const, reason: 'note_recording' };
      log.info('voice utterance', { outcome: body.outcome });
      return c.json(body);
    }
    // Don't pay for a model call nobody can act on.
    const target = hub.target(p.userId);
    if (!target) {
      const body = { id, outcome: 'no_glasses' as const };
      log.info('voice utterance', { outcome: body.outcome });
      return c.json(body);
    }

    let result;
    try {
      result = await resolveUtterance(models, deps.config.voice.model, target.context, utt, AbortSignal.timeout(MODEL_DEADLINE_MS));
    } catch (err) {
      const code = err instanceof ModelError ? err.code : 'timeout';
      log.warn('voice model failed', { code, ms: Math.round(performance.now() - started) });
      if (err instanceof ModelError && err.code === 'bad_request') throw new ApiError(422, 'voice_unsupported_input', err.message);
      throw new ApiError(503, 'voice_model_unavailable', 'The voice model could not answer in time. Try again.');
    }
    const { resolution: r } = result;
    let body;
    if (r.outcome === 'command') {
      // The glasses may have moved on while the model ran: only deliver to the same applet.
      const now = hub.target(p.userId);
      const delivered = now && now.deviceId === target.deviceId && now.context.projectId === target.context.projectId
        ? hub.publish(p.userId, target.deviceId, { id, tool: r.tool, args: r.args, heard: r.heard })
        : 0;
      body = delivered ? { id, outcome: 'command' as const, tool: r.tool, args: r.args, heard: r.heard } : { id, outcome: 'undelivered' as const, heard: r.heard };
    } else {
      body = { id, outcome: 'ignored' as const, reason: r.reason, heard: r.heard };
    }
    hub.remember(p.userId, id, body);
    // Never log `heard` or audio: ids, outcome, tool and cost only.
    log.info('voice utterance', {
      outcome: body.outcome,
      tool: r.outcome === 'command' ? r.tool : undefined,
      reason: r.outcome === 'ignored' ? r.reason : undefined,
      model: result.model,
      costUsd: result.costUsd,
      ms: Math.round(performance.now() - started),
    });
    return c.json(body);
  });

  return app;
}
