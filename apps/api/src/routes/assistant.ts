import { Hono } from 'hono';
import { z } from 'zod';
import { diffDefinitions, validateDefinition } from '@junction26/applet-format';
import { createProject, createRevision, getProject, getReleaseForOwner, getRevision, listRevisions, withTransaction } from '@junction26/db';
import { assistantAuthorId } from '../auth.ts';
import { assistantCapabilities, validateAssistantDefinition } from '../assistant-definition.ts';
import type { AppEnv, Deps } from '../context.ts';
import { ApiError, conflict, notFound } from '../errors.ts';
import { idempotencyKey, projectView, readJson, requestFingerprint, revisionSummaryView, uuid } from '../http.ts';

const DraftBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create'), title: z.string().trim().min(1).max(80), definition: z.unknown() }).strict(),
  z.object({ mode: z.literal('revise'), projectId: uuid, baseRevisionId: uuid, definition: z.unknown() }).strict(),
]);

// JSON objects have no key order. Normalize before hashing so transport/host
// reordering doesn't turn a retry into a different operation.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}

/** Private external-authoring seam. All persistence uses the existing DB helpers. */
export function assistantRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { assistantAuthorId(c, c.req.path.endsWith('/drafts') ? 'applets:draft' : 'applets:read'); await next(); });
  app.get('/capabilities', (c) => c.json(assistantCapabilities(deps.config.limits.maxDefinitionBytes)));
  app.post('/validate', async (c) => {
    const body = await readJson(c, z.object({ definition: z.unknown() }).strict());
    const result = validateAssistantDefinition(body.definition, deps.config.limits.maxDefinitionBytes);
    return c.json({ valid: result.ok, issues: result.issues, measuredFit: 'not_checked', sourceFidelity: 'not_checked' });
  });
  app.post('/drafts', async (c) => {
    const ownerId = assistantAuthorId(c, 'applets:draft');
    const key = idempotencyKey(c, true)!;
    const body = await readJson(c, DraftBody);
    const fingerprint = requestFingerprint(canonical(body));
    const saved = await withTransaction(deps.pool, async (tx) => {
      // Serialize retries before any side effect, including new project creation.
      // Transaction-scoped advisory locks also work with PgBouncer pooling.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`assistant-draft:${ownerId}:${key}`]);
      const replay = await tx.query('SELECT fingerprint, result FROM assistant_draft_operations WHERE owner_id = $1 AND operation_id = $2', [ownerId, key]);
      if (replay.rows[0]) {
        if (replay.rows[0].fingerprint !== fingerprint) throw conflict('idempotency_key_reused', 'Use a new operation ID for changed content');
        return { result: replay.rows[0].result, created: false };
      }
      const checked = validateAssistantDefinition(body.definition, deps.config.limits.maxDefinitionBytes);
      if (!checked.ok) throw new ApiError(422, 'invalid_definition', 'The applet definition is invalid', { issues: checked.issues });
      const project = body.mode === 'create'
        ? await createProject(tx, ownerId, body.title)
        : await getProject(tx, ownerId, body.projectId, { forUpdate: true });
      if (!project) throw notFound('Project');
      let findings: ReturnType<typeof diffDefinitions> = [];
      if (body.mode === 'revise') {
        const base = await getRevision(tx, project.id, body.baseRevisionId);
        if (!base) throw notFound('Revision');
        const latest = (await listRevisions(tx, project.id))[0];
        if (latest?.id !== base.id) throw conflict('stale_revision', 'Reload the latest revision before editing', { latestRevisionId: latest?.id });
        const parsed = validateDefinition(base.definition);
        if (!parsed.ok) throw conflict('unsupported_base_revision', 'This older revision cannot be safely compared by the current validator');
        findings = diffDefinitions(parsed.definition, checked.definition);
        // A chain of drafts must not hide impacts relative to the live release.
        if (project.currentReleaseId) {
          const release = await getReleaseForOwner(tx, ownerId, project.currentReleaseId);
          const live = release ? await getRevision(tx, project.id, release.revisionId) : null;
          const liveDefinition = live ? validateDefinition(live.definition) : null;
          if (!liveDefinition?.ok) throw conflict('unsupported_base_revision', 'The published definition cannot be safely compared');
          for (const finding of diffDefinitions(liveDefinition.definition, checked.definition)) {
            if (!findings.some((f) => f.kind === finding.kind && f.ref === finding.ref)) findings.push(finding);
          }
        }
      }
      const revision = await createRevision(tx, {
        projectId: project.id,
        baseRevisionId: body.mode === 'revise' ? body.baseRevisionId : null,
        definition: checked.definition,
        formatVersion: checked.definition.formatVersion,
        minimumRuntimeVersion: checked.definition.minimumRuntimeVersion,
        validationStatus: 'valid', validationIssues: [], source: 'client',
      });
      if (body.mode === 'revise') await tx.query(
        'INSERT INTO change_reviews (project_id, candidate_revision_id, base_revision_id, impacts) VALUES ($1, $2, $3, $4)',
        [project.id, revision.id, body.baseRevisionId, JSON.stringify(findings)],
      );
      const result = {
        project: projectView(project), revision: revisionSummaryView(revision), findings,
        previewUrl: new URL(`/author/p/${project.id}`, deps.config.publicOrigin).href,
        measuredFit: 'not_checked', published: false,
        reviewRequired: findings.length > 0,
      };
      await tx.query('INSERT INTO assistant_draft_operations (owner_id, operation_id, fingerprint, result) VALUES ($1, $2, $3, $4)', [ownerId, key, fingerprint, JSON.stringify(result)]);
      return { result, created: true };
    });
    return c.json(saved.result, saved.created ? 201 : 200);
  });
  return app;
}
