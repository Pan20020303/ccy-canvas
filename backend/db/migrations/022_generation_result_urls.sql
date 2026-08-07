-- Multi-asset generation results (P0-2 stability fix). A single generation can
-- yield several assets (wan2.7 组图 up to 12 images; any n>1 image request), but
-- generation_logs only stored one result_url — the rest were silently dropped.
-- result_urls stores the FULL ordered list as a JSON-encoded array of strings
-- when there is more than one result; empty string for single-result rows
-- (result_url remains the first/primary asset for all consumers).
--
-- Idempotent: safe to re-run.

ALTER TABLE generation_logs
    ADD COLUMN IF NOT EXISTS result_urls TEXT NOT NULL DEFAULT '';
