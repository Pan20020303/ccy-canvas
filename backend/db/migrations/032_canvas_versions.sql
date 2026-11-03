-- 画布版本历史:关键操作/手动打点的画布快照,协作误操作后可一键回滚。
-- canvas_snapshots 是 UNIQUE(project_id) 单快照,无历史;此表存多版本。只加表。
CREATE TABLE IF NOT EXISTS canvas_versions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    nodes      jsonb NOT NULL DEFAULT '[]',
    edges      jsonb NOT NULL DEFAULT '[]',
    groups     jsonb NOT NULL DEFAULT '[]',
    label      text NOT NULL DEFAULT '',
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canvas_versions_project_idx
    ON canvas_versions(project_id, created_at DESC);
