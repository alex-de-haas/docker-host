import type { ProviderRef } from "@hosty-sdk/app/agent-sessions";

export function sameProviderRef(a: ProviderRef | null | undefined, b: ProviderRef | null | undefined): boolean {
  return !!a && !!b && a.appId === b.appId && a.installationId === b.installationId && a.key === b.key
    && (a.implementationId ?? null) === (b.implementationId ?? null);
}

/** Keep the existing three elements for static references and extend only named identities. */
export function providerIdentityParts(ref: ProviderRef): string[] {
  const parts = [ref.appId, ref.installationId, ref.key];
  if (ref.implementationId != null) parts.push(ref.implementationId);
  return parts;
}
