import { AgentApiError, type AgentPendingDecision, type AgentResponseInput } from "@hosty-sdk/app/agent";

/** Resolve stable option IDs only against the exact provider-owned pending schema. */
export function questionAnswers(decision: AgentPendingDecision, response: AgentResponseInput["response"]): Record<string, string> {
  if (decision.kind !== response.kind) throw new AgentApiError("invalid_response", "Response kind does not match this pending decision.", 422);
  if (response.kind === "approval") return {};
  const questions = decision.questions ?? [], known = new Set(questions.map(question => question.id));
  if (Object.keys(response.answers).some(id => !known.has(id))) throw new AgentApiError("invalid_response", "An answer names an unknown question.", 422);
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const raw = response.answers[question.id];
    if (raw === undefined) { if (question.required !== false) throw new AgentApiError("invalid_response", "Answer every required question.", 422); continue; }
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length || values.length > 128 || !question.multiple && values.length !== 1) throw new AgentApiError("invalid_response", "The question does not accept that number of choices.", 422);
    const resolved = values.map(value => {
      if (typeof value !== "string" || Buffer.byteLength(value) > 65536) throw new AgentApiError("invalid_response", "Question answers must be bounded text.", 422);
      const exact = question.options?.find(option => option.id === value), labels = question.options?.filter(option => option.label === value) ?? [];
      if (!exact && labels.length > 1) throw new AgentApiError("invalid_response", "Choose a stable option ID when labels repeat.", 422);
      const option = exact ?? labels[0];
      if (option) return question.options!.filter(other => other.label === option.label).length > 1 ? `${option.label} [${option.id}]` : option.label;
      if (question.allowText === false || !value.trim()) throw new AgentApiError("invalid_response", "Choose a declared option or supply permitted free text.", 422);
      return value;
    });
    if (new Set(resolved).size !== resolved.length) throw new AgentApiError("invalid_response", "Question choices must be distinct.", 422);
    answers[question.id] = resolved.join(", ");
  }
  return answers;
}
