import type { IncomingMessage } from "node:http";
import { readAppCredential } from "./app-session.js";

/** The app session identifies the user; Core's assistant-target grant supplies MCP authority. */
export async function delegationCredential(request: IncomingMessage, _required = true): Promise<string | undefined> {
  const bearer = request.headers.authorization?.replace(/^Bearer /i, "");
  if (bearer?.startsWith("hosty_delegated.")) return bearer;
  return readAppCredential(request) ?? undefined;
}
