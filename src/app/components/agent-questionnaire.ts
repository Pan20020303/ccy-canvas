export type AgentQuestionPage = {
  id: string;
  question: string;
  options: string[];
  allowCustom: boolean;
  selectedAnswer?: string;
};

export function selectQuestionAnswer<T extends AgentQuestionPage>(
  questions: T[],
  questionId: string,
  answer: string,
): T[] {
  return questions.map((question) =>
    question.id === questionId
      ? { ...question, selectedAnswer: answer.trim() }
      : question,
  );
}

export function firstUnansweredQuestionIndex(questions: AgentQuestionPage[]): number {
  return questions.findIndex((question) => !question.selectedAnswer?.trim());
}

export function buildQuestionnaireReply(
  questions: AgentQuestionPage[],
  locale: "zh" | "en",
): string | null {
  if (questions.length === 0 || firstUnansweredQuestionIndex(questions) >= 0) return null;

  if (locale === "zh") {
    return [
      "以下是我对确认问题的逐项回答：",
      ...questions.flatMap((question, index) => [
        `${index + 1}. ${question.question}`,
        `回答：${question.selectedAnswer}`,
      ]),
    ].join("\n");
  }

  return [
    "Here are my answers to each question:",
    ...questions.flatMap((question, index) => [
      `${index + 1}. ${question.question}`,
      `Answer: ${question.selectedAnswer}`,
    ]),
  ].join("\n");
}
