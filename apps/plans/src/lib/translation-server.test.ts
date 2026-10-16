import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "@hosty-sdk/app/providers";
import { PlansError } from "./auth";
import { translateDocument, translationOptions } from "./translation-server";
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), list: vi.fn(), capabilities: vi.fn(), translate: vi.fn(),
  repositories: vi.fn(), workspaces: vi.fn(), listing: vi.fn(), content: vi.fn() }));
vi.mock("./auth", async original => ({ ...await original<typeof import("./auth")>(), requireAdministratorIdentity: mocks.authenticate }));
vi.mock("@hosty-sdk/app/providers/server", () => ({ ProviderClient: class { list = mocks.list; translationCapabilities = mocks.capabilities; translate = mocks.translate; } }));
vi.mock("./core-client", () => ({ CoreSourceReader: class { repositories = mocks.repositories; workspaces = mocks.workspaces; listing = mocks.listing; content = mocks.content; } }));
const content = "---\nstatus: Ready\n---\n# Plan\n\n## Deliverables\n- [ ] D1. Read **this**.\n";
const translated = content.replace("# Plan", "# План").replace("Deliverables", "Результаты").replace("Read **this**.", "Прочитать **это**.");
const input = { repositoryId: "repo", path: "docs/features/example/plan.md", workspaceId: null,
  contentHash: createHash("sha256").update(content).digest("hex"), providerAppId: "hosty.harness", installationId: "installation", key: "claude", targetLanguage: "ru" };
const provider = { appId: input.providerAppId, key: input.key, installationId: input.installationId, displayName: "Harness", kind: "translation", version: 1, capabilities: ["markdown"], available: true, url: "http://private-service/api/translation" };
function request(value: unknown = input, origin = "https://plans.example", signal?: AbortSignal) {
  return new Request("https://plans.example/api/translation", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(value), signal });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "https://core.example");
  mocks.authenticate.mockResolvedValue({ token: "user-token", userId: "admin" });
  mocks.list.mockResolvedValue([provider]); mocks.capabilities.mockResolvedValue({ ready: true, formats: ["markdown"] });
  mocks.repositories.mockResolvedValue([{ id: "repo" }]); mocks.workspaces.mockResolvedValue([{ id: "workspace" }]);
  mocks.listing.mockResolvedValue({ documents: [{ path: input.path, sha: "sha" }] });
  mocks.content.mockResolvedValue({ path: input.path, sha: "sha", content });
  mocks.translate.mockResolvedValue({ text: translated, targetLanguage: "ru", sourceLanguage: "auto" });
});
afterEach(() => vi.unstubAllEnvs());
describe("plan translations", () => {
  it("discovers both keys and readiness without exposing provider URLs or credentials", async () => {
    mocks.list.mockResolvedValue([provider, { ...provider, key: "codex" }]);
    mocks.capabilities.mockResolvedValueOnce({ ready: false, formats: ["markdown"], reason: "Choose a connection." });
    const response = await translationOptions(new Request("https://plans.example/api/translation"));
    const body = await response.json();
    expect(body.providers.map((p: { key: string }) => p.key)).toEqual(["claude", "codex"]);
    expect(body.providers[0].problem).toBe("Choose a connection.");
    expect(JSON.stringify(body)).not.toContain("private-service"); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("translates exact current Markdown through the chosen installation without reparsing translated headings", async () => {
    const response = await translateDocument(request());
    expect(response.status).toBe(200);
    const body = await response.json(); expect(body.body).toContain("## Результаты"); expect(body.body).not.toContain("status:");
    expect(body.contentHash).toBe(input.contentHash);
    expect(mocks.translate).toHaveBeenCalledWith(provider, { text: content, format: "markdown", targetLanguage: "ru" }, expect.any(AbortSignal));
  });
  it("reads the selected workspace without falling back to tracked source", async () => {
    expect((await translateDocument(request({ ...input, workspaceId: "workspace" }))).status).toBe(200);
    expect(mocks.listing).toHaveBeenCalledWith("repo", "worktree", "workspace", false, input.path);
    mocks.workspaces.mockResolvedValue([]); mocks.translate.mockClear();
    expect((await translateDocument(request({ ...input, workspaceId: "deleted" }))).status).toBe(404);
    expect(mocks.translate).not.toHaveBeenCalled();
  });
  it.each(["https://other.example", "null", ""]) ("refuses cross-origin requests: %s", async origin => {
    expect((await translateDocument(request(input, origin))).status).toBe(403); expect(mocks.translate).not.toHaveBeenCalled();
  });
  it("requires current administrator and optional provider permission", async () => {
    mocks.authenticate.mockRejectedValueOnce(new PlansError("Admin required", 403, "administrator_required"));
    expect((await translateDocument(request())).status).toBe(403); expect(mocks.list).not.toHaveBeenCalled();
    mocks.list.mockRejectedValue(new ProviderError("app_permission_required", "Denied", 403));
    const response = await translateDocument(request()); expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reviewUrl: expect.stringContaining("core.example"), message: expect.stringContaining("Translation") });
    expect(mocks.translate).not.toHaveBeenCalled();
  });
  it("refuses changed or deleted source before inference", async () => {
    mocks.content.mockResolvedValueOnce({ path: input.path, sha: "sha", content: content + "changed" });
    expect((await translateDocument(request())).status).toBe(409);
    mocks.listing.mockResolvedValue({ documents: [] }); expect((await translateDocument(request())).status).toBe(404);
    expect(mocks.translate).not.toHaveBeenCalled();
  });
  it("refuses a replaced or incompatible provider without fallback", async () => {
    mocks.list.mockResolvedValueOnce([{ ...provider, installationId: "new" }]); expect((await translateDocument(request())).status).toBe(409);
    mocks.list.mockResolvedValueOnce([{ ...provider, capabilities: ["text"] }]); expect((await translateDocument(request())).status).toBe(409);
    expect(mocks.translate).not.toHaveBeenCalled();
  });
  it.each([{ path: "docs/../secret.md" }, { targetLanguage: "auto" }, { targetLanguage: "ru extra" }, { contentHash: "bad" }])("rejects invalid input %j", async change => {
    expect((await translateDocument(request({ ...input, ...change }))).status).toBe(400); expect(mocks.list).not.toHaveBeenCalled();
  });
  it("returns provider errors without retry and forwards cancellation", async () => {
    mocks.translate.mockRejectedValue(new ProviderError("translation_markdown_changed", "Markdown changed", 502));
    const controller = new AbortController(); const response = await translateDocument(request(input, "https://plans.example", controller.signal));
    expect(response.status).toBe(502); expect(mocks.translate).toHaveBeenCalledTimes(1);
    controller.abort(); expect(mocks.translate.mock.calls[0][2].aborted).toBe(true);
  });
});
