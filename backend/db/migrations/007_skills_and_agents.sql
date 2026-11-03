-- Skills & Agents — see docs/superpowers/specs/2026-06-03-skills-agents-canvas-cli-design.md
-- Permission model: scope='global' is admin-managed, owner_id=NULL; scope='personal'
-- is per-user, owner_id is the user. Members can read globals but only mutate their
-- own personal rows.

CREATE TABLE IF NOT EXISTS skills (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope         TEXT NOT NULL CHECK (scope IN ('global','personal','team')),
    owner_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    team_id       UUID,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    category      TEXT NOT NULL DEFAULT 'other',
    icon          TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL CHECK (kind IN ('http','prompt','code')),
    spec          JSONB NOT NULL DEFAULT '{}'::jsonb,
    input_schema  JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A personal skill MUST have an owner; a global one MUST NOT.
    CONSTRAINT skills_scope_ownership_chk CHECK (
        (scope = 'personal' AND owner_id IS NOT NULL) OR
        (scope = 'global'   AND owner_id IS NULL) OR
        (scope = 'team'     AND team_id IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_skills_scope_owner ON skills(scope, owner_id);
CREATE INDEX IF NOT EXISTS idx_skills_enabled     ON skills(enabled) WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS agents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope         TEXT NOT NULL CHECK (scope IN ('global','personal','team')),
    owner_id      UUID REFERENCES users(id) ON DELETE CASCADE,
    team_id       UUID,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    avatar        TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    model         TEXT NOT NULL DEFAULT '',
    skill_ids     UUID[] NOT NULL DEFAULT '{}',
    canvas_tools  BOOLEAN NOT NULL DEFAULT TRUE,
    strategy      TEXT NOT NULL DEFAULT 'reactive'
                  CHECK (strategy IN ('reactive','scripted')),
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agents_scope_ownership_chk CHECK (
        (scope = 'personal' AND owner_id IS NOT NULL) OR
        (scope = 'global'   AND owner_id IS NULL) OR
        (scope = 'team'     AND team_id IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS idx_agents_scope_owner ON agents(scope, owner_id);
CREATE INDEX IF NOT EXISTS idx_agents_enabled     ON agents(enabled) WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS skill_runs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id)  ON DELETE SET NULL,
    agent_id    UUID REFERENCES agents(id) ON DELETE SET NULL,
    skill_id    UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    inputs      JSONB NOT NULL DEFAULT '{}'::jsonb,
    outputs     JSONB NOT NULL DEFAULT '{}'::jsonb,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','success','error')),
    error_msg   TEXT NOT NULL DEFAULT '',
    duration_ms INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_skill_runs_user_created ON skill_runs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_skill_runs_skill        ON skill_runs(skill_id);
