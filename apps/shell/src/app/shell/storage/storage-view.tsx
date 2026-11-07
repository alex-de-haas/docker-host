"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, HardDrive, LoaderCircle, RefreshCw } from "lucide-react";
import { Frame, FrameHeader, FramePanel } from "@/components/reui/frame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useShellActions } from "../shell-context";
import { getManageAppHref, getSettingsHref } from "../shell-routes";
import { Alert, EmptyState, InlineError, PageHeader } from "../ui";
import { appStorage, formatStorageBytes, largestFirst, STORAGE_CATEGORIES, STORAGE_PARTS, storageCategoryLabel, storageColor, storagePercent } from "./storage-data";
import type { StorageResource, StorageSize, StorageSnapshot } from "./storage-data";
import { useStorage } from "./use-storage";

type Segment = StorageSize & { id: string; label: string; partial?: boolean };

/** The visual bar and its full-size keyboard legend have identical ordering and identities. */
export function StorageBreakdown({ label, segments, total, selected, onSelect }: {
  label: string;
  segments: Segment[];
  total: number | null;
  selected?: string | null;
  onSelect?: (id: string) => void;
}) {
  const sorted = largestFirst(segments);
  return <div className="space-y-4">
    {total !== null && total > 0 ? <div aria-hidden="true" className="flex h-5 w-full overflow-hidden rounded-md bg-muted">
      {sorted.filter(segment => segment.allocatedBytes !== null && segment.allocatedBytes > 0).map(segment => <button
        key={segment.id} type="button" tabIndex={-1}
        title={`${segment.label}: ${formatStorageBytes(segment.allocatedBytes)} (${storagePercent(segment.allocatedBytes, total)})`}
        style={{ width: `${segment.allocatedBytes! / total * 100}%`, backgroundColor: storageColor(segment.id) }}
        className={cn("h-full shrink-0 transition-opacity hover:opacity-75", selected && selected !== segment.id && "opacity-50")}
        onClick={() => onSelect?.(segment.id)}
      />)}
    </div> : <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
      {total === null ? "Allocated space is unavailable; file sizes are shown separately." : "No allocated space in this measurement."}
    </p>}
    <ul aria-label={label} className="grid gap-1 sm:grid-cols-2 xl:grid-cols-3">
      {sorted.map(segment => <li key={segment.id} className="min-w-0">
        <button type="button" disabled={!onSelect}
          aria-pressed={onSelect ? selected === segment.id : undefined}
          className={cn("flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm disabled:opacity-100", onSelect && "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selected === segment.id && "bg-accent")}
          onClick={() => onSelect?.(segment.id)}>
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: storageColor(segment.id) }} />
          <span className="min-w-0 flex-1">
            <span className="block break-words font-medium">{segment.label}</span>
            <span className="block text-xs text-muted-foreground">{formatStorageBytes(segment.allocatedBytes)}{total !== null && segment.allocatedBytes !== null && ` · ${storagePercent(segment.allocatedBytes, total)}`}{segment.partial && " · Partial"}</span>
          </span>
        </button>
      </li>)}
    </ul>
  </div>;
}

function MeasuredAt({ snapshot }: { snapshot: StorageSnapshot }) {
  return <p className="text-xs text-muted-foreground">Measured <time dateTime={snapshot.measuredAt}>{new Date(snapshot.measuredAt).toLocaleString()}</time>{snapshot.partial && " · Partial measurement"}</p>;
}

function MeasurementNotes({ snapshot }: { snapshot: StorageSnapshot }) {
  return <div className="space-y-3">
    {snapshot.partial && <Alert severity="warning" title="Measured partially" detail="Some files could not be measured. The displayed amounts cover the files Core could read." />}
    <p className="text-xs leading-relaxed text-muted-foreground">Only files inside the Hosty data root are counted. Mounted folders and symbolic link targets are excluded. Shared files are counted once; deleting a resource may free a different amount of space.</p>
    {(snapshot.excludedSymlinkCount > 0 || snapshot.excludedMountCount > 0) && <p className="text-xs text-muted-foreground">Excluded: {snapshot.excludedMountCount.toLocaleString()} mounted folders · {snapshot.excludedSymlinkCount.toLocaleString()} symbolic links.</p>}
    {snapshot.issueCount > 0 && <details className="text-xs">
      <summary className="cursor-pointer font-medium">Measurement issues ({snapshot.issueCount.toLocaleString()})</summary>
      <ul className="mt-2 space-y-1 text-muted-foreground">{snapshot.issues.map((issue, index) => <li key={`${issue.relativePath}:${issue.code}:${index}`} className="break-all"><code>{issue.relativePath || "."}</code> · {issue.code}</li>)}</ul>
      {snapshot.issueCount > snapshot.issues.length && <p className="mt-2 text-muted-foreground">Showing {snapshot.issues.length} of {snapshot.issueCount} issues.</p>}
    </details>}
  </div>;
}

function ScanControls({ storage }: { storage: ReturnType<typeof useStorage> }) {
  return <div className="flex flex-wrap items-center gap-2">
    {(storage.error || storage.observationPaused) && <Button variant="outline" onClick={() => void storage.checkStatus()}>Check status</Button>}
    <Button variant="outline" disabled={storage.loading || storage.refreshing || storage.isScanning} onClick={() => void storage.recount()}>
      {storage.refreshing || storage.isScanning ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw aria-hidden="true" className="size-4" />}
      {storage.refreshing ? "Starting recount…" : storage.isScanning ? "Recounting…" : storage.retryRecount ? "Retry recount" : "Recount"}
    </Button>
  </div>;
}

function ScanFeedback({ storage }: { storage: ReturnType<typeof useStorage> }) {
  return <>
    {storage.error && <InlineError message={storage.error} />}
    {storage.lastError && <Alert severity="warning" title="The last recount failed" detail={storage.lastError} />}
    {storage.isScanning && <p role="status" className="text-sm text-muted-foreground">{storage.observationPaused ? "The recount is still running. Check its status to see the result." : storage.snapshot ? "Recounting storage. The previous measurement remains visible until the new one is ready." : "Measuring storage. This may take a little while."}</p>}
  </>;
}

function ResourceDetails({ resource }: { resource: StorageResource }) {
  return <div className="space-y-3 rounded-md bg-muted/35 p-3">
    <dl className="grid gap-3 text-xs sm:grid-cols-2">
      <div><dt className="text-muted-foreground">Allocated space</dt><dd className="mt-1 font-medium">{formatStorageBytes(resource.allocatedBytes)}{resource.partial && " (partial)"}</dd></div>
      <div><dt className="text-muted-foreground">Logical file size</dt><dd className="mt-1 font-medium">{formatStorageBytes(resource.logicalBytes)}</dd></div>
      <div className="sm:col-span-2"><dt className="text-muted-foreground">Path inside Hosty</dt><dd className="mt-1 break-all font-mono">{resource.relativePath || "."}</dd></div>
    </dl>
    {resource.parts.length > 0 && <StorageBreakdown label={`${resource.label} contents`} segments={resource.parts.map(part => ({ ...part, label: STORAGE_PARTS[part.id] ?? part.id }))} total={resource.allocatedBytes} />}
    {resource.appId && <Button asChild variant="outline" size="sm"><Link href={getManageAppHref(resource.appId, "storage")}>Application storage<ChevronRight aria-hidden="true" className="size-3.5" /></Link></Button>}
    {resource.relatedAppIds.length > 0 && <p className="break-words text-xs text-muted-foreground">Linked applications: {resource.relatedAppIds.join(", ")}. This resource is counted once in {storageCategoryLabel(resource.category)}.</p>}
    {resource.workspaceId && <p className="break-all text-xs text-muted-foreground">Workspace: {resource.workspaceId}</p>}
  </div>;
}

function ResourceList({ resources, selected, onSelect }: { resources: StorageResource[]; selected: string | null; onSelect: (id: string) => void }) {
  const prefix = useId();
  return <ul className="divide-y">{largestFirst(resources).map((resource, index) => {
    const expanded = selected === resource.id;
    const contentId = `${prefix}-${index}`;
    return <li key={resource.id} className="py-1">
      <button type="button" aria-expanded={expanded} aria-controls={contentId} onClick={() => onSelect(expanded ? "" : resource.id)}
        className="flex min-h-14 w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: storageColor(resource.id) }} />
        <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{resource.label}</span><span className="block break-all text-xs text-muted-foreground">{resource.relativePath || "."}</span></span>
        <span className="shrink-0 text-right text-sm tabular-nums">{formatStorageBytes(resource.allocatedBytes)}{resource.partial && <span className="block text-xs text-muted-foreground">Partial</span>}</span>
        <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} />
      </button>
      <div id={contentId} hidden={!expanded} className="pb-2">{expanded && <ResourceDetails resource={resource} />}</div>
    </li>;
  })}</ul>;
}

export function StoragePage({ dataRoot, withinSettings = false }: { dataRoot?: string | null; withinSettings?: boolean }) {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const storage = useStorage(coreOrigin, sendCsrfJson);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const snapshot = storage.snapshot;
  const categories = snapshot ? largestFirst(snapshot.categories) : [];
  const category = categories.find(item => item.id === selectedCategory) ?? categories[0];
  const resources = snapshot?.resources.filter(resource => resource.category === category?.id) ?? [];
  const selectCategory = (id: string) => { setSelectedCategory(id); setSelectedResource(null); };

  return <div className="space-y-5">
    {withinSettings ? <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><h2 className="text-xl font-semibold leading-7">Storage</h2><p className="text-sm text-muted-foreground">Disk space used by Hosty and the resources Core manages.</p></div><ScanControls storage={storage} /></div>
      : <PageHeader title="Storage" description="Disk space used by Hosty and the resources Core manages." actions={<ScanControls storage={storage} />} />}
    <ScanFeedback storage={storage} />
    {storage.loading && <EmptyState loading title="Loading storage usage" />}
    {!storage.loading && !snapshot && <EmptyState loading={storage.isScanning} title={storage.isScanning ? "Measuring storage" : "No storage measurement yet"} description={storage.error ? "Storage usage is unavailable. Check the status to try loading it again." : "Choose Recount to measure the files inside the Hosty data root."} />}
    {snapshot && <>
      <Frame>
        <FrameHeader><h2 className="text-sm font-medium">Hosty storage</h2></FrameHeader>
        <FramePanel className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1"><div className="flex items-center gap-2 text-sm text-muted-foreground"><HardDrive aria-hidden="true" className="size-4" />Allocated space</div><p className="text-3xl font-semibold tracking-tight tabular-nums">{formatStorageBytes(snapshot.allocatedBytes)}</p><MeasuredAt snapshot={snapshot} /></div>
            <div className="space-y-1 text-sm sm:text-right"><p className="text-muted-foreground">Logical file size</p><p className="font-medium tabular-nums">{formatStorageBytes(snapshot.logicalBytes)}</p>{snapshot.partial && <Badge variant="outline">Partial</Badge>}</div>
          </div>
          <StorageBreakdown label="Storage categories" segments={categories.map(item => ({ ...item, label: storageCategoryLabel(item.id) }))} total={snapshot.allocatedBytes} selected={category?.id} onSelect={selectCategory} />
          <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
            <p>The full bar represents space used by Hosty.</p>
            {snapshot.disk ? <p>{formatStorageBytes(snapshot.disk.availableBytes)} available on the volume · {formatStorageBytes(snapshot.disk.totalBytes)} total volume capacity.</p> : <p>Volume free space is unavailable.</p>}
            {dataRoot && <p className="break-all font-mono">{dataRoot}</p>}
          </div>
        </FramePanel>
      </Frame>
      {category && <section aria-labelledby="storage-category-title">
        <Frame>
          <FrameHeader><div className="flex flex-wrap items-center justify-between gap-2"><h2 id="storage-category-title" className="text-sm font-medium">{storageCategoryLabel(category.id)}</h2><span className="text-sm tabular-nums">{formatStorageBytes(category.allocatedBytes)}{category.partial && " · Partial"}</span></div></FrameHeader>
          <FramePanel className="space-y-4">
            <p className="text-sm text-muted-foreground">{STORAGE_CATEGORIES[category.id]?.description}</p>
            {resources.length ? <>
              <StorageBreakdown label={`${storageCategoryLabel(category.id)} resources`} segments={resources.map(resource => ({ ...resource, label: resource.label }))} total={category.allocatedBytes} selected={selectedResource} onSelect={setSelectedResource} />
              <ResourceList resources={resources} selected={selectedResource} onSelect={setSelectedResource} />
            </> : <p className="py-4 text-sm text-muted-foreground">No resources recorded in this category.</p>}
          </FramePanel>
        </Frame>
      </section>}
      <MeasurementNotes snapshot={snapshot} />
    </>}
  </div>;
}

export function AppStoragePanel({ appId }: { appId: string }) {
  const { coreOrigin, sendCsrfJson } = useShellActions();
  const storage = useStorage(coreOrigin, sendCsrfJson);
  const snapshot = storage.snapshot;
  const app = snapshot ? appStorage(snapshot, appId) : null;
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [selectedPart, setSelectedPart] = useState<string | null>(null);
  const parts = app?.own.flatMap(resource => resource.parts.map(part => ({ ...part, id: `${resource.id}:${part.id}`, label: STORAGE_PARTS[part.id] ?? part.id }))) ?? [];
  return <section aria-label="Application storage" className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1"><h2 className="text-sm font-medium">Application storage</h2><p className="text-xs text-muted-foreground">Uses the same measurement as the Hosty storage overview.</p></div><ScanControls storage={storage} /></div>
    <ScanFeedback storage={storage} />
    {storage.loading && <EmptyState loading title="Loading application storage" />}
    {!storage.loading && !snapshot && <EmptyState title="No storage measurement available" description="Recount Hosty storage to measure this application and its related resources." />}
    {snapshot && app && <>
      <Frame><FramePanel className="space-y-4">
        <div className="space-y-1"><p className="text-sm text-muted-foreground">Application files</p><p className="text-2xl font-semibold tabular-nums">{formatStorageBytes(app.allocatedBytes)}</p><MeasuredAt snapshot={snapshot} /></div>
        {app.own.length ? <>
          <StorageBreakdown label="Application contents" total={app.allocatedBytes} segments={parts.length ? parts : app.own.map(resource => ({ ...resource, label: resource.label }))} selected={selectedPart} onSelect={setSelectedPart} />
          {parts.some(part => part.id === selectedPart) && <p className="text-xs text-muted-foreground">Logical file size: {formatStorageBytes(parts.find(part => part.id === selectedPart)!.logicalBytes)}</p>}
          <ResourceList resources={app.own} selected={selectedResource} onSelect={setSelectedResource} />
        </> : <p className="text-sm text-muted-foreground">This application is not present in the measurement. Recount to include recent changes.</p>}
      </FramePanel></Frame>
      <Frame><FrameHeader><h3 className="text-sm font-medium">Related resources</h3></FrameHeader><FramePanel className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">Sources, workspaces, backups and test environments are counted in their own categories. Shared resources are listed here and are excluded from the application files total.</p>
        {app.related.length ? <ResourceList resources={app.related} selected={selectedResource} onSelect={setSelectedResource} /> : <p className="text-sm text-muted-foreground">No related resources in this measurement.</p>}
      </FramePanel></Frame>
      <Button asChild variant="outline" size="sm"><Link href={getSettingsHref("storage")}>Hosty storage overview<ChevronRight aria-hidden="true" className="size-3.5" /></Link></Button>
      <MeasurementNotes snapshot={snapshot} />
    </>}
  </section>;
}
