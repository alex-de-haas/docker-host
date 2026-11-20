export const speechKinds = ["speech-to-text", "text-to-speech"] as const;
export type SpeechKind = typeof speechKinds[number];
export type SpeechRef = { appId: string; installationId: string; key: string; implementationId?: string | null };
export type SpeechChoice = SpeechRef & { displayName: string };
export type SpeechOption = SpeechChoice & { available: boolean };
export type SpeechRoster = {
  granted: boolean; requestable: boolean; reviewAvailable?: boolean;
  providers: SpeechOption[]; selected: SpeechChoice | null; binding: string | null;
};
export type SpeechSettings = {
  account: string; revision: number; roles: Record<SpeechKind, SpeechRoster>;
};

export function sameSpeechChoice(a: SpeechRef, b: SpeechRef): boolean {
  return a.appId === b.appId && a.installationId === b.installationId && a.key === b.key
    && (a.implementationId ?? null) === (b.implementationId ?? null);
}
export function currentSpeechOption(roster: SpeechRoster) {
  const { selected } = roster;
  return selected && roster.providers.find(option => sameSpeechChoice(option, selected));
}
