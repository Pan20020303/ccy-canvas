# 存储迁移:腾讯云 COS → 阿里云 OSS(交接文档)

> 面向接手的工程师 / AI。目标:把资产存储从腾讯云 COS 迁到阿里云 OSS,**零停机、可回滚**,
> 并复用已购的「回源流量」做懒迁移。本文覆盖:背景、已完成项、待办、精确步骤、验证、回滚、坑。
>
> ⚠️ 本文不含任何密钥。所有 `<...>` 占位符请就地替换,密钥只放本机 `.env`,绝不入库/贴聊天。

## 1. 背景与策略

- 应用是 AI 图/视频生成画布(橙次元)。生成的资产必须放在**公网可达**的 URL 上,因为后端会把
  参考图/参考视频的 URL 交给上游 AI 供应商(火山 Ark、DMXAPI 等)去**下载**——本地/局域网 URL
  上游拉不到,带参考图的生成会失败(历史上踩过 base64/URL 不通的坑)。所以存储必须是公网对象存储。
- **迁移策略 = 镜像回源懒迁移**(已选定):
  1. OSS 建桶(公共读),配「镜像回源」规则指向旧 COS;
  2. 应用切 `STORAGE_BACKEND=oss`,把库里存量 COS URL 批量改写成 OSS URL;
  3. 用户首次访问某个老资产的新 OSS URL 时,OSS 发现自己没有 → 自动从 COS 拉回并存入 OSS
     (消耗「回源流量」,每个对象只回源一次)。新资产直接写 OSS。
- 目标地域:**华北2 北京 `cn-beijing`**(与旧 COS `ap-beijing` 同城)。Bucket 名:**`ccy-aliyun1`**。
- 旧 COS 公开域名(镜像回源源站):`https://ccy-canvas-1334659054.cos.ap-beijing.myqcloud.com`
- 新 OSS 公开域名:`https://ccy-aliyun1.oss-cn-beijing.aliyuncs.com`

## 2. 已完成(已入库)

- **代码**:`backend/internal/platform/assetstore/store.go` 新增 `ossStore`(实现 `Store` 接口:
  `Save`/`UploadFile`/`PresignGet`,对象 public-read + 长缓存,多分片走 `NewUploader`)与
  `STORAGE_BACKEND=oss` 分支。**cosStore 保留**以便灰度/回滚。所有调用点零改动。
  - 依赖:`github.com/aliyun/alibabacloud-oss-go-sdk-v2`(已在 go.mod)。
  - 提交:`feat(storage): 接入阿里云 OSS 存储后端...`
- **URL 改写脚本**:`backend/db/manual/oss-url-rewrite.sql`(带 dry-run 预览 + 单事务 + 残留校验)。
- **前端零改动**:`src/app/reference-media.ts` 的 URL 处理与域名无关,后端返回什么域名都能渲染。

## 3. 存储抽象(实现要点)

`Store` 接口三方法,`fromEnv()` 按 `STORAGE_BACKEND` 选 `local` / `cos` / `oss`:

| 方法 | 作用 | OSS 实现 |
|---|---|---|
| `Save(ctx, key, body, ct)` | 存对象,返回公开 URL | `PutObject`(Acl=public-read, CacheControl 长缓存) |
| `UploadFile(ctx, key, path, ct)` | 大文件多分片上传 | `NewUploader().UploadFile` |
| `PresignGet(ctx, rawURL, ttl)` | 给自家私有对象签短期 URL(proxy-media 用) | `Presign(GetObjectRequest)`;非本 store 的 URL 返回 `""` |

公开 URL 规则:`OSS_PUBLIC_BASE_URL + "/" + [OSS_KEY_PREFIX/]key`。COS 与 OSS **对象 key 完全一致**,
所以存量 URL 改写只是「换 host 前缀」。

### 环境变量(`.env`)
```dotenv
STORAGE_BACKEND=oss
OSS_BUCKET=ccy-aliyun1
OSS_REGION=cn-beijing
OSS_ACCESS_KEY_ID=<RAM 子账号 AccessKey ID>
OSS_ACCESS_KEY_SECRET=<RAM 子账号 AccessKey Secret>   # 密钥,勿入库/勿外传
OSS_KEY_PREFIX=ccy-canvas   # 必须与旧 COS_KEY_PREFIX 一致!否则新资产 key 布局与存量不一致
# 可选:
# OSS_PUBLIC_BASE_URL=   # 默认 https://<bucket>.oss-<region>.aliyuncs.com;挂 CDN/自定义域名才填
# OSS_ENDPOINT=          # 默认按 region 推导;内网/自定义端点才填
```

## 4. OSS 控制台配置(人工,一次性)

1. **建桶** `ccy-aliyun1`:地域=华北2(北京)、标准存储、**本地冗余 LRS**、读写权限=**公共读**。
2. **权限控制 → 阻止公共访问:关闭**。⚠️ 它开着会盖过 ACL,公共读也会 403。
3. **镜像回源**(数据管理 → 回源设置 → 新建):
   - 回源类型=镜像回源;触发条件=HTTP **404**(文件不存在才回源);
   - 源站=`https://ccy-canvas-1334659054.cos.ap-beijing.myqcloud.com`;
   - **开启「回源后保存到 Bucket」**(老对象首访后住进 OSS,只回源一次)。
4. **RAM 子账号 + AccessKey**(访问控制 RAM):
   - 建用户,勾「编程访问」,拿 AccessKey ID/Secret(**Secret 只显示一次**);
   - **不要用主账号 AK**。最小权限策略(仅限本桶):
     ```json
     { "Version": "1", "Statement": [
       { "Effect": "Allow", "Action": "oss:*",
         "Resource": ["acs:oss:*:*:ccy-aliyun1", "acs:oss:*:*:ccy-aliyun1/*"] } ] }
     ```
5.（可选)**防盗链**:若开 Referer 白名单,**必须允许空 Referer**——上游供应商抓参考图是服务器端
   请求、不带 Referer,禁空 Referer 会导致生成失败。因此防盗链只能挡浏览器盗链,价值有限;
   成本兜底更建议用**费用中心流量告警 + OSS 流量封顶**。

## 5. 存量 URL 改写(切换时执行一次)

存 COS 公开 URL 的列(改写目标),脚本 `backend/db/manual/oss-url-rewrite.sql` 已覆盖:

- 标量 TEXT:`generation_logs.result_url` / `result_urls`(TEXT 存的 JSON 数组)/ `cos_url`、
  `projects.cover_url`、`generation_history.thumbnail` / `content`、`saved_assets.thumbnail` / `url`、
  `provider_configs.icon_url`、`skills.icon`、`agents.avatar`
- JSONB:`canvas_snapshots.nodes` / `edges` / `groups`(节点内嵌 `data.url`;走 `::text→::jsonb`)

跑法(容器内 psql):
```bash
docker exec -i ccy-canvas-postgres psql -U postgres -d ccy_canvas -v ON_ERROR_STOP=1 \
  -f - < backend/db/manual/oss-url-rewrite.sql
```
脚本会先打印 dry-run 计数,再单事务改写,最后打印 `should_be_zero`(旧域名残留数,应为 0)。
**执行前务必备份数据库。** 回滚:把脚本里 `old_base`/`new_base` 两值对调再跑一遍。

## 5b. 直接拷贝法(不依赖镜像回源,本次实际采用)

如果不想用镜像回源(或想尽快下线 COS),可以在改写 URL 前把存量对象**直接拷到 OSS**。因为
数据集通常很小(本项目约 60 个对象),而且 COS 对象是公共读、外网可 GET,所以:

1. 从库里抽出所有被引用的 COS 对象 URL(去重),用正则覆盖所有列(含 JSONB):
   ```sql
   \set P 'https://ccy-canvas-1334659054\.cos\.ap-beijing\.myqcloud\.com/[A-Za-z0-9._/-]+'
   WITH urls AS (
     SELECT (regexp_matches(result_url,:'P','g'))[1] u FROM generation_logs
     UNION ALL SELECT (regexp_matches(result_urls,:'P','g'))[1] FROM generation_logs
     UNION ALL SELECT (regexp_matches(cos_url,:'P','g'))[1] FROM generation_logs
     UNION ALL SELECT (regexp_matches(cover_url,:'P','g'))[1] FROM projects
     UNION ALL SELECT (regexp_matches(thumbnail,:'P','g'))[1] FROM generation_history
     UNION ALL SELECT (regexp_matches(content,:'P','g'))[1] FROM generation_history
     UNION ALL SELECT (regexp_matches(thumbnail,:'P','g'))[1] FROM saved_assets
     UNION ALL SELECT (regexp_matches(url,:'P','g'))[1] FROM saved_assets
     UNION ALL SELECT (regexp_matches(icon_url,:'P','g'))[1] FROM provider_configs
     UNION ALL SELECT (regexp_matches(icon,:'P','g'))[1] FROM skills
     UNION ALL SELECT (regexp_matches(avatar,:'P','g'))[1] FROM agents
     UNION ALL SELECT (regexp_matches(nodes::text,:'P','g'))[1] FROM canvas_snapshots
     UNION ALL SELECT (regexp_matches(edges::text,:'P','g'))[1] FROM canvas_snapshots
     UNION ALL SELECT (regexp_matches(groups::text,:'P','g'))[1] FROM canvas_snapshots
   )
   SELECT DISTINCT u FROM urls WHERE u IS NOT NULL ORDER BY u;
   ```
   (用 `psql -t -A` 输出成一行一个 URL,存到 `cos_urls.txt`。)
2. 用 `backend/cmd/osscopy` 把这些对象逐个从 COS 下载、以**相同 key** 上传到 OSS:
   ```bash
   # 把 .env 的 OSS_* 导入环境后:
   go run ./cmd/osscopy < cos_urls.txt
   ```
3. 拷贝全部成功后,再跑第 5 节的改写 SQL,最后重启后端。

⚠️ **私有对象坑**:历史上有部分对象(本项目是几个早期 `.mp4`)在 COS 上是**私有 ACL**,外网 GET
返回 **403**,直接拷贝法拉不到(它们现在靠后端 proxy-media 用 COS 密钥签名播放)。切到 OSS 后端后,
`ossStore` 无法再签名 COS 私有对象,这些引用会失效。处理办法:
- **推荐**:在 COS 控制台把这几个对象临时设为「公有读」→ 重跑 osscopy 补拷 → 可再改回私有;
- 或:接受这几个老对象失效(若不重要);
- 或:保留 COS 的签名兜底(需在 OSS 后端里额外挂一个 COS presigner,代码改动,不建议)。

## 6. 切换顺序(零停机)

1. 部署代码(此时仍 `STORAGE_BACKEND=cos`)。
2. OSS 控制台配好:公共读 + 阻止公共访问关 + 镜像回源 + RAM key。
3. **手动传一张图**到桶里,确认 `https://ccy-aliyun1.oss-cn-beijing.aliyuncs.com/<key>` 匿名能打开。
4. **备份数据库。**
5. `.env` 切 `oss` + 填 `OSS_*`,重启后端 → 新资产进 OSS,老 URL 仍走 COS(COS 还活着)。
6. 跑改写 SQL → 老 URL 指向 OSS,首访时镜像回源自动拉取。
7. COS 桶保持存活(公共读)度过懒迁移期。想彻底下线 COS,再补一次冷数据全量拷贝
   (阿里云「数据在线迁移」或 ossutil sync),确认无残留后移除镜像回源规则并停用 COS。

## 7. 验证清单

- [ ] 传一张**新**图 → 落到 OSS(控制台文件列表可见)、公网 URL 匿名可开、前端画布渲染正常。
- [ ] 生成一次**带参考图**的图/视频 → 上游能拉到参考图(不再报 URL 不通)、结果回显正常。
- [ ] 改写 SQL 后,打开一个**老**项目 → 老图经新 OSS URL 加载成功(首访触发镜像回源,OSS 文件列表
      随后出现该对象)。
- [ ] `should_be_zero` = 0。
- [ ] 费用中心已设流量告警。

## 8. 关键坑(务必知道)

1. **资产 URL 必须公网可达**——上游 AI 供应商要下载参考图。故不能用纯本地/局域网存储。
2. **「阻止公共访问」会盖过桶 ACL**——公共读不生效就先查这个。
3. **防盗链禁空 Referer 会打断上游抓参考图**——要么允许空 Referer,要么别开防盗链。
4. **`generation_logs.result_urls` 是 TEXT** 不是 jsonb;只有 `canvas_snapshots.nodes/edges/groups` 是
   jsonb,改写用 `REPLACE(col::text, ...)::jsonb`。
5. **回滚窗口**:切 OSS 后新生成的资产只在 OSS;若之后回滚到 COS,这批 URL 在 COS 找不到,需重新处理。
6. **CDN**:目前规模小/内网访问为主,未上 CDN;`OSS_PUBLIC_BASE_URL` 用 OSS 默认域名。将来公网流量
   变大再挂 CDN(把 `OSS_PUBLIC_BASE_URL` 与改写 `new_base` 换成 CDN 域名即可,最好一次到位免二次改写)。

## 9. 当前状态 / 待办

- [x] 代码(`ossStore`)+ 改写 SQL + 拷贝工具 `cmd/osscopy` + 本文档,均已入库。
- [x] OSS 桶 `ccy-aliyun1` 建好:公共读 + 阻止公共访问关闭 + RAM key 已授权。
- [x] `.env` 填好 OSS 配置(`STORAGE_BACKEND=oss` / `OSS_BUCKET` / `OSS_REGION` / `OSS_KEY_PREFIX=ccy-canvas` / 密钥)。
- [x] 本地验证:OSS 写入 + 公共读 OK(探针 200)。
- [x] 存量对象拷贝:**57/60 已拷到 OSS**;**3 个早期 `.mp4` 因 COS 私有 ACL(403)未拷**(见 5b 私有对象坑)。
- [ ] 处理那 3 个私有对象(COS 设公有读补拷 / 或接受失效)。
- [ ] 跑改写 SQL(全量 60 URL 换成 OSS)+ 重启后端到 OSS + 验证(未执行;DB 已备份)。
- [ ] 镜像回源(可选,作为兜底/懒迁移;本次走的是直接拷贝法)。
- [ ] (远期)确认无残留后下线 COS。

> 备注:验证期间探针在 OSS 留了个 `_migration-probe/probe.txt`(17B),可随时删除。
