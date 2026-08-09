import type { IncomingMessage } from "node:http";
import { validateDelegatedToken, type DelegatedTokenClaims } from "@hosty-sdk/app/delegated";

// Operator sessions are admin-only by decision (docs/features/ai-gateway/plan.md, Execution
// Profiles): the profile's enforcement boundary is who can hold a session at all, so every API
// route requires a delegated token whose actor carries the host.admin role. Validation is fully
// local (Core-injected public key); a missing key or a non-admin actor both read as "no access".
const ADMIN_ROLE = "host.admin";

export function resolveAdmin(request: IncomingMessage): DelegatedTokenClaims | null {
  const authorization = request.headers.authorization;
  if (!authorization?.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const claims = validateDelegatedToken(authorization.slice("bearer ".length).trim());
  if (!claims || claims.role !== ADMIN_ROLE) {
    return null;
  }

  return claims;
}
