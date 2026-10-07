import { fetchCore } from "../core-transport.js";
import { CoreRequestError, readCoreErrorDetail, redirectToCoreLoginIfAuthRequired } from "../core-api";

export type SourceConnection = {
  id: string; label: string; provider: string; organization: string; accountId: string; accountName: string;
  method: string; status: string; checkedAt?: string; expiresAt?: string;
};
export type SourceProfile = {
  gitIdentity?: { name: string; email: string }; connections: SourceConnection[];
  providers: { id: string; displayName: string; authenticationMethods: string[]; capabilities: string[] }[];
};
export type SourceSend = (url: string, body: unknown, method?: string) => Promise<Response>;

export function createSourceConnectionsApi(coreOrigin: string, sendCsrfJson: SourceSend) {
  const check = async (response: Response) => {
    redirectToCoreLoginIfAuthRequired(response, coreOrigin);
    if (!response.ok) {
      const error = await readCoreErrorDetail(response);
      throw new CoreRequestError(error.message, error.code, response.status, error.body);
    }
    return response;
  };
  return {
    call: async (path: string, init?: RequestInit) => check(await fetchCore(`${coreOrigin}/api${path}`, { cache: "no-store", ...init })),
    send: async (path: string, body?: unknown, method = "POST") => check(await sendCsrfJson(`${coreOrigin}/api${path}`, body, method)),
  };
}
