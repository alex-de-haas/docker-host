// Delegated-token validation, in its own entry so plain Node services (not just Next apps) can
// import it: the server slice pulls in "server-only", which throws outside a React server bundle.
import { createPublicKey, verify as verifySignature } from "node:crypto";

// --- Delegated tokens ----------------------------------------------------------------------------
// Short-TTL signed tokens a browser client (Shell) presents when calling a system app's API
// directly (docs/features/ai-gateway/plan.md). Core signs with ECDSA P-256 and injects the
// verification key as HOSTY_DELEGATED_TOKEN_PUBLIC_KEY (base64 SubjectPublicKeyInfo DER), so
// validation is fully local — no Core round-trip. Format:
//   hosty_delegated.1.<b64url(claims json)>.<b64url(IEEE P1363 signature over "hosty_delegated.1.<claims>")>

export interface DelegatedTokenClaims {
  /** Acting Host user id. */
  sub: string;
  /** The actor's Host role at issuance (e.g. "host.admin"); gate admin surfaces on it. */
  role: string;
  /** Audience app id — must equal this app's own id. */
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface ValidateDelegatedTokenOptions {
  /** Audience to require; defaults to HOSTY_APP_ID. Validation fails when neither is set. */
  appId?: string;
  /** Base64 SPKI verification key; defaults to HOSTY_DELEGATED_TOKEN_PUBLIC_KEY. */
  publicKey?: string;
  /** Clock override for tests, ms since epoch. */
  nowMs?: number;
}

const DELEGATED_TOKEN_PREFIX = "hosty_delegated";
const DELEGATED_TOKEN_VERSION = "1";

/** Validates a delegated token locally and returns its claims, or null for anything invalid:
 * bad format, unknown key, wrong audience, expiry, or signature mismatch. Deliberately never
 * throws — a route treats null exactly like a missing token (401). */
export function validateDelegatedToken(
  token: string,
  options: ValidateDelegatedTokenOptions = {},
): DelegatedTokenClaims | null {
  const publicKeyBase64 = options.publicKey?.trim() || process.env.HOSTY_DELEGATED_TOKEN_PUBLIC_KEY?.trim();
  const expectedAppId = options.appId?.trim() || process.env.HOSTY_APP_ID?.trim();
  if (!publicKeyBase64 || !expectedAppId) {
    return null;
  }

  const parts = token.split(".");
  const [prefix, version, payloadPart, signaturePart] = parts;
  if (
    parts.length !== 4 ||
    prefix !== DELEGATED_TOKEN_PREFIX ||
    version !== DELEGATED_TOKEN_VERSION ||
    payloadPart === undefined ||
    signaturePart === undefined
  ) {
    return null;
  }

  try {
    const signingInput = `${prefix}.${version}.${payloadPart}`;
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    const signatureValid = verifySignature(
      "sha256",
      Buffer.from(signingInput, "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signaturePart, "base64url"),
    );
    if (!signatureValid) {
      return null;
    }

    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Partial<DelegatedTokenClaims>;
    if (
      typeof claims.sub !== "string" ||
      typeof claims.role !== "string" ||
      typeof claims.aud !== "string" ||
      typeof claims.exp !== "number"
    ) {
      return null;
    }

    if (claims.aud !== expectedAppId) {
      return null;
    }

    const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
    if (claims.exp <= nowSeconds) {
      return null;
    }

    return claims as DelegatedTokenClaims;
  } catch {
    return null;
  }
}
