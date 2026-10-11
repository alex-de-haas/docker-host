/** Server-advertised authority, never inferred from embedding or a missing activity deadline. */
export type AppContinuity = {
  version: 1; mode: "browser" | "native"; grantId: string; expiresAt: string; checkAfterSeconds: number;
};

export function readAppContinuity(value: unknown): AppContinuity | undefined {
  const v = value as Partial<AppContinuity> | null;
  if (v?.version !== 1 || !["browser", "native"].includes(v.mode ?? "") ||
      typeof v.grantId !== "string" || !v.grantId || v.grantId.length > 128 ||
      typeof v.expiresAt !== "string" || !Number.isFinite(Date.parse(v.expiresAt)) ||
      typeof v.checkAfterSeconds !== "number" || !Number.isFinite(v.checkAfterSeconds)) return;
  return { ...v, checkAfterSeconds: Math.max(60, Math.min(300, v.checkAfterSeconds)) } as AppContinuity;
}
