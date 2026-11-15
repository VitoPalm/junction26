import sharp from 'sharp';
import { getUploadById } from '@junction26/db';
import { EXTRACTION_SCHEMA, extractedFor, extractionSystem, normalizeExtraction } from '@junction26/laundry';
import { ModelError, type CompletionRequest, type ModelRegistry } from '@junction26/model';
import { boundedBody, imageSource } from './sources.ts';
import { JobError, type JobHandler } from './types.ts';

/**
 * `extract_care_label` job (docs/laundry.md): reads one garment label photo
 * with LABEL_MODEL (default free `fake:labels`) and returns every care
 * instruction as present / not present / unreadable, all unconfirmed, plus a
 * small thumbnail for the glasses. The original photo stays in storage as the
 * source of every instruction. No side effects besides the job result, so a
 * repeat is harmless.
 */
export function extractCareLabelHandler(models: ModelRegistry): JobHandler {
  return {
    async run(job, { deps, signal }) {
      const uploadId = job.input.uploadId as string;
      const region = job.input.region === 'iso' ? 'iso' : 'us';
      const upload = await getUploadById(deps.pool, uploadId);
      if (!upload || upload.ownerId !== job.ownerId) throw new JobError('upload_missing', 'The label photo is missing');
      if (!upload.mediaType.startsWith('image/')) throw new JobError('not_an_image', 'Upload a photo of the care label');
      const object = await deps.store.get(upload.objectKey);
      if (!object) throw new JobError('object_missing', 'The label photo is missing from storage', { retryable: true });
      const bytes = await boundedBody(object.body);
      signal.throwIfAborted();
      const image = await imageSource(bytes, upload.filename ?? 'label');
      const thumb = await sharp(bytes, { animated: false }).rotate().resize({ width: 96, height: 96, fit: 'cover' }).webp({ quality: 70 }).toBuffer();

      const spec = deps.config.laundry.labelModel;
      let resolved;
      try {
        resolved = models.resolve(spec);
      } catch (e) {
        if (e instanceof ModelError) throw new JobError(`model_${e.code}`, e.message, { retryable: e.retryable });
        throw e;
      }
      const req: CompletionRequest = {
        model: resolved.spec.model,
        system: extractionSystem(region),
        messages: [{ role: 'user', content: [{ type: 'text', text: `Label photo: ${upload.filename ?? 'label'}. Read every care instruction on it.` }, { type: 'image', mediaType: image.mediaType, data: image.data }] }],
        responseSchema: EXTRACTION_SCHEMA,
        maxOutputTokens: 1200,
        signal,
      };
      const out = await resolved.provider.complete(req).catch((e: unknown) => {
        if (e instanceof ModelError) throw new JobError(`model_${e.code}`, e.message, { retryable: e.retryable });
        throw e;
      });
      let raw: unknown = null;
      try {
        raw = JSON.parse(/\{[\s\S]*\}/.exec(out.text)?.[0] ?? 'null');
      } catch {
        raw = null;
      }
      const extraction = normalizeExtraction(raw);
      return {
        result: { uploadId, region, extraction, thumbnail: { mediaType: 'image/webp', data: thumb.toString('base64') } },
        usage: { ...out.usage, model: spec },
      };
    },
  };
}

// ---------------------------------------------------------------- free "fake:labels"

export function isLabelRequest(req: CompletionRequest): boolean {
  return req.responseSchema?.name === 'care_label';
}

/**
 * Deterministic stand-in: the fixture labels are recognized by file name
 * (it can't read pixels). Anything else comes back unreadable, asking for a
 * clearer photo or manual entry.
 */
export function fakeLabels(req: CompletionRequest): string {
  const text = req.messages.flatMap((m) => m.content).map((p) => (p.type === 'text' ? p.text : '')).join(' ');
  const file = /Label photo: ([^\s]+?)\.? Read/.exec(text)?.[1] ?? '';
  const fx = extractedFor(file);
  if (!fx) {
    const unreadable = { status: 'unreadable', value: null, source: 'Not readable in this photo' };
    return JSON.stringify({ wash: unreadable, bleach: unreadable, dry: unreadable, iron: unreadable, professional: unreadable, fibers: null, needsClearerImage: true, note: 'I couldn’t read this label. Try a closer, sharper photo or enter it yourself.' });
  }
  const l = fx.label;
  const f = (k: keyof typeof l) => ({ status: l[k].status, value: l[k].value, source: l[k].source });
  return JSON.stringify({ wash: f('wash'), bleach: f('bleach'), dry: f('dry'), iron: f('iron'), professional: f('professional'), fibers: fx.info.fibers, needsClearerImage: l.wash.status !== 'present', note: l.wash.status === 'unreadable' ? `The washing instruction is unclear: ${l.wash.source}` : '' });
}
