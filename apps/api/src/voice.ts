import { ModelError, type CompletionRequest, type FakeReply, type ModelRegistry, type Part } from '@junction26/model';

/**
 * Voice fallback core (docs/voice-fallback.md): an always-listening phone
 * bridge posts utterances; we resolve each one against the tools of the applet
 * open on the user's glasses and push the chosen action to those glasses.
 *
 * Privacy: transcripts and audio are never logged or stored. Callers log only
 * ids, outcomes, tool names, timings and cost.
 */

export interface VoiceToolDecl {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required?: string[] };
}

/** What the glasses publish about the open applet. Same tools as WebMCP. */
export interface VoiceContext {
  projectId: string;
  title: string;
  view: string | null;
  tools: VoiceToolDecl[];
  /** describeState() text: current values the model may need for arguments. */
  state: string;
}

export type Utterance = { kind: 'text'; text: string } | { kind: 'audio'; format: 'wav' | 'mp3'; data: string };

export type Resolution =
  | { outcome: 'command'; tool: string; args: Record<string, unknown>; heard: string }
  | { outcome: 'ignored'; heard: string; reason: string };

export interface VoiceCommandEvent {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  heard: string;
}

/** Contexts older than this are treated as gone (glasses crashed or lost network). */
export const CONTEXT_TTL_MS = 10 * 60 * 1000;
const RESULT_TTL_MS = 2 * 60 * 1000;
const MAX_RESULTS_PER_USER = 200;

interface Glasses {
  context: (VoiceContext & { updatedAt: number }) | null;
  subscribers: Set<(e: VoiceCommandEvent) => void>;
}

/**
 * In-process fan-out between bridge and glasses. Keyed by owner, so one user
 * can never reach another user's glasses. With more than one API instance this
 * becomes Postgres LISTEN/NOTIFY (see the plan).
 */
export class VoiceHub {
  private readonly users = new Map<string, Map<string, Glasses>>();
  private readonly results = new Map<string, Map<string, { at: number; body: unknown }>>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private glasses(userId: string, deviceId: string): Glasses {
    let u = this.users.get(userId);
    if (!u) this.users.set(userId, (u = new Map()));
    let g = u.get(deviceId);
    if (!g) u.set(deviceId, (g = { context: null, subscribers: new Set() }));
    return g;
  }

  private prune(userId: string, deviceId: string) {
    const u = this.users.get(userId);
    const g = u?.get(deviceId);
    if (g && !g.context && !g.subscribers.size) u!.delete(deviceId);
    if (u && !u.size) this.users.delete(userId);
  }

  setContext(userId: string, deviceId: string, context: VoiceContext | null) {
    this.glasses(userId, deviceId).context = context && { ...context, updatedAt: this.now() };
    this.prune(userId, deviceId);
  }

  subscribe(userId: string, deviceId: string, send: (e: VoiceCommandEvent) => void): () => void {
    const g = this.glasses(userId, deviceId);
    g.subscribers.add(send);
    return () => {
      g.subscribers.delete(send);
      this.prune(userId, deviceId);
    };
  }

  /** The listening glasses with the freshest open-applet context, if any. */
  target(userId: string): { deviceId: string; context: VoiceContext } | null {
    let best: { deviceId: string; context: VoiceContext & { updatedAt: number } } | null = null;
    for (const [deviceId, g] of this.users.get(userId) ?? []) {
      if (!g.subscribers.size || !g.context || this.now() - g.context.updatedAt > CONTEXT_TTL_MS) continue;
      if (!best || g.context.updatedAt > best.context.updatedAt) best = { deviceId, context: g.context };
    }
    return best;
  }

  /** Delivers to every open stream of that device; returns how many got it. */
  publish(userId: string, deviceId: string, e: VoiceCommandEvent): number {
    const subs = this.users.get(userId)?.get(deviceId)?.subscribers;
    if (!subs) return 0;
    for (const send of subs) send(e);
    return subs.size;
  }

  /** Retried uploads (same utterance id) get the first answer instead of acting twice. */
  recall(userId: string, id: string): unknown {
    const r = this.results.get(userId)?.get(id);
    return r && this.now() - r.at < RESULT_TTL_MS ? r.body : undefined;
  }

  remember(userId: string, id: string, body: unknown) {
    let m = this.results.get(userId);
    if (!m) this.results.set(userId, (m = new Map()));
    m.set(id, { at: this.now(), body });
    for (const [k, v] of m) if (m.size > MAX_RESULTS_PER_USER || this.now() - v.at > RESULT_TTL_MS) m.delete(k);
  }
}

// ------------------------------------------------------------------ resolver

const IGNORE = 'ignore';
/** Added to every tool so the model returns a transcript with its choice. */
const HEARD = 'heard_text';

const SYSTEM = `You control the applet open on the user's smart glasses by voice.
The microphone is always on, so most speech is conversation with other people, not a request for the applet.
Call exactly one tool for the utterance:
- an applet tool, only if the wearer is clearly asking the applet to do something that tool does;
- "${IGNORE}" otherwise (chatter, questions for other people, unclear or partial speech, noise).
Fill arguments from the utterance and the applet's current values. Never invent tools or values.
Always set "${HEARD}" to a short, faithful transcript of the utterance.`;

export function buildVoiceRequest(model: string, ctx: VoiceContext, utt: Utterance): CompletionRequest {
  const heard = { type: 'string', description: 'Short transcript of what was said.' };
  const tools: { name: string; description: string; parameters: Record<string, unknown> }[] = ctx.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: 'object',
      properties: { ...t.parameters.properties, [HEARD]: heard },
      required: [...(t.parameters.required ?? []), HEARD],
    },
  }));
  tools.push({
    name: IGNORE,
    description: 'The speech is not a request for this applet, or is unclear. Do nothing.',
    parameters: { type: 'object', properties: { [HEARD]: heard, reason: { type: 'string', description: 'Why, in a few words.' } }, required: [HEARD] },
  });
  const header: Part = {
    type: 'text',
    text: `Applet: ${ctx.title}\nPage: ${ctx.view ?? 'menu'}\nCurrent values:\n${ctx.state || '(none)'}\n\nUtterance:`,
  };
  const body: Part = utt.kind === 'text' ? { type: 'text', text: utt.text } : { type: 'audio', format: utt.format, data: utt.data };
  return { model, system: SYSTEM, messages: [{ role: 'user', content: [header, body] }], tools, toolChoice: 'required', maxOutputTokens: 300 };
}

export function parseVoiceResult(ctx: VoiceContext, call: { name: string; arguments: string } | undefined, fallbackHeard: string): Resolution {
  if (!call) return { outcome: 'ignored', heard: fallbackHeard, reason: 'no_tool_call' };
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.arguments || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
  } catch {
    return { outcome: 'ignored', heard: fallbackHeard, reason: 'bad_arguments' };
  }
  const heard = typeof args[HEARD] === 'string' ? (args[HEARD] as string).slice(0, 300) : fallbackHeard;
  delete args[HEARD];
  if (call.name === IGNORE) return { outcome: 'ignored', heard, reason: 'not_for_applet' };
  if (!ctx.tools.some((t) => t.name === call.name)) return { outcome: 'ignored', heard, reason: 'unknown_tool' };
  return { outcome: 'command', tool: call.name, args, heard };
}

export async function resolveUtterance(
  models: ModelRegistry,
  spec: string,
  ctx: VoiceContext,
  utt: Utterance,
  signal?: AbortSignal,
): Promise<{ resolution: Resolution; model: string; costUsd: number | null }> {
  const { provider, spec: s } = models.resolve(spec);
  if (utt.kind === 'audio' && !provider.capabilities(s.model).audio) {
    throw new ModelError('bad_request', `Voice model "${s.id}" doesn't accept audio; send text or change VOICE_MODEL`);
  }
  const req = buildVoiceRequest(s.model, ctx, utt);
  const out = await provider.complete(signal ? { ...req, signal } : req);
  const fallback = utt.kind === 'text' ? utt.text.slice(0, 300) : '';
  return { resolution: parseVoiceResult(ctx, out.toolCalls?.[0], fallback), model: `${out.provider}:${out.model}`, costUsd: out.usage.costUsd };
}

// ------------------------------------------------------- free "fake:voice"

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20 };
const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'my', 'and', 'or', 'by', 'it', 'is', 'in', 'on', 'for', 'this', 'that', 'please', 'open', 'applet', 'with', 'from']);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

/**
 * Deterministic keyword resolver so the whole voice loop runs without credit:
 * picks the tool whose name/description shares the most words with the text
 * and fills number arguments with the first number said. Audio → ignored.
 */
export function fakeVoice(req: CompletionRequest): FakeReply {
  const parts = req.messages.at(-1)?.content ?? [];
  const last = parts.at(-1);
  const call = (name: string, args: Record<string, unknown>) => ({ toolCalls: [{ id: 'fake-1', name, arguments: JSON.stringify(args) }] });
  if (!last || last.type !== 'text') return call(IGNORE, { [HEARD]: '(audio; the fake model only reads text)', reason: 'fake_model' });
  const said = last.text;
  const heardWords = new Set(words(said));
  let best: { name: string; score: number; props: Record<string, { type: string }> } | null = null;
  for (const t of req.tools ?? []) {
    if (t.name === IGNORE) continue;
    const local = t.name.replace(/^[a-z0-9]+_/, '').replace(/_/g, ' ');
    const nameWords = words(local);
    const score = nameWords.filter((w) => heardWords.has(w)).length * 2 + words(t.description.split('(')[0] ?? '').filter((w) => heardWords.has(w)).length;
    const props = ((t.parameters as { properties?: Record<string, { type: string }> }).properties ?? {});
    if (score > 0 && (!best || score > best.score)) best = { name: t.name, score, props };
  }
  if (!best) return call(IGNORE, { [HEARD]: said, reason: 'no_match' });
  const num = /-?\d+(\.\d+)?/.exec(said)?.[0] ?? said.toLowerCase().split(/\W+/).map((w) => NUMBER_WORDS[w]).find((n) => n !== undefined)?.toString();
  const args: Record<string, unknown> = { [HEARD]: said };
  for (const [k, p] of Object.entries(best.props)) {
    if (k === HEARD) continue;
    if ((p.type === 'integer' || p.type === 'number') && num !== undefined) args[k] = Number(num);
  }
  return call(best.name, args);
}
