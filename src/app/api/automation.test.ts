import { describe, expect, it } from "vitest";

import { automationTaskNodeId, storyboardTaskFingerprintSource } from "./automation";

describe("automation durable task identity", () => {
  it("uses a versioned 128-bit content fingerprint", () => {
    const first = automationTaskNodeId("extract", "project-a", "魁的身体爆裂开来。");
    const same = automationTaskNodeId("extract", "project-a", "魁的身体爆裂开来。");
    const changed = automationTaskNodeId("extract", "project-a", "魁从地面起身。");

    expect(first).toBe(same);
    expect(first).toMatch(/^automation-extract-project-a-v2-[0-9a-f]{32}$/);
    expect(changed).not.toBe(first);
  });

  it("keeps otherwise identical local projects in separate task scopes", () => {
    const source = storyboardTaskFingerprintSource({
      script: "魁：住手！",
      assets: [],
      storyboardSkillName: "融合版",
    });

    expect(automationTaskNodeId("storyboard-split", "local-project-a", source))
      .not.toBe(automationTaskNodeId("storyboard-split", "local-project-b", source));
  });
});
