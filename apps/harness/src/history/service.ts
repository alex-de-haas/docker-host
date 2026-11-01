import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MediatedProviderInvocation } from "@hosty-sdk/app/providers";
import type { Conversation, SourceConversationQuery, HistoryCapabilities, HistoryEntry, HistoryEntryGet, HistoryQuery, HistorySearch,
  HistoryShare, HistoryShareCreate, HistoryShareRevoke, ProviderRef, ConversationRef, HistoryCoverage } from "@hosty-sdk/app/history";
import { ExportCursors } from "./export-cursors.js";
import type { MediatedProviderInvocation as ExportInvocation } from "@hosty-sdk/app/providers";
import type { HistoryChange, HistoryChangePage, HistoryExportSnapshot } from "@hosty-sdk/app/history";
import { attachmentFile } from "./attachments.js";
import { ProviderError } from "@hosty-sdk/app/providers";
import { SessionStore } from "../sessions/store.js";
import { fingerprint, fold, project, searchable } from "./projection.js";
import { fail, missing, uuid, revision, id, HistoryStorage, type HistoryState, type Snapshot, type SourceConversation } from "./storage.js";

export type HistoryActor = Pick<MediatedProviderInvocation, "userId" | "principalId" | "hostRole">;
const features = ["history.read", "history.search.text", "history.sharing", "history.attachments", "history.changes", "history.tool-events", "history.usage"];
const coverage = (changed = false): HistoryCoverage => ({ state: "partial", reasons: ["Only public Harness transcript fields are represented; native state and tool inputs are omitted.", ...(changed ? ["Source content or current access changed during enumeration."] : [])] });
const referenceKey = (ref: ProviderRef) => `${ref.appId}\0${ref.installationId}\0${ref.key}`;
const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** Provider-owned projection and ACLs. Core receives qualified results, never this storage path. */
export class HistoryService {
  readonly storage: HistoryStorage;
  private readonly exportCursors: ExportCursors;
  private readonly deliveryGuards = new WeakMap<object, { acls: Record<string, number>; disclosures: Record<string, string>; entries: Array<{ conversation: string; id: string; revision: string }> }>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly unsubscribe: () => void;
  readonly capabilities: HistoryCapabilities = { version: 1, entryKinds: ["message", "tool_call", "tool_result", "usage"], extensions: [], maxPageSize: 200, snapshotLifetimeSeconds: 900, changeRetentionSeconds: 604800 };
  constructor(readonly sessions: SessionStore, readonly provider: ProviderRef, private readonly now: () => number = Date.now) {
    this.storage = new HistoryStorage(sessions.dataDir);
    this.exportCursors = new ExportCursors(this.storage.root);
    this.unsubscribe = sessions.observeChanges(id => this.storage.locked(async () => { await this.sync(id); }));
  }
  close(): void { this.unsubscribe(); for (const waiting of this.waiters.values()) for (const wake of waiting) wake(); this.waiters.clear(); }
  private check(actor: HistoryActor): void {
    if (!actor.userId || !actor.principalId || actor.hostRole !== "host.admin") fail("permission_denied", "Harness history requires a current administrator and source access.", 403);
  }
  private ref(ref: ConversationRef): string {
    if (!ref || !ref.provider || referenceKey(ref.provider) !== referenceKey(this.provider)) return missing();
    const value = id(ref.id); if (!/^[a-zA-Z0-9-]+$/.test(value)) return missing(); return value;
  }
  private async synchronized<T>(actor: HistoryActor, read: (state: HistoryState) => Promise<T> | T): Promise<T> {
    this.check(actor);
    return this.storage.locked(async () => {
      const state = await this.sync(); const result = await read(state);
      if (result && typeof result === "object" && !this.deliveryGuards.has(result)) this.deliveryGuards.set(result, this.deliveryGuard(state, result, actor));
      return result;
    });
  }
  private deliveryGuard(state: HistoryState, value: object, actor: HistoryActor) {
    const conversations = new Set<string>(), entries: Array<{ conversation: string; id: string; revision: string }> = [];
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const item of value) inspect(item); return; }
      const object = value as Record<string, unknown>;
      // Tombstones carry no source content and remain deliverable after deletion.
      if (object.type === "delete" || object.type === "access_reset") return;
      const ref = object.ref as { id?: string; provider?: ProviderRef; conversation?: ConversationRef } | undefined;
      if (ref?.conversation && typeof ref.id === "string" && typeof object.revision === "string") {
        conversations.add(ref.conversation.id); entries.push({ conversation: ref.conversation.id, id: ref.id, revision: object.revision });
      } else if (ref?.provider && typeof ref.id === "string") conversations.add(ref.id);
      const hit = object.entry as { conversation?: ConversationRef; id?: string } | undefined;
      if (hit?.conversation && typeof hit.id === "string" && typeof object.revision === "string") {
        conversations.add(hit.conversation.id); entries.push({ conversation: hit.conversation.id, id: hit.id, revision: object.revision });
      }
      // Traverse only public envelopes; tool/extension payloads cannot manufacture guard references.
      for (const key of ["entries", "conversations", "hits", "changes", "grant", "shares"]) inspect(object[key]);
      if (object.type === "upsert") inspect(object.entry);
    };
    inspect(value);
    return { acls: Object.fromEntries([...conversations].map(id => [id, state.conversations[id]?.acl ?? -1])),
      disclosures: Object.fromEntries([...conversations].map(id => [id, this.disclosure(state, id, actor)])), entries };
  }
  /** Perform the final local ACL check and synchronous response write under the source gate. */
  async deliver(actor: HistoryActor, value: object, write: () => void): Promise<void> {
    this.check(actor);
    const guard = this.deliveryGuards.get(value);
    if (!guard) { write(); return; } // Capabilities contain no conversation content.
    await this.storage.locked(async () => {
      const state = await this.sync();
      for (const [key, acl] of Object.entries(guard.acls)) {
        const source = state.conversations[key];
        if (!source || source.acl !== acl || guard.disclosures[key] !== this.disclosure(state, key, actor) || source.metadata.ownerUserId !== actor.userId && !this.grants(state, key, actor).length)
          fail("revision_conflict", "Source access changed before delivery. Read the current source again.", 409);
      }
      for (const item of guard.entries) {
        const source = state.conversations[item.conversation], entry = source?.entries.find(e => e.ref.id === item.id);
        if (!source || !entry || !this.entry(state, source, entry, actor)) return missing();
        if (source.metadata.ownerUserId !== actor.userId && item.revision !== entry.revision)
          fail("revision_conflict", "The shared source entry changed before delivery.", 409);
      }
      write();
    });
  }
  private change(state: HistoryState, value: Omit<HistoryState["changes"][number], "at" | "sequence">): string {
    if (!Number.isSafeInteger(state.sequence + 1)) return fail("budget_exceeded", "History sequence capacity reached.", 429);
    for (const wake of this.waiters.get(value.conversation) ?? []) wake();
    const sequence = String(++state.sequence); state.changes.push({ ...value, sequence, at: new Date(this.now()).toISOString() }); return sequence;
  }
  private async sync(changedId?: string): Promise<HistoryState> {
    const state = await this.storage.read();
    const changed = changedId ? await this.sessions.readRecord(changedId) : null;
    const records = changedId ? changed ? [changed] : [] : await this.sessions.listRecords();
    const seen = new Set<string>(), removed = new Set<string>(); let dirty = false;
    for (const record of records) {
      seen.add(record.id); const previous = state.conversations[record.id];
      const projected = project(record, await this.sessions.readEvents(record.id), this.provider);
      for (const entry of projected) if ("parts" in entry.data) for (const part of entry.data.parts) if (part.type === "attachment") {
        try {
          const file = await attachmentFile(this.sessions, record.id, part.attachmentId);
          if (!Buffer.isBuffer(file)) { part.revision = file.revision; part.sizeBytes = file.sizeBytes; }
        } catch (error) { if (!(error instanceof ProviderError) || error.code !== "not_found") throw error; }
      }
      const stamp = fingerprint({ title: record.title, owner: record.createdBy, createdAt: record.createdAt, projected });
      if (stamp === previous?.fingerprint) continue;
      const ownershipChanged = previous && previous.metadata.ownerUserId !== record.createdBy;
      if (ownershipChanged) {
        this.change(state, { type: "access_reset", owner: previous.metadata.ownerUserId, conversation: record.id, revision: String(BigInt(previous.metadata.revision) + 1n), reason: "ownership" });
        state.shares = state.shares.filter(g => g.ref.id !== record.id); removed.add(`${record.id}\0*`);
      }
      const entries = projected.map(entry => {
        const old = previous?.entries.find(e => e.ref.id === entry.ref.id);
        const { revision: _revision, sequence: _sequence, ...oldContent } = old ?? { revision: "0", sequence: "0" };
        if (old && !ownershipChanged && fingerprint(oldContent) === fingerprint(entry)) return old;
        const version = String(BigInt(old?.revision ?? "0") + 1n);
        this.change(state, { type: "upsert", owner: record.createdBy, conversation: record.id, entry: entry.ref.id, revision: version });
        return { ...entry, revision: version, sequence: old?.sequence ?? entry.ref.id.slice("event-".length) };
      });
      for (const old of previous?.entries ?? []) if (!entries.some(e => e.ref.id === old.ref.id)) {
        removed.add(`${record.id}\0${old.ref.id}`);
        this.change(state, { type: "delete", owner: previous!.metadata.ownerUserId, conversation: record.id, entry: old.ref.id, revision: String(BigInt(old.revision) + 1n) });
      }
      const metadata: Conversation = { ref: { provider: this.provider, id: record.id }, revision: String(BigInt(previous?.metadata.revision ?? "0") + 1n), title: record.title,
        ownerUserId: record.createdBy, createdAt: record.createdAt, updatedAt: new Date(this.now()).toISOString(), capabilities: features };
      state.conversations[record.id] = { metadata, entries, fingerprint: stamp, acl: (previous?.acl ?? 0) + (ownershipChanged ? 1 : 0) }; dirty = true;
    }
    for (const [key, conversation] of Object.entries(state.conversations)) if ((!changedId || changedId === key) && !seen.has(key)) {
      removed.add(`${key}\0*`);
      for (const entry of conversation.entries) {
        removed.add(`${key}\0${entry.ref.id}`);
        this.change(state, { type: "delete", owner: conversation.metadata.ownerUserId, conversation: key, entry: entry.ref.id, revision: String(BigInt(entry.revision) + 1n) });
      }
      this.change(state, { type: "access_reset", owner: conversation.metadata.ownerUserId, conversation: key, revision: String(BigInt(conversation.metadata.revision) + 1n) });
      delete state.conversations[key]; state.shares = state.shares.filter(g => g.ref.id !== key); dirty = true;
    }
    const cutoff = this.now() - 604800000;
    while (state.changes.length && Date.parse(state.changes[0]!.at) < cutoff) { state.floor = Number(state.changes.shift()!.sequence); dirty = true; }
    if (removed.size) await this.purgeSnapshots(removed);
    if (dirty) await this.storage.write(state);
    return state;
  }
  private grants(state: HistoryState, conversation: string, actor: HistoryActor): HistoryShare[] {
    return state.shares.filter(g => g.ref.id === conversation && g.state === "active" && g.recipientUserIds.includes(actor.userId)
      && (!g.expiresAt || Date.parse(g.expiresAt) > this.now()));
  }
  private disclosure(state: HistoryState, conversation: string, actor: HistoryActor): string {
    // Share expiry changes effective disclosure without writing a new ACL revision.
    return state.conversations[conversation]?.metadata.ownerUserId === actor.userId ? "owner" : fingerprint(this.grants(state, conversation, actor));
  }
  private visible(state: HistoryState, conversation: string, actor: HistoryActor): SourceConversation {
    const value = state.conversations[conversation];
    if (!value || value.metadata.ownerUserId !== actor.userId && !this.grants(state, conversation, actor).length) return missing();
    return value;
  }
  private entry(state: HistoryState, conversation: SourceConversation, entry: HistoryEntry, actor: HistoryActor): HistoryEntry | null {
    if (conversation.metadata.ownerUserId === actor.userId) return entry;
    const grants = this.grants(state, conversation.metadata.ref.id, actor).filter(g => g.selection.includeFutureEntries || g.selection.entryIds?.includes(entry.ref.id));
    if (!grants.length) return null;
    const result = structuredClone(entry); delete result.parentEntryId; delete result.run;
    if (result.data.kind === "extension" && !grants.some(g => g.extensions.includes(result.data.kind === "extension" ? result.data.name : ""))) return null;
    if ("parts" in result.data && !grants.some(g => g.includeAttachments)) result.data.parts = result.data.parts.filter(p => p.type !== "attachment");
    return result;
  }
  private metadata(state: HistoryState, source: SourceConversation, actor: HistoryActor): Conversation {
    if (source.metadata.ownerUserId === actor.userId) return source.metadata;
    const grants = this.grants(state, source.metadata.ref.id, actor);
    const entries = source.entries.map(e => this.entry(state, source, e, actor)).filter((e): e is HistoryEntry => e !== null);
    // No private title, activity timestamp, native binding or hidden-entry count in a shared projection.
    const stamp = fingerprint({ grants, entries: entries.map(e => [e.ref.id, e.revision]) });
    const times = entries.map(e => e.updatedAt).sort();
    return { ref: source.metadata.ref, revision: BigInt("0x" + stamp.slice(0, 24)).toString(), title: grants.find(g => g.label)?.label ?? "Shared conversation",
      ownerUserId: source.metadata.ownerUserId, createdAt: times[0] ?? "1970-01-01T00:00:00.000Z", updatedAt: times.at(-1) ?? "1970-01-01T00:00:00.000Z", capabilities: ["history.read", "history.search.text"] };
  }
  async conversation(actor: HistoryActor, reference: ConversationRef): Promise<Conversation> {
    const conversation = this.ref(reference); return this.synchronized(actor, state => this.metadata(state, this.visible(state, conversation, actor), actor));
  }
  async get(actor: HistoryActor, input: HistoryEntryGet): Promise<HistoryEntry> {
    const key = this.ref(input.entry?.conversation); id(input.entry?.id);
    return this.synchronized(actor, state => {
      const source = this.visible(state, key, actor), entry = source.entries.find(e => e.ref.id === input.entry.id);
      const result = entry && this.entry(state, source, entry, actor); if (!result) return missing();
      if (input.expectedRevision != null && revision(input.expectedRevision) !== result.revision) fail("revision_conflict", "The source entry changed.", 409);
      if (byteSize(result) > 256 * 1024) fail("budget_exceeded", "The source entry exceeds the common history envelope.", 429);
      return result;
    });
  }
  async attachment(actor: HistoryActor, input: { entry: HistoryEntryGet["entry"]; attachmentId: string; revision: string; offset?: number; length?: number }, content = false) {
    const entry = await this.get(actor, { entry: input.entry });
    const disclosed = "parts" in entry.data && entry.data.parts.some(p => p.type === "attachment" && p.attachmentId === input.attachmentId && p.revision === input.revision);
    if (!disclosed) return missing();
    const result = await attachmentFile(this.sessions, input.entry.conversation.id, input.attachmentId, content ? { revision: input.revision, offset: input.offset!, length: input.length! } : undefined);
    this.deliveryGuards.set(result, this.deliveryGuards.get(entry)!); return result;
  }
  async list(actor: HistoryActor, input: SourceConversationQuery) {
    if (!input.provider || referenceKey(input.provider) !== referenceKey(this.provider)) return missing();
    if (input.title != null && (typeof input.title !== "string" || input.title.length > 512)) fail("invalid_input", "Title filters are bounded strings.");
    return this.synchronized(actor, async state => {
      const items: Snapshot["items"] = [];
      for (const [key, source] of Object.entries(state.conversations)) {
        if (source.metadata.ownerUserId !== actor.userId && !this.grants(state, key, actor).length) continue;
        const metadata = this.metadata(state, source, actor);
        if (!input.title || fold(metadata.title ?? "").includes(fold(input.title))) items.push({ conversation: key, metadata });
      }
      items.sort((a, b) => b.metadata!.updatedAt.localeCompare(a.metadata!.updatedAt) || a.conversation.localeCompare(b.conversation));
      const page = await this.page(state, actor, "conversations", input, items);
      return { conversations: page.items.map(i => i.metadata!), ...page.rest };
    });
  }
  async read(actor: HistoryActor, input: HistoryQuery) {
    const key = this.ref(input.conversation); this.kinds(input.kinds);
    return this.synchronized(actor, async state => {
      const source = this.visible(state, key, actor);
      const items = source.entries.map(e => this.entry(state, source, e, actor)).filter((e): e is HistoryEntry => e !== null && (!input.kinds || input.kinds.includes(e.data.kind))).map(entry => ({ conversation: key, entry }));
      const page = await this.page(state, actor, "entries", input, items);
      return { entries: page.items.map(i => i.entry!), ...page.rest };
    });
  }
  async search(actor: HistoryActor, input: Omit<HistorySearch, "providers"> & { provider: ProviderRef }) {
    if (!input.provider || referenceKey(input.provider) !== referenceKey(this.provider)) return missing();
    if (typeof input.q !== "string" || input.q.length > 512 || (input.conversations?.length ?? 0) > 100) fail("invalid_input", "Use a bounded search query and corpus.");
    const terms = [...new Set(fold(input.q).split(/\s+/u).filter(Boolean))];
    if (!terms.length || terms.length > 16) fail("invalid_input", "Use 1–16 literal terms.");
    this.kinds(input.kinds); const kinds = input.kinds ?? ["message"];
    const selected = input.conversations?.map(c => this.ref(c));
    return this.synchronized(actor, async state => {
      const items: Snapshot["items"] = [];
      for (const [key, source] of Object.entries(state.conversations)) {
        if (selected && !selected.includes(key) || source.metadata.ownerUserId !== actor.userId && !this.grants(state, key, actor).length) continue;
        for (const raw of source.entries) {
          const entry = this.entry(state, source, raw, actor);
          if (entry && kinds.includes(entry.data.kind) && terms.every(term => fold(searchable(entry)).includes(term))) items.push({ conversation: key, entry, metadata: this.metadata(state, source, actor) });
        }
      }
      items.sort((a, b) => b.entry!.updatedAt.localeCompare(a.entry!.updatedAt) || a.conversation.localeCompare(b.conversation) || a.entry!.ref.id.localeCompare(b.entry!.ref.id));
      const page = await this.page(state, actor, "search", input, items);
      return { hits: page.items.map(i => ({ entry: i.entry!.ref, revision: i.entry!.revision, conversationTitle: i.metadata!.title,
        excerpt: searchable(i.entry!).slice(0, 500), updatedAt: i.entry!.updatedAt, observedAt: new Date(this.now()).toISOString() })), ...page.rest };
    });
  }
  private kinds(kinds: unknown): void {
    if (kinds != null && (!Array.isArray(kinds) || !kinds.length || kinds.length > 6 || kinds.some(k => !["message", "tool_call", "tool_result", "run_state", "usage", "extension"].includes(k)))) fail("invalid_input", "Select common history kinds.");
  }
  private async page(state: HistoryState, actor: HistoryActor, kind: string, input: { cursor?: string; limit?: number }, items: Snapshot["items"]) {
    const limit = input.limit ?? 50; if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail("invalid_input", "Use page size 1–200.");
    const query = fingerprint({ kind, ...input, cursor: undefined });
    let snapshot: Snapshot, offset = 0;
    if (input.cursor) {
      const match = /^([a-f0-9]{32})\.([0-9]{1,9})$/.exec(input.cursor);
      if (!match) return fail("cursor_expired", "Start a new history query.", 410);
      try { snapshot = JSON.parse(await readFile(path.join(this.storage.root, `snapshot-${match[1]}.json`), "utf8")); }
      catch { return fail("cursor_expired", "This snapshot is unavailable.", 410); }
      if (snapshot.user !== actor.userId || snapshot.principal !== actor.principalId || snapshot.query !== query || snapshot.expires <= this.now()) fail("cursor_expired", "The caller, query or snapshot lifetime changed.", 410);
      offset = Number(match[2]);
      if (offset > snapshot.items.length) fail("cursor_expired", "Invalid continuation offset.", 410);
    } else {
      const files = await this.snapshots(); let count = 0;
      for (const file of files) {
        const old = JSON.parse(await readFile(path.join(this.storage.root, file), "utf8")) as Snapshot;
        if (old.expires <= this.now()) await rm(path.join(this.storage.root, file)); else if (old.user === actor.userId) count++;
      }
      if (count >= 256 || byteSize(items) > 64 * 1024 * 1024) fail("budget_exceeded", "The history snapshot budget is exhausted.", 429);
      snapshot = { id: randomUUID().replaceAll("-", ""), user: actor.userId, principal: actor.principalId, query, expires: this.now() + 900000,
        highWater: kind === "export" ? String(state.sequence) : BigInt("0x" + fingerprint(items).slice(0, 32)).toString(), acls: Object.fromEntries(items.map(i => [i.conversation, state.conversations[i.conversation]!.acl])), items, disclosures: Object.fromEntries(items.map(i => [i.conversation, this.disclosure(state, i.conversation, actor)])), offset: 0 };
      await this.storage.writeFile(`snapshot-${snapshot.id}.json`, snapshot);
    }
    const page: Snapshot["items"] = []; let bytes = 0, changed = false;
    while (offset < snapshot.items.length && page.length < limit) {
      const item = snapshot.items[offset]!, current = state.conversations[item.conversation];
      if (!current || current.metadata.ownerUserId !== actor.userId && !this.grants(state, item.conversation, actor).length) { changed = true; offset++; continue; }
      if (snapshot.acls[item.conversation] !== current.acl || snapshot.disclosures?.[item.conversation] !== this.disclosure(state, item.conversation, actor)) fail("cursor_expired", "Source sharing changed. Start a fresh query.", 410);
      if (item.entry) {
        const live = current.entries.find(e => e.ref.id === item.entry!.ref.id);
        if (!live || !this.entry(state, current, live, actor)) { changed = true; offset++; continue; }
        // Selected shares always follow live revisions. Owners can read their point-in-time snapshot.
        if (current.metadata.ownerUserId !== actor.userId && live.revision !== item.entry.revision) { changed = true; offset++; continue; }
        if (byteSize(item.entry) > 256 * 1024) fail("budget_exceeded", "A source entry exceeds the common history envelope.", 429);
      }
      const size = byteSize(item); if (bytes + size > 800 * 1024) break;
      bytes += size; page.push(item); offset++;
    }
    return { items: page, rest: { nextCursor: offset < snapshot.items.length ? `${snapshot.id}.${offset}` : null, snapshotId: snapshot.id, highWater: snapshot.highWater, coverage: coverage(changed) } };
  }
  private async snapshots(): Promise<string[]> {
    try { return (await readdir(this.storage.root)).filter(n => /^snapshot-[a-f0-9]{32}\.json$/.test(n)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  private async purgeSnapshots(removed: Set<string>): Promise<void> {
    for (const name of await this.snapshots()) {
      const snapshot = JSON.parse(await readFile(path.join(this.storage.root, name), "utf8")) as Snapshot;
      // Preserve offsets without preserving deleted bytes: invalidate the affected snapshot entirely.
      if (snapshot.expires <= this.now() || snapshot.items.some(i => removed.has(`${i.conversation}\0*`) || i.entry && removed.has(`${i.conversation}\0${i.entry.ref.id}`))) await rm(path.join(this.storage.root, name));
    }
  }
  async export(actor: ExportInvocation, input: { scope: NonNullable<ExportInvocation["export"]>; cursor?: string; limit?: number }, changes: boolean): Promise<HistoryExportSnapshot | HistoryChangePage> {
    const scope = actor.export;
    if (!scope || !input.scope || scope.ownerUserId !== actor.userId || referenceKey(scope.provider) !== referenceKey(this.provider)
      || fingerprint(scope) !== fingerprint(input.scope)) fail("permission_denied", "An exact current Core-approved export partition is required.", 403);
    const binding = { grant: scope!.grantId, owner: actor.userId, principal: actor.principalId, provider: this.provider, conversations: scope!.conversationIds };
    const stamp = fingerprint(binding), selected = scope!.conversationIds;
    const limit = input.limit ?? 50; if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail("invalid_input", "Use page size 1–200.");
    return this.synchronized(actor, async state => {
      if (!changes) {
        const items: Snapshot["items"] = [];
        for (const [key, source] of Object.entries(state.conversations)) {
          if (source.metadata.ownerUserId !== actor.userId || selected && !selected.includes(key)) continue;
          items.push(...source.entries.map(entry => ({ conversation: key, entry })));
        }
        const query = { ...input, scope: binding };
        const page = await this.page(state, actor, "export", query, items);
        return { entries: page.items.map(i => i.entry!), ...page.rest, changeCursor: await this.exportCursors.issue(stamp, page.rest.highWater) };
      }
      if (!input.cursor) return fail("rescan_required", "Complete a source snapshot before reading changes.", 410);
      let sequence = await this.exportCursors.read(stamp, input.cursor);
      if (sequence < state.floor || sequence > state.sequence) return fail("rescan_required", "The retained change window no longer covers this cursor.", 410);
      const results: HistoryChange[] = []; let bytes = 0;
      for (const change of state.changes) {
        if (Number(change.sequence) <= sequence) continue;
        if (change.owner !== actor.userId || selected && !selected.includes(change.conversation) || change.reason === "sharing") { sequence = Number(change.sequence); continue; }
        let result: HistoryChange;
        const changeId = `change-${change.sequence}`;
        const source = state.conversations[change.conversation];
        const entry = source?.metadata.ownerUserId === actor.userId ? source.entries.find(e => e.ref.id === change.entry) : undefined;
        if (change.type === "upsert" && entry) result = { id: changeId, sequence: change.sequence, type: "upsert", entry };
        else if (change.entry) result = { id: changeId, sequence: change.sequence, type: "delete", ref: { conversation: { provider: this.provider, id: change.conversation }, id: change.entry }, revision: change.revision };
        else result = { id: changeId, sequence: change.sequence, type: "access_reset", reason: "The source conversation was removed or its ownership changed." };
        if (result.type === "upsert" && byteSize(result.entry) > 256 * 1024) fail("budget_exceeded", "A source entry exceeds the common history envelope.", 429);
        const size = byteSize(result); if (results.length >= limit || bytes + size > 800 * 1024) break;
        results.push(result); bytes += size; sequence = Number(change.sequence);
      }
      return { changes: results, nextCursor: await this.exportCursors.issue(stamp, String(sequence)), highWater: String(sequence), coverage: coverage() };
    });
  }
  /** Bounded source wait; Core delivers these identifiers over its subject-bound SSE channel. */
  async notifications(actor: HistoryActor, input: { conversation: ConversationRef; cursor?: string; waitSeconds?: number }, signal?: AbortSignal) {
    const key = this.ref(input.conversation), waitSeconds = input.waitSeconds ?? 20;
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 20) fail("invalid_input", "Notification waits are bounded to 20 seconds.");
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      let wake!: () => void;
      const waiting = new Promise<void>(resolve => { wake = resolve; });
      const watchers = this.waiters.get(key) ?? new Set<() => void>(); watchers.add(wake); this.waiters.set(key, watchers);
      const timeout = setTimeout(wake, Math.max(0, deadline - Date.now())); signal?.addEventListener("abort", wake, { once: true });
      try {
        const result = await this.synchronized(actor, async state => {
          const source = this.visible(state, key, actor);
          const scope = fingerprint({ kind: "notifications", user: actor.userId, principal: actor.principalId, conversation: input.conversation, acl: source.acl, disclosure: this.disclosure(state, key, actor) });
          let after = state.sequence, rescanRequired = !input.cursor;
          if (input.cursor) {
            try { after = await this.exportCursors.read(scope, input.cursor); }
            catch (error) { if (!(error instanceof ProviderError) || error.code !== "rescan_required") throw error; rescanRequired = true; }
            if (after < state.floor || after > state.sequence) { rescanRequired = true; after = state.sequence; }
          }
          const changes: Array<{ type: "upsert" | "delete"; entryId: string; revision: string }> = [];
          if (!rescanRequired) for (const change of state.changes) {
            if (Number(change.sequence) <= after || change.conversation !== key || !change.entry) continue;
            const live = source.entries.find(e => e.ref.id === change.entry);
            const permitted = source.metadata.ownerUserId === actor.userId || this.grants(state, key, actor).some(g => g.selection.includeFutureEntries || g.selection.entryIds?.includes(change.entry!));
            if (!permitted || live && !this.entry(state, source, live, actor)) continue;
            if (changes.length >= 200) { rescanRequired = true; changes.length = 0; break; }
            changes.push({ type: live ? "upsert" : "delete", entryId: change.entry, revision: live?.revision ?? change.revision });
          }
          const result = { conversation: input.conversation, revision: this.metadata(state, source, actor).revision,
            cursor: await this.exportCursors.issue(scope, String(state.sequence)), changes, rescanRequired };
          this.deliveryGuards.set(result, { acls: { [key]: source.acl }, disclosures: { [key]: this.disclosure(state, key, actor) }, entries: [] });
          return result;
        });
        if (result.rescanRequired || result.changes.length || Date.now() >= deadline || signal?.aborted) return result;
        await waiting;
        if (signal?.aborted) throw new ProviderError("request_cancelled", "The notification consumer disconnected.", 499);
      } finally { clearTimeout(timeout); watchers.delete(wake); if (!watchers.size) this.waiters.delete(key); signal?.removeEventListener("abort", wake); }
    }
  }
  async shares(actor: HistoryActor, reference: ConversationRef) {
    const key = this.ref(reference);
    return this.synchronized(actor, state => {
      const source = this.visible(state, key, actor), owner = source.metadata.ownerUserId === actor.userId;
      return { shares: state.shares.filter(g => g.ref.id === key && (owner || g.recipientUserIds.includes(actor.userId))).map(g => owner ? g : { ...g, recipientUserIds: [actor.userId] }), conversationRevision: this.metadata(state, source, actor).revision };
    });
  }
  async share(actor: HistoryActor, input: HistoryShareCreate | HistoryShareRevoke, revoke = false) {
    const key = this.ref(input.ref), requestId = uuid(input.requestId); revision(input.expectedRevision);
    return this.synchronized(actor, async state => {
      const source = this.visible(state, key, actor); if (source.metadata.ownerUserId !== actor.userId) fail("permission_denied", "Only the source owner can change sharing.", 403);
      const stamp = fingerprint({ ...input, requestId, revoke });
      const receipt = state.receipts.find(r => r.user === actor.userId && r.principal === actor.principalId && r.requestId === requestId);
      if (receipt) {
        if (receipt.fingerprint !== stamp) fail("request_conflict", "This UUID already identifies different input.", 409);
        return receipt.result;
      }
      if (source.metadata.revision !== input.expectedRevision) fail("revision_conflict", "Read the current conversation before changing sharing.", 409);
      let grant: HistoryShare;
      if (revoke) {
        const previous = state.shares.find(g => g.ref.id === key && g.id === (input as HistoryShareRevoke).grantId); if (!previous) return missing();
        grant = { ...previous, state: "revoked", revision: String(BigInt(previous.revision) + 1n) };
        state.shares = state.shares.map(g => g.id === grant.id ? grant : g);
      } else {
        if (state.shares.filter(g => g.ref.id === key).length >= 200) fail("budget_exceeded", "This conversation has reached its retained share budget.", 429);
        const create = input as HistoryShareCreate, selection = create.selection;
        if (!selection || selection.includeFutureEntries === true && selection.entryIds != null || selection.includeFutureEntries !== true && (!Array.isArray(selection.entryIds) || selection.entryIds.length < 1 || selection.entryIds.length > 200 || new Set(selection.entryIds).size !== selection.entryIds.length)) fail("invalid_input", "Select fixed entries or explicitly include future entries.");
        if (!Array.isArray(create.recipientUserIds) || !create.recipientUserIds.length || create.recipientUserIds.length > 16 || new Set(create.recipientUserIds).size !== create.recipientUserIds.length || create.recipientUserIds.some(u => !u || u === actor.userId)) fail("invalid_input", "Select distinct existing recipients.");
        if (typeof create.includeAttachments !== "boolean" || create.label != null && (typeof create.label !== "string" || create.label.length > 200) || create.expiresAt && (!Number.isFinite(Date.parse(create.expiresAt)) || Date.parse(create.expiresAt) <= this.now()) || create.extensions?.length) fail("invalid_input", "Select valid disclosure and expiration options; Harness declares no history extensions.");
        for (const entry of selection.entryIds ?? []) if (!source.entries.some(e => e.ref.id === entry)) return missing();
        grant = { id: randomUUID(), ref: source.metadata.ref, revision: "1", ownerUserId: actor.userId, recipientUserIds: [...create.recipientUserIds].sort(), selection,
          includeAttachments: create.includeAttachments, extensions: [], label: create.label ?? null, expiresAt: create.expiresAt ?? null, state: "active" };
        state.shares.push(grant);
      }
      source.acl++; source.metadata.revision = String(BigInt(source.metadata.revision) + 1n);
      this.change(state, { type: "access_reset", owner: actor.userId, conversation: key, revision: source.metadata.revision, reason: "sharing" });
      const result = { requestId, grant, conversationRevision: source.metadata.revision };
      state.receipts.push({ user: actor.userId, principal: actor.principalId, requestId, fingerprint: stamp, result });
      await this.storage.write(state); return result;
    });
  }
}
