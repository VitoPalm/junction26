import { createHash } from 'node:crypto';
import {
  finishRelease,
  getProjectById,
  getReleaseById,
  getRevision,
  getUploadById,
  lockRelease,
  setProjectCurrentRelease,
  setUploadStatus,
  withTransaction,
  type Release,
  type Revision,
} from '@junction26/db';
import { objectKeys } from '@junction26/storage';
import { JobError, type HandlerRegistry, type JobHandler } from './types.ts';

// ---------------------------------------------------------------- prepare_upload

/**
 * Confirms the stored object matches what the API recorded and marks the
 * upload ready for authoring. Milestone M4 adds real preparation here (render
 * PDF pages, extract text, crop diagrams; see docs/implementation-plan.md).
 */
export const prepareUpload: JobHandler = {
  async run(job, { deps }) {
    const uploadId = job.input.uploadId as string;
    const upload = await getUploadById(deps.pool, uploadId);
    if (!upload) throw new JobError('upload_missing', 'The upload record no longer exists');
    if (upload.status === 'ready') return { result: { uploadId, status: 'ready' } };
    if (upload.status !== 'stored') throw new JobError('upload_not_stored', `Upload is ${upload.status}`);
    const head = await deps.store.head(upload.objectKey);
    if (!head) throw new JobError('object_missing', 'The uploaded file is missing from storage', { retryable: true });
    if (head.contentLength !== upload.byteSize) {
      throw new JobError('size_mismatch', 'The stored file size does not match the upload', {
        details: { stored: head.contentLength, recorded: upload.byteSize },
      });
    }
    await setUploadStatus(deps.pool, uploadId, 'ready');
    return { result: { uploadId, status: 'ready' } };
  },
  async onFailed(job, error, deps) {
    await setUploadStatus(deps.pool, job.input.uploadId as string, 'failed', { code: error.code });
  },
};

// ---------------------------------------------------------------- package_release

export const PACKAGE_FORMAT = 1;

/**
 * The immutable release package served to the glasses. Deterministic for a
 * given release, so a retried job writes byte-identical content to the same
 * key. Format documented in docs/jobs.md ("Release package").
 */
export function buildPackage(release: Release, revision: Revision): Buffer {
  const pkg = {
    packageFormat: PACKAGE_FORMAT,
    releaseId: release.id,
    projectId: release.projectId,
    revisionId: revision.id,
    revisionNumber: revision.number,
    formatVersion: revision.formatVersion,
    minimumRuntimeVersion: revision.minimumRuntimeVersion,
    publishedAt: release.createdAt.toISOString(),
    definition: revision.definition,
    // Applet-specific assets, inlined by content hash. Populated once M4
    // produces assets; shared fonts/icons ship with the glasses app instead.
    assets: {},
  };
  return Buffer.from(JSON.stringify(pkg));
}

/**
 * Builds and uploads the package, then (in one transaction) marks the release
 * ready and advances the project's pointer, but only if the project still
 * points at the release this publish expected to replace. Otherwise the
 * release is `superseded` and the pointer is untouched.
 */
export const packageRelease: JobHandler = {
  async run(job, { deps, signal, log }) {
    const releaseId = job.input.releaseId as string;
    const release = await getReleaseById(deps.pool, releaseId);
    if (!release) throw new JobError('release_missing', 'The release no longer exists');
    if (release.status !== 'pending') return { result: { releaseId, status: release.status } };
    const revision = await getRevision(deps.pool, release.projectId, release.revisionId);
    if (!revision) throw new JobError('revision_missing', 'The revision no longer exists');

    const body = buildPackage(release, revision);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const key = objectKeys.releasePackage(release.projectId, release.id);
    signal.throwIfAborted();
    try {
      await deps.store.put(key, body, { contentType: 'application/json', contentLength: body.length, signal });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new JobError('storage_unavailable', 'Could not upload the package', { retryable: true, details: { message: (err as Error).message } });
    }
    signal.throwIfAborted();

    const status = await withTransaction(deps.pool, async (tx) => {
      const locked = await lockRelease(tx, releaseId);
      if (!locked || locked.status !== 'pending') return locked?.status ?? 'missing';
      const project = await getProjectById(tx, release.projectId, { forUpdate: true });
      if (!project) throw new JobError('project_missing', 'The project no longer exists');
      if (project.currentReleaseId !== locked.baseReleaseId) {
        await finishRelease(tx, releaseId, {
          status: 'superseded',
          error: { code: 'superseded', message: 'Another release was published first', currentReleaseId: project.currentReleaseId },
        });
        return 'superseded';
      }
      await finishRelease(tx, releaseId, { status: 'ready', packageKey: key, packageSha256: sha256, packageBytes: body.length });
      await setProjectCurrentRelease(tx, release.projectId, releaseId);
      return 'ready';
    });
    log.info('release packaged', { releaseId, status, bytes: body.length });
    return { result: { releaseId, status, packageSha256: sha256, packageBytes: body.length } };
  },
  async onFailed(job, error, deps) {
    await withTransaction(deps.pool, async (tx) => {
      const locked = await lockRelease(tx, job.input.releaseId as string);
      if (locked?.status === 'pending') await finishRelease(tx, locked.id, { status: 'failed', error });
    });
  },
};

// ---------------------------------------------------------------- generate_revision

/**
 * Placeholder until milestone M4 (model adapter + ingest). Fails with a clear,
 * non-retryable error so no money is spent and the client can show why.
 */
export const generateRevision: JobHandler = {
  async run() {
    throw new JobError('not_implemented', 'Automatic generation is not available yet. Submit a definition with POST /v1/projects/:id/revisions.');
  },
};

export const defaultHandlers: HandlerRegistry = {
  prepare_upload: prepareUpload,
  package_release: packageRelease,
  generate_revision: generateRevision,
};
