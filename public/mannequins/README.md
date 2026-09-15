# 导演台 GLB 素体资产

这个目录是导演台节点(`DirectorStageOverlay`)在运行时去 fetch GLB 真模型
的固定位置。文件名是 hard-coded 的,改名要同步改
[`DirectorStageOverlay.tsx`](../../src/app/components/nodes/DirectorStageOverlay.tsx) 里
`BODY_TYPES[*].glbUrl`。

## 文件清单

当前(2026-07)五种体型共用一个模型,按 `widthMul/heightMul` 派生差异:

```
public/mannequins/
└── xbot.glb   ← Mixamo X Bot(取自 three.js 官方示例库,~2.8 MB,
                  标准 mixamorig 骨架 + 手指骨,自带 idle/walk/run 等动画,
                  材质在运行时被覆写成雕塑灰)
```

想按体型放不同模型:丢新的 `.glb` 进来,把 `BODY_TYPES[*].glbUrl` 指过去
即可;**加载失败自动走 procedural 回落**(不会报错)。

每个文件建议 **< 2 MB**(我们要在浏览器 fetch + cache,不能放几十 MB 的高
模);如果原始模型大,用 [gltfpack](https://github.com/zeux/meshoptimizer/tree/master/gltf)
或 [glTF-Transform](https://gltf-transform.dev/) 压一下:

```bash
npx gltfpack -i raw.glb -o standard.glb -cc -kn -tc
```

`-tc` 启用 KTX2 纹理压缩、`-cc` 启用 mesh 压缩、`-kn` 保留节点名(后面要靠骨头名做姿势映射,不能丢)。

## Bone 名兼容性

`DirectorStageOverlay.tsx` 里 `BONE_NAME_PATTERNS` 已经覆盖以下 3 种主流命名:

| Rig 来源 | bone 命名示例 |
|---|---|
| Mixamo | `mixamorigSpine` / `mixamorigLeftArm` / `mixamorigLeftLeg` |
| Quaternius / Blender 默认 | `Spine` / `LeftArm` / `LeftUpLeg` |
| Ready Player Me / VRM | `Spine` / `LeftShoulder` / `LeftArm` / `LeftUpLeg` |

任何符合其中一种命名习惯的 GLB 都能被识别、能受姿势预设 / 滑杆控制。

## 推荐的免费 / CC0 来源

### Quaternius(纯 CC0,无需注册)

- 仓库:<https://quaternius.com/packs/character.html>
- 优点:已经是低多边形 + 干净 rig,跟我们项目美术风格自然吻合
- 下载后直接拖进 [Blender](https://www.blender.org/) → File → Export → glTF 2.0

### Mixamo(Adobe 免费)

- 仓库:<https://www.mixamo.com/>
- 选 X Bot / Y Bot 或者其它 character → **不选 animation**,只导出 T-pose
- 导出选 FBX → 用 Blender 转 GLB(`File → Import → FBX` → `File → Export → glTF 2.0`)
- bone 命名带 `mixamorig` 前缀,我们已经匹配

### Ready Player Me(免费,带衣服)

- <https://readyplayer.me/avatar>
- 自定义一个 avatar → 拿到 GLB URL(直接 `.glb` 后缀)
- 下载本地放进来。**注意:这种模型自带头发 / 衣物,不再是"素体"风格,
  可能跟你想要的 reference 风格不一致**。

## 验证

放完文件刷新页面,打开导演台 → 切换体型 → 看 console:

- 命中:Network tab 里能看到 `/mannequins/standard.glb` 200
- 没命中:404,看到的还是 procedural 版

切换体型按钮里会优先尝试真模型,失败自动 fallback,**用户操作不变**。

## 法律 / 商业使用

- Quaternius:**CC0**(随便用,包括商业)
- Mixamo:**Adobe Free License**(允许商业,但要遵守 Adobe TOS)
- Ready Player Me:个人项目免费,商业要看 [TOS](https://docs.readyplayer.me/ready-player-me/integration-guides/all-integrations/personal-and-commercial-use)

我们 ccy-canvas 走开源 + 商业混合模式,**强烈建议优先选 Quaternius**。
