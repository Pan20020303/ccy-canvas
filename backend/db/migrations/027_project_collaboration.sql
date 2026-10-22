-- 项目协作:owner 之外的成员表 + 项目「协作中」标记。
-- 一个项目转为协作后 is_collaborative=true;创建者(owner)不入表,受邀成员入
-- project_members(角色:管理者/协作者/访问者)。被邀请者据此在自己账号里看到
-- 并打开协作画布。幂等:可重复执行。

ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_collaborative boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS project_members (
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       text NOT NULL DEFAULT 'visitor' CHECK (role IN ('admin', 'collaborator', 'visitor')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members(user_id);
