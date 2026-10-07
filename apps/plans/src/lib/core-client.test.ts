import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@hosty-sdk/app/server", () => ({
  getAppId: () => "hosty.plans", getCoreOrigin: () => "http://core.example",
  getRecoveryParams: vi.fn(), readAppIdentityToken: vi.fn(), resolveAppSession: vi.fn(),
}));
import { CoreSourceReader } from "./core-client";
import type { DocumentListing } from "./types";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("Core focused document contract", () => {
  it("sends the focused path and version as query values with both current credentials", async () => {
    const listing: DocumentListing = { repositoryId: "canonical", version: "base", workspaceId: "workspace", commit: "base-commit", documents: [], state: "available", error: null };
    const fetch = vi.fn(async () => Response.json(listing));
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service-test-token");
    const reader = new CoreSourceReader("acting-admin-test-token");
    const documentPath = "docs/features/title & summary/plan.md";
    await reader.listing("repo/branch", "base", "workspace", true, documentPath);
    const [url, options] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/api/internal/apps/hosty.plans/source-documents/repositories/repo%2Fbranch/documents");
    expect(Object.fromEntries(url.searchParams)).toEqual({ version: "base", workspaceId: "workspace", refresh: "true", path: documentPath });
    expect(options).toMatchObject({ headers: { Authorization: "Bearer service-test-token", "X-Hosty-User-Token": "acting-admin-test-token" }, cache: "no-store", redirect: "error" });
    await reader.content("canonical", documentPath, listing, "listed-sha");
    const [contentUrl] = fetch.mock.calls[1] as unknown as [URL, RequestInit];
    expect(Object.fromEntries(contentUrl.searchParams)).toEqual({ version: "base", workspaceId: "workspace", commit: "base-commit", expectedSha: "listed-sha", path: documentPath });
  });
});
