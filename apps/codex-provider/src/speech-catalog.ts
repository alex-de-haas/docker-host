import path from "node:path";
import { readFile } from "node:fs/promises";
import { durableWriteFile } from "@hosty/agent-provider-runtime/persistence";
import type { ProviderClient } from "@hosty-sdk/app/providers/server";
import { speechKinds, type CodexConnections, type SpeechKind } from "./connections.js";

type CatalogRow = { id: string; displayName: string; available: boolean };
type Catalog = { revision: number; implementations: CatalogRow[] };
type State = Partial<Record<SpeechKind, Catalog>>;

/** Persist each exact snapshot before publishing so retries after a crash reuse its revision. */
export class SpeechCatalog {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private dirty = false;
  private readonly stop = new AbortController();
  private readonly file: string;

  constructor(private readonly accounts: CodexConnections, data: string,
    private readonly core: Pick<ProviderClient, "publishImplementations">) {
    this.file = path.join(data, "speech-catalog.json");
    accounts.speechChanged = () => this.schedule(0);
    this.schedule(0);
  }

  private schedule(delay: number) {
    if (this.stop.signal.aborted) return;
    if (this.running) { this.dirty = true; return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.refresh().catch(() => {}); }, delay);
    this.timer.unref();
  }

  refresh(): Promise<void> {
    if (this.running) return this.running;
    clearTimeout(this.timer);
    let delay = 60_000;
    this.running = this.publish().catch(error => { delay = 5_000; throw error; }).finally(() => {
      this.running = undefined;
      this.schedule(this.dirty ? 0 : delay);
      this.dirty = false;
    });
    return this.running;
  }

  private async publish() {
    const entries = await this.accounts.speechImplementations();
    let prior: State = {};
    try { prior = JSON.parse(await readFile(this.file, "utf8")) as State; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next: State = {};
    let changed = false;
    for (const kind of speechKinds) {
      const implementations = entries.filter(entry => entry.roles.includes(kind))
        .map(({ id, displayName, available }) => ({ id, displayName, available })).sort((a, b) => a.id.localeCompare(b.id));
      const old = prior[kind];
      if (old && (!Number.isSafeInteger(old.revision) || old.revision < 1 || !Array.isArray(old.implementations)))
        throw new Error("Invalid speech catalog revision.");
      if (old && JSON.stringify(old.implementations) === JSON.stringify(implementations)) next[kind] = old;
      else { next[kind] = { revision: (old?.revision ?? 0) + 1, implementations }; changed = true; }
    }
    if (changed) await durableWriteFile(this.file, JSON.stringify(next));
    // A permission-review failure for one interface must not block the other.
    const results = await Promise.allSettled(speechKinds.map(kind =>
      this.core.publishImplementations(kind, "default", next[kind]!, this.stop.signal)));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }

  close() {
    this.accounts.speechChanged = undefined;
    this.stop.abort();
    clearTimeout(this.timer);
  }
}
