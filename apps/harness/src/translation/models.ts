/** Suggestions, not an account entitlement catalog. Operators may supply another native model ID. */
export const TRANSLATION_MODELS = {
  codex: [
    { id: "gpt-6-luna", label: "GPT-6 Luna" },
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { id: "gpt-6-sol", label: "GPT-6 Sol" },
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  ],
  claude: [
    { id: "claude-haiku-5-5", label: "Haiku 5.5" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    { id: "haiku", label: "Haiku (agent alias)" },
    { id: "sonnet", label: "Sonnet (agent alias)" },
    { id: "opus", label: "Opus (agent alias)" },
  ],
} as const;

export function isTranslationModel(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value));
}
