import { providerIdentityParts } from "../../shared/provider-reference.js";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { AgentHistoryObservation, AgentProviderRef } from "@hosty-sdk/app/agent";
import { durableMkdir, durableWriteFile } from "../persistence.js";
import type { SessionStore } from "../sessions/store.js";

type Interval = { from: number; to: number };
export type ProviderHistoryGap = Interval & { sessionId: string; epoch: string; archiveGeneration?: string; unavailable?: boolean };
export type HistoryReceipt = AgentHistoryObservation & { replayed?: boolean; recoveryGeneration?: string };
type Coverage = { head: number; stored: Interval[]; unavailable: Interval[]; confirmedHead?: number; confirmedThrough?: string };
type Scope = { sessionId: string; epoch: string; generation: string };

function merge(ranges: Interval[], added: Interval): Interval[] {
  const result: Interval[] = [];
  let next = { ...added };
  for (const range of ranges) {
    if (range.to < next.from - 1) result.push(range);
    else if (next.to < range.from - 1) { result.push(next); next = range; }
    else next = { from: Math.min(range.from, next.from), to: Math.max(range.to, next.to) };
  }
  result.push(next);
  return result;
}

function missing(coverage: Coverage): (Interval & { unavailable?: boolean })[] {
  const result: (Interval & { unavailable?: boolean })[] = [];
  const split = (start: number, end: number) => {
    for (const range of coverage.unavailable) {
      if (range.to < start) continue;
      if (range.from > end) break;
      if (start < range.from) result.push({ from: start, to: range.from - 1 });
      result.push({ from: Math.max(start, range.from), to: Math.min(end, range.to), unavailable: true });
      start = range.to + 1;
      if (start > end) return;
    }
    if (start <= end) result.push({ from: start, to: end });
  };
  let start = 1;
  for (const range of coverage.stored) {
    if (start < range.from) split(start, range.from - 1);
    start = range.to + 1;
  }
  if (start <= coverage.head) split(start, coverage.head);
  return result;
}

function validCoverage(value: Coverage): boolean {
  const ranges = (items: Interval[]) => Array.isArray(items) && items.every((item, i) =>
    item && Number.isSafeInteger(item.from) && Number.isSafeInteger(item.to) &&
    item.from >= 1 && item.from <= item.to && item.to <= value.head && (!i || item.from - 1 > items[i - 1]!.to));
  return value && Number.isSafeInteger(value.head) && value.head >= 0 &&
    (value.confirmedHead === undefined || Number.isSafeInteger(value.confirmedHead) && value.confirmedHead >= 0 && value.confirmedHead <= value.head) &&
    (value.confirmedThrough === undefined || typeof value.confirmedThrough === "string") &&
    ranges(value.stored) && ranges(value.unavailable);
}

function confirmHead(coverage: Coverage, head: number, through: string): boolean {
  if (head < (coverage.confirmedHead ?? 0) || head === coverage.confirmedHead && coverage.confirmedThrough) return false;
  coverage.confirmedHead = head;
  coverage.confirmedThrough = through;
  coverage.head = Math.max(coverage.head, head);
  return true;
}

/** The transcript commit precedes the receipt. A crash between them retries the stable source identity. */
export class ProviderHistoryCoverage {
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly active = new Map<string, string>();
  private readonly reported = new Map<string, string>();

  constructor(private readonly store: SessionStore, private readonly report: (id: string, gaps: ProviderHistoryGap[]) => Promise<void>,
    private readonly isCurrent: (id: string, provider: AgentProviderRef, sessionId: string) => boolean = () => true) {}

  private key(provider: AgentProviderRef, scope: Scope): string {
    return createHash("sha256").update(JSON.stringify([...providerIdentityParts(provider),
      scope.sessionId, scope.epoch, scope.generation])).digest("hex");
  }

  activate(id: string, provider: AgentProviderRef, scope: Scope): void {
    if (this.isCurrent(id, provider, scope.sessionId)) this.active.set(id, this.key(provider, scope));
  }

  forget(id: string): void {
    this.active.delete(id);
    this.reported.delete(id);
  }

  private async update(id: string, provider: AgentProviderRef, scope: Scope, change: (value: Coverage) => Promise<boolean>) {
    const key = this.key(provider, scope), name = "coverage-" + key + ".json";
    const task = (this.lanes.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      let fileExists = false;
      const stored = await this.store.withHistoryInbox(id, async folder => {
        try {
          const bytes = await readFile(path.join(folder, name), "utf8");
          fileExists = true;
          const value: Coverage = JSON.parse(bytes);
          if (validCoverage(value)) return value;
        } catch (error) {
          if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return { head: 0, stored: [], unavailable: [] } as Coverage;
      });
      if (!stored) return [];
      if (await change(stored)) {
        await this.store.withHistoryInbox(id, async folder => {
          if (!fileExists) await durableMkdir(folder);
          await durableWriteFile(path.join(folder, name), JSON.stringify({ ...stored, scope }));
        });
      }
      const gaps = missing(stored).map(range => ({ ...range, epoch: scope.epoch, sessionId: scope.sessionId }));
      if (this.active.get(id) === key) {
        const displayed = gaps.map(gap => ({ ...gap, archiveGeneration: scope.generation }));
        const reportKey = JSON.stringify(displayed);
        if (this.reported.get(id) !== reportKey) {
          await this.report(id, displayed);
          this.reported.set(id, reportKey);
        }
      }
      return gaps;
    });
    this.lanes.set(id, task);
    try { return await task; } finally { if (this.lanes.get(id) === task) this.lanes.delete(id); }
  }

  async observeHead(id: string, provider: AgentProviderRef, scope: Scope, head: number, through: string) {
    this.activate(id, provider, scope);
    return this.update(id, provider, scope, async coverage => confirmHead(coverage, head, through));
  }

  /** Deletion and creation after the inventory boundary both produce an omitted session.
   * Ask at the stored cursor where its highest ordinal was actually observed. */
  async unlisted(id: string, provider: AgentProviderRef, sessionId: string, generation: string): Promise<(ProviderHistoryGap & { through?: string })[]> {
    return await this.store.withHistoryInbox(id, async folder => {
      let files: string[];
      try { files = await readdir(folder); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const gaps: (ProviderHistoryGap & { through?: string })[] = [];
      for (const name of files.filter(file => /^coverage-[a-f0-9]{64}\.json$/.test(file))) {
        let saved: Coverage & { scope?: Scope };
        try { saved = JSON.parse(await readFile(path.join(folder, name), "utf8")); }
        catch (error) { if (error instanceof SyntaxError) continue; throw error; }
        if (!saved || typeof saved !== "object") continue;
        const { scope, confirmedHead } = saved;
        if (!scope || scope.sessionId !== sessionId || scope.generation !== generation ||
          !confirmedHead || !validCoverage(saved) || name !== "coverage-" + this.key(provider, scope) + ".json") continue;
        this.activate(id, provider, scope);
        for (const gap of missing(saved)) if (!gap.unavailable && gap.from <= confirmedHead)
          gaps.push({ ...gap, to: Math.min(confirmedHead, gap.to), sessionId, epoch: scope.epoch, through: saved.confirmedThrough });
      }
      return gaps;
    }) ?? [];
  }

  async unavailable(id: string, provider: AgentProviderRef, scope: Scope, from: number, to: number) {
    await this.update(id, provider, scope, async coverage => {
      coverage.head = Math.max(coverage.head, to);
      coverage.unavailable = merge(coverage.unavailable, { from, to });
      return true;
    });
  }

  async accept(id: string, provider: AgentProviderRef, fact: HistoryReceipt, apply: () => Promise<void>) {
    const { sessionId, sessionPosition, epoch, recoveryGeneration } = fact;
    if (!sessionPosition || !epoch || !recoveryGeneration) return apply();
    await this.update(id, provider, { sessionId, epoch, generation: recoveryGeneration }, async coverage => {
      const updatedHead = confirmHead(coverage, sessionPosition, fact.cursor);
      if (coverage.stored.some(range => range.from <= sessionPosition && sessionPosition <= range.to)) return updatedHead;
      await apply();
      coverage.stored = merge(coverage.stored, { from: sessionPosition, to: sessionPosition });
      return true;
    });
  }
}
