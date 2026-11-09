import { enrichDocuments, featurePath } from "./catalog";
import { documentKind } from "../../../../scripts/docs-format.mjs";
import path from "node:path";
import { tmpdir } from "node:os";
import { DocumentCache } from "./cache";
import { DocumentsError } from "./auth";
import type { SourceReader } from "./core-client";
import { componentApps, mapBounded, workspaceLabel } from "./model";
import { parseSourceDocument } from "./parser";
import type {
  DocumentListing,
  ParsedDocument,
  PlanCard,
  PlanDetail,
  RepositoryDocuments,
  SourceRepository,
  Workspace,
  WorkspacePlan,
} from "./types";

const cacheKey = Symbol.for("hosty.documents.cache.v3");
export function getCache(): DocumentCache {
  const holder = globalThis as { [cacheKey]?: DocumentCache };
  return (holder[cacheKey] ??= new DocumentCache(
    path.join(
      process.env.HOSTY_APP_CACHE_DIR?.trim() ||
        path.join(tmpdir(), "hosty-documents"),
      "documents",
    ),
  ));
}
function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The document could not be read.";
}
function requireListing(listing: DocumentListing) {
  if (listing.error || !Array.isArray(listing.documents))
    throw new DocumentsError(
      listing.error ?? "Repository documents are unavailable.",
    );
}
function authorityRefused(failure: unknown): boolean {
  return (
    failure instanceof DocumentsError &&
    (failure.status === 401 ||
      (failure.status === 403 && failure.code !== "source_document_forbidden"))
  );
}
export class DocumentsService {
  constructor(
    private readonly reader: SourceReader,
    private readonly cache = getCache(),
  ) {}
  async repositories() {
    return this.reader.repositories();
  }
  private async document(
    repositoryId: string,
    listing: DocumentListing,
    documentPath: string,
  ): Promise<ParsedDocument | null> {
    requireListing(listing);
    const entry = listing.documents.find((item) => item.path === documentPath);
    if (!entry) return null;
    // This request's listing is the authority; a previous user's cache hit cannot authorize a read.
    if (Array.isArray(entry.referencePaths)) {
      const validated = this.cache.readValidated(
        entry.sha,
        documentPath,
        entry.referencePaths,
      );
      if (validated) return validated;
    }
    const cached = await this.cache.read(entry.sha, documentPath);
    const served = cached
      ? null
      : await this.reader.content(
          repositoryId,
          documentPath,
          listing,
          entry.sha,
        );
    if (served && (served.sha !== entry.sha || served.path !== documentPath))
      throw new DocumentsError(
        "The document changed during the read. Refresh to read its current version.",
        409,
        "document_changed",
      );
    const content = cached?.content ?? served!.content;
    const parsed =
      cached?.document ??
      (await this.cache.write(served!.sha, documentPath, content));
    const references = served?.referencePaths ?? entry.referencePaths;
    if (!Array.isArray(references))
      return {
        ...parsed,
        errors: [
          ...parsed.errors,
          "Core did not provide referenced-path validation. Refresh after updating Core.",
        ],
        progress: null,
      };
    // References are derived from this exact served/listed version; no wider file access is used.
    return this.cache.validate(entry.sha, documentPath, content, references);
  }
  private async workspaceDocuments(
    repository: SourceRepository,
    workspace: Workspace,
    onlyPath?: string,
    allDocuments = false,
  ): Promise<WorkspacePlan[]> {
    const changes = (workspace.changes ?? []).filter(
      (change) =>
        (allDocuments || /\/plan\.md$/.test(change.path)) &&
        (!onlyPath || change.path === onlyPath),
    );
    if (onlyPath && !changes.length) return [];
    if (!changes.length) return [];
    let current: DocumentListing | null = null,
      base: DocumentListing | null = null;
    let error: string | null = null;
    try {
      [current, base] = await Promise.all([
        this.reader.listing(
          repository.id,
          "worktree",
          workspace.id,
          false,
          onlyPath,
        ),
        this.reader.listing(
          repository.id,
          "base",
          workspace.id,
          false,
          onlyPath,
        ),
      ]);
      requireListing(current);
      requireListing(base);
      if (
        onlyPath?.endsWith("/plan.md") &&
        changes.some((change) => change.kind === "deleted")
      ) {
        const featurePath = onlyPath.replace(/plan\.md$/, "feature.md");
        const [currentFeature, baseFeature] = await Promise.all([
          this.reader.listing(
            repository.id,
            "worktree",
            workspace.id,
            false,
            featurePath,
          ),
          this.reader.listing(
            repository.id,
            "base",
            workspace.id,
            false,
            featurePath,
          ),
        ]);
        requireListing(currentFeature);
        requireListing(baseFeature);
        current = {
          ...current,
          documents: [...current.documents, ...currentFeature.documents],
        };
        base = {
          ...base,
          documents: [...base.documents, ...baseFeature.documents],
        };
      }
    } catch (failure) {
      if (authorityRefused(failure)) throw failure;
      error = message(failure);
    }
    const allowedCurrent = new Set(
      (current ? boundedEntries(current) : []).map((item) => item.path),
    );
    const allowedBase = new Set(
      (base ? boundedEntries(base) : []).map((item) => item.path),
    );
    const versions = await mapBounded(
      changes.slice(0, 2000),
      4,
      async (change) => {
        let document: ParsedDocument | null = null,
          baseDocument: ParsedDocument | null = null;
        let readError = error;
        if (
          !onlyPath &&
          ((current?.documents.some((item) => item.path === change.path) &&
            !allowedCurrent.has(change.path)) ||
            (base?.documents.some((item) => item.path === change.path) &&
              !allowedBase.has(change.path)))
        )
          readError =
            "Workspace document index budget exceeded. Open its exact document link to read this version.";
        if (!readError && current && base) {
          try {
            [document, baseDocument] = await Promise.all([
              this.document(repository.id, current, change.path),
              this.document(repository.id, base, change.path),
            ]);
          } catch (failure) {
            if (authorityRefused(failure)) throw failure;
            readError = message(failure);
          }
        }
        const featurePath = change.path.replace(/plan\.md$/, "feature.md");
        const currentFeature = current?.documents.find(
          (item) => item.path === featurePath,
        );
        const baseFeature = base?.documents.find(
          (item) => item.path === featurePath,
        );
        // The projection omits changes already equal to the target. A feature update can be
        // integrated before the plan deletion; compare its own base/worktree SHAs for this label.
        const featureUpdated =
          !error && current && base
            ? Boolean(currentFeature && currentFeature.sha !== baseFeature?.sha)
            : undefined;
        return {
          workspace,
          change,
          label: workspaceLabel(workspace, change, featureUpdated),
          document,
          base: baseDocument,
          error: readError,
        };
      },
    );
    if (allDocuments && !onlyPath && current && !error) {
      const contextListing = current;
      const context = await mapBounded(
        boundedEntries(contextListing),
        4,
        async (entry) => {
          try {
            return await this.document(
              repository.id,
              contextListing,
              entry.path,
            );
          } catch (failure) {
            if (authorityRefused(failure)) throw failure;
            return null;
          }
        },
      );
      const documents = context.filter(
        (item): item is ParsedDocument => item !== null,
      );
      const enriched = new Map(
        enrichDocuments(
          documents,
          documents.length === contextListing.documents.length,
        ).map((item) => [item.path, item]),
      );
      for (const version of versions) {
        const validated = enriched.get(version.change.path);
        if (validated && version.document?.content === validated.content)
          version.document = validated;
      }
    }
    return versions;
  }
  async repository(
    repositoryId: string,
    refresh = false,
    allDocuments = false,
  ): Promise<RepositoryDocuments> {
    // First reads can resolve an undeclared remote default branch. Core accepts the provisional
    // entry as an alias and returns its canonical branch identity; use that identity thereafter.
    let listing: DocumentListing | null = null;
    let targetError: string | null = null;
    try {
      listing = await this.reader.listing(
        repositoryId,
        "target",
        undefined,
        refresh,
      );
      requireListing(listing);
    } catch (error) {
      if (authorityRefused(error)) throw error;
      targetError = message(error);
    }
    const repository = (await this.reader.repositories()).find(
      (item) => item.id === (listing?.repositoryId ?? repositoryId),
    );
    if (!repository)
      throw new DocumentsError(
        "Repository was not found or is no longer accessible.",
        404,
        "repository_not_found",
      );
    const workspaces = await this.reader.workspaces(repository.id);
    const workspaceDocuments = (
      await mapBounded(workspaces, 3, (workspace) =>
        this.workspaceDocuments(repository, workspace, undefined, allDocuments),
      )
    ).flat();
    if (targetError || !listing)
      return {
        repository,
        plans: this.cards(repository, [], workspaceDocuments),
        workspaces,
        state: "unavailable",
        error: targetError,
      };
    const targetListing = listing;
    const entries = boundedEntries(listing);
    const partial =
      entries.length < listing.documents.length ||
      workspaces.some((item) => (item.changes?.length ?? 0) > 2000);
    const plans = await mapBounded(
      entries.filter((item) => allDocuments || /\/plan\.md$/.test(item.path)),
      4,
      async (entry) => {
        try {
          return {
            path: entry.path,
            document: await this.document(
              repository.id,
              targetListing,
              entry.path,
            ),
          };
        } catch (error) {
          if (authorityRefused(error)) throw error;
          return {
            path: entry.path,
            document: {
              ...parseSourceDocument(entry.path, ""),
              errors: [message(error)],
              progress: null,
            },
          };
        }
      },
    );
    const enriched = enrichDocuments(
      plans.flatMap((item) => (item.document ? [item.document] : [])),
      entries.length === listing.documents.length,
    );
    return {
      repository,
      plans: this.cards(
        repository,
        enriched.map((document) => ({ path: document.path, document })),
        workspaceDocuments,
      ),
      workspaces,
      state: partial ? "partial" : listing.state,
      error: partial
        ? "The documentation index is limited to 2,000 documents and 32 MiB per version. Exact document links remain available."
        : listing.error,
    };
  }
  private cards(
    repository: SourceRepository,
    baseline: { path: string; document: ParsedDocument | null }[],
    changes: WorkspacePlan[],
  ): PlanCard[] {
    const paths = new Set([
      ...baseline.map((item) => item.path),
      ...changes.map((item) => item.change.path),
    ]);
    return [...paths].sort().map((documentPath) => {
      const document =
        baseline.find((item) => item.path === documentPath)?.document ?? null;
      const workspaces = changes.filter(
        (item) => item.change.path === documentPath,
      );
      return {
        repository,
        path: documentPath,
        document: overviewDocument(document),
        workspaces: workspaces.map((version) => ({
          ...version,
          document: overviewDocument(version.document),
          base: null,
        })),
        apps: componentApps(
          repository,
          document ??
            workspaces.find((item) => item.document)?.document ??
            null,
        ),
      };
    });
  }
  async detail(
    repositoryId: string,
    documentPath: string,
    refresh = false,
    selectedWorkspaceId?: string,
    rich = false,
  ): Promise<PlanDetail> {
    let listing: DocumentListing | null = null;
    let targetFailure: { cause: unknown; error: string } | null = null;
    const unavailableTarget = (failure: unknown) => {
      // Identity, role and permission refusals retain their HTTP refusal semantics. A provider
      // outage may leave independently authorized local workspace versions available.
      if (
        failure instanceof DocumentsError &&
        (failure.status === 401 || failure.status === 403)
      )
        throw failure;
      return { cause: failure, error: message(failure) };
    };
    try {
      listing = await this.reader.listing(
        repositoryId,
        "target",
        undefined,
        refresh,
        documentPath,
      );
      requireListing(listing);
    } catch (failure) {
      targetFailure = unavailableTarget(failure);
      listing = null;
    }
    const repository = (await this.reader.repositories()).find(
      (item) => item.id === (listing?.repositoryId ?? repositoryId),
    );
    if (!repository)
      throw new DocumentsError(
        "Repository was not found or is no longer accessible.",
        404,
        "repository_not_found",
      );
    const [document, workspaces] = await Promise.all([
      listing
        ? this.document(repository.id, listing, documentPath).catch(
            (failure) => {
              targetFailure = unavailableTarget(failure);
              return null;
            },
          )
        : null,
      this.reader
        .workspaces(repository.id)
        .then((items) =>
          mapBounded(items, 3, (item) =>
            this.workspaceDocuments(repository, item, documentPath, true),
          ),
        )
        .then((items) => items.flat()),
    ]);
    if (
      selectedWorkspaceId &&
      !workspaces.some((item) => item.workspace.id === selectedWorkspaceId)
    ) {
      const workspace = (await this.reader.workspaces(repository.id)).find(
        (item) => item.id === selectedWorkspaceId,
      );
      if (workspace) {
        const current = await this.reader.listing(
          repository.id,
          "worktree",
          workspace.id,
          false,
          documentPath,
        );
        const base = await this.reader.listing(
          repository.id,
          "base",
          workspace.id,
          false,
          documentPath,
        );
        const local = await this.document(repository.id, current, documentPath);
        if (local)
          workspaces.push({
            workspace,
            document: local,
            base: await this.document(repository.id, base, documentPath),
            label: "changed",
            error: null,
            change: {
              path: documentPath,
              kind: "unchanged",
              modifiedAt: null,
              targetChanged: false,
              baseSha: base.documents[0]?.sha ?? null,
              worktreeSha: current.documents[0]?.sha ?? null,
              targetSha: listing?.documents[0]?.sha ?? null,
            },
          });
      }
    }
    if (!document && !workspaces.length) {
      if (targetFailure) throw targetFailure.cause;
      throw new DocumentsError(
        "The document does not exist in the tracked branch or a changing workspace.",
        404,
        "document_not_found",
      );
    }
    if (!rich)
      return {
        repository,
        path: documentPath,
        document,
        workspaces,
        error: targetFailure?.error ?? null,
      };
    const selected = selectedWorkspaceId
      ? workspaces.find((item) => item.workspace.id === selectedWorkspaceId)
      : null;
    const contextListing = selected
      ? await this.reader.listing(
          repository.id,
          "worktree",
          selected.workspace.id,
        )
      : listing
        ? await this.reader.listing(repository.id, "target")
        : null;
    if (
      !selected &&
      listing &&
      contextListing &&
      listing.commit !== contextListing.commit
    )
      throw new DocumentsError(
        "The tracked branch changed during the read. Refresh to read the current version.",
        409,
        "document_changed",
      );
    const context = contextListing
      ? await mapBounded(boundedEntries(contextListing), 4, async (entry) => {
          try {
            return await this.document(
              repository.id,
              contextListing,
              entry.path,
            );
          } catch (failure) {
            if (authorityRefused(failure)) throw failure;
            return null;
          }
        })
      : [];
    const enriched = enrichDocuments(
      context.filter((item): item is ParsedDocument => item !== null),
      !!contextListing &&
        context.filter(Boolean).length === contextListing.documents.length,
    );
    const enrichedCurrent = enriched.find((item) => item.path === documentPath);
    if (
      enrichedCurrent &&
      (selected?.document ?? document)?.content !== enrichedCurrent.content
    )
      throw new DocumentsError(
        "The document changed while its links were being read. Refresh to read the current version.",
        409,
        "document_changed",
      );
    if (selected && enrichedCurrent) selected.document = enrichedCurrent;
    const folder = featurePath(documentPath);
    const related = enriched
      .filter(
        (item) =>
          folder &&
          featurePath(item.path) === folder &&
          item.path !== documentPath,
      )
      .map((item) => ({
        path: item.path,
        title: item.title,
        kind: documentKind(item.path) as NonNullable<ParsedDocument["kind"]>,
      }));
    return {
      repository,
      path: documentPath,
      document: selected ? document : (enrichedCurrent ?? document),
      workspaces,
      related,
      error: targetFailure?.error ?? null,
    };
  }
}
function overviewDocument(
  document: ParsedDocument | null,
): ParsedDocument | null {
  // The overview transports only status, progress and labels. Full Markdown and base versions
  // are read through the detail request, keeping independent repository responses small.
  return document
    ? {
        ...document,
        body: "",
        content: "",
        deliverables: [],
      }
    : null;
}

function boundedEntries(listing: DocumentListing) {
  let bytes = 0;
  return listing.documents.slice(0, 2000).filter((entry) => {
    bytes += entry.size;
    return bytes <= 32 * 1024 * 1024;
  });
}
