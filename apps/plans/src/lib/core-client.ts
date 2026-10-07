import { getAppId, getCoreOrigin } from "@hosty-sdk/app/server";
import { config, PlansError } from "./auth";
import type { SourceRepository, DocumentListing, DocumentContent, DocumentVersion, Workspace } from "./types";

// Allow Core's 30-second fetch plus bounded local metadata, queue and response work.
const CORE_SOURCE_TIMEOUT_MS = 75_000;

export interface SourceReader {
  repositories(): Promise<SourceRepository[]>;
  listing(repositoryId: string, version?: DocumentVersion, workspaceId?: string, refresh?: boolean, documentPath?: string): Promise<DocumentListing>;
  content(repositoryId: string, path: string, listing: DocumentListing, sha: string): Promise<DocumentContent>;
  workspaces(repositoryId?: string): Promise<Workspace[]>;
}
export class CoreSourceReader implements SourceReader {
  constructor(private readonly credential: string, private readonly signal?: AbortSignal) {}
  private async get<T>(path: string, query = new URLSearchParams()): Promise<T> {
    const origin = getCoreOrigin();
    const service = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
    if (!origin || !service) throw new PlansError("Core source access is not configured. Start Plans through Hosty.", 503, "core_unconfigured");
    const url = new URL(`/api/internal/apps/${encodeURIComponent(getAppId(config))}/source-documents/${path}`, origin);
    url.search = query.toString();
    let response: Response;
    try {
      const deadline = AbortSignal.timeout(CORE_SOURCE_TIMEOUT_MS);
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${service}`, "X-Hosty-User-Token": this.credential },
        cache: "no-store", redirect: "error", signal: this.signal ? AbortSignal.any([this.signal, deadline]) : deadline,
      });
    } catch { throw new PlansError("Core source access is unavailable. Try again."); }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: string; code?: string; error?: string } | null;
      throw new PlansError(body?.message ?? body?.error ?? `Core source read returned HTTP ${response.status}.`, response.status, body?.code);
    }
    return response.json() as Promise<T>;
  }
  async repositories() { return (await this.get<{ repositories: SourceRepository[] }>("repositories")).repositories; }
  async listing(repositoryId: string, version: DocumentVersion = "target", workspaceId?: string, refresh = false, documentPath?: string) {
    const query = new URLSearchParams({ version });
    if (workspaceId) query.set("workspaceId", workspaceId);
    if (refresh) query.set("refresh", "true");
    if (documentPath) query.set("path", documentPath);
    return this.get<DocumentListing>(`repositories/${encodeURIComponent(repositoryId)}/documents`, query);
  }
  async content(repositoryId: string, path: string, listing: DocumentListing, sha: string) {
    const query = new URLSearchParams({ path, version: listing.version, expectedSha: sha });
    if (listing.workspaceId) query.set("workspaceId", listing.workspaceId);
    if (listing.commit) query.set("commit", listing.commit);
    return this.get<DocumentContent>(`repositories/${encodeURIComponent(repositoryId)}/content`, query);
  }
  async workspaces(repositoryId?: string) { return (await this.get<{ workspaces: Workspace[] }>("workspaces", new URLSearchParams(repositoryId ? { repositoryId } : {}))).workspaces; }
}
