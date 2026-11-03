-- 画布模板:被标记为模板的项目出现在首页「从模板开始」,任何登录用户可一键
-- 复制成自己的项目(复用 duplicate 逻辑)。只加列不改数据。
ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_template boolean NOT NULL DEFAULT false;

-- 首页模板墙按发布时间倒序列出,数量不大,部分索引足够。
CREATE INDEX IF NOT EXISTS projects_is_template_idx
    ON projects(created_at DESC) WHERE is_template;
