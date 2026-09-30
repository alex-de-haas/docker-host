/** Provider categories supported by Core. Agent execution is intentionally not part of this contract. */
export type ProviderKind = "speech-to-text" | "assistant";
export type ProviderDescriptor = {
  appId: string; displayName: string; kind: ProviderKind; key: string;
  version: number | null; capabilities: string[]; url: string | null; available: boolean;
};
export type AppPermissionState = { required: string[]; optional: string[]; granted: string[]; reviewAvailable?: boolean };
export type ProviderInvocation = { callerAppId: string; callerInstallation: string; userId: string | null; hostRole: string | null; kind: ProviderKind; key: string };
export type SpeechResult = { text: string; language?: string | null };
export type SpeechCapabilities = { version: 1; mediaTypes: string[]; maxBytes: number; maxDurationSeconds: number; backend: string; ready: boolean };

/** Errors retain Core/provider codes so consumers can distinguish denial from unavailable service. */
export class ProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) { super(message); }
}
