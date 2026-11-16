import type { HarnessQuestion } from "@hosty/agent-provider-runtime/harness/adapter";
export { questionAnswers } from "@hosty/agent-provider-runtime/harness/questions";

/** Normalize only known provider fields. Never publish secret questions or silently drop a question. */
export function readNativeQuestions(input: Record<string, unknown>): HarnessQuestion[] {
  if (Buffer.byteLength(JSON.stringify(input)) > 65_536 || !Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4)
    throw new Error("Provide one to four bounded questions.");
  const ids = new Set<string>();
  return input.questions.map((value: unknown, index: number) => {
    const q = value as Record<string, unknown> | null;
    if (q?.isSecret === true) throw new Error("Secret questions are unsupported. Use the owning application's secure credential setup.");
    if (!q || !bounded(q.question, 4000) || typeof q.header !== "string" || q.header.length > 100)
      throw new Error("The question cannot be displayed safely.");
    const id = `q${index + 1}`;
    if (!bounded(id, 100) || ids.has(id)) throw new Error("Questions require distinct stable IDs.");
    ids.add(id);
    if (q.options != null && !Array.isArray(q.options)) throw new Error("Question options must be an array.");
    const raw = (q.options ?? []) as unknown[];
    if (raw.length > 8) throw new Error("A question supports at most eight options.");
    const options = raw.map((value, optionIndex) => {
      const option = value as Record<string, unknown> | null;
      if (!option || !bounded(option.label, 500) || typeof option.description !== "string" || option.description.length > 2000)
        throw new Error("An option cannot be displayed safely.");
      return { id: `o${optionIndex + 1}`, label: option.label, description: option.description,
        ...(typeof option.preview === "string" && option.preview.length <= 8000 ? { preview: option.preview } : {}) };
    });
    return { id, question: q.question, header: q.header, multiSelect: q.multiSelect === true,
      allowText: true, options };
  });
}
function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= maximum && !value.includes("\0");
}
