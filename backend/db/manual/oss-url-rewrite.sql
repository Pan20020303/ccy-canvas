-- ============================================================================
-- COS → OSS 资产 URL 一次性改写脚本(手动执行,非自动迁移)
-- ----------------------------------------------------------------------------
-- 作用:把库里所有已持久化的腾讯云 COS 公开 URL,批量换成阿里云 OSS 公开 URL。
--       COS 与 OSS 的对象 key 完全一致,所以这只是「换 host 前缀」,纯字符串替换。
--
-- 前置条件(务必先满足):
--   1. OSS bucket(ccy-aliyun1,北京)已上线,读写权限=公共读,且「阻止公共访问」关闭;
--   2. 已配「镜像回源」规则,源站指向 COS 公开域名,且开启「回源后保存到 Bucket」;
--   3. 后端已切 STORAGE_BACKEND=oss 并重启(新资产已写入 OSS);
--   4. 已对数据库做完整备份。
--
-- 可逆:把下面 old_base / new_base 两个值对调,再跑一遍即可回滚(COS 对象未动)。
--       注意:切 OSS 之后新生成的资产只在 OSS,回滚后这批 URL 在 COS 找不到。
--
-- 执行(容器内 psql 示例):
--   docker exec -i ccy-canvas-postgres psql -U postgres -d ccy_canvas -v ON_ERROR_STOP=1 -f - < oss-url-rewrite.sql
--   (或 psql ... -f backend/db/manual/oss-url-rewrite.sql)
-- ============================================================================

\set old_base 'https://ccy-canvas-1334659054.cos.ap-beijing.myqcloud.com'
\set new_base 'https://ccy-aliyun1.oss-cn-beijing.aliyuncs.com'

-- ── 影响面预览(dry-run,只读,不改数据)────────────────────────────────────
SELECT 'generation_logs.result_url'   AS col, count(*) FROM generation_logs    WHERE result_url  LIKE :'old_base' || '%'
UNION ALL SELECT 'generation_logs.result_urls', count(*) FROM generation_logs   WHERE result_urls LIKE '%' || :'old_base' || '%'
UNION ALL SELECT 'generation_logs.cos_url',     count(*) FROM generation_logs   WHERE cos_url     LIKE :'old_base' || '%'
UNION ALL SELECT 'projects.cover_url',          count(*) FROM projects          WHERE cover_url   LIKE :'old_base' || '%'
UNION ALL SELECT 'generation_history.thumbnail',count(*) FROM generation_history WHERE thumbnail  LIKE :'old_base' || '%'
UNION ALL SELECT 'generation_history.content',  count(*) FROM generation_history WHERE content    LIKE :'old_base' || '%'
UNION ALL SELECT 'saved_assets.thumbnail',      count(*) FROM saved_assets       WHERE thumbnail  LIKE :'old_base' || '%'
UNION ALL SELECT 'saved_assets.url',            count(*) FROM saved_assets       WHERE url        LIKE :'old_base' || '%'
UNION ALL SELECT 'provider_configs.icon_url',   count(*) FROM provider_configs   WHERE icon_url   LIKE :'old_base' || '%'
UNION ALL SELECT 'skills.icon',                 count(*) FROM skills             WHERE icon       LIKE :'old_base' || '%'
UNION ALL SELECT 'agents.avatar',               count(*) FROM agents             WHERE avatar     LIKE :'old_base' || '%'
UNION ALL SELECT 'canvas_snapshots.nodes',      count(*) FROM canvas_snapshots   WHERE nodes::text  LIKE '%' || :'old_base' || '%'
UNION ALL SELECT 'canvas_snapshots.edges',      count(*) FROM canvas_snapshots   WHERE edges::text  LIKE '%' || :'old_base' || '%'
UNION ALL SELECT 'canvas_snapshots.groups',     count(*) FROM canvas_snapshots   WHERE groups::text LIKE '%' || :'old_base' || '%';

-- ── 改写(单事务,失败整体回滚)──────────────────────────────────────────────
BEGIN;

-- 标量 TEXT 列(result_urls 也是 TEXT 存的 JSON 数组,直接替换)
UPDATE generation_logs    SET result_url  = REPLACE(result_url,  :'old_base', :'new_base') WHERE result_url  LIKE :'old_base' || '%';
UPDATE generation_logs    SET result_urls = REPLACE(result_urls, :'old_base', :'new_base') WHERE result_urls LIKE '%' || :'old_base' || '%';
UPDATE generation_logs    SET cos_url     = REPLACE(cos_url,     :'old_base', :'new_base') WHERE cos_url     LIKE :'old_base' || '%';
UPDATE projects           SET cover_url   = REPLACE(cover_url,   :'old_base', :'new_base') WHERE cover_url   LIKE :'old_base' || '%';
UPDATE generation_history SET thumbnail   = REPLACE(thumbnail,   :'old_base', :'new_base') WHERE thumbnail   LIKE :'old_base' || '%';
UPDATE generation_history SET content     = REPLACE(content,     :'old_base', :'new_base') WHERE content     LIKE :'old_base' || '%';
UPDATE saved_assets       SET thumbnail   = REPLACE(thumbnail,   :'old_base', :'new_base') WHERE thumbnail   LIKE :'old_base' || '%';
UPDATE saved_assets       SET url         = REPLACE(url,         :'old_base', :'new_base') WHERE url         LIKE :'old_base' || '%';
UPDATE provider_configs   SET icon_url    = REPLACE(icon_url,    :'old_base', :'new_base') WHERE icon_url    LIKE :'old_base' || '%';
UPDATE skills             SET icon        = REPLACE(icon,        :'old_base', :'new_base') WHERE icon        LIKE :'old_base' || '%';
UPDATE agents             SET avatar      = REPLACE(avatar,      :'old_base', :'new_base') WHERE avatar      LIKE :'old_base' || '%';

-- JSONB 列(文本替换后转回 jsonb;URL 是不透明字符串值,替换安全)
UPDATE canvas_snapshots   SET nodes  = REPLACE(nodes::text,  :'old_base', :'new_base')::jsonb WHERE nodes::text  LIKE '%' || :'old_base' || '%';
UPDATE canvas_snapshots   SET edges  = REPLACE(edges::text,  :'old_base', :'new_base')::jsonb WHERE edges::text  LIKE '%' || :'old_base' || '%';
UPDATE canvas_snapshots   SET groups = REPLACE(groups::text, :'old_base', :'new_base')::jsonb WHERE groups::text LIKE '%' || :'old_base' || '%';

COMMIT;

-- ── 改写后校验:旧域名应全部为 0 ────────────────────────────────────────────
SELECT 'remaining COS refs' AS check,
       (SELECT count(*) FROM generation_logs   WHERE result_url  LIKE :'old_base' || '%')
     + (SELECT count(*) FROM generation_logs   WHERE result_urls LIKE '%' || :'old_base' || '%')
     + (SELECT count(*) FROM generation_logs   WHERE cos_url     LIKE :'old_base' || '%')
     + (SELECT count(*) FROM projects          WHERE cover_url   LIKE :'old_base' || '%')
     + (SELECT count(*) FROM generation_history WHERE thumbnail  LIKE :'old_base' || '%')
     + (SELECT count(*) FROM generation_history WHERE content    LIKE :'old_base' || '%')
     + (SELECT count(*) FROM saved_assets       WHERE thumbnail  LIKE :'old_base' || '%')
     + (SELECT count(*) FROM saved_assets       WHERE url        LIKE :'old_base' || '%')
     + (SELECT count(*) FROM provider_configs   WHERE icon_url   LIKE :'old_base' || '%')
     + (SELECT count(*) FROM skills             WHERE icon       LIKE :'old_base' || '%')
     + (SELECT count(*) FROM agents             WHERE avatar     LIKE :'old_base' || '%')
     + (SELECT count(*) FROM canvas_snapshots   WHERE nodes::text  LIKE '%' || :'old_base' || '%')
     + (SELECT count(*) FROM canvas_snapshots   WHERE edges::text  LIKE '%' || :'old_base' || '%')
     + (SELECT count(*) FROM canvas_snapshots   WHERE groups::text LIKE '%' || :'old_base' || '%') AS should_be_zero;
