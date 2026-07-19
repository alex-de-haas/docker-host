import {
  getAppId,
  getRecoveryParams as readSdkRecoveryParams,
  readAppIdentityToken,
  resolveAppSession,
  type HostyAppConfig,
} from "@hosty-sdk/app/server";
import type { AppSessionStatus, SessionRecoveryParams } from "@hosty-sdk/app";

export const appIdentityCookieName = "hosty_telemetry_identity";

/** This app's SDK configuration: the cookie namespace stays app-owned; system apps keep the
 * raw Host role (the admin gate lives in route-auth). */
export const hostyAppConfig: HostyAppConfig = {
  appIdFallback: "hosty.telemetry",
  identityCookieName: appIdentityCookieName,
};

export type HeaderReader = {
  get(name: string): string | null;
};

/** The SDK session taxonomy: not-present/expired recoverable, forbidden terminal,
 * unavailable transient, misconfigured an operator problem (was the legacy "error"). */
export type TelemetryIdentityStatus = AppSessionStatus;

export type RecoveryParams = SessionRecoveryParams;

export interface TelemetryIdentity {
  status: TelemetryIdentityStatus;
  tokenPresent: boolean;
  appId: string;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  hostRole: string | null;
  expiresAt: string | null;
  error: { code: string; message: string; status: number | null } | null;
}

/** Revalidates the request's identity token against Core via the SDK (30s positive cache,
 * negatives never cached, in-flight dedup) and maps it onto this app's identity shape. */
export async function getTelemetryIdentity(headersList: HeaderReader): Promise<TelemetryIdentity> {
  const token = readAppIdentityToken(headersList, hostyAppConfig);
  const base = { tokenPresent: Boolean(token), appId: getAppId(hostyAppConfig) };
  const resolution = await resolveAppSession(token, hostyAppConfig);

  if (resolution.status !== "active") {
    return {
      ...base,
      status: resolution.status,
      userId: null,
      email: null,
      displayName: null,
      hostRole: null,
      expiresAt: null,
      error: resolution.error
        ? { code: resolution.error.code, message: resolution.error.message, status: resolution.error.status }
        : null,
    };
  }

  return {
    ...base,
    status: "active",
    userId: resolution.identity.userId,
    email: resolution.identity.email,
    displayName: resolution.identity.displayName,
    hostRole: resolution.identity.hostRole,
    expiresAt: resolution.identity.expiresAt,
    error: null,
  };
}

/** Recovery parameters for the identity probe response (request-time env, never baked). */
export function getRecoveryParams(): RecoveryParams {
  return readSdkRecoveryParams(hostyAppConfig);
}

/** Core endpoint builder for this app's service-token calls (not part of the identity flow). */
export function buildCoreEndpoint(path: string): string | null {
  try {
    return new URL(path, process.env.HOSTY_CORE_ORIGIN ?? "http://localhost:7070").toString();
  } catch {
    return null;
  }
}
