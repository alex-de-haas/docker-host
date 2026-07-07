"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, Plus, Store, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { addCatalogSource, getCatalogSources, removeCatalogSource } from "../catalog-api";
import type { CatalogSource } from "../types";
import { EmptyState, IconButton, InlineError } from "../ui";

type SendCsrfJson = (endpoint: string, body?: unknown, method?: string) => Promise<Response>;

// Operator management of catalog sources (WS7 federation). Adding or removing a source takes effect on
// the next storefront fetch — no Core restart — so onChanged refreshes the marketplace list. Until the
// first edit the list is the untouched HOSTY_CATALOG_SOURCES default (managed === false).
export function MarketplaceSourcesDialog({
  open,
  coreOrigin,
  sendCsrfJson,
  onClose,
  onChanged,
}: {
  open: boolean;
  coreOrigin: string;
  sendCsrfJson: SendCsrfJson;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [sources, setSources] = useState<CatalogSource[]>([]);
  const [managed, setManaged] = useState(true);
  const [draftUrl, setDraftUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await getCatalogSources(coreOrigin, signal);
        setSources(response.sources ?? []);
        setManaged(response.managed);
      } catch (caught) {
        if (caught instanceof Error && caught.name === "AbortError") {
          return;
        }
        setError(caught instanceof Error ? caught.message : "Loading catalog sources failed.");
      } finally {
        // Don't flip loading off for a superseded/aborted load — a newer one may be in flight.
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [coreOrigin],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = draftUrl.trim();
    if (url.length === 0) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const response = await addCatalogSource(coreOrigin, sendCsrfJson, url);
      setSources(response.sources ?? []);
      setManaged(response.managed);
      setDraftUrl("");
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Adding the catalog source failed.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (source: CatalogSource) => {
    setError(null);
    setBusy(true);
    try {
      const response = await removeCatalogSource(coreOrigin, sendCsrfJson, source.url);
      setSources(response.sources ?? []);
      setManaged(response.managed);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Removing the catalog source failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Catalog sources</DialogTitle>
          <DialogDescription>
            Catalogs the marketplace lists apps from. Add an http(s) URL or absolute path to a catalog.json. Changes apply
            immediately — no Core restart.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {error && <InlineError message={error} />}
          {!managed && !loading && (
            <p className="text-sm text-muted-foreground">
              Using the default source from <span className="font-mono text-xs">HOSTY_CATALOG_SOURCES</span>. Adding or
              removing a source takes over management from that environment variable.
            </p>
          )}

          <form onSubmit={add} className="space-y-3 rounded-md border p-3">
            <div className="space-y-1">
              <Label htmlFor="catalog-source-url">Source URL or path</Label>
              <Input
                id="catalog-source-url"
                placeholder="https://example.github.io/catalog/catalog.json"
                className="font-mono text-xs"
                value={draftUrl}
                onChange={(event) => setDraftUrl(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy || draftUrl.trim().length === 0}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add source
            </Button>
          </form>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <LoaderCircle className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : sources.length === 0 ? (
            <EmptyState
              icon={Store}
              title="No catalog sources"
              description="The marketplace is empty until you add a source above."
            />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Source</TableHead>
                    <TableHead>URL</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sources.map((source) => (
                    <TableRow key={source.url}>
                      <TableCell className="font-medium">{source.name}</TableCell>
                      <TableCell className="max-w-[280px] truncate font-mono text-xs text-muted-foreground">{source.url}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end">
                          <IconButton title="Remove source" destructive disabled={busy} onClick={() => remove(source)}>
                            <Trash2 className="h-4 w-4" />
                          </IconButton>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
