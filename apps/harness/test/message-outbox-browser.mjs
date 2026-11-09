// Browser storage unit checks. This synthetic origin does not validate Hosty identity or runtime.
import assert from "node:assert/strict";
import { build } from "esbuild";
const { chromium } = await import(process.env.HOSTY_QUEUE_PLAYWRIGHT_MODULE || "playwright");
const bundle = await build({ entryPoints: [new URL("../web/src/lib/message-outbox.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "iife", globalName: "Outbox", platform: "browser" });
const browser = await chromium.launch({ headless: true, channel: process.env.HOSTY_QUEUE_BROWSER_CHANNEL || "chrome" });
try {
  const context = await browser.newContext();
  await context.route("http://outbox.localhost/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Storage unit fixture</title>" }));
  const page = await context.newPage();
  const open = async () => { await page.goto("http://outbox.localhost/"); await page.addScriptTag({ content: bundle.outputFiles[0].text }); };
  await open();
  const created = await page.evaluate(async () => {
    const api = globalThis.Outbox, scope = api.outboxScope("install-one", "owner-one", "chat-one");
    const file = new File(["original image bytes"], "photo.png", { type: "image/png" });
    const make = id => ({ id, scope, sessionId: "chat-one", text: id, draftText: id, files: api.outboxFiles([file]), attachments: [] });
    const first = make(crypto.randomUUID()), second = make(crypto.randomUUID());
    await Promise.all([api.stageOutbox(first), api.stageOutbox(second)]);
    const rows = await api.listOutbox(scope);
    if (rows.length !== 2 || rows[0].id !== first.id || rows[0].sequence >= rows[1].sequence) throw new Error("Concurrent staging did not retain order.");
    const otherOwner = api.outboxScope("install-one", "owner-two", "chat-one"), otherInstall = api.outboxScope("install-two", "owner-one", "chat-one");
    if ((await api.listOutbox(otherOwner)).length || (await api.listOutbox(otherInstall)).length) throw new Error("Browser outbox crossed its scope.");
    await api.saveEditDraft({ scope, entryId: first.id, viewId: "first-view", reservationId: "first-reservation",
      stash: { text: "unsent draft", attachments: [], files: api.outboxFiles([file]) }, buffer: { text: "edited queued text", attachments: [], files: [] } });
    const preserved = { id: "original-stash", draft: { text: "preserved original draft", attachments: [{ name: "uploaded.txt", size: 7 }], files: api.outboxFiles([file]) } };
    await Promise.all([api.preserveDraft(scope, preserved), api.preserveDraft(scope, { id: "other-stash", draft: { text: "second saved draft", attachments: [], files: [] } })]);
    await api.preserveDraft(scope, { ...preserved, draft: { text: "must not overwrite the first copy", attachments: [], files: [] } });
    await api.preserveDraft(otherOwner, { id: "original-stash", draft: { text: "another owner's draft", attachments: [], files: [] } });
    if ((await api.listPreservedDrafts(otherInstall)).length) throw new Error("Preserved drafts crossed an installation boundary.");
    return { scope, first: first.id, second: second.id };
  });
  await open();
  const restored = await page.evaluate(async ({ scope, first }) => {
    const api = globalThis.Outbox, rows = await api.listOutbox(scope), edit = await api.readEditDraft(scope);
    if (await rows[0].files[0].bytes.text() !== "original image bytes") throw new Error("Queued file bytes were lost on reload.");
    if (edit.stash.text !== "unsent draft" || edit.buffer.text !== "edited queued text" || await edit.stash.files[0].bytes.text() !== "original image bytes") throw new Error("Editing lost its stashed draft or attachment.");
    const preserved = await api.listPreservedDrafts(scope);
    if (preserved.length !== 2 || preserved[0].id !== "original-stash" || preserved[0].draft.text !== "preserved original draft"
      || preserved[0].draft.attachments[0].name !== "uploaded.txt" || await preserved[0].draft.files[0].bytes.text() !== "original image bytes")
      throw new Error("Preserved text, attachment metadata, or file bytes did not survive reload idempotently.");
    await api.removePreservedDraft(scope, "missing-draft");
    if ((await api.listPreservedDrafts(scope)).length !== 2) throw new Error("Removing an unknown draft changed saved data.");
    await api.removePreservedDraft(scope, "original-stash");
    const remainingDrafts = await api.listPreservedDrafts(scope);
    const otherOwner = api.outboxScope("install-one", "owner-two", "chat-one");
    if (remainingDrafts.length !== 1 || remainingDrafts[0].id !== "other-stash"
      || (await api.listPreservedDrafts(otherOwner))[0]?.draft.text !== "another owner's draft")
      throw new Error("Removing one preserved draft affected another identity or owner scope.");
    await api.removeOutbox(scope, first); await api.saveOutbox(rows[0]);
    if ((await api.listOutbox(scope)).some(row => row.id === first)) throw new Error("A stale uploader resurrected an acknowledged message.");
    await api.saveEditDraft({ ...edit, reservationId: "pending", viewId: "second-view" });
    await api.saveEditDraft({ ...edit, reservationId: "second-reservation", viewId: "second-view" });
    let refused = false;
    try { await api.saveEditDraft({ ...edit, buffer: { text: "stale editor overwrite", attachments: [], files: [] } }); } catch { refused = true; }
    await api.clearEditDraft(scope, "first-reservation");
    const current = await api.readEditDraft(scope);
    if (!refused || current.reservationId !== "second-reservation") throw new Error("An older editor replaced a recovered edit.");
    return { rows: rows.length, remaining: (await api.listOutbox(scope)).length };
  }, created);
  assert.deepEqual(restored, { rows: 2, remaining: 1 });
  await open();
  await page.evaluate(async ({ scope }) => {
    const api = globalThis.Outbox, remaining = await api.listPreservedDrafts(scope);
    if (remaining.length !== 1 || remaining[0].id !== "other-stash") throw new Error("Preserved-draft deletion did not survive reload.");
    const fullScope = api.outboxScope("install-one", "owner-one", "capacity-fixture");
    await Promise.all(Array.from({ length: 100 }, (_, index) => api.preserveDraft(fullScope,
      { id: `draft-${index}`, draft: { text: `saved-${index}`, attachments: [], files: [] } })));
    await api.preserveDraft(fullScope, { id: "draft-0", draft: { text: "do not replace", attachments: [], files: [] } });
    let full = false;
    try { await api.preserveDraft(fullScope, { id: "overflow", draft: { text: "must refuse", attachments: [], files: [] } }); } catch { full = true; }
    const saved = await api.listPreservedDrafts(fullScope);
    if (!full || saved.length !== 100 || saved.some(value => value.id === "overflow") || saved[0].draft.text !== "saved-0")
      throw new Error("The preserved-draft capacity bound evicted, replaced, or accepted an extra draft.");
  }, created);
  await context.close();
  console.log("PASS: actual Chromium IndexedDB ordering, installation/user isolation, file/edit reload, stale acknowledgement, edit reservation protection, and idempotent preserved-draft reload/removal/capacity.");
} finally { await browser.close(); }
