import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchInstalledAppIdsFromCore, projectInstalledApp, extractAppIds, extractUpdateStatus } from "@/lib/installed-apps";

describe("extractAppIds", () => {
  it("returns the app ids from a Core installed-apps response", () => {
    expect(extractAppIds({ appIds: ["com.haas.media-server", "com.haas.torrent-engine"] })).toEqual([
      "com.haas.media-server",
      "com.haas.torrent-engine",
    ]);
  });

  it("drops non-string and empty ids", () => {
    expect(extractAppIds({ appIds: ["com.haas.demo-app", "", 42, null, "com.haas.media-server"] })).toEqual([
      "com.haas.demo-app",
      "com.haas.media-server",
    ]);
  });

  it("returns an empty list for an empty or missing set", () => {
    expect(extractAppIds({ appIds: [] })).toEqual([]);
    expect(extractAppIds({})).toEqual([]);
  });

  it.each([null, "string", [], 42, { appIds: "nope" }])("returns [] for malformed payload %#", value => {
    expect(extractAppIds(value)).toEqual([]);
  });
});

describe("extractUpdateStatus", () => {
  it("reads installed/updateAvailable booleans strictly", () => {
    expect(extractUpdateStatus({ appId: "x", installed: true, updateAvailable: true })).toEqual({ installed: true, updateAvailable: true });
    expect(extractUpdateStatus({ installed: true, updateAvailable: false })).toEqual({ installed: true, updateAvailable: false });
    expect(extractUpdateStatus({ installed: false, updateAvailable: false })).toEqual({ installed: false, updateAvailable: false });
  });

  it("treats non-boolean / missing / malformed payloads as not-installed, no-update", () => {
    expect(extractUpdateStatus({ installed: "yes", updateAvailable: 1 })).toEqual({ installed: false, updateAvailable: false });
    expect(extractUpdateStatus({})).toEqual({ installed: false, updateAvailable: false });
    expect(extractUpdateStatus(null)).toEqual({ installed: false, updateAvailable: false });
    expect(extractUpdateStatus("nope")).toEqual({ installed: false, updateAvailable: false });
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("projects only public display fields and installation-bound public Core links", () => {
  vi.stubEnv("HOSTY_CORE_PUBLIC_ORIGIN", "https://core.example.test");
  const shell = { id: "hosty.shell", runtimeState: "running", endpoints: [{ key: "web", public: true, protocol: "http", browserOrigin: "https://shell.example.test" }] };
  const app = projectInstalledApp({ id: "notes", displayName: "Notes", version: "1.2.3", source: "/private/local/source", entryPath: "/notes", entryEndpoint: "web", installationId: "notes-install",
    updateCheck: { updateAvailable: true, targetVersion: "1.3.0", error: "Feed unavailable" } }, shell);
  expect(app.source).toBe("Local install");
  expect(JSON.stringify(app)).not.toContain("/private/local/source");
  expect(app.update).toEqual({ state: "failed", availableVersion: "1.3.0", message: "Feed unavailable" });
  const open = new URL(app.openUrl!); expect(open.origin).toBe("https://core.example.test");
  expect(open.searchParams.get("installationId")).toBe("notes-install");
  expect(open.searchParams.get("route")).toBe("/notes");
  expect(app.manageUrl).toBe("https://shell.example.test/settings?tab=manage%3Anotes&section=app");
});
it("revalidates the user at Core with app credentials and never sends a Core cookie", async () => {
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service"); vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.internal");
  const upstream = vi.fn(async () => Response.json({ apps: [{ id: "local", displayName: "Local", version: "2" }] })); vi.stubGlobal("fetch", upstream);
  const result = await fetchInstalledAppIdsFromCore(new Headers({ "X-Docker-Host-Identity": "identity" }));
  expect(result.apps[0].name).toBe("Local");
  expect(upstream).toHaveBeenCalledWith("http://core.internal/api/apps", expect.objectContaining({ redirect: "error", cache: "no-store", headers: { Authorization: "Bearer service", "X-Hosty-App-Identity": "identity" } }));
});
it.each([401, 403, 503])("does not turn Core refusal %s into an empty installed list", async status => {
  vi.stubEnv("HOSTY_APP_SERVICE_TOKEN", "service"); vi.stubEnv("HOSTY_CORE_ORIGIN", "http://core.internal");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "denied", message: "Core refused" }, { status })));
  await expect(fetchInstalledAppIdsFromCore(new Headers({ "X-Docker-Host-Identity": "identity" }))).rejects.toMatchObject({ status, code: "denied" });
});
it("does not use service credentials alone for the richer installed list", async () => {
  const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
  await expect(fetchInstalledAppIdsFromCore(new Headers())).rejects.toMatchObject({ status: 401 });
  expect(upstream).not.toHaveBeenCalled();
});

it("names the execution engine rather than a publisher's runtime profile key", () => {
  expect(projectInstalledApp({ id: "notes", selectedRuntime: "production", runtimeProfiles: [{ key: "production", type: "docker" }] }).runtime).toBe("docker");
  expect(projectInstalledApp({ id: "notes", selectedRuntime: "custom", runtimeProfiles: [{ key: "custom", type: "localCommand" }] }).runtime).toBe("local");
  expect(projectInstalledApp({ id: "notes", selectedRuntime: "unknown" }).runtime).toBeNull();
});
