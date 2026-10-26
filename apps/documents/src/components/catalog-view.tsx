"use client";
import { useEffect, useRef, useState } from "react";
import {
  BookOpenIcon,
  CompassIcon,
  FileTextIcon,
  GitBranchIcon,
  LightbulbIcon,
  ListChecksIcon,
  SearchIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { attentionReasons, featurePath, kindOf } from "@/lib/catalog";
import {
  documentForCard,
  filterDocuments,
  planLink,
  statusCounts,
} from "@/lib/model";
import {
  STATUSES,
  type PlanCard,
  type RepositoryDocuments,
  type SourceRepository,
} from "@/lib/types";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { Progress, formatTime } from "./plan-metadata";
import { WorkspaceOwner } from "./workspace-owner";
import { PlanGrid } from "./plan-grid";
import { SourceDocument } from "./document";

const views = [
  ["home", "Home", BookOpenIcon],
  ["vision", "Vision", CompassIcon],
  ["ideas", "Ideas", LightbulbIcon],
  ["features", "Features", FileTextIcon],
  ["plans", "Plans", ListChecksIcon],
  ["reviews", "Reviews", BookOpenIcon],
  ["tooling", "Tooling", FileTextIcon],
] as const;
export function repositoryName(repository: SourceRepository) {
  try {
    return new URL(repository.repository).pathname
      .replace(/^\//, "")
      .replace(/\.git$/, "");
  } catch {
    return repository.repository;
  }
}
function Entry({
  card,
  navigate,
  workspaceId,
  search = "",
}: {
  card: PlanCard;
  navigate: (url: string) => void;
  workspaceId?: string;
  search?: string;
}) {
  const document = workspaceId
    ? card.workspaces.find((item) => item.workspace.id === workspaceId)
        ?.document
    : documentForCard(card);
  if (!document) return null;
  const effectiveWorkspace =
    workspaceId ??
    (!card.document
      ? card.workspaces.find((item) => item.document)?.workspace.id
      : undefined);
  const match = search
    ? document.headings?.find((item) =>
        item.text.toLowerCase().includes(search.toLowerCase()),
      )
    : null;
  const destination =
    planLink(card.repository.id, card.path, effectiveWorkspace) +
    (match ? `#${encodeURIComponent(match.id)}` : "");
  return (
    <a
      href={destination}
      onClick={(event) => {
        if (!event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          navigate(destination);
        }
      }}
      className="group flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-brand"
    >
      <div className="flex items-start justify-between gap-3">
        <strong className="min-w-0 text-sm font-medium wrap-anywhere group-hover:text-info">
          {document.title}
        </strong>
        {document.status && (
          <Badge variant="secondary">{document.status}</Badge>
        )}
      </div>
      <p className="truncate text-xs text-muted-foreground" title={card.path}>
        {document.kind} · {card.path}
      </p>
      {match && <p className="text-xs text-info">Section: {match.text}</p>}
      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
        {document.summary || document.path}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {repositoryName(card.repository).split("/").at(-1)} ·{" "}
          {effectiveWorkspace
            ? `workspace · ${card.workspaces.find((item) => item.workspace.id === effectiveWorkspace)?.workspace.name || card.workspaces.find((item) => item.workspace.id === effectiveWorkspace)?.workspace.branch}`
            : card.repository.branch}
        </span>
        {document.progress && <Progress document={document} />}
        {card.workspaces.length > 0 && (
          <span>
            {card.workspaces.length} workspace
            {card.workspaces.length === 1 ? "" : "s"}
          </span>
        )}
        {document.errors.length > 0 && (
          <span className="text-warning">Needs attention</span>
        )}
      </div>
    </a>
  );
}
export function CatalogView({
  repositories,
  loaded,
  query,
  loading,
  error,
  navigate,
  refresh,
  unavailableRepositories,
}: {
  repositories: SourceRepository[];
  loaded: Record<string, RepositoryDocuments>;
  query: URLSearchParams;
  loading: string | null;
  error: string | null;
  navigate: (url: string) => void;
  refresh: () => void;
  unavailableRepositories: Record<string, string>;
}) {
  const view = query.get("view") ?? "home",
    repo = query.get("repository") ?? "",
    app = query.get("app") ?? "",
    search = query.get("q") ?? "",
    status = query.get("status") ?? "";
  const searchInput = useRef<HTMLInputElement>(null);
  const [pages, setPages] = useState<Record<string, number>>({});
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  function change(key: string, value: string) {
    const next = new URLSearchParams(query);
    next.delete("page");
    if (value) next.set(key, value);
    else next.delete(key);
    navigate(`/?${next}`);
  }
  const all = repositories.flatMap((item) => loaded[item.id]?.plans ?? []);
  const filtered = filterDocuments(all, {
    repository: repo,
    app,
    search,
    status,
  });
  const scopes = repositories.filter((item) => !repo || item.id === repo);
  const selected = repositories.find((item) => item.id === repo);
  const apps = [
    ...new Map(
      scopes.flatMap((item) => item.apps).map((item) => [item.appId, item]),
    ).values(),
  ];
  const plans = filtered.filter((card) => kindOf(card) === "plan");
  const counts = statusCounts(
    filterDocuments(
      all.filter((card) => kindOf(card) === "plan"),
      { repository: repo, app, search, status: "" },
    ),
  );
  const roots = filtered.filter((card) => kindOf(card) === "overview");
  const featureCards = filtered.filter(
    (card) =>
      kindOf(card) === "feature" ||
      (kindOf(card) === "plan" &&
        !filtered.some(
          (other) =>
            kindOf(other) === "feature" &&
            other.repository.id === card.repository.id &&
            featurePath(other.path) === featurePath(card.path),
        )),
  );
  const candidates = search
    ? filtered
    : view === "features"
      ? featureCards
      : filtered.filter(
          (card) =>
            kindOf(card) ===
            (view === "reviews" ? "review" : view === "plans" ? "plan" : view),
        );
  const page = Math.max(0, Number(query.get("page")) || 0),
    pageSize = 24;
  const shown = candidates.slice(page * pageSize, (page + 1) * pageSize);
  const workspaces = scopes.flatMap(
    (item) => loaded[item.id]?.workspaces ?? [],
  );
  const attention = filterDocuments(all, {
    repository: repo,
    app,
    search: "",
    status: "",
  }).flatMap((card) => [
    ...attentionReasons(card.document).map((reason) => ({
      card,
      reason,
      workspace: undefined as string | undefined,
    })),
    ...card.workspaces.flatMap((item) =>
      attentionReasons(item.document).map((reason) => ({
        card,
        reason,
        workspace: item.workspace.id,
      })),
    ),
  ]);
  const noPlan = featureCards.filter(
    (card) =>
      kindOf(card) === "feature" &&
      !all.some(
        (other) =>
          other.repository.id === card.repository.id &&
          kindOf(other) === "plan" &&
          featurePath(other.path) === featurePath(card.path),
      ),
  ).length;
  const list = (cards: PlanCard[]) =>
    cards.map((card) => (
      <Entry
        key={`${card.repository.id}:${card.path}`}
        card={card}
        navigate={navigate}
        search={search}
      />
    ));
  const title = search
    ? `Search results`
    : selected
      ? repositoryName(selected).split("/").at(-1)
      : "All repositories";
  return (
    <div className="documents-layout">
      <aside
        className="documents-navigation"
        aria-label="Documentation navigation"
      >
        <label className="flex flex-col gap-2 text-xs font-medium">
          Repository
          <select
            value={repo}
            onChange={(event) => change("repository", event.target.value)}
            className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">All repositories</option>
            {repositories.map((item) => (
              <option key={item.id} value={item.id}>
                {repositoryName(item)} · {item.branch || "default"}
              </option>
            ))}
          </select>
        </label>
        <nav className="flex gap-1 overflow-x-auto md:flex-col">
          {views.map(([key, label, Icon]) => (
            <Button
              key={key}
              variant={view === key && !search ? "secondary" : "ghost"}
              size="sm"
              className="shrink-0 justify-start"
              onClick={() => {
                const next = new URLSearchParams(query);
                next.set("view", key);
                next.delete("q");
                next.delete("status");
                navigate(`/?${next}`);
              }}
              aria-current={view === key && !search ? "page" : undefined}
            >
              <Icon className="size-4" />
              {label}
              {key === "plans" && (
                <span className="ml-auto text-xs tabular-nums">
                  {plans.length}
                </span>
              )}
            </Button>
          ))}
        </nav>
        <div className="hidden border-t pt-4 md:block">
          <p className="mb-3 text-xs font-medium text-muted-foreground">
            CURRENT WORK
          </p>
          {STATUSES.map((state) => (
            <button
              key={state}
              className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-xs hover:bg-muted"
              onClick={() => {
                const next = new URLSearchParams(query);
                next.set("view", "plans");
                next.set("status", state);
                navigate(`/?${next}`);
              }}
            >
              <span>{state}</span>
              <span className="tabular-nums text-muted-foreground">
                {counts[state]}
              </span>
            </button>
          ))}
        </div>
      </aside>
      <div className="min-w-0 space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-48 flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              ref={searchInput}
              aria-label="Search documentation"
              placeholder="Search documents, sections, ideas or deliverables…"
              className="pl-9"
              value={search}
              onChange={(event) => change("q", event.target.value)}
            />
          </div>
          <select
            aria-label="Application filter"
            value={app}
            onChange={(event) => change("app", event.target.value)}
            className="h-9 max-w-48 rounded-md border bg-background px-2 text-xs"
          >
            <option value="">All apps</option>
            {apps.map((item) => (
              <option value={item.appId} key={item.appId}>
                {item.name}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh documentation"
            onClick={refresh}
            disabled={!!loading}
          >
            <RefreshCwIcon className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {view === "home" || search
              ? title
              : (views.find((item) => item[0] === view)?.[1] ?? "Documents")}
          </h1>
          <p className="text-xs text-muted-foreground">
            {selected ? (
              <>
                Documentation on <strong>{selected.branch}</strong> ·{" "}
                {selected.commit?.slice(0, 10) ?? "commit unknown"} · fetched{" "}
                {formatTime(selected.fetchedAt)}
              </>
            ) : (
              `${scopes.length} repositories · current documentation and workspaces`
            )}
          </p>
        </header>
        {loading && (
          <p role="status" className="text-xs text-muted-foreground">
            {loading}
          </p>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Sources unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {scopes
          .filter((item) => unavailableRepositories[item.id])
          .map((item) => (
            <Alert variant="destructive" key={item.id}>
              <AlertTitle>{repositoryName(item)}</AlertTitle>
              <AlertDescription>
                {unavailableRepositories[item.id]}
              </AlertDescription>
            </Alert>
          ))}
        {loading && !all.length ? (
          <div
            className="rounded-lg border border-dashed p-10 text-sm text-muted-foreground"
            role="status"
          >
            Reading authorized documentation…
          </div>
        ) : view === "home" && !search ? (
          <>
            {roots.length > 0 && (
              <section className="grid gap-3 lg:grid-cols-2">
                {roots.map((card) => (
                  <section
                    key={card.repository.id}
                    className="min-w-0 rounded-lg border p-5"
                  >
                    <a
                      href={planLink(card.repository.id, card.path)}
                      onClick={(event) => {
                        if (!event.metaKey && !event.ctrlKey) {
                          event.preventDefault();
                          navigate(planLink(card.repository.id, card.path));
                        }
                      }}
                      className="mb-4 block text-xs text-info hover:underline"
                    >
                      {repositoryName(card.repository)} ·{" "}
                      {card.repository.branch} · Open full overview
                    </a>
                    {card.document && (
                      <SourceDocument
                        document={{
                          ...card.document,
                          errors: [],
                          backlinks: [],
                        }}
                        repositoryId={card.repository.id}
                        navigate={navigate}
                        body={card.document.body}
                      />
                    )}
                  </section>
                ))}
              </section>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-3 rounded-lg border p-4 text-xs">
              {STATUSES.map((state) => (
                <span key={state}>
                  {state}{" "}
                  <strong className="ml-2 tabular-nums">{counts[state]}</strong>
                </span>
              ))}
              <span>
                No open plan{" "}
                <strong className="ml-2 tabular-nums">{noPlan}</strong>
              </span>
            </div>
            <section aria-label="Needs your attention" className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <TriangleAlertIcon className="size-4 text-warning" />
                Needs your attention{" "}
                <span className="text-muted-foreground">
                  {attention.length}
                </span>
              </h2>
              {attention.length ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  {attention
                    .slice(0, pages.attention ?? 6)
                    .map((item, index) => (
                      <button
                        key={index}
                        onClick={() =>
                          navigate(
                            planLink(
                              item.card.repository.id,
                              item.card.path,
                              item.workspace,
                            ),
                          )
                        }
                        className="rounded-lg border border-warning/30 bg-warning/5 p-4 text-left"
                      >
                        <strong className="text-sm font-medium">
                          {documentForCard(item.card)?.title ?? item.card.path}
                        </strong>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {item.reason}
                        </p>
                        <p className="mt-2 text-xs">
                          {item.workspace
                            ? "Open workspace version"
                            : "Open document"}
                        </p>
                      </button>
                    ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No attention items in the available documents.
                </p>
              )}
              {attention.length > (pages.attention ?? 6) && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setPages((old) => ({
                      ...old,
                      attention: (old.attention ?? 6) + 12,
                    }))
                  }
                >
                  Show more attention items
                </Button>
              )}
            </section>
            <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
              <section className="space-y-3">
                <h2 className="text-sm font-semibold">In progress</h2>
                <div className="grid gap-3">
                  {list(
                    plans
                      .filter(
                        (card) =>
                          documentForCard(card)?.status === "In Progress",
                      )
                      .slice(0, pages.active ?? 8),
                  )}
                </div>
                {!plans.some(
                  (card) => documentForCard(card)?.status === "In Progress",
                ) && (
                  <p className="text-sm text-muted-foreground">
                    No plans are currently in progress.
                  </p>
                )}
                <Button variant="ghost" onClick={() => change("view", "plans")}>
                  Open all plans
                </Button>
              </section>
              <aside className="space-y-6">
                <section className="space-y-3">
                  <h2 className="text-sm font-semibold">
                    In development{" "}
                    <span className="text-muted-foreground">
                      {workspaces.length}
                    </span>
                  </h2>
                  {workspaces
                    .slice(0, pages.workspaces ?? 8)
                    .map((workspace) => (
                      <div
                        key={workspace.id}
                        className="space-y-2 rounded-lg border p-3"
                      >
                        <div className="flex items-center gap-2 text-xs">
                          <GitBranchIcon className="size-3.5 shrink-0" />
                          <strong className="truncate" title={workspace.branch}>
                            {workspace.name || workspace.branch}
                          </strong>
                        </div>
                        <WorkspaceOwner workspace={workspace} />
                        <p className="text-xs text-muted-foreground">
                          {workspace.changes?.length ?? "Unknown"} document
                          changes ·{" "}
                          {workspace.observationState ?? "observation unknown"}
                        </p>
                        {workspace.changes?.slice(0, 3).map((change) => (
                          <a
                            className="block truncate text-xs text-info hover:underline"
                            href={planLink(
                              workspace.repositoryId,
                              change.path,
                              workspace.id,
                            )}
                            key={change.path}
                            onClick={(event) => {
                              event.preventDefault();
                              navigate(
                                planLink(
                                  workspace.repositoryId,
                                  change.path,
                                  workspace.id,
                                ),
                              );
                            }}
                          >
                            {change.path.replace("docs/", "")}
                          </a>
                        ))}
                      </div>
                    ))}
                  {workspaces.length > (pages.workspaces ?? 8) && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setPages((old) => ({
                          ...old,
                          workspaces: (old.workspaces ?? 8) + 8,
                        }))
                      }
                    >
                      More workspaces
                    </Button>
                  )}
                </section>
                <section className="space-y-3">
                  <h2 className="text-sm font-semibold">
                    Recently updated documents
                  </h2>
                  {filtered
                    .filter((card) => card.document?.updated)
                    .sort((a, b) =>
                      (b.document?.updated ?? "").localeCompare(
                        a.document?.updated ?? "",
                      ),
                    )
                    .slice(0, 5)
                    .map((card) => (
                      <a
                        key={`${card.repository.id}:${card.path}`}
                        href={planLink(card.repository.id, card.path)}
                        onClick={(event) => {
                          event.preventDefault();
                          navigate(planLink(card.repository.id, card.path));
                        }}
                        className="block text-xs hover:underline"
                      >
                        {card.document?.title}
                        <span className="mt-1 block text-muted-foreground">
                          {card.document?.updated}
                        </span>
                      </a>
                    ))}
                </section>
              </aside>
            </div>
          </>
        ) : view === "plans" && !search ? (
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <select
                aria-label="Plan status"
                value={status}
                onChange={(event) => change("status", event.target.value)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">All statuses</option>
                {STATUSES.map((state) => (
                  <option key={state}>{state}</option>
                ))}
              </select>
              <div className="flex gap-1">
                <Button
                  variant={
                    query.get("layout") !== "table" ? "secondary" : "ghost"
                  }
                  onClick={() => change("layout", "board")}
                >
                  Board
                </Button>
                <Button
                  variant={
                    query.get("layout") === "table" ? "secondary" : "ghost"
                  }
                  onClick={() => change("layout", "table")}
                >
                  Table
                </Button>
              </div>
            </div>
            {query.get("layout") === "table" ? (
              <PlanGrid
                plans={plans}
                navigate={navigate}
                unavailableRepositories={unavailableRepositories}
              />
            ) : (
              <div className="grid items-start gap-4 md:grid-cols-2 2xl:grid-cols-5">
                {["Draft", "Ready", "In Progress", "Blocked", "On Hold"]
                  .filter((state) => !status || state === status)
                  .map((state) => {
                    const items = plans.filter(
                      (card) =>
                        documentForCard(card)?.status === state &&
                        !documentForCard(card)?.errors.length,
                    );
                    return (
                      <section
                        key={state}
                        className="space-y-3 rounded-lg bg-muted/35 p-3"
                      >
                        <h2 className="flex justify-between text-xs font-semibold">
                          {state}
                          <span className="text-muted-foreground">
                            {items.length}
                          </span>
                        </h2>
                        {list(items.slice(0, pages[state] ?? 12))}
                        {!items.length && (
                          <p className="py-5 text-xs text-muted-foreground">
                            No {state.toLowerCase()} plans.
                          </p>
                        )}
                        {items.length > (pages[state] ?? 12) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setPages((old) => ({
                                ...old,
                                [state]: (old[state] ?? 12) + 12,
                              }))
                            }
                          >
                            Show more
                          </Button>
                        )}
                      </section>
                    );
                  })}
              </div>
            )}
            {plans.some((card) => documentForCard(card)?.errors.length) && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold">Invalid plans</h2>
                {list(
                  plans.filter((card) => documentForCard(card)?.errors.length),
                )}
              </section>
            )}
          </section>
        ) : (
          <section className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {candidates.length} {search ? "matching documents" : "documents"}
              {search && " · titles, sections and body text"}
            </p>
            <div className="grid gap-3 lg:grid-cols-2">{list(shown)}</div>
            {search && (
              <section className="space-y-3">
                <h2 className="text-sm font-semibold">
                  Matching workspace versions
                </h2>
                {filterDocuments(all, {
                  repository: repo,
                  app,
                  search: "",
                  status: "",
                })
                  .flatMap((card) =>
                    card.workspaces
                      .filter((item) =>
                        item.document?.searchText?.includes(
                          search.toLowerCase(),
                        ),
                      )
                      .map((item) => (
                        <Entry
                          key={`${card.path}:${item.workspace.id}`}
                          card={card}
                          workspaceId={item.workspace.id}
                          navigate={navigate}
                        />
                      )),
                  )
                  .slice(0, 24)}
              </section>
            )}
            {!candidates.length && !loading && (
              <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
                {search
                  ? "No documents match this search."
                  : `No ${view} documents in this scope. Optional documentation may not exist yet.`}
              </div>
            )}
            {candidates.length > pageSize && (
              <nav
                aria-label="Document pages"
                className="flex items-center justify-between"
              >
                <Button
                  variant="outline"
                  disabled={!page}
                  onClick={() => change("page", String(page - 1))}
                >
                  Previous
                </Button>
                <span className="text-xs">
                  Page {page + 1} of {Math.ceil(candidates.length / pageSize)}
                </span>
                <Button
                  variant="outline"
                  disabled={(page + 1) * pageSize >= candidates.length}
                  onClick={() => change("page", String(page + 1))}
                >
                  Next
                </Button>
              </nav>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
