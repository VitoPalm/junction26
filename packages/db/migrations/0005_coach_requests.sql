-- Task coach (docs/task-coach.md): grounded questions and recovery proposals
-- from the glasses run as `coach_request` jobs. Append-only migration.
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check
  CHECK (kind IN ('prepare_upload', 'generate_revision', 'package_release', 'transcribe_voice_note', 'coach_request'));
