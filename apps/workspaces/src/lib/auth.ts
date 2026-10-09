import { getAppId, getRecoveryParams, readAppIdentityToken, resolveAppSession, type HostyAppConfig } from "@hosty-sdk/app/server";

export const config: HostyAppConfig = { appIdFallback: "hosty.workspaces", identityCookieName: "hosty_workspaces_identity" };
export async function getIdentity(headers: Headers) {
  const token = readAppIdentityToken(headers, config);
  const session = await resolveAppSession(token, config);
  const base = { tokenPresent: Boolean(token), appId: getAppId(config), recovery: await getRecoveryParams(config) };
  return session.status === "active" ? { ...base, status: "active" as const, ...session.identity } : { ...base, status: session.status, error: session.error };
}
export class WorkspacesError extends Error {
  constructor(message: string, public status = 503, public code = "workspaces_unavailable") { super(message); }
}
export async function requireAdministrator(headers: Headers): Promise<string> {
  return (await requireAdministratorIdentity(headers)).token;
}
export async function requireAdministratorIdentity(headers: Headers): Promise<{ token: string; userId: string }> {
  const token = readAppIdentityToken(headers, config);
  const session = await resolveAppSession(token, config);
  if (session.status === "active") {
    if (session.identity.hostRole !== "host.admin") throw new WorkspacesError("Workspaces is available only to Hosty administrators.", 403, "administrator_required");
    return { token: token!, userId: session.identity.userId };
  }
  if (session.status === "not-present" || session.status === "expired") throw new WorkspacesError("Sign in through Hosty to read workspaces.", 401, "app_identity_required");
  if (session.status === "forbidden") throw new WorkspacesError(session.error?.message ?? "This app session is not allowed.", 403, session.error?.code);
  throw new WorkspacesError(session.error?.message ?? "Hosty could not verify this session.", 503, session.error?.code);
}
export function errorResponse(error: unknown) {
  const known = error instanceof WorkspacesError ? error : new WorkspacesError("Workspace information is unavailable. Try again.");
  return Response.json({ code: known.code, message: known.message }, { status: known.status, headers: { "Cache-Control": "no-store" } });
}
