/** Native predictions are optional plain text, never another model turn or tool request. */
export const SUGGESTION_DEADLINE_MS = 30_000;
export const SUGGESTION_TTL_MS = 15 * 60_000;
export type SuggestionReason = "unavailable" | "unsupported" | "timeout";
export type PromptSuggestion = { type: "prompt_suggestion"; text: string | null; reason?: SuggestionReason };
export function suggestionText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 4_000
    || [...value].length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return null;
  return value.trim();
}
export function successfulResult(status: string): boolean { return status === "success"; }
