-- Laundry (docs/laundry.md): care-label reading runs as `extract_care_label`
-- jobs. Append-only migration.
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check
  CHECK (kind IN ('prepare_upload', 'generate_revision', 'package_release', 'transcribe_voice_note', 'coach_request', 'extract_care_label'));
