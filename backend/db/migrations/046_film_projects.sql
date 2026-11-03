-- Full one-click film documents, isolated from canvas snapshots. Re-runnable.
CREATE TABLE IF NOT EXISTS film_projects (
  id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id),
  client_id text NOT NULL,
  document jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  mutation_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_id, client_id),
  CHECK (jsonb_typeof(document) = 'object')
);
CREATE INDEX IF NOT EXISTS film_projects_owner_updated_idx ON film_projects(owner_id, updated_at DESC);
