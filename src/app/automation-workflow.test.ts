import { describe, expect, it } from "vitest";

import {
  buildStoryboardDrafts,
  ensureScriptCharacterCoverage,
  extractAssetsFromScript,
  extractScriptCharacterCandidates,
  hasCompletedScriptExtraction,
  parseStoryboardResponse,
  parseExtractedAssetsResponse,
} from "./automation-workflow";
import { defaultStoryboardSkillId, storyboardSkillOptions } from "./storyboard-skills";

describe("automation workflow helpers", () => {
  const script = `
人物：林默、苏晴
场景一：废弃车站
音效：远处列车轰鸣

林默：我们只剩五分钟。
苏晴：钥匙在我这里。
林默拿起手电筒，望向站台尽头。

场景二：地下通道
苏晴手持钥匙打开铁门。
`;

  it("extracts the four production asset groups", () => {
    const assets = extractAssetsFromScript(script);
    expect(assets.some((asset) => asset.type === "character" && asset.name === "林默")).toBe(true);
    expect(assets.some((asset) => asset.type === "scene" && asset.name.includes("废弃车站"))).toBe(true);
    expect(assets.some((asset) => asset.type === "prop" && asset.name === "手电筒")).toBe(true);
    expect(assets.some((asset) => asset.type === "audio")).toBe(true);
  });

  it("recognizes single-character speakers and narrative character evidence", () => {
    const candidates = extractScriptCharacterCandidates(`
魁：住手！
李清颜化身的鸾凤将魁死死按在地上。
利爪收紧，魁的身体爆裂开来。
`);
    expect(candidates.map((candidate) => candidate.name)).toContain("魁");
  });

  it("does not turn action grammar, pronouns, quantities or visual nouns into characters", () => {
    const candidates = extractScriptCharacterCandidates(`
李清颜：不要动。
李清颜的身体倒下。
李清颜将他的身体死死压住。
一道黑影冲向大门，三人倒下。
人物：林默、苏晴
场景：山林
动作：魁倒下
旁白：风声越来越近
道具：长剑
关键道具：玉佩
音频：风声
BGM：低沉鼓点
OS：不要回头
人物表：阿宁、阿远
场景一：山林
镜头1：魁倒下
魁梧的身体挡住大门。
年轻男人的身体倒下。
`);
    expect(candidates.map((candidate) => candidate.name)).toEqual([
      "林默",
      "苏晴",
      "阿宁",
      "阿远",
      "李清颜",
    ]);
  });

  it("fills a character omitted by the text model from high-confidence script evidence", () => {
    const modelAssets = parseExtractedAssetsResponse(JSON.stringify({
      assetsList: [
        {
          name: "李清颜",
          desc: "女性，白衣银发",
          prompt: "a woman, white robe, silver hair",
          type: "role",
        },
        {
          name: "陆吾",
          desc: "男性，身形魁梧",
          prompt: "a tall muscular man",
          type: "role",
        },
      ],
    }));
    const covered = ensureScriptCharacterCoverage(`
李清颜化身的鸾凤将魁死死按在地上。
利爪收紧，魁的身体爆裂开来。
陆吾身形魁梧，站在一旁。
`, modelAssets);

    expect(covered.addedNames).toEqual(["魁"]);
    expect(covered.assets.filter((asset) => asset.name === "魁")).toHaveLength(1);
  });

  it("removes screenplay directions from characters and reclassifies sound cues", () => {
    const modelAssets = parseExtractedAssetsResponse(JSON.stringify({
      assetsList: [
        { name: "苏灵雨", desc: "女性，黑色长发", prompt: "a young woman, black hair", type: "role" },
        { name: "何为", desc: "男性，黑色制服", prompt: "a young man, black uniform", type: "role" },
        { name: "外界声音窜入", desc: "外界传来的声音", prompt: "distant voice entering", type: "role" },
        { name: "异能局大屏爆红", desc: "屏幕突然变红", prompt: "control room screen turns red", type: "role" },
        { name: "极短字幕", desc: "画面中的短字幕", prompt: "short subtitle", type: "role" },
        { name: "片名砸出", desc: "片名冲击出现", prompt: "title slam reveal", type: "role" },
      ],
    }));

    const corrected = ensureScriptCharacterCoverage(`
人物：苏灵雨、何为
苏灵雨：立刻撤离！
何为转身看向异能局大屏，大屏突然爆红。
外界声音窜入。
极短字幕：危险。
片名砸出。
`, modelAssets);

    expect(corrected.assets.filter((asset) => asset.type === "character").map((asset) => asset.name))
      .toEqual(["苏灵雨", "何为"]);
    expect(corrected.assets.some((asset) => asset.type === "audio" && asset.name === "外界声音"))
      .toBe(true);
    expect(corrected.removedNames).toEqual(["异能局大屏爆红", "极短字幕", "片名砸出"]);
    expect(corrected.reclassifiedAudioNames).toEqual(["外界声音窜入"]);
  });

  it("accepts audio assets returned by the extraction model", () => {
    const assets = parseExtractedAssetsResponse(JSON.stringify({
      assetsList: [
        {
          name: "远处雷声",
          desc: "低沉、遥远并带有空间混响的雷声",
          prompt: "distant low thunder with spacious reverb",
          type: "audio",
        },
      ],
    }));

    expect(assets[0]).toMatchObject({ type: "audio", name: "远处雷声" });
  });

  it("creates storyboard drafts linked to extracted assets", () => {
    const assets = extractAssetsFromScript(script);
    const shots = buildStoryboardDrafts(script, assets);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots[0].status).toBe("draft");
    expect(shots.some((shot) => shot.assetIds.length > 0)).toBe(true);
  });

  it("parses the structured result produced by the system extraction prompt", () => {
    const assets = parseExtractedAssetsResponse(`\`\`\`json
{"assetsList":[{"name":"林默","desc":"男性，黑色短发","prompt":"a young man, black hair","type":"role"}]}
\`\`\``);
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      type: "character",
      name: "林默",
      generationPrompt: "a young man, black hair",
    });
  });

  it("keeps extracted character forms inside the character asset", () => {
    const assets = parseExtractedAssetsResponse(JSON.stringify({
      assetsList: [
        {
          name: "李清颜",
          desc: "女性，冷峻剑修，白衣银发",
          prompt: "female sword cultivator, white robe, silver hair",
          type: "role",
          variants: [
            {
              name: "鸾凤状态",
              desc: "李清颜化身鸾凤，紫色火焰环绕",
              prompt: "phoenix form, purple flames",
            },
          ],
        },
      ],
    }));

    expect(assets).toHaveLength(1);
    expect(assets[0].name).toBe("李清颜");
    expect(assets[0].variants?.[0]).toMatchObject({
      name: "鸾凤状态",
      description: "李清颜化身鸾凤，紫色火焰环绕",
      generationPrompt: "phoenix form, purple flames",
    });
  });

  it("parses resultTool-style wrapped extraction output", () => {
    const assets = parseExtractedAssetsResponse(JSON.stringify({
      name: "resultTool",
      arguments: {
        assetsList: [
          { name: "废弃车站", desc: "夜色中的老车站", prompt: "abandoned train station at night", type: "scene" },
        ],
      },
    }));

    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      type: "scene",
      name: "废弃车站",
    });
  });

  it("parses storyboard shots and binds referenced assets", () => {
    const assets = parseExtractedAssetsResponse(
      `{"assetsList":[{"name":"林默","desc":"黑发青年","prompt":"young man","type":"role"}]}`,
    );
    const shots = parseStoryboardResponse(JSON.stringify({
      shots: [
        {
          title: "分镜 01",
          description: "林默站在雨夜车站",
          shot: "中景",
          duration: "3s",
          camera: "平视缓慢推进",
          imagePrompt: "电影分镜线稿，林默站在雨夜车站，中景，平视缓慢推进",
          assetIds: [assets[0].id],
        },
      ],
    }), assets);

    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({
      title: "分镜 01",
      camera: "平视缓慢推进",
      assetIds: [assets[0].id],
    });
  });

  it("resolves storyboard asset names to ids and backfills explicit name mentions", () => {
    const assets = parseExtractedAssetsResponse(JSON.stringify({
      assetsList: [
        { name: "魁", desc: "男性，受伤的敌人", prompt: "an injured male enemy", type: "role" },
        { name: "陆吾", desc: "男性，身形魁梧", prompt: "a tall muscular man", type: "role" },
      ],
    }));
    const shots = parseStoryboardResponse(JSON.stringify({
      shots: [
        {
          description: "李清颜将魁死死按在地上",
          imagePrompt: "魁的身体被压在焦土上",
          assetIds: ["魁"],
        },
        {
          description: "陆吾身形魁梧，站在山林边缘",
          imagePrompt: "陆吾中景",
          assetIds: [],
        },
        {
          description: "镜头对准魁，李清颜抓住魁后退，随后击中魁胸口",
          imagePrompt: "魁站在焦土上，与魁并肩而立",
          assetIds: [],
        },
      ],
    }), assets);

    const kui = assets.find((asset) => asset.name === "魁")!;
    const luwu = assets.find((asset) => asset.name === "陆吾")!;
    expect(shots[0].assetIds).toContain(kui.id);
    expect(shots[1].assetIds).toContain(luwu.id);
    expect(shots[1].assetIds).not.toContain(kui.id);
    expect(shots[2].assetIds).toContain(kui.id);
  });

  it("parses storyboard JSON wrapped in model prose and a code fence", () => {
    const shots = parseStoryboardResponse(`模型分析完成，分镜如下：
\`\`\`json
{"shots":[{"title":"分镜 01","description":"角色走入雨夜车站","imagePrompt":"雨夜车站电影分镜线稿","assetIds":[]}]}
\`\`\`
以上为最终结果。`, []);

    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({
      title: "分镜 01",
      description: "角色走入雨夜车站",
      prompt: "雨夜车站电影分镜线稿",
    });
  });

  it("normalizes structured camera, action, continuity and negative constraints", () => {
    const shots = parseStoryboardResponse(JSON.stringify({
      result: {
        content: JSON.stringify({
          shots: [
            {
              narrativeGoal: "建立角色与对手的压迫关系",
              durationSec: 3.5,
              camera: {
                shotSize: "wide",
                angle: "low",
                lensMm: 35,
                movement: "slow push-in",
              },
              actionChain: ["角色停步", "抬眼", "握紧剑柄"],
              continuity: {
                fromPrev: "延续上一镜向右运动",
                persistentAnchors: ["黑色长袍", "右手持剑"],
              },
              continuityLocks: {
                identityLock: ["面部不变"],
                lightLock: ["主光保持左后方"],
              },
              prompt: { cn: "低机位广角，角色在逆光中握紧剑柄" },
              negativeConstraints: ["不要换脸", "不要多余肢体"],
            },
          ],
        }),
      },
    }), []);

    expect(shots).toHaveLength(1);
    expect(shots[0].duration).toBe("3.5s");
    expect(shots[0].shot).toBe("wide");
    expect(shots[0].camera).toContain("焦段：35mm");
    expect(shots[0].camera).toContain("运镜：slow push-in");
    expect(shots[0].action).toBe("角色停步 → 抬眼 → 握紧剑柄");
    expect(shots[0].continuity).toContain("承接上镜：延续上一镜向右运动");
    expect(shots[0].continuity).toContain("身份锁定：面部不变");
    expect(shots[0].negativePrompt).toBe("不要换脸；不要多余肢体");
    expect(shots[0].prompt).toBe("低机位广角，角色在逆光中握紧剑柄");
  });

  it("keeps the fusion skill as default and exposes the researched top three", () => {
    expect(defaultStoryboardSkillId).toBe("xiaocai-expression-fusion-v1");
    expect(storyboardSkillOptions.map((skill) => skill.id)).toEqual([
      "xiaocai-expression-fusion-v1",
      "create-storyboard-v1",
      "movieagent-v1",
      "camera-artist-v1",
    ]);
    expect(storyboardSkillOptions.slice(1).map(({ name, score }) => ({ name, score }))).toEqual([
      { name: "Create Storyboard", score: 91 },
      { name: "MovieAgent", score: 90 },
      { name: "Camera Artist", score: 89 },
    ]);
    expect(storyboardSkillOptions.every((skill) => skill.source && skill.prompt.length > 500)).toBe(true);
  });

  it("rejects model output that does not contain extracted script assets", () => {
    expect(() => parseExtractedAssetsResponse("我已经阅读了剧本，可以开始整理素材。"))
      .toThrow("文字模型返回内容无法解析为剧本资产");
  });

  it("only unlocks material sorting after the current script has extracted assets", () => {
    const assets = parseExtractedAssetsResponse(
      `{"assetsList":[{"name":"林默","desc":"男性，黑色短发","prompt":"a young man, black hair","type":"role"}]}`,
    );
    const workflow = {
      version: 1 as const,
      projectId: "project-1",
      scriptName: "demo.txt",
      scriptText: script,
      extractedScriptText: script.trim(),
      extractionCompletedAt: Date.now(),
      assets,
      storyboards: [],
      updatedAt: Date.now(),
    };

    expect(hasCompletedScriptExtraction(workflow)).toBe(true);
    expect(hasCompletedScriptExtraction({ ...workflow, scriptText: `${script}\n新增一场` })).toBe(false);
    expect(hasCompletedScriptExtraction({
      ...workflow,
      assets: assets.map((asset) => ({ ...asset, source: "uploaded" as const })),
    })).toBe(false);
  });
});
