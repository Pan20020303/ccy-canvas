-- Independent timeout tracking for provider_configs.
--
-- Rationale: a single timeout is almost always "upstream slow, not broken".
-- Counting timeouts toward the same failure budget that drives cooldown
-- (currently 3 strikes → 5 min cooldown, exponential thereafter) caused
-- healthy channels to be sidelined every time the upstream had a slow
-- minute. Timeouts now bump a separate counter that is informational only:
-- visible to admins, but not used by the routing decision.
--
-- Idempotent: re-running on a partially-applied DB is safe.

ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS timeout_count INT NOT NULL DEFAULT 0;
ALTER TABLE provider_configs
    ADD COLUMN IF NOT EXISTS last_timeout_at TIMESTAMPTZ;
