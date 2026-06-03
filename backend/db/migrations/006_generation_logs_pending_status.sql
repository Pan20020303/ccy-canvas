ALTER TABLE generation_logs
    DROP CONSTRAINT IF EXISTS generation_logs_status_check;

ALTER TABLE generation_logs
    ADD CONSTRAINT generation_logs_status_check
    CHECK (status IN ('pending', 'success', 'error'));
