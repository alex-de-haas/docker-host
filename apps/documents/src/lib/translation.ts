export type TranslationChoice = { appId: string; key: string; installationId: string; displayName: string; problem: string | null };
export type TranslationOptions = { userId: string; providers: TranslationChoice[] };
export type TranslationInput = {
  repositoryId: string; path: string; workspaceId: string | null; contentHash: string;
  providerAppId: string; installationId: string; key: string; targetLanguage: string;
};
export type PlanTranslation = { body: string; contentHash: string; targetLanguage: string; providerAppId: string; key: string };
export const TRANSLATION_LANGUAGES = [
  ["ru", "Russian"], ["en", "English"], ["nl", "Dutch"], ["de", "German"], ["fr", "French"],
  ["es", "Spanish"], ["it", "Italian"], ["pt", "Portuguese"], ["uk", "Ukrainian"], ["ja", "Japanese"], ["zh", "Chinese"],
] as const;
export function validTargetLanguage(value: unknown): value is string {
  return typeof value === "string" && value.length <= 63 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value) && value.toLowerCase() !== "auto";
}

// A translated heading is prose, not an English workflow field to parse again.
export function translationBody(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}
