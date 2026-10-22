# 登录页轮播素材

两张图片通过内置 image_gen 工具生成，生成日期 2026-09-14。原始 PNG 保存到本目录；页面实际引用同尺寸 WebP，视频引用无音轨的 1080p 压缩版本，由 Vite 随项目打包。格式转换不改变场景内容。

- `stellar-voyage.png`：星际远航，1536 × 1024。
- `dragon-realm.png`：云上之境，1536 × 1024。
- `origin-poster.jpg`：从项目已有 `../login-background.mp4` 的 1.5 秒位置抽取的 1440px 宽封面；视频来源未改变。
- `stellar-voyage.webp`：页面用图，206 KB。
- `dragon-realm.webp`：页面用图，317 KB。
- `origin-loop.mp4`：原品牌视频的 1920 × 1080、H.264、无音轨、faststart 版本，2.3 MB；原视频保留。

前两张用 CSS 缓慢推镜和氛围层形成动态场景，不是 AI 视频。轮播素材清单位于 `src/app/components/auth/showcase-scenes.ts`；新增 `video` 字段即可换成真实视频，同时保留 `poster` 回退。

## 星际远航生成提示词

Use case: stylized-concept. Asset type: cinematic fullscreen visual for the LEFT 75 percent of a dark AI filmmaking application's login page. Create one premium photorealistic science-fiction movie frame, landscape 1536x1024. A lone astronaut in a weathered ivory spacesuit seen in three-quarter back view stands in the left-middle foreground of a vast moon desert. An enormous ringed planet hangs low over a misty horizon, an elegant dark spacecraft glides above distant monumental rocks. Refined teal-grey atmosphere and soft warm amber reflected light, real material textures, cinematic haze, subtle film grain, high dynamic range, majestic quiet sense of scale, Denis-Villeneuve-like grounded epic science fiction cinematography. Main subject near x=38 percent, generous landscape at right, medium wide camera framing with foreground depth. Fill the entire image edge to edge; no black margins, no text, no typography, no logo, no UI, no watermark, no border. This is the finished background asset, not a website mockup.

## 云上之境生成提示词

Use case: stylized-concept. Asset type: cinematic fullscreen visual for the LEFT 75 percent of a dark AI filmmaking application's login page. Create one premium photorealistic wuxia fantasy movie frame, landscape 1536x1024. A Chinese swordswoman in flowing ivory robes with a restrained crimson sash stands on a weathered stone platform amid immense misty Chinese mountain peaks; she is near the left-middle in three-quarter rear view, long black hair moving gently. A huge intricately detailed eastern dragon winds through the pale silver mist in the middle distance, ancient floating temple silhouettes between jagged peaks, delicately textured clouds. Muted forest green and silver blue palette with warm sunrise gold at the horizon, dramatic real cinematic depth and light, exquisite natural textures, epic but serene. Main subject near x=36 percent, medium wide camera framing, space at right to fade into dark UI. Fill image edge to edge; no black margins, no text, no typography, no logo, no UI, no watermark, no borders. This is the finished image asset, not a website mockup.
