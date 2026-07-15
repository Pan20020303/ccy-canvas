-- 画布评论批注:锚定到画布节点的线程式评论,支持回复与「解决」。
-- 协作审阅闭环:参与者(含只读访问者)可对节点/版本给意见。只建表不改数据。
CREATE TABLE IF NOT EXISTS canvas_comments (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- 锚定的画布节点 id(前端字符串 id);空串 = 项目级评论。
    node_id    text NOT NULL DEFAULT '',
    author_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 线程回复指向父评论;NULL = 话题根。
    parent_id  uuid REFERENCES canvas_comments(id) ON DELETE CASCADE,
    body       text NOT NULL,
    resolved   boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS canvas_comments_project_idx
    ON canvas_comments(project_id, created_at);
