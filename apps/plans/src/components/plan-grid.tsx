"use client";

import { Fragment, useId, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import {
  flexRender,
  functionalUpdate,
  getCoreRowModel,
  getExpandedRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnDef,
  type ExpandedState,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/reui/frame";
import { LoadingIndicator } from "@/components/loading-indicator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Progress, VersionBrief, formatTime } from "@/components/plan-metadata";
import { documentForCard, planLink } from "@/lib/model";
import type { PlanCard, WorkspacePlan } from "@/lib/types";

const EMPTY_UNAVAILABLE: Record<string, string> = {};

function cardId(card: PlanCard): string {
  return JSON.stringify([card.repository.id, card.path]);
}

function repositoryName(card: PlanCard): string {
  try {
    return new URL(card.repository.repository).pathname.replace(/^\//, "").replace(/\.git$/, "") || card.repository.repository;
  } catch {
    return card.repository.repository;
  }
}

function cardError(card: PlanCard, unavailable: Record<string, string>): string | null {
  return unavailable[card.repository.id] ?? card.document?.errors[0] ?? null;
}

function cardStatus(card: PlanCard, unavailable: Record<string, string>): string {
  if (unavailable[card.repository.id]) return "Unavailable";
  const document = card.document;
  if (document?.errors.length) return "Document error";
  return document?.status ?? `Absent on ${card.repository.branch || "tracked branch"}`;
}

function followLink(event: MouseEvent<HTMLAnchorElement>, url: string, navigate: (url: string) => void) {
  if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    navigate(url);
  }
}

function SortableHeader({ column, title }: { column: Column<PlanCard>; title: string }) {
  const sorted = column.getIsSorted();
  const SortIcon = sorted === "asc" ? ArrowUpIcon : sorted === "desc" ? ArrowDownIcon : ArrowUpDownIcon;
  return <Button type="button" variant="ghost" size="sm" aria-label={`Sort by ${title}`} onClick={column.getToggleSortingHandler()}>
    <span className="whitespace-normal text-left">{title}</span><SortIcon aria-hidden="true" data-icon="inline-end" />
  </Button>;
}

export function PlanGrid({ plans, navigate, loadingMessage, toolbar, emptyMessage, unavailableRepositories = EMPTY_UNAVAILABLE }: { plans: PlanCard[]; navigate: (url: string) => void; loadingMessage?: string | null; toolbar?: ReactNode; emptyMessage?: ReactNode; unavailableRepositories?: Record<string, string> }) {
  "use no memo"; // TanStack v8 exposes a mutable table instance that React Compiler cannot memoize.
  const [sorting, setSorting] = useState<SortingState>([{ id: "updated", desc: true }]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const expansionId = useId();
  const planSetKey = useMemo(() => JSON.stringify(plans.map(cardId).sort()), [plans]);
  const [page, setPage] = useState<{ key: string; pagination: PaginationState }>({
    key: planSetKey,
    pagination: { pageIndex: 0, pageSize: 10 },
  });
  // Polling preserves the page; a different filtered result set starts at page one.
  const pagination: PaginationState = {
    pageSize: page.pagination.pageSize,
    pageIndex: page.key === planSetKey
      ? Math.min(page.pagination.pageIndex, Math.max(0, Math.ceil(plans.length / page.pagination.pageSize) - 1))
      : 0,
  };
  const columns = useMemo<ColumnDef<PlanCard>[]>(() => [
    {
      id: "plan",
      accessorFn: card => documentForCard(card)?.title ?? card.path,
      header: ({ column }) => <SortableHeader column={column} title="Plan" />,
      sortingFn: "alphanumeric",
      cell: ({ row }) => {
        const card = row.original;
        const document = documentForCard(card);
        const url = planLink(card.repository.id, card.path);
        const error = cardError(card, unavailableRepositories);
        return <div className="flex min-w-64 max-w-96 flex-col gap-1 whitespace-normal">
          <a className="font-medium underline-offset-4 hover:underline focus-visible:outline-ring" href={url} onClick={event => followLink(event, url, navigate)}>{document?.title || card.path}</a>
          <p className="line-clamp-2 text-xs text-muted-foreground">{document?.summary || card.path}</p>
          {error && <span className="break-all text-xs text-muted-foreground">{card.path}</span>}
          {error && <p className="line-clamp-2 text-xs text-destructive" title={error}>{error}</p>}
        </div>;
      },
    },
    {
      id: "status",
      accessorFn: card => cardStatus(card, unavailableRepositories),
      header: ({ column }) => <SortableHeader column={column} title="Tracked status" />,
      sortingFn: "text",
      cell: ({ row }) => {
        const status = cardStatus(row.original, unavailableRepositories);
        const variant = ["Document error", "Unavailable", "Blocked"].includes(status) ? "destructive" : status === "In Progress" ? "default" : "secondary";
        return <Badge variant={variant}>{status}</Badge>;
      },
    },
    {
      id: "progress",
      accessorFn: card => {
        const document = unavailableRepositories[card.repository.id] ? null : card.document;
        const progress = document?.errors.length ? null : document?.progress;
        return progress && progress.total > 0 ? progress.done / progress.total : undefined;
      },
      header: ({ column }) => <SortableHeader column={column} title="Tracked progress" />,
      sortingFn: "basic",
      sortUndefined: "last",
      cell: ({ row }) => {
        const document = unavailableRepositories[row.original.repository.id] ? null : row.original.document;
        return <div className="text-xs"><Progress document={document?.errors.length ? null : document} /></div>;
      },
    },
    {
      id: "repository",
      accessorFn: card => `${repositoryName(card)} ${card.repository.branch} ${card.apps.map(app => app.name).join(", ")}`,
      header: ({ column }) => <SortableHeader column={column} title="Repository / apps" />,
      sortingFn: "alphanumeric",
      cell: ({ row }) => <div className="flex min-w-44 max-w-60 flex-col gap-1 whitespace-normal">
        <span className="break-words text-xs">{repositoryName(row.original)}</span>
        <span className="break-all text-xs text-muted-foreground">Tracked branch: {row.original.repository.branch || "unresolved"}</span>
        <span className="text-xs text-muted-foreground">{row.original.apps.map(app => app.name).join(", ") || "Repository-wide"}</span>
      </div>,
    },
    {
      id: "updated",
      accessorFn: card => {
        const document = unavailableRepositories[card.repository.id] ? null : card.document;
        return document?.errors.length ? undefined : document?.updated ?? undefined;
      },
      header: ({ column }) => <SortableHeader column={column} title="Tracked updated" />,
      sortingFn: "text",
      sortUndefined: "last",
      cell: ({ getValue }) => {
        const updated = getValue<string | undefined>();
        return updated ? <time className="text-xs tabular-nums" dateTime={updated}>{updated}</time> : <span className="text-xs text-muted-foreground">Unknown</span>;
      },
    },
    {
      id: "workspaces",
      accessorFn: card => card.workspaces.length,
      header: ({ column }) => <SortableHeader column={column} title="Workspaces" />,
      sortingFn: "basic",
      cell: ({ row }) => {
        const card = row.original;
        const count = card.workspaces.length;
        if (!count) return <span className="text-xs tabular-nums text-muted-foreground">0</span>;
        const ChevronIcon = row.getIsExpanded() ? ChevronDownIcon : ChevronRightIcon;
        return <Button type="button" variant="ghost" size="sm" aria-expanded={row.getIsExpanded()} aria-controls={`${expansionId}-${encodeURIComponent(row.id)}`} aria-label={`${row.getIsExpanded() ? "Collapse" : "Expand"} workspace versions of ${documentForCard(card)?.title ?? card.path}`} onClick={row.getToggleExpandedHandler()}>
          <ChevronIcon aria-hidden="true" data-icon="inline-start" />{count} {count === 1 ? "workspace version" : "workspace versions"}
        </Button>;
      },
    },
  ], [navigate, unavailableRepositories, expansionId]);
  // eslint-disable-next-line react-hooks/incompatible-library -- The component explicitly opts out of compilation above.
  const table = useReactTable({
    data: plans,
    columns,
    getRowId: cardId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowCanExpand: row => row.original.workspaces.length > 0,
    paginateExpandedRows: false,
    enableRowSelection: false,
    enableMultiSort: false,
    autoResetPageIndex: false,
    autoResetExpanded: false,
    state: { sorting, pagination, expanded },
    onExpandedChange: setExpanded,
    onSortingChange: updater => {
      setSorting(updater);
      setPage({ key: planSetKey, pagination: { ...pagination, pageIndex: 0 } });
    },
    onPaginationChange: updater => setPage({ key: planSetKey, pagination: functionalUpdate(updater, pagination) }),
  });
  const first = plans.length ? pagination.pageIndex * pagination.pageSize + 1 : 0;
  const last = Math.min(plans.length, (pagination.pageIndex + 1) * pagination.pageSize);

  return <Frame spacing="xs">
    {(toolbar || loadingMessage) && <FrameHeader className="gap-2 py-3">{toolbar}{loadingMessage && <LoadingIndicator message={loadingMessage} />}</FrameHeader>}
    <FramePanel>
      <Table aria-label="Plans comparison" aria-busy={Boolean(loadingMessage)}>
        <TableCaption className="sr-only">Tracked-branch plans with status, deliverable progress, repository and update date. Expand a row to compare each workspace version. Column headers sort the primary plan rows.</TableCaption>
        <TableHeader>{table.getHeaderGroups().map(group => <TableRow key={group.id}>{group.headers.map(header => {
          const sorted = header.column.getIsSorted();
          return <TableHead key={header.id} scope="col" aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}>
            {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
          </TableHead>;
        })}</TableRow>)}</TableHeader>
        <TableBody>{table.getRowModel().rows.length > 0 ? table.getRowModel().rows.map(row => <Fragment key={row.id}><TableRow>
          {row.getVisibleCells().map(cell => <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}
        </TableRow>{row.getIsExpanded() && <TableRow><TableCell colSpan={row.getVisibleCells().length} className="whitespace-normal"><div id={`${expansionId}-${encodeURIComponent(row.id)}`} className="flex flex-col gap-3 p-3">
          <h3 className="font-semibold">Workspace versions of {documentForCard(row.original)?.title ?? row.original.path}</h3>
          <Table aria-label={`Workspace versions of ${documentForCard(row.original)?.title ?? row.original.path}`}><TableHeader><TableRow><TableHead>Workspace branch</TableHead><TableHead>Status / change</TableHead><TableHead>Workspace progress</TableHead><TableHead>Last change</TableHead><TableHead>State / observation</TableHead><TableHead>Links</TableHead></TableRow></TableHeader><TableBody>
            {row.original.workspaces.map(version => <WorkspaceVersionRow key={version.workspace.id} card={row.original} version={version} navigate={navigate} />)}
          </TableBody></Table>
        </div></TableCell></TableRow>}</Fragment>) : <TableRow><TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">{emptyMessage ?? (loadingMessage ? "Loading plans…" : "No plans match these filters.")}</TableCell></TableRow>}</TableBody>
      </Table>
    </FramePanel>
    <FrameFooter className="flex-row flex-wrap items-center justify-between gap-3">
      <p className="text-xs tabular-nums text-muted-foreground" aria-live="polite">{first}–{last} of {plans.length} plans</p>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Rows per page</span>
          <Select value={String(pagination.pageSize)} onValueChange={value => table.setPagination({ pageIndex: 0, pageSize: Number(value) })}>
            <SelectTrigger size="sm" aria-label="Rows per page"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{[10, 20].map(size => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">{plans.length ? `Page ${pagination.pageIndex + 1} of ${table.getPageCount()}` : "No pages"}</span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>Previous</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>Next</Button>
        </div>
      </div>
    </FrameFooter>
  </Frame>;
}

function WorkspaceVersionRow({ card, version, navigate }: { card: PlanCard; version: WorkspacePlan; navigate: (url: string) => void }) {
  const { workspace, document, change } = version;
  const error = version.error ?? document?.errors[0] ?? workspace.error;
  const deleted = change.kind === "deleted";
  const status = version.error ? "Unavailable" : document?.errors.length ? "Document error" : deleted ? "Plan deleted" : document?.status ?? "Unknown";
  const variant = ["Unavailable", "Document error", "Blocked"].includes(status) ? "destructive" : status === "In Progress" ? "default" : "secondary";
  const url = planLink(card.repository.id, card.path, workspace.id);
  return <TableRow>
    <TableCell className="min-w-48 whitespace-normal"><a className="break-all underline underline-offset-4 focus-visible:outline-ring" href={url} onClick={event => followLink(event, url, navigate)}>{workspace.branch}</a></TableCell>
    <TableCell className="min-w-48 whitespace-normal"><div className="flex flex-col items-start gap-2"><Badge variant={variant}>{status}</Badge>
      {version.label === "new" && <span className="text-xs text-muted-foreground">New plan in this workspace</span>}
      {(version.label === "completing" || version.label === "removed") && <span className="text-xs text-muted-foreground"><VersionBrief version={version} /></span>}
      {change.targetChanged && <span className="text-xs text-muted-foreground">Tracked branch also changed since the workspace base.</span>}
    </div></TableCell>
    <TableCell><div className="text-xs">{deleted ? <span className="text-muted-foreground">Not applicable</span> : <Progress document={error ? null : document} />}</div></TableCell>
    <TableCell className="whitespace-normal text-xs">{formatTime(change.modifiedAt)}</TableCell>
    <TableCell className="min-w-48 whitespace-normal"><div className="flex flex-col items-start gap-2"><Badge variant="outline">{workspace.state}</Badge><span className="text-xs text-muted-foreground">Observed {formatTime(workspace.observationAt)}{workspace.observationState ? ` (${workspace.observationState})` : ""}</span>{error && <p className="text-xs text-destructive">{error}</p>}</div></TableCell>
    <TableCell className="min-w-48 whitespace-normal"><div className="flex flex-col items-start gap-2 text-xs"><a className="underline underline-offset-4 focus-visible:outline-ring" href={url} onClick={event => followLink(event, url, navigate)}>View workspace document</a>
      {workspace.sessionUrl ? <a className="underline underline-offset-4 focus-visible:outline-ring" href={workspace.sessionUrl} target="_blank" rel="noopener noreferrer">Open assistant session</a> : <span className="text-muted-foreground">Session link unavailable: {workspace.sessionUrlError ?? "the assistant installation is unavailable"}.</span>}
    </div></TableCell>
  </TableRow>;
}
