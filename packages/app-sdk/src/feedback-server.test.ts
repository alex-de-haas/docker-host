import { afterEach, expect, it, vi } from "vitest";
import { createHostyUiResponse } from "./ui-server.js";
import { FeedbackServerClient } from "./feedback-server.js";
const context = { session: { status: "active" as const, identity: { hostRole: "host.user" } }, token: "own-user-grant" };
const options = { appId: "third.party", coreOrigin: "https://core.test", serviceToken: "app-service" };
afterEach(() => vi.unstubAllGlobals());
it("submits from an ordinary app session only to its fixed intake endpoint", async () => {
  const fetcher = vi.fn(async () => Response.json({ id: "report", status: "submitted" })); vi.stubGlobal("fetch", fetcher);
  const body = JSON.stringify({ requestId: "id", comment: "Fix", annotations: [] });
  const request = (origin: string) => new Request("https://app.test/api/hosty/ui/feedback", { method: "POST", headers: { origin, "content-type": "application/json" }, body });
  expect((await createHostyUiResponse(request("https://foreign.test"), context, options)).status).toBe(403); expect(fetcher).not.toHaveBeenCalled();
  const result = await createHostyUiResponse(request("https://app.test"), context, options); expect(result.status).toBe(200);
  expect(fetcher).toHaveBeenCalledWith(new URL("https://core.test/api/internal/apps/third.party/ui/feedback"), expect.objectContaining({
    redirect: "error", headers: expect.objectContaining({ authorization: "Bearer app-service", "X-Hosty-User-Token": "own-user-grant" }), body,
  }));
});
it("does not offer management routes on the ordinary UI adapter and retains typed Core refusals", async () => {
  const fetcher = vi.fn(async () => Response.json({ code: "feedback_identity_changed", message: "Account changed" }, { status: 403 })); vi.stubGlobal("fetch", fetcher);
  expect((await createHostyUiResponse(new Request("https://app.test/api/hosty/ui/feedback/reports"), context, options)).status).toBe(404);
  expect(fetcher).not.toHaveBeenCalled();
  await expect(new FeedbackServerClient(options).list("grant")).rejects.toMatchObject({ code: "feedback_identity_changed", status: 403 });
});
it("refuses oversized intake before contacting Core", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const response = await createHostyUiResponse(new Request("https://app.test/api/hosty/ui/feedback", { method: "POST", headers: { origin: "https://app.test", "content-type": "application/json" }, body: "x".repeat(12 * 1024 * 1024 + 1) }), context, options);
  expect(response.status).toBe(413); expect(fetcher).not.toHaveBeenCalled();
});
it("forwards revision-checked edits and deletion to fixed management routes with unchanged retry identities", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "report", status: "deleted" })); vi.stubGlobal("fetch", fetcher);
  const client = new FeedbackServerClient(options);
  const edit = { requestId: "edit-request", expectedRevision: 2, comment: "Revised", annotations: [{ id: "note", text: "Move left" }] };
  const remove = { requestId: "delete-request", expectedRevision: 3 };
  await client.edit("report", edit, "grant"); await client.edit("report", edit, "grant");
  await client.remove("report", remove, "grant");
  expect(fetcher.mock.calls).toHaveLength(3);
  expect(fetcher.mock.calls[1]![0]).toEqual(fetcher.mock.calls[0]![0]);
  expect(fetcher.mock.calls[1]![1]?.body).toBe(fetcher.mock.calls[0]![1]?.body);
  expect(fetcher).toHaveBeenNthCalledWith(1, new URL("https://core.test/api/internal/apps/third.party/feedback/report/edit"), expect.objectContaining({
    method: "POST", redirect: "error", body: JSON.stringify(edit), headers: expect.objectContaining({ "X-Hosty-User-Token": "grant" }),
  }));
  expect(fetcher).toHaveBeenNthCalledWith(3, new URL("https://core.test/api/internal/apps/third.party/feedback/report/delete"), expect.objectContaining({ body: JSON.stringify(remove) }));
});

it.each([404, 405])("explains unavailable edit/delete routes without making known refusal %s uncertain", async status => {
  const fetcher = vi.fn(async () => new Response("", { status })); vi.stubGlobal("fetch", fetcher);
  const client = new FeedbackServerClient(options);
  await expect(client.edit("report", { requestId: "edit-request", expectedRevision: 1, comment: "Fix", annotations: [] }, "grant"))
    .rejects.toMatchObject({ code: "feedback_mutation_unsupported", status, message: "This Core does not support editing feedback. Update Core and retry." });
  await expect(client.remove("report", { requestId: "delete-request", expectedRevision: 1 }, "grant"))
    .rejects.toMatchObject({ code: "feedback_mutation_unsupported", status, message: "This Core does not support deleting feedback. Update Core and retry." });
  // Intake retains its existing local-draft recovery guidance.
  await expect(client.submit({ requestId: "submit-request", comment: "Fix", annotations: [] }, "grant"))
    .rejects.toMatchObject({ code: "feedback_unavailable", status, message: "Feedback is unavailable. Your draft is retained." });
});

it.each([
  { status: 404, code: "feedback_not_found", message: "Feedback not found." },
  { status: 403, code: "app_permission_required", message: "Allow this app to manage feedback." },
  { status: 409, code: "feedback_revision_conflict", message: "Feedback changed; refresh before continuing." },
])("preserves structured mutation refusal $code", async error => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: error.code, message: error.message }, { status: error.status })));
  const client = new FeedbackServerClient(options);
  await expect(client.remove("report", { requestId: "delete-request", expectedRevision: 1 }, "grant")).rejects.toMatchObject(error);
  await expect(client.edit("report", { requestId: "edit-request", expectedRevision: 1, comment: "Fix", annotations: [] }, "grant")).rejects.toMatchObject(error);
});
