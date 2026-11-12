import { beforeEach, expect, it, vi } from "vitest";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { AssistantApiError, getStorageRecovery } from "./assistant-api";
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: vi.fn(), APP_SESSION_RESTORED: "restored" }));
beforeEach(() => vi.resetAllMocks());
const issue = { sessionId: "chat", code: "session_storage_unavailable", message: "Storage needs recovery" };

it("loads the authenticated same-origin recovery inventory without caching", async () => {
  const report = { issues: [issue], projectionIssues: [{ ...issue, code: "history_projection_unavailable" }] };
  vi.mocked(appFetch).mockResolvedValue(Response.json(report));
  const signal = new AbortController().signal;
  expect(await getStorageRecovery(signal)).toEqual(report);
  expect(appFetch).toHaveBeenCalledExactlyOnceWith("/api/storage-recovery", expect.objectContaining({ cache: "no-store", signal }));
});

it.each([404, 405, 501])("treats only an older unsupported endpoint as unavailable: %s", async status => {
  vi.mocked(appFetch).mockResolvedValue(Response.json({ message: "Unavailable" }, { status }));
  expect(await getStorageRecovery()).toBeNull();
});

it("retains a real refusal instead of presenting an empty healthy inventory", async () => {
  vi.mocked(appFetch).mockResolvedValue(Response.json({ code: "permission_denied", message: "Current administrator access is required." }, { status: 403 }));
  await expect(getStorageRecovery()).rejects.toBeInstanceOf(AssistantApiError);
});

it("bounds diagnostic arrays and text and rejects malformed reports", async () => {
  vi.mocked(appFetch).mockResolvedValueOnce(Response.json({ issues: Array.from({ length: 80 }, () => ({ ...issue, message: "\0" + "x".repeat(700) })) }));
  const report = await getStorageRecovery();
  expect(report?.issues).toHaveLength(50); expect(report?.issues[0].message).toHaveLength(500);
  expect(report?.issues[0].message).not.toContain("\0");
  vi.mocked(appFetch).mockResolvedValueOnce(Response.json({ issues: [{ ...issue, sessionId: "../../private" }] }));
  await expect(getStorageRecovery()).rejects.toMatchObject({ code: "invalid_storage_recovery" });
  vi.mocked(appFetch).mockResolvedValueOnce(Response.json({}));
  await expect(getStorageRecovery()).rejects.toMatchObject({ code: "invalid_storage_recovery" });
});
