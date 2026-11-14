import type { Queryable } from '../pool.ts';
import {
  camel,
  camelRows,
  type Message,
  type Project,
  type Release,
  type Revision,
  type RevisionSummary,
  type Upload,
  type UploadStatus,
  type User,
} from '../rows.ts';

// Every read of user-owned data takes the owner ID and filters on it, so a
// missing ownership check shows up as a missing argument, not a data leak.

// ---------------------------------------------------------------- users

export async function upsertUserByExternalId(q: Queryable, externalId: string, displayName: string | null = null): Promise<User> {
  const { rows } = await q.query(
    `INSERT INTO users (external_id, display_name) VALUES ($1, $2)
     ON CONFLICT (external_id) DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, users.display_name)
     RETURNING *`,
    [externalId, displayName],
  );
  return camel<User>(rows[0]!);
}

export async function getUser(q: Queryable, id: string): Promise<User | null> {
  const { rows } = await q.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ? camel<User>(rows[0]) : null;
}

// ---------------------------------------------------------------- projects

export async function createProject(q: Queryable, ownerId: string, title: string): Promise<Project> {
  const { rows } = await q.query('INSERT INTO projects (owner_id, title) VALUES ($1, $2) RETURNING *', [ownerId, title]);
  return camel<Project>(rows[0]!);
}

export interface ProjectListItem extends Project {
  currentRelease: { id: string; revisionId: string; packageSha256: string; packageBytes: number; readyAt: Date } | null;
}

/** Most recently opened first, then most recently changed. */
export async function listProjects(q: Queryable, ownerId: string): Promise<ProjectListItem[]> {
  const { rows } = await q.query(
    `SELECT p.*, r.id AS rel_id, r.revision_id AS rel_revision_id, r.package_sha256 AS rel_sha,
            r.package_bytes AS rel_bytes, r.ready_at AS rel_ready_at
       FROM projects p
       LEFT JOIN releases r ON r.id = p.current_release_id
      WHERE p.owner_id = $1
      ORDER BY p.last_opened_at DESC NULLS LAST, p.updated_at DESC`,
    [ownerId],
  );
  return rows.map((row) => {
    const { rel_id, rel_revision_id, rel_sha, rel_bytes, rel_ready_at, ...rest } = row;
    return {
      ...camel<Project>(rest),
      currentRelease: rel_id
        ? {
            id: rel_id as string,
            revisionId: rel_revision_id as string,
            packageSha256: rel_sha as string,
            packageBytes: rel_bytes as number,
            readyAt: rel_ready_at as Date,
          }
        : null,
    };
  });
}

export async function getProject(q: Queryable, ownerId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<Project | null> {
  const { rows } = await q.query(
    `SELECT * FROM projects WHERE id = $1 AND owner_id = $2${opts.forUpdate ? ' FOR UPDATE' : ''}`,
    [id, ownerId],
  );
  return rows[0] ? camel<Project>(rows[0]) : null;
}

export async function updateProject(
  q: Queryable,
  ownerId: string,
  id: string,
  patch: { title?: string; lastOpenedAt?: Date },
): Promise<Project | null> {
  const { rows } = await q.query(
    `UPDATE projects
        SET title = COALESCE($3, title),
            last_opened_at = GREATEST(last_opened_at, $4::timestamptz),
            updated_at = CASE WHEN $3::text IS NOT NULL THEN now() ELSE updated_at END
      WHERE id = $1 AND owner_id = $2
      RETURNING *`,
    [id, ownerId, patch.title ?? null, patch.lastOpenedAt ?? null],
  );
  return rows[0] ? camel<Project>(rows[0]) : null;
}

// ---------------------------------------------------------------- uploads

export async function createUpload(
  q: Queryable,
  args: { id: string; ownerId: string; projectId: string | null; objectKey: string; filename: string | null; mediaType: string },
): Promise<Upload> {
  const { rows } = await q.query(
    `INSERT INTO uploads (id, owner_id, project_id, object_key, filename, media_type)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [args.id, args.ownerId, args.projectId, args.objectKey, args.filename, args.mediaType],
  );
  return camel<Upload>(rows[0]!);
}

export async function markUploadStored(q: Queryable, id: string, byteSize: number, sha256: string): Promise<Upload> {
  const { rows } = await q.query(
    `UPDATE uploads SET status = 'stored', byte_size = $2, sha256 = $3, updated_at = now()
      WHERE id = $1 AND status = 'receiving' RETURNING *`,
    [id, byteSize, sha256],
  );
  if (!rows[0]) throw new Error(`Upload ${id} is not receiving`);
  return camel<Upload>(rows[0]);
}

export async function setUploadStatus(q: Queryable, id: string, status: UploadStatus, error: unknown = null): Promise<Upload | null> {
  const { rows } = await q.query(
    `UPDATE uploads SET status = $2, error = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, status, error === null ? null : JSON.stringify(error)],
  );
  return rows[0] ? camel<Upload>(rows[0]) : null;
}

export async function getUpload(q: Queryable, ownerId: string, id: string): Promise<Upload | null> {
  const { rows } = await q.query('SELECT * FROM uploads WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return rows[0] ? camel<Upload>(rows[0]) : null;
}

/** Internal (worker) read without an owner filter. */
export async function getUploadById(q: Queryable, id: string): Promise<Upload | null> {
  const { rows } = await q.query('SELECT * FROM uploads WHERE id = $1', [id]);
  return rows[0] ? camel<Upload>(rows[0]) : null;
}

export async function getUploadsByIds(q: Queryable, ownerId: string, ids: string[]): Promise<Upload[]> {
  if (!ids.length) return [];
  const { rows } = await q.query('SELECT * FROM uploads WHERE owner_id = $1 AND id = ANY($2::uuid[])', [ownerId, ids]);
  return camelRows<Upload>(rows);
}

// ---------------------------------------------------------------- messages

export async function createMessage(
  q: Queryable,
  args: { projectId: string; ownerId: string; role: Message['role']; body: string; attachmentIds: string[]; jobId?: string | null },
): Promise<Message> {
  const { rows } = await q.query(
    `INSERT INTO messages (project_id, owner_id, role, body, attachment_ids, job_id)
     VALUES ($1, $2, $3, $4, $5::uuid[], $6) RETURNING *`,
    [args.projectId, args.ownerId, args.role, args.body, args.attachmentIds, args.jobId ?? null],
  );
  return camel<Message>(rows[0]!);
}

export async function listMessages(q: Queryable, ownerId: string, projectId: string): Promise<Message[]> {
  const { rows } = await q.query(
    'SELECT * FROM messages WHERE project_id = $1 AND owner_id = $2 ORDER BY created_at, id',
    [projectId, ownerId],
  );
  return camelRows<Message>(rows);
}

// ---------------------------------------------------------------- revisions

/**
 * Inserts the next-numbered revision. Callers must hold the project row lock
 * (`getProject(..., { forUpdate: true })`) so numbers are assigned serially.
 */
export async function createRevision(
  q: Queryable,
  args: {
    projectId: string;
    baseRevisionId: string | null;
    definition: unknown;
    formatVersion: number;
    minimumRuntimeVersion: string | null;
    validationStatus: 'valid' | 'invalid';
    validationIssues: unknown[];
    source: 'client' | 'model';
    jobId?: string | null;
  },
): Promise<Revision> {
  const { rows } = await q.query(
    `INSERT INTO revisions (project_id, number, base_revision_id, definition, format_version,
                            minimum_runtime_version, validation_status, validation_issues, source, job_id)
     VALUES ($1, (SELECT COALESCE(MAX(number), 0) + 1 FROM revisions WHERE project_id = $1),
             $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      args.projectId,
      args.baseRevisionId,
      JSON.stringify(args.definition),
      args.formatVersion,
      args.minimumRuntimeVersion,
      args.validationStatus,
      JSON.stringify(args.validationIssues),
      args.source,
      args.jobId ?? null,
    ],
  );
  return camel<Revision>(rows[0]!);
}

export async function getRevision(q: Queryable, projectId: string, id: string): Promise<Revision | null> {
  const { rows } = await q.query('SELECT * FROM revisions WHERE id = $1 AND project_id = $2', [id, projectId]);
  return rows[0] ? camel<Revision>(rows[0]) : null;
}

export async function listRevisions(q: Queryable, projectId: string): Promise<RevisionSummary[]> {
  const { rows } = await q.query(
    `SELECT id, project_id, number, base_revision_id, format_version, minimum_runtime_version,
            validation_status, validation_issues, source, job_id, created_at
       FROM revisions WHERE project_id = $1 ORDER BY number DESC`,
    [projectId],
  );
  return camelRows<RevisionSummary>(rows);
}

/** True when the revision has detected impacts that haven't been accepted. */
export async function revisionNeedsReview(q: Queryable, revisionId: string): Promise<boolean> {
  const { rows } = await q.query(
    `SELECT 1 FROM change_reviews
      WHERE candidate_revision_id = $1 AND decision <> 'accepted' AND jsonb_array_length(impacts) > 0`,
    [revisionId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------- releases

export async function createRelease(
  q: Queryable,
  args: { projectId: string; revisionId: string; baseReleaseId: string | null; minimumRuntimeVersion: string | null },
): Promise<Release> {
  const { rows } = await q.query(
    `INSERT INTO releases (project_id, revision_id, base_release_id, minimum_runtime_version)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [args.projectId, args.revisionId, args.baseReleaseId, args.minimumRuntimeVersion],
  );
  return camel<Release>(rows[0]!);
}

export async function getReleaseById(q: Queryable, id: string): Promise<Release | null> {
  const { rows } = await q.query('SELECT * FROM releases WHERE id = $1', [id]);
  return rows[0] ? camel<Release>(rows[0]) : null;
}

export async function getReleaseForOwner(q: Queryable, ownerId: string, id: string): Promise<Release | null> {
  const { rows } = await q.query(
    `SELECT r.* FROM releases r JOIN projects p ON p.id = r.project_id WHERE r.id = $1 AND p.owner_id = $2`,
    [id, ownerId],
  );
  return rows[0] ? camel<Release>(rows[0]) : null;
}

export async function listReleases(q: Queryable, projectId: string): Promise<Release[]> {
  const { rows } = await q.query('SELECT * FROM releases WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
  return camelRows<Release>(rows);
}

export async function finishRelease(
  q: Queryable,
  id: string,
  outcome:
    | { status: 'ready'; packageKey: string; packageSha256: string; packageBytes: number }
    | { status: 'superseded' | 'failed'; error: unknown },
): Promise<Release> {
  const { rows } =
    outcome.status === 'ready'
      ? await q.query(
          `UPDATE releases SET status = 'ready', package_key = $2, package_sha256 = $3, package_bytes = $4,
                  ready_at = now(), error = NULL
            WHERE id = $1 AND status = 'pending' RETURNING *`,
          [id, outcome.packageKey, outcome.packageSha256, outcome.packageBytes],
        )
      : await q.query(
          `UPDATE releases SET status = $2, error = $3 WHERE id = $1 AND status = 'pending' RETURNING *`,
          [id, outcome.status, JSON.stringify(outcome.error)],
        );
  if (!rows[0]) throw new Error(`Release ${id} is not pending`);
  return camel<Release>(rows[0]);
}

export async function setProjectCurrentRelease(q: Queryable, projectId: string, releaseId: string): Promise<void> {
  await q.query('UPDATE projects SET current_release_id = $2, updated_at = now() WHERE id = $1', [projectId, releaseId]);
}

// ---------------------------------------------------------------- internal (worker)

/** Worker-side project read without an owner filter; `forUpdate` locks the row. */
export async function getProjectById(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<Project | null> {
  const { rows } = await q.query(`SELECT * FROM projects WHERE id = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] ? camel<Project>(rows[0]) : null;
}

export async function lockRelease(q: Queryable, id: string): Promise<Release | null> {
  const { rows } = await q.query('SELECT * FROM releases WHERE id = $1 FOR UPDATE', [id]);
  return rows[0] ? camel<Release>(rows[0]) : null;
}
