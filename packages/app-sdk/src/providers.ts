/** Provider categories supported by Core. Task execution does not expose model/profile configuration. */
export type ProviderKind = "speech-to-text" | "assistant" | "translation" | "tasks" | "task-executor";
export type ProviderDescriptor = {
  appId: string; displayName: string; kind: ProviderKind; key: string;
  version: number | null; capabilities: string[]; url: string | null; available: boolean;
  /** Declared browser surfaces for resolving assistant handoffs; absent on older Core versions. */
  uiSurfaces?: Array<{ endpoint: string | null; path: string; url: string | null;
    kind?: "panel" | "navigation" | "entrypoint"; panelId?: string | null }> | null;
  /** Opaque Core installation identity; compare for equality, never parse. */
  installationId?: string | null;
};
export type AppPermissionState = { required: string[]; optional: string[]; granted: string[]; reviewAvailable?: boolean; unsupportedRequired?: string[]; status?: string };
export type ProviderInvocation = { callerAppId: string; callerInstallation: string; userId: string | null; hostRole: string | null; kind: ProviderKind; key: string };
export type SpeechResult = { text: string; language?: string | null };
export type SpeechCapabilities = { version: 1; mediaTypes: string[]; maxBytes: number; maxDurationSeconds: number; backend: string; ready: boolean };
export type TranslationRequest = { text: string; targetLanguage: string; sourceLanguage?: string; format?: "text" | "markdown" };
export type TranslationResult = { text: string; targetLanguage: string; sourceLanguage: string };
export type TranslationCapabilities = { version: 1; formats: string[]; maxCharacters: number; maxSegmentCharacters: number; maxBytes: number; maxOutputBytes: number; timeoutSeconds: number; backend: string; ready: boolean; reason?: string };

/** Errors retain Core/provider codes so consumers can distinguish denial from unavailable service. */
export class ProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
}
