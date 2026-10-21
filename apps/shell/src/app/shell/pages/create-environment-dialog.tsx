"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { fetchCore } from "../core-transport.js";
import { readCoreErrorDetail } from "../core-api";

type Entry = { id: string; title: string; description?: string; defaultEnabled: boolean };
export function CreateEnvironmentDialog({ origin, disabled, onCreate }: {
  origin: string; disabled: boolean; onCreate: (input: Record<string, unknown>) => Promise<void>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false), [entries, setEntries] = useState<Entry[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [error, setError] = useState("");
  const [label, setLabel] = useState("New environment"), [corePort, setCorePort] = useState("");
  const [memory, setMemory] = useState(4), [cpus, setCpus] = useState(2), [pids, setPids] = useState(512);
  const [appPorts, setAppPorts] = useState("");
  useEffect(() => {
    if (!open || entries) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetchCore(`${origin}/api/core/bootstrap`, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw new Error((await readCoreErrorDetail(response)).message);
        const catalog = await response.json() as { apps: Entry[]; problems: string[] };
        if (catalog.problems?.length) throw new Error(catalog.problems.join("; "));
        if (!abort.signal.aborted) { setEntries(catalog.apps); setSelected(catalog.apps.filter(e => e.defaultEnabled).map(e => e.id)); setError(""); }
      } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Cannot read the distribution catalog."); }
    })();
    return () => abort.abort();
  }, [open, entries, origin]);
  const overCapacity = selected.length * 2 > memory || selected.length > cpus || selected.length * 256 > pids;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const ports = appPorts.split(',').map(value => value.trim()).filter(Boolean).map(value => {
        const match = /^([^:]+):([^:]+):([^=]+)=(\d+)$/.exec(value);
        if (!match || +match[4] < 1024 || +match[4] > 65535 || !selected.includes(match[1]))
          throw new Error("Use appId:service:portKey=port for a selected app, with ports from 1024 to 65535.");
        return { appId: match[1], service: match[2], portKey: match[3], port: +match[4] };
      });
      await onCreate({ requestId: crypto.randomUUID(), label: label.trim(), mode: "current",
        initialization: { schemaVersion: "hosty-initialization.0.1", requestId: crypto.randomUUID(), apps: selected, ports },
        ...(corePort ? { corePort: +corePort } : {}),
        limits: { memoryBytes: memory * 1073741824, cpus, pids, diskBytes: 10737418240,
          applicationMemoryBytes: 2147483648, applicationCpus: 1, applicationPids: 256 } });
      setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Environment creation failed."); }
  };
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button type="button" size="sm" disabled={disabled}><Plus data-icon="inline-start" />Create environment</Button></DialogTrigger>
    <DialogContent className="max-h-[85dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>Create environment</DialogTitle><DialogDescription>A fresh Core with separate apps, accounts and data. Register its administrator in the browser after installation.</DialogDescription></DialogHeader>
      <form onSubmit={event => void submit(event)} className="flex flex-col gap-5">
        <FieldGroup>
          <Field><FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel><Input id={`${id}-name`} value={label} onChange={e => setLabel(e.target.value)} required maxLength={120} disabled={disabled} /></Field>
          <FieldSet><FieldLegend>Applications</FieldLegend><FieldDescription>Core is always included. Recommended apps are selected below.</FieldDescription>
            {!entries && !error && <p role="status">Loading available applications…</p>}
            <FieldGroup>{entries?.map(entry => <Field key={entry.id} orientation="horizontal">
              <Checkbox id={`${id}-${entry.id}`} checked={selected.includes(entry.id)} disabled={disabled}
                onCheckedChange={checked => setSelected(previous => checked === true ? [...previous, entry.id] : previous.filter(value => value !== entry.id))} />
              <FieldContent><FieldLabel htmlFor={`${id}-${entry.id}`}>{entry.title}{entry.defaultEnabled && <Badge variant="secondary">Recommended</Badge>}</FieldLabel><FieldDescription>{entry.description}</FieldDescription></FieldContent>
            </Field>)}</FieldGroup>
          </FieldSet>
          {!selected.includes("hosty.shell") && entries && <FieldDescription>Without Shell, manage the environment through CLI/API. You can install Shell later with hosty setup.</FieldDescription>}
        </FieldGroup>
        <details><summary className="cursor-pointer text-sm">Advanced: ports and resources</summary>
          <FieldGroup className="mt-4">
            <Field><FieldLabel htmlFor={`${id}-port`}>Core port</FieldLabel><Input id={`${id}-port`} type="number" min={1024} max={65535} placeholder="Automatic" value={corePort} onChange={e => setCorePort(e.target.value)} /></Field>
            <Field><FieldLabel htmlFor={`${id}-app-ports`}>Application ports</FieldLabel><Input id={`${id}-app-ports`} value={appPorts} onChange={e => setAppPorts(e.target.value)} placeholder="Automatic" /><FieldDescription>Optional overrides: appId:service:portKey=port, separated by commas.</FieldDescription></Field>
            <Field><FieldLabel htmlFor={`${id}-memory`}>Reserved memory (GiB)</FieldLabel><Input id={`${id}-memory`} type="number" min={1} max={8} required value={memory} onChange={e => setMemory(+e.target.value)} /></Field>
            <Field><FieldLabel htmlFor={`${id}-cpus`}>Reserved CPUs</FieldLabel><Input id={`${id}-cpus`} type="number" min={1} max={4} required value={cpus} onChange={e => setCpus(+e.target.value)} /></Field>
            <Field><FieldLabel htmlFor={`${id}-pids`}>Process limit</FieldLabel><Input id={`${id}-pids`} type="number" min={256} max={1024} required value={pids} onChange={e => setPids(+e.target.value)} /></Field>
            <FieldDescription>Each app reserves 2 GiB, 1 CPU and 256 processes. The shared environment pool allows up to 8 GiB, 4 CPUs and two environments.</FieldDescription>
          </FieldGroup>
        </details>
        {overCapacity && <Alert variant="destructive"><AlertDescription>Select fewer apps or increase the limits under Advanced. This selection exceeds the current reservation.</AlertDescription></Alert>}
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <DialogFooter><Button type="submit" disabled={disabled || !entries || !label.trim() || overCapacity}>Create and start</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
