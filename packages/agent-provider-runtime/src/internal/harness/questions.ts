import type { HarnessQuestion } from "./adapter.js";

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= maximum && !value.includes("\0");
}
/** Legacy text keys are accepted only when their wording is unique. */
export function questionAnswers(questions: HarnessQuestion[], answers: Record<string, string>): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const question of questions) {
    const key = question.id ?? question.question;
    const answer = answers[key] ?? (questions.filter(q => q.question === question.question).length === 1 ? answers[question.question] : undefined);
    // Selected labels can accompany a bounded 4,000-character text answer.
    if (!bounded(answer, 12000)) return null;
    result[key] = answer;
  }
  return result;
}
