# 媒体加载性能优化(proxy-media 缓存 / Cache-Control / 缩略图)

面向局域网 / 自托管部署:让图片、视频加载更快、更省 OSS 下行流量。

## 背景:为什么改这里

前端 `src/app/reference-media.ts` 的 `toRenderableMediaUrl` 会把**所有** http(s) 媒体 URL
都包成 `/api/app/proxy-media?url=...`,也就是说**每一张图/视频都经过本地后端的 proxy-media**
(为的是绕开 CORS / referer / 混合内容,并能对私有对象服务端签名)。

所以优化的杠杆点全在 **proxy-media 这一个 handler**(`backend/internal/workspace/interfaces/upload_handler.go`),
不用碰前端域名、不用另立 nginx:

| 优化 | 作用 | 默认是否生效 |
|---|---|---|
| ① proxy-media 磁盘缓存 | 局域网后端把 OSS 对象缓存到本地盘,全网首访一次、之后 LAN 速度直供,省 OSS 流量 | **需开关**(`MEDIA_CACHE_DIR`) |
| ② 差异化 Cache-Control | 自家不可变资产返回 `immutable` 一年长缓存(原来统一 1 天) | 默认生效 |
| ③ 缩略图(OSS resize) | 画廊/画布瓦片按需取小尺寸 WebP,而非几 MB 原图 | 默认对 OSS 图片生效 |

## ① proxy-media 磁盘缓存(最大 LAN 收益)

- **开关**:设环境变量 `MEDIA_CACHE_DIR=<目录>` 即启用;不设则完全走原来的流式转发,**现有部署零影响**。
- **容量**:`MEDIA_CACHE_MAX_BYTES`(字节,默认 5 GiB)。超限时按最久未访问(mtime)驱逐到 90%。
- **只缓存自家资产**:命中 `assetstore.PresignGet`(即本店 COS/OSS 对象)的才缓存;第三方/临时 URL 仍流式转发。
- **key 稳定**:用对象的**公开 URL**(+ 缩略图宽度)做 key,不用会变的签名 URL;资产是 uuid 内容寻址、永不变,
  故**无需失效逻辑**,只有容量驱逐。
- **Range/拖动**:缓存命中用 Go `http.ServeContent` 从本地文件服务,天然支持分片(视频可正常 seek)。
  缓存未命中时会**拉取整个对象**(忽略客户端 Range)写盘,再从盘上按 Range 回给客户端。
- **观测**:响应头 `X-Cache: HIT|MISS` 表示是否命中缓存。
- **清缓存**:删 `MEDIA_CACHE_DIR` 目录内容即可(内容寻址,删了下次自动回填)。

实现:`backend/internal/workspace/interfaces/media_cache.go`。

## ② 差异化 Cache-Control

proxy-media 响应头:
- **自家不可变资产**(PresignGet 命中):`public, max-age=31536000, immutable` —— 同一用户一年内零回源、零 revalidate。
- **其它透传 URL**:保持 `public, max-age=86400`(1 天)。

因为资产 key 是 uuid、内容永不变,`immutable` 安全。此项**不依赖磁盘缓存,默认就生效**。

## ③ 缩略图(OSS 图片处理)

- proxy-media 支持 `?w=<像素>`:当目标是**自家 OSS 图片**时,通过 OSS 图片处理管线
  (`x-oss-process=image/resize,w_<n>,limit_1/format,webp`)拉一张小 WebP,而不是几 MB 原图。
  - 非 OSS(如迁移期的 COS)、非图片、或未带 `w` → 忽略,返回原图。
  - resize 拉取失败会自动回退取原图。
- 前端:`toRenderableMediaUrl(url, { thumbWidth })` 追加 `&w=`;`MediaThumb` 组件默认 `thumbWidth=640`
  (画廊/资产瓦片)。传 `thumbWidth={0}` 可强制原图。
- ⚠️ 缩略图**只对 OSS 图片生效**,所以要等 COS→OSS 迁移完成、URL 指向 OSS 后才真正省字节。

**扩展到画布节点**:画布里的图片在 `src/app/components/nodes/CustomNodes.tsx` 渲染(不走 MediaThumb)。
要让画布瓦片也用缩略图,给那里的 `toRenderableMediaUrl(url)` 调用加第二参 `{ thumbWidth: <节点显示宽度> }`
即可(点开/放大再取原图)。本次未改 CustomNodes,列为后续。

## 配置速查(`.env`)

```dotenv
# 开启 proxy-media 磁盘缓存(局域网/自托管强烈建议)
MEDIA_CACHE_DIR=./media-cache
# 可选:缓存容量上限,默认 5GiB
MEDIA_CACHE_MAX_BYTES=10737418240
```

## 验证

```bash
# 命中头(需带登录 Cookie);第一次 MISS,第二次 HIT
curl -s -D - -o /dev/null -H "Cookie: ccy_session=<你的会话>" \
  "http://<后端>/api/app/proxy-media?url=<某OSS对象URL编码后>" | grep -iE 'X-Cache|Cache-Control|Content-Type'

# 缩略图:带 &w=400 的响应应是 image/webp 且远小于原图
curl -s -D - -o /tmp/t.webp -H "Cookie: ccy_session=<...>" \
  "http://<后端>/api/app/proxy-media?url=<OSS图片URL编码>&w=400" | grep -iE 'Content-Type|Content-Length|X-Cache'
```

## 注意事项 / 坑

- **`immutable` 语义**:浏览器一年内不再校验。资产内容寻址不会变,安全;但若你**手动改了某个对象的内容却复用了 key**
  (本项目不会),用户会看到旧图直到硬刷新。
- **磁盘缓存只在开了 `MEDIA_CACHE_DIR` 时启用**;不开则行为与之前完全一致。
- **视频未命中会整段回源写盘**:首次拖动一个未缓存的大视频会先把整段拉下来(为了缓存完整对象)。之后就快了。
  单对象上限受 `maxProxySize`(100MB)约束。
- **缩略图依赖 OSS**:COS 不支持 `x-oss-process`,迁移完成前 `?w=` 对 COS 对象无效(自动回原图)。
- **缓存是每用户鉴权后的响应**,`Cache-Control: public` 允许共享缓存(如 LAN nginx)缓存;资产非敏感,可接受。

## 涉及文件

- 新增:`backend/internal/workspace/interfaces/media_cache.go`(磁盘缓存 + 缩略图 URL 助手)
- 改:`backend/internal/workspace/interfaces/upload_handler.go`(proxy-media 接入缓存①、Cache-Control②、缩略图③、`X-Cache` 头)
- 改:`src/app/reference-media.ts`(`toRenderableMediaUrl` 增加可选 `thumbWidth`)
- 改:`src/app/components/MediaThumb.tsx`(默认请求 640px 缩略图)

## 后续 / 可选

- 把 ③ 缩略图接到画布节点(CustomNodes)与其它大图渲染点。
- 公网大流量时再上 CDN:把 `OSS_PUBLIC_BASE_URL` 指向 CDN 域名即可(见 `backend/db/manual/oss-migration.md`)。
- 客户端锦上添花:`loading="lazy"`、视频 `poster` + `preload="metadata"`、blur-up 占位、并发限流。
