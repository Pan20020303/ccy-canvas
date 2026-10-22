-- Management-console operation audit trail. This is intentionally separate
-- from generation_logs: generation logs describe user jobs, while this table
-- records privileged management actions and their outcome.
CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id    text NOT NULL DEFAULT '',
    actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_name    text NOT NULL DEFAULT '',
    actor_email   text NOT NULL DEFAULT '',
    action        text NOT NULL,
    target_type   text NOT NULL DEFAULT '',
    target_id     text NOT NULL DEFAULT '',
    target_label  text NOT NULL DEFAULT '',
    method        text NOT NULL,
    route         text NOT NULL,
    status        text NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'success', 'error')),
    http_status   integer,
    error_code    text NOT NULL DEFAULT '',
    summary       text NOT NULL DEFAULT '',
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    duration_ms   integer,
    created_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS admin_audit_logs_created_idx
    ON admin_audit_logs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_audit_logs_actor_created_idx
    ON admin_audit_logs (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_logs_action_created_idx
    ON admin_audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_logs_request_id_idx
    ON admin_audit_logs (request_id)
    WHERE request_id <> '';
