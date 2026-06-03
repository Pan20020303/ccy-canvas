CREATE TABLE generation_logs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES users(id),
    node_id      VARCHAR(128) NOT NULL DEFAULT '',
    service_type VARCHAR(32)  NOT NULL,
    model        VARCHAR(128) NOT NULL,
    prompt       TEXT         NOT NULL DEFAULT '',
    status       VARCHAR(16)  NOT NULL CHECK (status IN ('pending', 'success', 'error')),
    result_url   TEXT         NOT NULL DEFAULT '',
    error_msg    TEXT         NOT NULL DEFAULT '',
    duration_ms  INT          NOT NULL DEFAULT 0,
    cost         NUMERIC(10,5) NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX generation_logs_user_idx ON generation_logs(user_id, created_at DESC);
CREATE INDEX generation_logs_created_idx ON generation_logs(created_at DESC);
