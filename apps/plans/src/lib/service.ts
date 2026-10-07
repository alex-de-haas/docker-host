import path from "node:path";
import { tmpdir } from "node:os";
import { DocumentCache } from "./cache";
import { PlansError } from "./auth";
import type { SourceReader } from "./core-client";
import { componentApps, mapBounded, workspaceLabel } from "./model";
import { parseSourceDocument } from "./parser";
import type { DocumentListing, ParsedDocument, PlanCard, PlanDetail, RepositoryPlans, SourceRepository, Workspace, WorkspacePlan } from "./types";

const cacheKey = Symbol.for("hosty.plans.cache.v2");
export function getCache(): DocumentCache {
  const holder = globalThis as { [cacheKey]?: DocumentCache };
  return holder[cacheKey] ??= new DocumentCache(path.join(process.env.HOSTY_APP_CACHE_DIR?.trim() || path.join(tmpdir(), "hosty-plans"), "documents"));
}
function message(error: unknown): string { return error instanceof Error ? error.message : "The document could not be read."; }
function requireListing(listing: DocumentListing) {
  if (listing.error || !Array.isArray(listing.documents)) throw new PlansError(listing.error ?? "Repository documents are unavailable.");
}
function authorityRefused(failure: unknown): boolean {
  return failure instanceof PlansError && (failure.status === 401 || failure.status === 403 && failure.code !== "source_document_forbidden");
}
export class PlansService {
  constructor(private readonly reader: SourceReader, private readonly cache = getCache()) {}
  async repositories() { return this.reader.repositories(); }
  private async document(repositoryId: string, listing: DocumentListing, documentPath: string): Promise<ParsedDocument | null> {
    requireListing(listing);
    const entry = listing.documents.find(item => item.path === documentPath);
    if (!entry) return null;
    // This request's listing is the authority; a previous user's cache hit cannot authorize a read.
    if (Array.isArray(entry.referencePaths)) {
      const validated = this.cache.readValidated(entry.sha, documentPath, entry.referencePaths);
      if (validated) return validated;
    }
    const cached = await this.cache.read(entry.sha, documentPath);
    const served = cached ? null : await this.reader.content(repositoryId, documentPath, listing, entry.sha);
    if (served && (served.sha !== entry.sha || served.path !== documentPath)) throw new PlansError("The document changed during the read. Refresh to read its current version.", 409, "document_changed");
    const content = cached?.content ?? served!.content;
    const parsed = cached?.document ?? await this.cache.write(served!.sha, documentPath, content);
    const references = served?.referencePaths ?? entry.referencePaths;
    if (!Array.isArray(references)) return { ...parsed, errors: [...parsed.errors, "Core did not provide referenced-path validation. Refresh after updating Core."], progress: null };
    // References are derived from this exact served/listed version; no wider file access is used.
    return this.cache.validate(entry.sha, documentPath, content, references);
  }
  private async workspacePlans(repository: SourceRepository, workspace: Workspace, onlyPath?: string): Promise<WorkspacePlan[]> {
    const changes = (workspace.changes ?? []).filter(change => /\/plan\.md$/.test(change.path) && (!onlyPath || change.path === onlyPath));
    if (onlyPath && !changes.length) return [];
    if (!changes.length) return [];
    let current: DocumentListing | null = null, base: DocumentListing | null = null;
    let error: string | null = null;
    try {
      [current, base] = await Promise.all([this.reader.listing(repository.id, "worktree", workspace.id, false, onlyPath), this.reader.listing(repository.id, "base", workspace.id, false, onlyPath)]);
      requireListing(current); requireListing(base);
      if (onlyPath && changes.some(change => change.kind === "deleted")) {
        const featurePath = onlyPath.replace(/plan\.md$/, "feature.md");
        const [currentFeature, baseFeature] = await Promise.all([this.reader.listing(repository.id, "worktree", workspace.id, false, featurePath), this.reader.listing(repository.id, "base", workspace.id, false, featurePath)]);
        requireListing(currentFeature); requireListing(baseFeature);
        current = { ...current, documents: [...current.documents, ...currentFeature.documents] };
        base = { ...base, documents: [...base.documents, ...baseFeature.documents] };
      }
    } catch (failure) { if (authorityRefused(failure)) throw failure; error = message(failure); }
    return mapBounded(changes, 4, async change => {
      let document: ParsedDocument | null = null, baseDocument: ParsedDocument | null = null;
      let readError = error;
      if (!error && current && base) {
        try { [document, baseDocument] = await Promise.all([this.document(repository.id, current, change.path), this.document(repository.id, base, change.path)]); }
        catch (failure) { if (authorityRefused(failure)) throw failure; readError = message(failure); }
      }
      const featurePath = change.path.replace(/plan\.md$/, "feature.md");
      const currentFeature = current?.documents.find(item => item.path === featurePath);
      const baseFeature = base?.documents.find(item => item.path === featurePath);
      // The projection omits changes already equal to the target. A feature update can be
      // integrated before the plan deletion; compare its own base/worktree SHAs for this label.
      const featureUpdated = !error && current && base ? Boolean(currentFeature && currentFeature.sha !== baseFeature?.sha) : undefined;
      return { workspace, change, label: workspaceLabel(workspace, change, featureUpdated), document, base: baseDocument, error: readError };
    });
  }
  async repository(repositoryId: string, refresh = false): Promise<RepositoryPlans> {
    // First reads can resolve an undeclared remote default branch. Core accepts the provisional
    // entry as an alias and returns its canonical branch identity; use that identity thereafter.
    let listing: DocumentListing | null = null;
    let targetError: string | null = null;
    try { listing = await this.reader.listing(repositoryId, "target", undefined, refresh); requireListing(listing); }
    catch (error) { targetError = message(error); }
    const repository = (await this.reader.repositories()).find(item => item.id === (listing?.repositoryId ?? repositoryId));
    if (!repository) throw new PlansError("Repository was not found or is no longer accessible.", 404, "repository_not_found");
    const workspaces = await this.reader.workspaces(repository.id);
    const workspacePlans = (await mapBounded(workspaces, 3, workspace => this.workspacePlans(repository, workspace))).flat();
    if (targetError || !listing) return { repository, plans: this.cards(repository, [], workspacePlans), workspaces, state: "unavailable", error: targetError };
    const targetListing = listing;
    const plans = await mapBounded(listing.documents.filter(item => /\/plan\.md$/.test(item.path)), 4, async entry => {
      try { return { path: entry.path, document: await this.document(repository.id, targetListing, entry.path) }; }
      catch (error) { return { path: entry.path, document: { ...parseSourceDocument(entry.path, ""), errors: [message(error)], progress: null } }; }
    });
    return { repository, plans: this.cards(repository, plans, workspacePlans), workspaces, state: listing.state, error: listing.error };
  }
  private cards(repository: SourceRepository, baseline: { path: string; document: ParsedDocument | null }[], changes: WorkspacePlan[]): PlanCard[] {
    const paths = new Set([...baseline.map(item => item.path), ...changes.map(item => item.change.path)]);
    return [...paths].sort().map(documentPath => {
      const document = baseline.find(item => item.path === documentPath)?.document ?? null;
      const workspaces = changes.filter(item => item.change.path === documentPath);
      return { repository, path: documentPath, document: overviewDocument(document), workspaces: workspaces.map(version => ({ ...version, document: overviewDocument(version.document), base: null })), apps: componentApps(repository, document ?? workspaces.find(item => item.document)?.document ?? null) };
    });
  }
  async detail(repositoryId: string, documentPath: string, refresh = false): Promise<PlanDetail> {
    let listing: DocumentListing | null = null;
    let targetFailure: { cause: unknown; error: string } | null = null;
    const unavailableTarget = (failure: unknown) => {
      // Identity, role and permission refusals retain their HTTP refusal semantics. A provider
      // outage may leave independently authorized local workspace versions available.
      if (failure instanceof PlansError && (failure.status === 401 || failure.status === 403)) throw failure;
      return { cause: failure, error: message(failure) };
    };
    try { listing = await this.reader.listing(repositoryId, "target", undefined, refresh, documentPath); requireListing(listing); }
    catch (failure) { targetFailure = unavailableTarget(failure); listing = null; }
    const repository = (await this.reader.repositories()).find(item => item.id === (listing?.repositoryId ?? repositoryId));
    if (!repository) throw new PlansError("Repository was not found or is no longer accessible.", 404, "repository_not_found");
    const [document, workspaces] = await Promise.all([
      listing ? this.document(repository.id, listing, documentPath).catch(failure => { targetFailure = unavailableTarget(failure); return null; }) : null,
      this.reader.workspaces(repository.id).then(items => mapBounded(items, 3, item => this.workspacePlans(repository, item, documentPath))).then(items => items.flat()),
    ]);
    if (!document && !workspaces.length) {
      if (targetFailure) throw targetFailure.cause;
      throw new PlansError("The document does not exist in the tracked branch or a changing workspace.", 404, "document_not_found");
    }
    return { repository, path: documentPath, document, workspaces, error: targetFailure?.error ?? null };
  }
}
function overviewDocument(document: ParsedDocument | null): ParsedDocument | null {
  // The overview transports only status, progress and labels. Full Markdown and base versions
  // are read through the detail request, keeping independent repository responses small.
  return document ? { ...document, body: "", content: "", deliverables: [] } : null;
}
