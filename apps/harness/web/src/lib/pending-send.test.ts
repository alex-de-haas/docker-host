// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { AssistantApiError } from "./assistant-api";
import { writeDraft } from "./draft-store";
import { claimPendingSend, dispatchPendingSend, forgetPendingSend, readPendingSend, rememberPendingSend, retryPendingSend, type PendingSend } from "./pending-send";

vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: vi.fn(), APP_SESSION_RESTORED: "hosty:app-session-restored" }));
const key = "hosty.assistant.pending-send.session-one";
const request: PendingSend = { version: 1, clientRequestId: "18b2e622-85f5-4c1a-a847-b3b88561bc45", sessionId: "session-one",
  text: "Original serialized @App reference", draftText: "Original editable draft", attachments: [{ name: "stored-file.txt", size: 13 }],
  appContextRevision: 4, withoutAppDetails: true, selectionRevision: 8 };
const receipt = (state: "accepted" | "unknown" | "rejected") => Response.json({ clientRequestId: request.clientRequestId, state, ...(state === "accepted" ? { eventSeq: 17 } : {}) });
const failure = (status: number, code?: string) => Response.json({ message: "Refused", ...(code ? { code } : {}) }, { status });
beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("recovers a lost acknowledgement from the receipt after reload without a second POST", async () => {
  rememberPendingSend(request);
  vi.mocked(appFetch).mockRejectedValueOnce(new TypeError("Connection lost after admission"));
  await expect(dispatchPendingSend(request)).rejects.toThrow("Connection lost");
  const reloaded = readPendingSend(request.sessionId)!;
  expect(reloaded).toEqual(request); expect(reloaded).not.toBe(request);
  vi.mocked(appFetch).mockResolvedValueOnce(receipt("accepted"));
  expect(await retryPendingSend(reloaded)).toMatchObject({ state: "accepted", eventSeq: 17 });
  const calls = vi.mocked(appFetch).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0][1]?.method).toBe("POST");
  expect(calls[1]).toEqual([`/api/sessions/session-one/messages/${request.clientRequestId}`, expect.objectContaining({ cache: "no-store" })]);
  expect(readPendingSend(request.sessionId)).toEqual(request);
  forgetPendingSend(reloaded); expect(readPendingSend(request.sessionId)).toBeNull();
});

it.each(["unknown", "rejected"] as const)("returns a %s receipt without replaying the original write", async state => {
  vi.mocked(appFetch).mockResolvedValueOnce(receipt(state));
  expect(await retryPendingSend(request)).toMatchObject({ state });
  expect(appFetch).toHaveBeenCalledOnce(); expect(vi.mocked(appFetch).mock.calls[0][1]?.method).toBeUndefined();
});

it.each([
  { status: 404, code: undefined }, { status: 404, code: "session_not_found" }, { status: 404, code: "message_not_found" },
  { status: 401, code: "message_request_not_found" }, { status: 403, code: "message_request_not_found" },
  { status: 410, code: "message_request_not_found" }, { status: 503, code: "unavailable" },
])("does not replay on an ambiguous or refused receipt lookup ($status/$code)", async ({ status, code }) => {
  rememberPendingSend(request); vi.mocked(appFetch).mockResolvedValueOnce(failure(status, code));
  await expect(retryPendingSend(request)).rejects.toMatchObject({ status, code });
  expect(appFetch).toHaveBeenCalledOnce(); expect(readPendingSend(request.sessionId)).toEqual(request);
});

it("does not replay a lookup whose network outcome is unknown", async () => {
  const error = new TypeError("Offline"); vi.mocked(appFetch).mockRejectedValueOnce(error);
  await expect(retryPendingSend(request)).rejects.toBe(error); expect(appFetch).toHaveBeenCalledOnce();
});

it("replays only the exact original UUID and payload after an explicit missing-request receipt", async () => {
  rememberPendingSend(request);
  vi.mocked(appFetch).mockResolvedValueOnce(failure(404, "message_request_not_found")).mockResolvedValueOnce(receipt("accepted"));
  expect(await retryPendingSend(readPendingSend(request.sessionId)!)).toMatchObject({ state: "accepted" });
  expect(appFetch).toHaveBeenCalledTimes(2);
  const [path, init] = vi.mocked(appFetch).mock.calls[1];
  expect(path).toBe("/api/sessions/session-one/messages"); expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ text: request.text, attachments: ["stored-file.txt"], appContextRevision: 4,
    withoutAppDetails: true, selectionRevision: 8, clientRequestId: request.clientRequestId });
  expect(readPendingSend(request.sessionId)).toEqual(request);
});

it("does not loop when replay of the original request also loses its acknowledgement", async () => {
  rememberPendingSend(request);
  vi.mocked(appFetch).mockResolvedValueOnce(failure(404, "message_request_not_found")).mockRejectedValueOnce(new TypeError("Lost again"));
  await expect(retryPendingSend(request)).rejects.toThrow("Lost again"); expect(appFetch).toHaveBeenCalledTimes(2);
  expect(readPendingSend(request.sessionId)).toEqual(request);
});

it.each([
  { clientRequestId: "another-request", state: "accepted" }, { clientRequestId: request.clientRequestId, state: "pending" }, null,
])("treats malformed or foreign receipts as unknown without resending", async body => {
  vi.mocked(appFetch).mockResolvedValueOnce(Response.json(body));
  await expect(retryPendingSend(request)).rejects.toBeInstanceOf(AssistantApiError);
  expect(appFetch).toHaveBeenCalledOnce();
});

it("retiring a late receipt does not remove a newer view's request", () => {
  const newer = { ...request, clientRequestId: "40297a84-3183-4dce-a42a-487efb9ed5a6", draftText: "A later draft" };
  rememberPendingSend(newer); forgetPendingSend(request); expect(readPendingSend(request.sessionId)).toEqual(newer);
});

it.each([
  "{", "null", "[]", JSON.stringify({ ...request, version: 2 }), JSON.stringify({ ...request, sessionId: "another-session" }),
  JSON.stringify({ ...request, clientRequestId: "not-a-uuid" }), JSON.stringify({ ...request, appContextRevision: -1 }),
  JSON.stringify({ ...request, attachments: [{ name: "", size: 2 }] }), "x".repeat(1024 * 1024 + 1),
])("keeps corrupt or out-of-scope recovery data and blocks a fresh implicit send", raw => {
  localStorage.setItem(key, raw); expect(() => readPendingSend(request.sessionId)).toThrow("recovery details are unavailable");
  expect(localStorage.getItem(key)).toBe(raw); expect(appFetch).not.toHaveBeenCalled();
});

it.each(["write", "verify", "silent"])("refuses to dispatch when browser storage cannot durably record the UUID (%s)", refusal => {
  if (refusal === "write") vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota", "QuotaExceededError"); });
  if (refusal === "verify") vi.spyOn(Storage.prototype, "getItem").mockReturnValueOnce(null).mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
  if (refusal === "silent") vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
  expect(() => rememberPendingSend(request)).toThrow("message was not sent"); expect(appFetch).not.toHaveBeenCalled();
});

it("surfaces storage read refusal rather than assuming no previous send exists", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
  expect(() => readPendingSend(request.sessionId)).toThrow("Denied"); expect(appFetch).not.toHaveBeenCalled();
});

it.each([
  { clientRequestId: "40297a84-3183-4dce-a42a-487efb9ed5a6" }, { text: "Changed serialized payload" },
  { attachments: [{ name: "another-file.txt", size: 1 }] }, { appContextRevision: 5 },
])("does not overwrite an unresolved request with a different UUID or changed payload (%j)", change => {
  rememberPendingSend(request); const saved = localStorage.getItem(key);
  expect(() => rememberPendingSend({ ...request, ...change })).toThrow("already awaiting confirmation");
  expect(localStorage.getItem(key)).toBe(saved); expect(appFetch).not.toHaveBeenCalled();
});

it("allows an identical recovery record without creating a new request", () => {
  rememberPendingSend(request); rememberPendingSend(JSON.parse(JSON.stringify(request)));
  expect(readPendingSend(request.sessionId)).toEqual(request); expect(appFetch).not.toHaveBeenCalled();
});

it.each([false, true])("allows only one competing claim with Web Locks=%s", async useLocks => {
  const newer = { ...request, clientRequestId: "40297a84-3183-4dce-a42a-487efb9ed5a6" };
  let tail: Promise<unknown> = Promise.resolve();
  const lock = vi.fn((_name: string, callback: () => void) => {
    const result = tail.then(callback); tail = result.catch(() => {}); return result;
  });
  vi.stubGlobal("navigator", useLocks ? { locks: { request: lock } } : {});
  const outcomes = await Promise.allSettled([claimPendingSend(request), claimPendingSend(newer)]);
  expect(outcomes.map(item => item.status)).toEqual(["fulfilled", "rejected"]);
  expect(readPendingSend(request.sessionId)).toEqual(request); expect(appFetch).not.toHaveBeenCalled();
  if (useLocks) expect(lock.mock.calls.map(([name]) => name)).toEqual([key, key]); else expect(lock).not.toHaveBeenCalled();
});

it.each([false, true])("refuses a stale draft claim with Web Locks=%s", async useLocks => {
  localStorage.setItem("hosty.assistant.draft.session-one", "Edited in the other view");
  const lock = vi.fn(async (_name: string, callback: () => void) => callback());
  vi.stubGlobal("navigator", useLocks ? { locks: { request: lock } } : {});
  await expect(claimPendingSend(request)).rejects.toThrow("draft changed in another view");
  expect(readPendingSend(request.sessionId)).toBeNull(); expect(appFetch).not.toHaveBeenCalled();
});

it("settles only a re-POST's provable pre-admission refusal after an exact missing receipt", async () => {
  rememberPendingSend(request);
  vi.mocked(appFetch).mockResolvedValueOnce(failure(404, "message_request_not_found")).mockResolvedValueOnce(failure(409, "selection_conflict"));
  expect(await retryPendingSend(request)).toMatchObject({ clientRequestId: request.clientRequestId, state: "rejected", error: { code: "selection_conflict" } });
  expect(appFetch).toHaveBeenCalledTimes(2); expect(vi.mocked(appFetch).mock.calls[1][1]?.method).toBe("POST");
});

it("does not treat a receipt GET's selection conflict as proof the original POST was refused", async () => {
  rememberPendingSend(request); vi.mocked(appFetch).mockResolvedValueOnce(failure(409, "selection_conflict"));
  await expect(retryPendingSend(request)).rejects.toMatchObject({ code: "selection_conflict", status: 409 });
  expect(appFetch).toHaveBeenCalledOnce(); expect(readPendingSend(request.sessionId)).toEqual(request);
});

it.each(["x".repeat(40_000), "   "])("claims a draft using the draft store's normalization without changing the submitted payload", async text => {
  const normalized = { ...request, text: text.trim(), draftText: text };
  writeDraft(request.sessionId, text); await claimPendingSend(normalized);
  expect(readPendingSend(request.sessionId)).toEqual(normalized); expect(appFetch).not.toHaveBeenCalled();
});
