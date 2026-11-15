-- 0007_model_usage: spend ledger for model calls made directly by the API
-- (voice resolution, live stop-phrase checks) so a per-user demo budget can
-- count them alongside job usage. See docs/database.md.

CREATE TABLE model_usage (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      text NOT NULL,
  model       text NOT NULL,
  cost_usd    numeric(12, 6) NOT NULL CHECK (cost_usd >= 0),
  -- True when the provider reported no cost and a conservative estimate was stored.
  estimated   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_usage_owner ON model_usage (owner_id, created_at DESC);
