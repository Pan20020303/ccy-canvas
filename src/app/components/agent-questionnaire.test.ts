import { describe, expect, it } from "vitest";
import {
  buildQuestionnaireReply,
  firstUnansweredQuestionIndex,
  selectQuestionAnswer,
  type AgentQuestionPage,
} from "./agent-questionnaire";

const questions: AgentQuestionPage[] = [
  {
    id: "q1",
    question: "选择宣传片类型？",
    options: ["玩法一", "玩法二"],
    allowCustom: true,
  },
  {
    id: "q2",
    question: "主题是什么？",
    options: ["都市", "奇幻"],
    allowCustom: true,
  },
];

describe("agent questionnaire", () => {
  it("keeps answers attached to their question while paging", () => {
    const answered = selectQuestionAnswer(questions, "q1", "玩法二");

    expect(answered[0].selectedAnswer).toBe("玩法二");
    expect(answered[1].selectedAnswer).toBeUndefined();
    expect(firstUnansweredQuestionIndex(answered)).toBe(1);
  });

  it("waits for every answer before building the continuation message", () => {
    const firstAnswered = selectQuestionAnswer(questions, "q1", "玩法一");
    expect(buildQuestionnaireReply(firstAnswered, "zh")).toBeNull();

    const allAnswered = selectQuestionAnswer(firstAnswered, "q2", "奇幻");
    expect(buildQuestionnaireReply(allAnswered, "zh")).toContain("1. 选择宣传片类型？");
    expect(buildQuestionnaireReply(allAnswered, "zh")).toContain("回答：奇幻");
  });
});
