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
    await api.saveEditDraft({ scope, entryId: second.id, viewId: "other-view", reservationId: "other-reservation",
      stash: { text: "other unsent draft", attachments: [], files: api.outboxFiles([new File(["other stash bytes"], "other-stash.txt")]) },
      buffer: { text: "other queued edit", attachments: [], files: api.outboxFiles([new File(["other buffer bytes"], "other-buffer.txt")]) } });
    const preserved = { id: "original-stash", draft: { text: "preserved original draft", attachments: [{ name: "uploaded.txt", size: 7 }], files: api.outboxFiles([file]) } };
    await Promise.all([api.preserveDraft(scope, preserved), api.preserveDraft(scope, { id: "other-stash", draft: { text: "second saved draft", attachments: [], files: [] } })]);
    await api.preserveDraft(scope, { ...preserved, draft: { text: "must not overwrite the first copy", attachments: [], files: [] } });
    await api.preserveDraft(otherOwner, { id: "original-stash", draft: { text: "another owner's draft", attachments: [], files: [] } });
    if ((await api.listPreservedDrafts(otherInstall)).length) throw new Error("Preserved drafts crossed an installation boundary.");
    return { scope, first: first.id, second: second.id };
  });
  await open();
  const restored = await page.evaluate(async ({ scope, first, second }) => {
    const api = globalThis.Outbox, rows = await api.listOutbox(scope), edit = await api.readEditDraft(scope, first), other = await api.readEditDraft(scope, second);
    if (await rows[0].files[0].bytes.text() !== "original image bytes") throw new Error("Queued file bytes were lost on reload.");
    if (edit.stash.text !== "unsent draft" || edit.buffer.text !== "edited queued text" || await edit.stash.files[0].bytes.text() !== "original image bytes") throw new Error("Editing lost its stashed draft or attachment.");
    if (other.stash.text !== "other unsent draft" || other.buffer.text !== "other queued edit"
      || await other.stash.files[0].bytes.text() !== "other stash bytes" || await other.buffer.files[0].bytes.text() !== "other buffer bytes")
      throw new Error("Concurrent row editing lost another entry's text or file bytes.");
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
    await api.saveEditDraft({ ...edit, reservationId: "pending:second-view", viewId: "second-view" });
    await api.saveEditDraft({ ...edit, reservationId: "second-reservation", viewId: "second-view" });
    let refused = false;
    try { await api.saveEditDraft({ ...edit, buffer: { text: "stale editor overwrite", attachments: [], files: [] } }); } catch { refused = true; }
    const old = await api.readEditDraft(scope, first, "first-reservation");
    if (old.buffer.text !== "edited queued text") throw new Error("Recovery removed the prior editor's exact saved buffer.");
    await api.clearEditDraft(scope, first, "first-reservation");
    const current = await api.readEditDraft(scope, first), untouched = await api.readEditDraft(scope, second);
    if (!refused || current.reservationId !== "second-reservation") throw new Error("An older editor replaced a recovered edit.");
    if (untouched.reservationId !== other.reservationId || await untouched.buffer.files[0].bytes.text() !== "other buffer bytes")
      throw new Error("Clearing one reservation touched another queued entry.");
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

    // A full recovery destination must roll the source deletion back in the same transaction.
    const capacityRow = await api.stageOutbox({ id: crypto.randomUUID(), scope: fullScope, sessionId: "capacity-fixture", text: "submitted form", draftText: "only copy",
      files: api.outboxFiles([new File(["capacity blob"], "capacity.txt")]), attachments: [], error: "Upload failed before POST" });
    let capacityRefused = false;
    try { await api.recoverOutbox(fullScope, capacityRow.id); } catch { capacityRefused = true; }
    const retained = (await api.listOutbox(fullScope)).find(row => row.id === capacityRow.id);
    if (!capacityRefused || !retained || await retained.files[0].bytes.text() !== "capacity blob" || (await api.listPreservedDrafts(fullScope)).length !== 100)
      throw new Error("A full Saved drafts pool lost or partially recovered the original outbox row.");

    // Definite local failures recover all bytes, while any uncertain transport remains immutable.
    const recoveryScope = api.outboxScope("install-one", "owner-one", "recovery-fixture");
    const make = id => ({ id, scope: recoveryScope, sessionId: "recovery-fixture", text: "serialized prompt", draftText: "visible draft",
      files: api.outboxFiles([new File(["recover original bytes"], "recover.txt")]), attachments: [{ name: "server.txt", size: 8 }], error: "Upload failed" });
    const unsent = await api.stageOutbox(make(crypto.randomUUID()));
    await api.recoverOutbox(recoveryScope, unsent.id); await api.recoverOutbox(recoveryScope, unsent.id);
    const recovered = (await api.listPreservedDrafts(recoveryScope)).find(row => row.id === `outbox:${unsent.id}`);
    if ((await api.listOutbox(recoveryScope)).length || recovered.draft.text !== "visible draft" || recovered.draft.attachments[0].name !== "server.txt"
      || await recovered.draft.files[0].bytes.text() !== "recover original bytes") throw new Error("Recover-before-POST did not atomically preserve the complete visible draft.");
    const pending = await api.stageOutbox({ ...make(crypto.randomUUID()), recoverable: false,
      command: { requestId: crypto.randomUUID(), expectedRevision: 0, command: { type: "enqueue", entryId: "same-server-entry", text: "serialized prompt", attachments: [] } } });
    const firstTransport = crypto.randomUUID(), secondTransport = crypto.randomUUID();
    await Promise.all([api.recordOutboxAttempt(recoveryScope, pending.id, firstTransport), api.recordOutboxAttempt(recoveryScope, pending.id, secondTransport)]);
    await api.recordOutboxAttempt(recoveryScope, pending.id, firstTransport, true);
    await api.saveOutbox({ ...pending, recoverable: true });
    let pendingRefused = false;
    try { await api.recoverOutbox(recoveryScope, pending.id); } catch { pendingRefused = true; }
    if (!pendingRefused || !(await api.listOutbox(recoveryScope)).some(row => row.id === pending.id)
      || (await api.listPreservedDrafts(recoveryScope)).some(row => row.id === `outbox:${pending.id}`))
      throw new Error("A stale row or one rejected response erased a second uncertain transport attempt.");
    await api.recordOutboxAttempt(recoveryScope, pending.id, secondTransport, true);
    await api.recoverOutbox(recoveryScope, pending.id);
    if ((await api.listOutbox(recoveryScope)).length || !(await api.listPreservedDrafts(recoveryScope)).some(row => row.id === `outbox:${pending.id}`))
      throw new Error("Definitively rejected transport attempts could not recover the original row.");

    // Seed the previous metadata key only in this synthetic browser database, then migrate it.
    const legacyScope = api.outboxScope("install-one", "owner-one", "legacy-fixture"), legacy = {
      scope: legacyScope, entryId: "legacy-entry", viewId: "legacy-view", reservationId: "legacy-reservation",
      stash: { text: "legacy stash", attachments: [], files: api.outboxFiles([new File(["legacy stash bytes"], "legacy-stash.txt")]) },
      buffer: { text: "legacy buffer", attachments: [], files: api.outboxFiles([new File(["legacy buffer bytes"], "legacy-buffer.txt")]) },
    };
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("hosty.message-outbox.v1", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      await new Promise((resolve, reject) => { const tx = db.transaction("metadata", "readwrite"); tx.objectStore("metadata").put(legacy, `edit:${legacyScope}`); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      const migrated = await api.readEditDraft(legacyScope, legacy.entryId), exact = await api.readEditDraft(legacyScope, legacy.entryId, legacy.reservationId);
      if (migrated.buffer.text !== "legacy buffer" || await exact.buffer.files[0].bytes.text() !== "legacy buffer bytes"
        || await exact.stash.files[0].bytes.text() !== "legacy stash bytes") throw new Error("Legacy edit migration lost text or Blob values.");
      const raw = await new Promise((resolve, reject) => { const request = db.transaction("metadata", "readonly").objectStore("metadata").get(`edit:${legacyScope}`); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      if (raw !== undefined) throw new Error("The migrated legacy edit key was not retired.");
      await api.clearEditDraft(legacyScope, legacy.entryId, legacy.reservationId);
      if (await api.readEditDraft(legacyScope, legacy.entryId)) throw new Error("Migrated edit cleanup retained its current pointer.");
    } finally { db.close(); }
  }, created);
  await context.close();
  console.log("PASS: actual Chromium IndexedDB ordering, installation/user isolation, file/edit reload, independent row/reservation Blob storage, stale acknowledgement, legacy edit migration, preserved-draft reload/removal/capacity, atomic local recovery and independent uncertain-transport admission guards.");
} finally { await browser.close(); }
