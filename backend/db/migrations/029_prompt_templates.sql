-- 提示词模板库:用户上传的提示词模板,全站共享;他人可点赞/踩。
-- 文本节点全屏编辑器的「提示词库」按钮 + 管理后台「提示词模板」记录页共用。

CREATE TABLE IF NOT EXISTS prompt_templates (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prompt_template_votes (
    template_id UUID NOT NULL REFERENCES prompt_templates(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 1 = 赞,-1 = 踩;一人一票,改票走 upsert。
    vote        SMALLINT NOT NULL CHECK (vote IN (1, -1)),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (template_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_created
    ON prompt_templates(created_at DESC);
