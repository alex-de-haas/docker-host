"use client";

import { useId, useMemo, useState } from "react";
import {
  columnVisibilityFeature, createPaginatedRowModel, createSortedRowModel, flexRender, functionalUpdate,
  rowPaginationFeature, rowSelectionFeature, rowSortingFeature, sortFn_basic, sortFn_text, tableFeatures, useTable,
  type Column, type ColumnDef, type PaginationState, type RowSelectionState, type SortingState, type ColumnVisibilityState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, ListFilter, MoreHorizontal, Rows3, Trash2 } from "lucide-react";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/reui/frame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HostyEmptySlots } from "../../../../../../shared/web/hosty-states";
import { cn } from "@/lib/utils";

export type Credential = { id: string; kind: string; label?: string; audience?: string; scopes: string[]; createdAt: string; lastSeenAt: string; oauthClientName?: string; oauthClientId?: string; lastRequestAt?: string | null; lastRefreshAt?: string | null; expiresAt?: string };
const features = tableFeatures({ rowSortingFeature, rowPaginationFeature, rowSelectionFeature, columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(), paginatedRowModel: createPaginatedRowModel(), sortFns: { text: sortFn_text, basic: sortFn_basic } });
const KIND_NAMES: Record<string, string> = { browser: "Browser", device: "Device", manual: "Manual token", oauth: "OAuth" };
const COLUMN_NAMES: Record<string, string> = { kind: "Type", access: "Access", used: "Last used", created: "Created", expires: "Expires", fingerprint: "Fingerprint", client: "OAuth client" };
export const credentialName = (credential: Credential) => credential.label || credential.oauthClientName || (credential.kind === "browser" ? "Browser session" : KIND_NAMES[credential.kind] || credential.kind);
const timestamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
function DateValue({ value, fallback = "Not recorded" }: { value?: string | null; fallback?: string }) {
  return timestamp(value) === undefined ? <span className="text-muted-foreground">{fallback}</span> : <time className="font-mono text-xs" dateTime={value!}>{new Date(value!).toLocaleString()}</time>;
}
function SortHeader({ column, title }: { column: Column<typeof features, Credential, unknown>; title: string }) {
  const sorted = column.getIsSorted(), Icon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
  return <Button variant="ghost" size="sm" aria-label={`Sort by ${title}`} onClick={column.getToggleSortingHandler()}>{title}<Icon data-icon="inline-end" /></Button>;
}

type Props = { credentials: Credential[]; busy: boolean; loading: boolean; failed: boolean;
  onRename: (id: string, label: string) => Promise<boolean>; onRevoke: (ids: string[]) => Promise<void> };
export function CredentialGrid({ credentials, busy, loading, failed, onRename, onRevoke }: Props) {
  "use no memo"; // TanStack builder reads are not tracked by React Compiler.
  const searchId = useId(), nameId = useId();
  const [search, setSearch] = useState(""), [kinds, setKinds] = useState<string[]>([]), [audience, setAudience] = useState("all");
  const [density, setDensity] = useState("comfortable"), [sorting, setSorting] = useState<SortingState>([{ id: "created", desc: true }]);
  const [visibility, setVisibility] = useState<ColumnVisibilityState>({ created: false, expires: false, fingerprint: false, client: false });
  const [selection, setSelection] = useState<RowSelectionState>({}), [page, setPage] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [editing, setEditing] = useState<string | null>(null), [label, setLabel] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const matching = useMemo(() => credentials.filter(credential => (!kinds.length || kinds.includes(credential.kind)) &&
    (audience === "all" || (credential.audience || "Your host role") === audience) &&
    (!query || [credentialName(credential), credential.id, credential.kind, credential.oauthClientId, credential.oauthClientName, credential.audience, ...credential.scopes].some(value => value?.toLocaleLowerCase().includes(query)))), [credentials, kinds, audience, query]);
  const availableKinds = [...new Set(credentials.map(credential => credential.kind))].sort();
  const audiences = [...new Set(credentials.map(credential => credential.audience || "Your host role"))].sort();
  const selected = credentials.filter(credential => selection[credential.id]);
  const pagination = { pageSize: page.pageSize, pageIndex: Math.min(page.pageIndex, Math.max(0, Math.ceil(matching.length / page.pageSize) - 1)) };
  const columns = useMemo<ColumnDef<typeof features, Credential, unknown>[]>(() => [
    { id: "select", enableSorting: false, enableHiding: false,
      header: ({ table }) => <Checkbox aria-label="Select this page" disabled={busy || !matching.length} checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")} onCheckedChange={value => table.toggleAllPageRowsSelected(value === true)} />,
      cell: ({ row }) => <Checkbox aria-label={`Select ${credentialName(row.original)}`} disabled={busy} checked={row.getIsSelected()} onCheckedChange={value => row.toggleSelected(value === true)} /> },
    { id: "name", accessorFn: credentialName, enableHiding: false, sortFn: "text", header: ({ column }) => <SortHeader column={column} title="Name" />,
      cell: ({ row }) => <div className="flex min-w-0 flex-col gap-1">
        {editing === row.id ? <form onSubmit={event => { event.preventDefault(); if (label.trim() && !busy) void onRename(row.id, label).then(saved => { if (saved) setEditing(null); }); }}><FieldGroup><Field><FieldLabel htmlFor={nameId} className="sr-only">Credential name</FieldLabel><Input id={nameId} value={label} disabled={busy} onChange={event => setLabel(event.target.value)} autoFocus /><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !label.trim()}>Save name</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button></div></Field></FieldGroup></form> : <span className="break-words font-medium">{credentialName(row.original)}</span>}
        {row.original.oauthClientName && row.original.oauthClientName !== credentialName(row.original) && <span className="break-words text-xs text-muted-foreground">{row.original.oauthClientName}</span>}
      </div> },
    { id: "kind", accessorFn: credential => KIND_NAMES[credential.kind] || credential.kind, sortFn: "text", header: ({ column }) => <SortHeader column={column} title="Type" />,
      cell: ({ getValue }) => <Badge variant="secondary">{getValue<string>()}</Badge> },
    { id: "access", accessorFn: credential => credential.audience || "Your host role", sortFn: "text", header: ({ column }) => <SortHeader column={column} title="Access" />,
      cell: ({ row, getValue }) => <div className="flex flex-col gap-1"><span className="break-all">{getValue<string>()}</span>{row.original.scopes.length > 0 && <span className="break-all text-xs text-muted-foreground">{row.original.scopes.join(", ")}</span>}</div> },
    { id: "used", accessorFn: credential => timestamp(credential.lastRequestAt), sortFn: "basic", sortUndefined: "last", header: ({ column }) => <SortHeader column={column} title="Last used" />,
      cell: ({ row }) => <div className="flex flex-col gap-1"><DateValue value={row.original.lastRequestAt} fallback="No recorded request" />{row.original.lastRefreshAt && <span className="text-xs text-muted-foreground">Refreshed <DateValue value={row.original.lastRefreshAt} /></span>}</div> },
    { id: "created", accessorFn: credential => timestamp(credential.createdAt), sortFn: "basic", sortUndefined: "last", header: ({ column }) => <SortHeader column={column} title="Created" />, cell: ({ row }) => <DateValue value={row.original.createdAt} /> },
    { id: "expires", accessorFn: credential => timestamp(credential.expiresAt), sortFn: "basic", sortUndefined: "last", header: ({ column }) => <SortHeader column={column} title="Expires" />, cell: ({ row }) => <DateValue value={row.original.expiresAt} fallback="Not provided" /> },
    { id: "client", accessorFn: credential => [credential.oauthClientName, credential.oauthClientId].filter(Boolean).join(" "), sortFn: "text", header: ({ column }) => <SortHeader column={column} title="OAuth client" />,
      cell: ({ row }) => row.original.oauthClientName || row.original.oauthClientId ? <div className="flex flex-col gap-1">{row.original.oauthClientName && <span className="break-words">{row.original.oauthClientName}</span>}{row.original.oauthClientId && <span className="break-all font-mono text-xs text-muted-foreground">{row.original.oauthClientId}</span>}</div> : <span className="text-muted-foreground">{row.original.kind === "oauth" ? "Not recorded" : "Not applicable"}</span> },
    { id: "fingerprint", accessorKey: "id", sortFn: "text", header: ({ column }) => <SortHeader column={column} title="Fingerprint" />, cell: ({ getValue }) => <span className="break-all font-mono text-xs text-muted-foreground">{getValue<string>()}</span> },
    { id: "actions", enableSorting: false, enableHiding: false, header: () => <span className="sr-only">Actions</span>, cell: ({ row }) => <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`Actions for ${credentialName(row.original)}`}><MoreHorizontal /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuItem onSelect={() => { setEditing(row.id); setLabel(row.original.label || row.original.oauthClientName || ""); }}>Rename</DropdownMenuItem><DropdownMenuItem variant="destructive" onSelect={() => void onRevoke([row.id])}>Revoke access…</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu> },
  ], [busy, matching.length, editing, label, nameId, onRename, onRevoke]);
  const table = useTable({ features, data: matching, columns, getRowId: credential => credential.id, enableMultiSort: false,
    autoResetPageIndex: false, state: { sorting, pagination, columnVisibility: visibility, rowSelection: selection },
    onSortingChange: updater => { setSorting(updater); setPage(current => ({ ...current, pageIndex: 0 })); },
    onColumnVisibilityChange: setVisibility, onRowSelectionChange: setSelection,
    onPaginationChange: updater => setPage(functionalUpdate(updater, pagination)) });
  const resetPage = () => setPage(current => ({ ...current, pageIndex: 0 }));
  return <Frame spacing="xs" className="min-w-0">
    <FrameHeader className="gap-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Field className="min-w-44 flex-1"><FieldLabel htmlFor={searchId} className="sr-only">Search tokens and devices</FieldLabel><Input id={searchId} type="search" placeholder="Search tokens and devices…" value={search} onChange={event => { setSearch(event.target.value); resetPage(); }} /></Field>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" className="border-dashed"><ListFilter data-icon="inline-start" />Type{kinds.length > 0 && <Badge variant="secondary">{kinds.length}</Badge>}</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuLabel>Credential type</DropdownMenuLabel><DropdownMenuGroup>{availableKinds.map(kind => <DropdownMenuCheckboxItem key={kind} checked={kinds.includes(kind)} onSelect={event => event.preventDefault()} onCheckedChange={checked => { setKinds(current => checked ? [...current, kind] : current.filter(value => value !== kind)); resetPage(); }}>{KIND_NAMES[kind] || kind}<span className="ml-auto tabular-nums text-muted-foreground">{credentials.filter(credential => credential.kind === kind).length}</span></DropdownMenuCheckboxItem>)}</DropdownMenuGroup>{kinds.length > 0 && <><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuItem onSelect={() => { setKinds([]); resetPage(); }}>Clear type filter</DropdownMenuItem></DropdownMenuGroup></>}</DropdownMenuContent></DropdownMenu>
        <Select value={audience} onValueChange={value => { setAudience(value); resetPage(); }}><SelectTrigger aria-label="Filter by access" className="max-w-full border-dashed"><SelectValue placeholder="Access" /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">All access</SelectItem>{audiences.map(value => <SelectItem value={value} key={value}>{value}</SelectItem>)}</SelectGroup></SelectContent></Select>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="Row density"><Rows3 /></Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuRadioGroup value={density} onValueChange={setDensity}><DropdownMenuRadioItem value="comfortable">Comfortable · 48 px</DropdownMenuRadioItem><DropdownMenuRadioItem value="compact">Compact · 36 px</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="Choose columns"><Columns3 /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuLabel>Columns</DropdownMenuLabel><DropdownMenuGroup>{table.getAllLeafColumns().filter(column => column.getCanHide()).map(column => <DropdownMenuCheckboxItem key={column.id} checked={column.getIsVisible()} onSelect={event => event.preventDefault()} onCheckedChange={checked => column.toggleVisibility(checked === true)}>{COLUMN_NAMES[column.id]}</DropdownMenuCheckboxItem>)}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
      </div>
      <p className="text-xs text-muted-foreground">{credentials.length} active credentials. Revoking access is reviewed in Core and can end a browser session.</p>
    </FrameHeader>
    <FramePanel className="min-w-0 p-0">
      <Table aria-label="Tokens and devices" aria-busy={busy} className="min-w-[640px] table-fixed">
        <TableCaption className="sr-only">Active credential metadata. Select a page or individual credentials to review revocation in Core.</TableCaption>
        <TableHeader>{table.getHeaderGroups().map(group => <TableRow key={group.id}>{group.headers.map(header => {
          const sorted = header.column.getIsSorted();
          return <TableHead key={header.id} scope="col" className={cn(header.id === "select" && "w-10", header.id === "actions" && "w-12", !["select", "actions"].includes(header.id) && "whitespace-normal px-1 [&_button]:max-w-full [&_button]:whitespace-normal")} aria-sort={header.column.getCanSort() ? sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none" : undefined}>{flexRender(header.column.columnDef.header, header.getContext())}</TableHead>;
        })}</TableRow>)}</TableHeader>
        <TableBody>{table.getRowModel().rows.map(row => <TableRow key={row.id} data-state={row.getIsSelected() ? "selected" : undefined} className={cn(density === "compact" ? "h-9" : "h-12")}>
          {row.getVisibleCells().map(cell => <TableCell key={cell.id} className={cn("whitespace-normal break-words", density === "compact" ? "py-1" : "py-2")}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}
        </TableRow>)}{!matching.length && <TableRow><TableCell colSpan={table.getVisibleLeafColumns().length} className="py-8 text-center whitespace-normal text-muted-foreground">{loading ? "Loading credentials…" : failed ? "Credentials could not be loaded." : credentials.length ? <div className="flex flex-col items-center gap-3"><HostyEmptySlots className="size-12" />No credentials match these filters.<Button variant="outline" size="sm" onClick={() => { setSearch(""); setKinds([]); setAudience("all"); resetPage(); }}>Clear filters</Button></div> : <div className="flex flex-col items-center gap-3"><HostyEmptySlots className="size-12" />No active tokens or devices.</div>}</TableCell></TableRow>}</TableBody>
      </Table>
    </FramePanel>
    <FrameFooter className="flex-row flex-wrap items-center justify-between gap-3 py-3">
      <p aria-live="polite" className="text-xs tabular-nums text-muted-foreground">{matching.length ? pagination.pageIndex * pagination.pageSize + 1 : 0}–{Math.min(matching.length, (pagination.pageIndex + 1) * pagination.pageSize)} of {matching.length}{matching.length !== credentials.length && ` · ${credentials.length} total`}</p>
      <div className="flex flex-wrap items-center gap-2"><Select value={String(pagination.pageSize)} onValueChange={value => table.setPagination({ pageIndex: 0, pageSize: Number(value) })}><SelectTrigger size="sm" aria-label="Rows per page"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{[10, 20, 50].map(size => <SelectItem key={size} value={String(size)}>{size} rows</SelectItem>)}</SelectGroup></SelectContent></Select><Button variant="outline" size="sm" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>Previous</Button><span className="text-xs tabular-nums text-muted-foreground">{matching.length ? `${pagination.pageIndex + 1} / ${table.getPageCount()}` : "0 / 0"}</span><Button variant="outline" size="sm" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>Next</Button></div>
    </FrameFooter>
    {selected.length > 0 && <div className="sticky bottom-4 mx-2 mb-2 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-primary px-4 py-3 text-primary-foreground shadow-lg" role="region" aria-label="Selected credentials"><p className="text-sm">{selected.length} selected{selected.some(credential => !matching.includes(credential)) && " (includes hidden rows)"}</p><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => setSelection({})}>Clear selection</Button><Button variant="destructive" size="sm" disabled={busy} onClick={() => void onRevoke(selected.map(credential => credential.id))}><Trash2 data-icon="inline-start" />Review revoke ({selected.length})</Button></div></div>}
  </Frame>;
}
