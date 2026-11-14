import type { Readable } from 'node:stream';
import {
  AuthoringResponse,
  authoringResponseJsonSchema,
  FIXTURES,
  repairPrompt,
  systemPrompt,
  validateDefinition,
  type Issue,
} from '@junction26/applet-format';
import {
  createMessage,
  createRevision,
  getProject,
  getProjectById,
  getRevision,
  getUploadsByIds,
  listMessages,
  listRevisions,
  updateProject,
  withTransaction,
  type Upload,
} from '@junction26/db';
import {
  addUsage,
  createModelRegistry,
  extractJson,
  ModelError,
  ZERO_USAGE,
  type ChatMessage,
  type CompletionRequest,
  type ModelRegistry,
  type Part,
  type Usage,
} from '@junction26/model';
import type { Config } from '@junction26/server-common';
import { JobError, type JobHandler } from './types.ts';

/** Attachment budgets per generation (bytes). Keep requests small and cheap. */
const MAX_TEXT_ATTACHMENT = 200 * 1024;
const MAX_BINARY_ATTACHMENT = 12 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 12;
export const DEFAULT_PROJECT_TITLE = 'New applet';

export function modelRegistryFromConfig(config: Config): ModelRegistry {
  return createModelRegistry({
    openRouter: { apiKey: config.model.apiKey, baseUrl: config.model.baseUrl },
    openAI: config.model.openAI,
    fake: fakeAuthor,
  });
}

/**
 * The free "fake:" provider. Picks a fixture by keyword so the whole
 * author → preview → publish → glasses loop works without spending credit.
 */
export function fakeAuthor(req: CompletionRequest): string {
  const last = req.messages.at(-1)?.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ') ?? '';
  const ask = (/User request:\n([\s\S]*)$/.exec(last)?.[1] ?? last).toLowerCase();
  const pick =
    /d&d|dnd|character|health|hp|spell|inventory/.test(ask) ? FIXTURES.characterSheet
    : /pack|checklist|list|todo|to-do/.test(ask) ? FIXTURES.packingList
    : /recipe|pancake|cook|guide|step/.test(ask) ? FIXTURES.pancakeGuide
    : FIXTURES.rowCounter;
  return JSON.stringify({ reply: `Here's a “${pick.title}” applet (demo model, no AI involved).`, definition: pick });
}

async function readBody(body: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    size += (c as Buffer).length;
    if (size > limit) {
      body.destroy();
      throw new JobError('attachment_too_large', 'An attachment is too large for authoring');
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * generate_revision: thread + attachments + current definition → model →
 * validated candidate revision + assistant reply. Safe to run twice: if this
 * job already saved its revision/reply, it returns them without calling the
 * model again.
 */
export function generateRevisionHandler(models: ModelRegistry): JobHandler {
  return {
    async run(job, { deps, signal, progress, log }) {
      const { pool, store, config } = deps;
      const projectId = job.input.projectId as string;
      const messageId = job.input.messageId as string | undefined;

      // Repeat run after a crash: the result is already saved.
      const done = await pool.query<{ id: string; number: number }>('SELECT id, number FROM revisions WHERE job_id = $1', [job.id]);
      const doneReply = await pool.query<{ id: string }>(`SELECT id FROM messages WHERE job_id = $1 AND role = 'assistant'`, [job.id]);
      if (doneReply.rows[0]) {
        return { result: { revisionId: done.rows[0]?.id ?? null, revisionNumber: done.rows[0]?.number ?? null, messageId: doneReply.rows[0].id, repeated: true } };
      }

      const project = await getProject(pool, job.ownerId, projectId);
      if (!project) throw new JobError('project_missing', 'The project no longer exists');
      const thread = await listMessages(pool, job.ownerId, projectId);
      const current = thread.find((m) => m.id === messageId) ?? thread.filter((m) => m.role === 'user').at(-1);
      if (!current) throw new JobError('message_missing', 'The message to answer no longer exists');

      // Base: the explicitly chosen revision, else the latest valid one (so chat edits iterate).
      let baseRevisionId = (job.input.baseRevisionId as string | null) ?? null;
      if (!baseRevisionId) baseRevisionId = (await listRevisions(pool, projectId)).find((r) => r.validationStatus === 'valid')?.id ?? null;
      const base = baseRevisionId ? await getRevision(pool, projectId, baseRevisionId) : null;

      const specString = (job.input.model as string | undefined) ?? config.model.model;
      if (!config.model.allowed.includes(specString)) throw new JobError('model_not_allowed', `Model ${specString} is not enabled`);
      let resolved;
      try {
        resolved = models.resolve(specString);
      } catch (e) {
        throw new JobError('model_not_configured', (e as Error).message);
      }
      const { provider, spec } = resolved;
      const caps = provider.capabilities(spec.model);

      await progress({ stage: 'preparing' });
      const attachments = await getUploadsByIds(pool, job.ownerId, current.attachmentIds);
      const parts: Part[] = [];
      const skipped: string[] = [];
      for (const u of attachments) {
        signal.throwIfAborted();
        const part = await attachmentPart(u, store, caps);
        if (part) parts.push(part);
        else skipped.push(u.filename ?? u.id);
      }

      // History (oldest first), then the current request with context.
      const history: ChatMessage[] = thread
        .filter((m) => m.id !== current.id && m.createdAt <= current.createdAt && m.role !== 'system')
        .slice(-MAX_HISTORY_MESSAGES)
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: [{ type: 'text', text: m.body }] }));
      const context = base
        ? `Current applet definition (revise it; keep ids of anything that stays):\n${JSON.stringify(base.definition)}`
        : 'There is no applet yet; create one.';
      const note = skipped.length ? `\n(Attachments this model can't read were skipped: ${skipped.join(', ')}.)` : '';
      const messages: ChatMessage[] = [
        ...history,
        { role: 'user', content: [{ type: 'text', text: `${context}${note}\n\nUser request:\n${current.body}` }, ...parts] },
      ];

      const request = (msgs: ChatMessage[]): CompletionRequest => ({
        model: spec.model,
        system: systemPrompt(),
        messages: msgs,
        responseSchema: caps.structuredOutput ? { name: 'applet_authoring', schema: authoringResponseJsonSchema() } : undefined,
        maxOutputTokens: config.limits.maxOutputTokens,
        reasoningEffort: config.model.reasoningEffort,
        signal,
      });

      let usage: Usage = ZERO_USAGE;
      const call = async (msgs: ChatMessage[]) => {
        try {
          const r = await provider.complete(request(msgs));
          usage = addUsage(usage, r.usage);
          if (r.finishReason === 'length') throw new JobError('output_truncated', 'The model ran out of room before finishing. Try a smaller request.');
          return r.text;
        } catch (e) {
          if (e instanceof ModelError) throw new JobError(`model_${e.code}`, e.message, { retryable: e.retryable });
          throw e;
        }
      };

      await progress({ stage: 'generating', model: spec.id });
      let text = await call(messages);
      let outcome = interpret(text);
      if (!outcome.ok) {
        // One bounded repair attempt with the exact issues.
        log.info('generation invalid, repairing', { issues: outcome.issues.length });
        await progress({ stage: 'repairing', model: spec.id });
        text = await call([...messages, { role: 'assistant', content: [{ type: 'text', text }] }, { role: 'user', content: [{ type: 'text', text: repairPrompt(outcome.issues) }] }]);
        outcome = interpret(text);
      }
      const usageRecord = { ...usage, model: spec.id };
      if (!outcome.ok) {
        log.warn('generation invalid after repair', { issues: outcome.issues.length, usage: usageRecord });
        throw new JobError('invalid_output', "The assistant couldn't produce a valid applet. Try rephrasing or asking for something smaller.", {
          details: { issues: outcome.issues.slice(0, 20), usage: usageRecord },
        });
      }

      const { reply, definition } = outcome;
      const saved = await withTransaction(pool, async (tx) => {
        const locked = await getProjectById(tx, projectId, { forUpdate: true });
        if (!locked) throw new JobError('project_missing', 'The project no longer exists');
        const revision = definition
          ? await createRevision(tx, {
              projectId,
              baseRevisionId: base?.id ?? null,
              definition,
              formatVersion: definition.formatVersion,
              minimumRuntimeVersion: definition.minimumRuntimeVersion,
              validationStatus: 'valid',
              validationIssues: [],
              source: 'model',
              jobId: job.id,
            })
          : null;
        const message = await createMessage(tx, { projectId, ownerId: job.ownerId, role: 'assistant', body: reply, attachmentIds: [], jobId: job.id });
        // Name the project after its first applet.
        if (definition && locked.title === DEFAULT_PROJECT_TITLE) await updateProject(tx, job.ownerId, projectId, { title: definition.title });
        return { revision, message };
      });
      log.info('generation saved', { projectId, revisionId: saved.revision?.id, usage: usageRecord });
      return {
        result: { revisionId: saved.revision?.id ?? null, revisionNumber: saved.revision?.number ?? null, messageId: saved.message.id },
        usage: usageRecord,
      };
    },
    async onFailed(job, error, deps) {
      // Tell the user in the thread, in plain words. Never include raw model output.
      const projectId = job.input.projectId as string;
      const exists = await deps.pool.query(`SELECT 1 FROM messages WHERE job_id = $1 AND role = 'assistant'`, [job.id]);
      if (exists.rowCount || !(await getProject(deps.pool, job.ownerId, projectId))) return;
      await createMessage(deps.pool, {
        projectId,
        ownerId: job.ownerId,
        role: 'assistant',
        body: friendlyFailure(error.code, error.message),
        attachmentIds: [],
        jobId: job.id,
      });
    },
  };
}

type Interpreted = { ok: true; reply: string; definition: ReturnType<typeof validOrNull> } | { ok: false; issues: Issue[] };

function validOrNull(def: unknown) {
  const r = validateDefinition(def);
  return r.ok ? r.definition : null;
}

function interpret(text: string): Interpreted {
  const json = extractJson(text);
  const env = AuthoringResponse.safeParse(json);
  if (!env.success) return { ok: false, issues: [{ path: '$', code: 'envelope', message: 'Return a JSON object {"reply": string, "definition": object | null}' }] };
  if (env.data.definition === null) return { ok: true, reply: env.data.reply, definition: null };
  const r = validateDefinition(env.data.definition);
  if (!r.ok) return { ok: false, issues: r.issues.map((i) => ({ ...i, path: `definition.${i.path}` })) };
  return { ok: true, reply: env.data.reply, definition: r.definition };
}

async function attachmentPart(
  u: Upload,
  store: { get(key: string): Promise<{ body: Readable } | null> },
  caps: { images: boolean; files: boolean },
): Promise<Part | null> {
  if (u.status !== 'ready' && u.status !== 'stored') return null;
  const isText = u.mediaType === 'text/plain' || u.mediaType === 'text/markdown';
  const isImage = u.mediaType.startsWith('image/');
  const isPdf = u.mediaType === 'application/pdf';
  if ((isImage && !caps.images) || (isPdf && !caps.files) || (!isText && !isImage && !isPdf)) return null;
  const obj = await store.get(u.objectKey);
  if (!obj) throw new JobError('object_missing', 'An attachment is missing from storage', { retryable: true });
  const bytes = await readBody(obj.body, isText ? MAX_TEXT_ATTACHMENT : MAX_BINARY_ATTACHMENT);
  const name = u.filename ?? 'attachment';
  if (isText) return { type: 'text', text: `Attached file "${name}":\n${bytes.toString('utf8')}` };
  if (isImage) return { type: 'image', mediaType: u.mediaType, data: bytes.toString('base64') };
  return { type: 'file', mediaType: u.mediaType, filename: name, data: bytes.toString('base64') };
}

function friendlyFailure(code: string, message: string): string {
  switch (code) {
    case 'model_insufficient_credits':
      return 'Sorry, the authoring budget is used up right now, so I could not build this. Nothing was changed.';
    case 'model_rate_limited':
    case 'model_unavailable':
    case 'model_timeout':
      return 'The AI service is busy or unreachable right now. Please try again in a minute. Nothing was changed.';
    case 'model_not_configured':
    case 'model_auth':
      return 'Authoring isn’t set up on this server yet (no working model key). Nothing was changed.';
    case 'cancelled':
      return 'Stopped. Nothing was changed.';
    default:
      return `I couldn't finish this: ${message} Nothing was changed.`;
  }
}
