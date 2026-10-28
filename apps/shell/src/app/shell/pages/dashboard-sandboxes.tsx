"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Boxes, ChevronRight, ExternalLink, RefreshCw, Server } from "lucide-react";
import type { CoreEnvironment, SandboxDiagnostics, SandboxInstance } from "@hosty-sdk/app/sandbox/server";
import type { EnvironmentApps } from "@hosty-sdk/app/sandbox/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, OperationStatus, StatusBadge } from "../ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Frame, FrameHeader, FramePanel } from "@/components/reui/frame";
import { useConfirmation } from "@/components/reui/confirmation";
import { cn } from "@/lib/utils";
import { watchSandboxEvents } from "../events/sandbox-events";
import { fetchCore } from "../core-transport.js";
import { CoreRequestError, readCoreErrorDetail } from "../core-api";
import { useShellActions } from "../shell-context";
import type { CoreApp } from "../types";
import { EnvironmentInitialization } from "./environment-initialization";
import { HostyLoader } from "../../../../../../shared/web/hosty-states";
import { CreateEnvironmentDialog } from "./create-environment-dialog";
import type { ActivationWorkspace } from "../workspace-sources";

type CorePending = { path: string; body: Record<string, unknown>; id?: string; kind: string };
type AppPending = { id: string; action: string; requestId: string; expectedRevision: number };
type Inventory<T> = { loaded: boolean; loading: boolean; items: T[]; error: string };
type Feedback = { id?: string; message: string; failed?: boolean };
type Request = <T>(path: string, body: unknown) => Promise<T>;
const empty = <T,>(): Inventory<T> => ({ loaded: false, loading: true, items: [], error: "" });
const message = (cause: unknown) => cause instanceof Error ? cause.message : "The sandbox request could not be confirmed.";
const normalizeId = (value: string) => value.replaceAll("-", "");
const terminalAppRefusals = new Set(["sandbox_revision_stale", "sandbox_operation_capacity", "sandbox_metadata_quota", "sandbox_forbidden", "sandbox_not_found"]);

function safeUrl(value?: string): string | undefined {
  try {
    const url = new URL(value ?? "");
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* A missing or unsafe destination has no link. */ }
}
function personaUrl(value: string | undefined, persona: string) {
  const safe = safeUrl(value);
  if (!safe) return;
  const url = new URL(safe); url.searchParams.set("hosty_sandbox_persona", persona); return url.href;
}
async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetchCore(url, { cache: "no-store", signal });
  if (!response.ok) {
    const detail = await readCoreErrorDetail(response);
    throw new CoreRequestError(detail.message, detail.code, response.status, detail.body);
  }
  return await response.json() as T;
}
function workspaceName(id: string | undefined, workspaces: Map<string, ActivationWorkspace>) {
  if (!id) return "Independent run";
  const workspace = workspaces.get(id);
  return workspace ? workspace.name || workspace.owner.label || "Workspace unavailable" : "Workspace unavailable";
}

export function DashboardSandboxes(props: { coreOrigin: string; apps: CoreApp[]; workspaces: ActivationWorkspace[] }) {
  // Inventory, pending receipts and app setup drafts never cross Core instances.
  return <SandboxInventory key={props.coreOrigin} {...props} />;
}

function SandboxInventory({ coreOrigin, apps, workspaces }: { coreOrigin: string; apps: CoreApp[]; workspaces: ActivationWorkspace[] }) {
  const { sendCsrfJson } = useShellActions();
  const { confirm, dialog } = useConfirmation(coreOrigin);
  const [cores, setCores] = useState<Inventory<CoreEnvironment>>(empty);
  const [individual, setIndividual] = useState<Inventory<SandboxInstance>>(empty);
  const [corePending, setCorePending] = useState<CorePending | null>(null);
  const [appPending, setAppPending] = useState<AppPending | null>(null);
  const corePendingRef = useRef<CorePending | null>(null);
  const appPendingRef = useRef<AppPending | null>(null);
  const [coreBusy, setCoreBusy] = useState(false), [appBusy, setAppBusy] = useState(false);
  const coreBusyRef = useRef(false), appBusyRef = useRef(false);
  const [coreFeedback, setCoreFeedback] = useState<Feedback | null>(null);
  const [appFeedback, setAppFeedback] = useState<Feedback | null>(null);
  const [pollVersion, setPollVersion] = useState(0);
  const alive = useRef(false), readEpoch = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const coreKey = `hosty:core-environment:${coreOrigin}`;
  const appKey = `hosty:sandbox-operation:${coreOrigin}`;
  const refresh = useCallback(() => refreshRef.current(), []);
  const saveCorePending = useCallback((value: CorePending | null) => {
    if (value) sessionStorage.setItem(coreKey, JSON.stringify(value));
    else { try { sessionStorage.removeItem(coreKey); } catch { /* The retained receipt is still safe to read. */ } }
    corePendingRef.current = value; if (alive.current) setCorePending(value);
  }, [coreKey]);
  const saveAppPending = useCallback((value: AppPending | null) => {
    if (value) sessionStorage.setItem(appKey, JSON.stringify(value));
    else { try { sessionStorage.removeItem(appKey); } catch { /* Core retains the operation identity. */ } }
    appPendingRef.current = value; if (alive.current) setAppPending(value);
  }, [appKey]);
  const observeCore = useCallback((item: CoreEnvironment) => {
    const saved = corePendingRef.current;
    if (!saved?.id || saved.id !== item.id) return;
    const operation = item.operations?.find(op => normalizeId(op.id) === normalizeId(String(saved.body.requestId)));
    if (!operation || !["succeeded", "failed"].includes(operation.state)) return;
    const superseded = operation !== item.operations.at(-1);
    if (operation.state === "succeeded" || saved.kind !== "finish" || superseded) saveCorePending(null);
    setCoreFeedback(operation.state === "failed" ? { id: item.id, message: item.error || operation.message || "Sandbox operation failed.", failed: true }
      : item.state === "finished" ? { message: "Sandbox deleted. Workspace source is preserved." } : null);
  }, [saveCorePending]);
  const observeApp = useCallback((item: SandboxInstance) => {
    const saved = appPendingRef.current;
    if (!saved || saved.id !== item.id) return;
    const operation = item.operations?.find(op => normalizeId(op.id) === normalizeId(saved.requestId));
    if (!operation || !["succeeded", "failed"].includes(operation.state)) return;
    const superseded = operation !== item.operations.at(-1);
    if (operation.state === "succeeded" || saved.action !== "dispose" || superseded) saveAppPending(null);
    setAppFeedback(operation.state === "failed" ? { id: item.id, message: operation.message || operation.errorCode || "Sandbox operation failed.", failed: true } : null);
  }, [saveAppPending]);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    let pending: Promise<void> | null = null, reread = false, streamGeneration = 0;
    const current = () => !controller.signal.aborted;
    let receiptTimer: ReturnType<typeof setTimeout> | undefined;
    let receiptPending = false, receiptDelay = 1000;
    const recoverReceipt = async (saved: AppPending) => {
      if (!current() || receiptPending || receiptTimer || appPendingRef.current?.requestId !== saved.requestId) return;
      receiptPending = true;
      try {
        const receipt = await read<SandboxInstance>(`${coreOrigin}/api/sandbox-instances/${encodeURIComponent(saved.id)}`, controller.signal);
        if (current() && appPendingRef.current?.requestId === saved.requestId) observeApp(receipt);
      } catch { /* A lost receipt read must recover even if no further inventory event occurs. */ }
      finally {
        receiptPending = false;
        if (current() && appPendingRef.current?.requestId === saved.requestId) {
          receiptTimer = setTimeout(() => { receiptTimer = undefined; void recoverReceipt(saved); }, receiptDelay);
          receiptDelay = Math.min(receiptDelay * 2, 30_000);
        } else receiptDelay = 1000;
      }
    };
    const load = (): Promise<void> => {
      if (!current()) return Promise.resolve();
      if (pending) { reread = true; return pending; }
      setCores(previous => ({ ...previous, loading: true }));
      setIndividual(previous => ({ ...previous, loading: true }));
      const epoch = readEpoch.current, generation = streamGeneration;
      const valid = () => current() && epoch === readEpoch.current && generation === streamGeneration;
      pending = Promise.allSettled([
        read<{ environments: CoreEnvironment[] }>(`${coreOrigin}/api/core-environments`, controller.signal)
          .then(result => {
            if (!valid()) return;
            if (!Array.isArray(result.environments)) throw new Error("Core did not return the sandbox inventory.");
            setCores({ loaded: true, loading: false, items: result.environments, error: "" });
            for (const item of result.environments) observeCore(item);
          }).catch(cause => { if (valid()) setCores(previous => ({ ...previous, loading: false, error: message(cause) })); }),
        read<{ instances: SandboxInstance[] }>(`${coreOrigin}/api/sandbox-instances`, controller.signal)
          .then(async result => {
            if (!valid()) return;
            if (!Array.isArray(result.instances)) throw new Error("Core did not return the app sandbox inventory.");
            setIndividual({ loaded: true, loading: false, items: result.instances, error: "" });
            for (const item of result.instances) observeApp(item);
            const saved = appPendingRef.current;
            if (saved && !result.instances.some(item => item.id === saved.id)) {
              void recoverReceipt(saved);
            }
          }).catch(cause => { if (valid()) setIndividual(previous => ({ ...previous, loading: false, error: message(cause) })); }),
      ]).then(() => { if (valid()) setPollVersion(value => value + 1); }).finally(() => {
        pending = null;
        if (current() && (reread || epoch !== readEpoch.current)) { reread = false; void load(); }
      });
      return pending;
    };
    refreshRef.current = load;
    void Promise.resolve().then(() => {
      if (!current()) return;
      try {
        const saved = JSON.parse(sessionStorage.getItem(coreKey) ?? "null") as CorePending | null;
        if (saved && (saved.path === "" || /^\/(?:from-workspace|[a-f0-9]{32}\/operations\/(?:start|stop|restart|finish))$/.test(saved.path))
          && typeof saved.body?.requestId === "string") {
          corePendingRef.current = saved; setCorePending(saved);
        }
      } catch { setCoreFeedback({ message: "Cannot read the saved Core sandbox request.", failed: true }); }
      try {
        const saved = JSON.parse(sessionStorage.getItem(appKey) ?? "null") as AppPending | null;
        if (saved && typeof saved.id === "string" && typeof saved.requestId === "string" &&
          ["start", "stop", "restart", "reset", "dispose"].includes(saved.action) && Number.isFinite(saved.expectedRevision)) {
          appPendingRef.current = saved; setAppPending(saved);
        }
      } catch { setAppFeedback({ message: "Cannot read the saved app sandbox request.", failed: true }); }
      void load();
    });
    const stopEvents = watchSandboxEvents(coreOrigin, load, data => {
      if (!current()) return;
      streamGeneration++;
      if (data.environments) {
        setCores({ loaded: true, loading: false, items: data.environments, error: "" });
        for (const item of data.environments) observeCore(item);
      } else setCores(previous => ({ ...previous, loading: false, error: data.coreError || "Core sandbox inventory is unavailable." }));
      if (data.instances) {
        setIndividual({ loaded: true, loading: false, items: data.instances, error: "" });
        for (const item of data.instances) observeApp(item);
        // Disposal removes the row, but only its durable receipt confirms a pending operation.
        const saved = appPendingRef.current;
        if (saved && !data.instances.some(item => item.id === saved.id)) {
          void recoverReceipt(saved);
        }
      } else setIndividual(previous => ({ ...previous, loading: false, error: data.appError || "Application sandbox inventory is unavailable." }));
    });
    return () => {
      alive.current = false; controller.abort(); stopEvents(); clearTimeout(receiptTimer);
      if (refreshRef.current === load) refreshRef.current = async () => {};
    };
  }, [coreOrigin, coreKey, appKey, observeCore, observeApp]);

  const coreRequest = useCallback<Request>(async (path, body) => {
    const response = await sendCsrfJson(`${coreOrigin}/api/core-environments${path}`, body);
    return await response.json();
  }, [coreOrigin, sendCsrfJson]);
  const runCore = async (value: CorePending) => {
    if (coreBusyRef.current || (corePendingRef.current && corePendingRef.current.body.requestId !== value.body.requestId)) return;
    coreBusyRef.current = true; setCoreBusy(true); setCoreFeedback(null); readEpoch.current++;
    try {
      saveCorePending(value);
      let result = await coreRequest<CoreEnvironment>(value.path, value.body);
      if (value.path === "" && result.state === "stopped" && result.initializationRequested) {
        const start = { path: `/${result.id}/operations/start`, body: { requestId: crypto.randomUUID(), expectedRevision: result.revision }, id: result.id, kind: "start" };
        saveCorePending(start);
        result = await coreRequest<CoreEnvironment>(start.path, start.body);
      }
      if (!alive.current) return;
      setCores(previous => ({ ...previous, loaded: true, items: [...previous.items.filter(item => item.id !== result.id), result] }));
      observeCore(result);
      if (!value.id || result.state === "finished") saveCorePending(null);
      if (result.error) setCoreFeedback({ id: result.id, message: result.error, failed: true });
      return result;
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof CoreRequestError && cause.status >= 400 && cause.status < 500) saveCorePending(null);
      setCoreFeedback({ id: value.id, message: message(cause), failed: true });
    } finally {
      coreBusyRef.current = false;
      if (alive.current) { setCoreBusy(false); readEpoch.current++; void refresh(); }
    }
  };
  const runApp = async (value: AppPending) => {
    if (appBusyRef.current || (appPendingRef.current && appPendingRef.current.requestId !== value.requestId)) return;
    appBusyRef.current = true; setAppBusy(true); setAppFeedback(null); readEpoch.current++;
    try {
      saveAppPending(value);
      const response = await sendCsrfJson(`${coreOrigin}/api/sandbox-instances/${encodeURIComponent(value.id)}/operations/${value.action}`, {
        requestId: value.requestId, expectedRevision: value.expectedRevision,
      });
      const result = await response.json() as SandboxInstance;
      if (!alive.current) return;
      setIndividual(previous => ({ ...previous, loaded: true, items: [...previous.items.filter(item => item.id !== result.id), result] }));
      observeApp(result);
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof CoreRequestError && terminalAppRefusals.has(cause.code ?? "")) saveAppPending(null);
      setAppFeedback({ id: value.id, message: message(cause), failed: true });
    } finally {
      appBusyRef.current = false;
      if (alive.current) { setAppBusy(false); readEpoch.current++; void refresh(); }
    }
  };
  const auxiliaryCore = async (path: string, body: unknown) => {
    if (coreBusyRef.current || corePendingRef.current) return;
    coreBusyRef.current = true; setCoreBusy(true); setCoreFeedback(null); readEpoch.current++;
    try { await coreRequest(path, body); }
    catch (cause) { if (alive.current) setCoreFeedback({ message: message(cause), failed: true }); }
    finally { coreBusyRef.current = false; if (alive.current) { setCoreBusy(false); readEpoch.current++; void refresh(); } }
  };
  const finishCore = async (item: CoreEnvironment) => {
    if (coreBusyRef.current || corePendingRef.current) return;
    if (await confirm({ title: `Delete ${item.label}?`, description: "Delete this sandbox, its apps, test users, data and caches? Workspace source and shared folders are preserved.", action: "Delete sandbox", destructive: true }))
      await runCore({ path: `/${item.id}/operations/finish`, body: { requestId: crypto.randomUUID(), expectedRevision: item.revision }, id: item.id, kind: "finish" });
  };
  const finishApp = async (item: SandboxInstance, label: string) => {
    if (appBusyRef.current || appPendingRef.current) return;
    if (await confirm({ title: `Finish ${label}?`, description: "Delete this sandbox's test users, data, caches and evidence? Export needed results first. Workspace source is preserved.", action: "Finish sandbox", destructive: true }))
      await runApp({ id: item.id, action: "dispose", requestId: crypto.randomUUID(), expectedRevision: item.revision });
  };

  const survivingCores = cores.items.filter(item => item.state !== "finished");
  const survivingApps = individual.items.filter(item => item.state !== "disposed");
  const workspaceById = new Map(workspaces.map(workspace => [workspace.id, workspace]));
  const appById = new Map(apps.map(app => [app.id, app]));
  const coreDisabled = coreBusy || corePending !== null, appDisabled = appBusy || appPending !== null;
  return <Frame role="region" aria-label="Sandboxes">
    <FrameHeader className="flex-row flex-wrap items-center justify-between gap-3 p-3">
      <h2 className="font-medium">Sandboxes</h2>
      <div className="flex flex-wrap items-center gap-2">
        <CreateEnvironmentDialog origin={coreOrigin} disabled={coreDisabled} onCreate={async body => { if (!await runCore({ path: "", body, kind: "create" })) throw new Error("Creation could not be confirmed. Check the sandbox message and retry its saved request before creating another."); }} />
        <Button type="button" variant="ghost" size="sm" disabled={cores.loading || individual.loading} onClick={() => void refresh()}><RefreshCw data-icon="inline-start" />Refresh sandboxes</Button>
      </div>
    </FrameHeader>
    <FramePanel className="flex flex-col gap-2 p-0">
      {(!cores.loaded && cores.loading || !individual.loaded && individual.loading) && <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><HostyLoader label={null} className="size-5 shrink-0" />Loading sandbox inventory…</p>}
      {!survivingCores.length && !survivingApps.length && cores.loaded && individual.loaded && !cores.error && !individual.error && <EmptyState className="rounded-none border-0" title="No sandboxes yet" description="Create an environment to try a fresh Hosty installation." />}
      {(cores.error && cores.items.length > 0 || individual.error && individual.items.length > 0) && <p className="px-3 text-sm text-muted-foreground">Previously loaded sandboxes are shown for the unavailable inventory.</p>}
      {cores.error && <ErrorNotice>Core sandbox inventory: {cores.error}</ErrorNotice>}
      {individual.error && <ErrorNotice>App sandbox inventory: {individual.error}</ErrorNotice>}
      {coreFeedback && <FeedbackNotice value={coreFeedback} />}
      {appFeedback && <FeedbackNotice value={appFeedback} />}
      {corePending && <PendingNotice kind="Core sandbox" busy={coreBusy} onRetry={() => void runCore(corePending)} />}
      {appPending && <PendingNotice kind="App sandbox" busy={appBusy} onRetry={() => void runApp(appPending)} />}
      {survivingCores.map(item => <SandboxRow key={`core:${item.id}`} rowKey={`core:${item.id}`} label={item.label || "Core sandbox"}
        state={item.state} workspace={workspaceName(item.context?.workspaceId, workspaceById)} kind="core"
        error={item.error || (coreFeedback?.id === item.id && coreFeedback.failed ? coreFeedback.message : undefined)}>
        <CoreSandboxDetails item={item} origin={coreOrigin} pollVersion={pollVersion} disabled={coreDisabled} request={coreRequest}
          onRefresh={refresh} onCommand={kind => void runCore({ path: `/${item.id}/operations/${kind}`, body: { requestId: crypto.randomUUID(), expectedRevision: item.revision }, id: item.id, kind })}
          onFinish={() => void finishCore(item)} onRevoke={() => void auxiliaryCore(`/${item.id}/consent/revoke`, {})} />
      </SandboxRow>)}
      {survivingApps.map(item => {
        const label = `${appById.get(item.appId)?.displayName || item.appId} sandbox`;
        return <SandboxRow key={`app:${item.id}`} rowKey={`app:${item.id}`} label={label} state={item.state} kind="app"
          workspace={workspaceName(item.context?.workspaceId, workspaceById)}
          error={item.errorCode || (appFeedback?.id === item.id && appFeedback.failed ? appFeedback.message : undefined)}>
          <AppSandboxDetails item={item} label={label} origin={coreOrigin} disabled={appDisabled}
            onCommand={action => void runApp({ id: item.id, action, requestId: crypto.randomUUID(), expectedRevision: item.revision })}
            onFinish={() => void finishApp(item, label)} />
        </SandboxRow>;
      })}
    </FramePanel>
    {dialog}
  </Frame>;
}

function ErrorNotice({ children }: { children: ReactNode }) {
  return <Alert variant="destructive" className="m-3 w-auto"><AlertDescription>{children}</AlertDescription></Alert>;
}
function FeedbackNotice({ value }: { value: Feedback }) {
  return value.failed ? <ErrorNotice>{value.message}</ErrorNotice> : <p role="status" className="px-3 py-2 text-sm text-muted-foreground">{value.message}</p>;
}
function PendingNotice({ kind, busy, onRetry }: { kind: string; busy: boolean; onRetry: () => void }) {
  return <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
    <OperationStatus tone={busy ? "working" : "attention"} className="text-sm">{busy ? `${kind} operation is in progress…` : `${kind} operation needs confirmation.`}</OperationStatus>
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRetry}>Retry same request</Button>
  </div>;
}
function SandboxRow({ rowKey, label, state, workspace, kind, error, children }: {
  rowKey: string; label: string; state: string; workspace: string; kind: "core" | "app"; error?: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Icon = kind === "core" ? Server : Boxes;
  return <Collapsible open={open} onOpenChange={setOpen} asChild>
    <article data-sandbox-key={rowKey} aria-label={`Sandbox ${label}`} className="border-b last:border-b-0">
      <CollapsibleTrigger asChild><Button type="button" variant="ghost" className="h-auto w-full justify-start gap-3 rounded-none px-3 py-3"
        aria-label={`${open ? "Hide" : "Show"} details for ${label}`}>
        <ChevronRight aria-hidden="true" className={cn("shrink-0 transition-transform", open && "rotate-90")} />
        <Icon aria-hidden="true" className="shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"><span className="truncate">{label}</span><span className="max-w-full truncate text-xs text-muted-foreground">{workspace}</span></span>
        <Badge variant="outline" className="shrink-0"><StatusBadge value={state} label={state} className="gap-1.5 text-xs" /></Badge>
      </Button></CollapsibleTrigger>
      {error && <p role="alert" className="break-words px-3 pb-3 text-sm text-destructive-foreground">{error}</p>}
      <CollapsibleContent><div className="flex flex-col gap-4 border-t p-3">{children}</div></CollapsibleContent>
    </article>
  </Collapsible>;
}

function PreviewLink({ href, children }: { href?: string; children: ReactNode }) {
  const safe = safeUrl(href);
  return safe ? <Button asChild variant="outline" size="sm"><a href={safe} target="_blank" rel="noreferrer">{children}<ExternalLink data-icon="inline-end" /></a></Button> : null;
}
function CoreSandboxDetails({ item, origin, pollVersion, disabled, request, onRefresh, onCommand, onFinish, onRevoke }: {
  item: CoreEnvironment; origin: string; pollVersion: number; disabled: boolean; request: Request; onRefresh: () => Promise<void>;
  onCommand: (kind: string) => void; onFinish: () => void; onRevoke: () => void;
}) {
  const [inventory, setInventory] = useState<EnvironmentApps | null>(null), [error, setError] = useState("");
  const sequence = useRef(0);
  const [detailVersion, setDetailVersion] = useState(0);
  useEffect(() => {
    if (item.state !== "running") return;
    const refresh = () => { if (document.visibilityState === "visible") setDetailVersion(value => value + 1); };
    const timer = setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [item.state]);
  useEffect(() => {
    if (item.state !== "running") return;
    const controller = new AbortController(), current = ++sequence.current;
    void read<EnvironmentApps>(`${origin}/api/core-environments/${item.id}/apps`, controller.signal).then(value => {
      if (!controller.signal.aborted && current === sequence.current) { setInventory(value); setError(""); }
    }).catch(cause => { if (!controller.signal.aborted && current === sequence.current) setError(message(cause)); });
    return () => controller.abort();
  }, [origin, item.id, item.state, pollVersion, detailVersion]);
  const login = safeUrl(item.previewUrl);
  const transitional = ["building", "starting", "stopping", "finishing"].includes(item.state);
  return <>
    <div className="flex flex-wrap items-center gap-2">
      {item.state === "running" && login && <PreviewLink href={new URL("/login", login).href}>Open Core</PreviewLink>}
      {item.state === "running" ? <><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onCommand("stop")}>Stop</Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onCommand("restart")}>Restart</Button></>
        : ["stopped", "failed", "quota-exceeded"].includes(item.state) ? <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onCommand("start")}>Start</Button> : null}
      <Button type="button" variant="ghost" size="sm" disabled={disabled || transitional} onClick={onFinish}>{item.state === "cleanup-failed" ? "Retry deletion" : "Delete sandbox"}</Button>
    </div>
    {item.state === "running" && item.initializationRequested && <EnvironmentInitialization item={item} origin={origin} pollVersion={pollVersion + detailVersion} request={request} />}
    {item.state === "running" ? <>
      {error && <ErrorNotice>Application status: {error}</ErrorNotice>}
      {!inventory ? <p role="status" className="text-sm text-muted-foreground">Reading application status…</p>
        : inventory.state === "ready" ? <ul aria-label="Sandbox applications" className="divide-y">{inventory.apps.map(app => <li key={app.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
          <div><span className="font-medium">{app.displayName}</span><span className="ml-2 text-muted-foreground">{app.runtimeState} · {app.health || "Health unknown"}</span></div>
          {app.runtimeState === "running" && <PreviewLink href={app.previewUrl}>Open preview<span className="sr-only"> for {app.displayName}</span></PreviewLink>}
        </li>)}{!inventory.apps.length && <li className="py-2 text-sm text-muted-foreground">No apps installed in this sandbox yet.</li>}</ul>
          : <p role="status" className="text-sm text-muted-foreground">{inventory.error || (inventory.state === "setup-required" ? "Set up a test administrator for this Core." : "Connect the sandbox's test account to read its apps.")}</p>}
      {!item.initializationRequested && inventory && ["setup-required", "sign-in-required"].includes(inventory.state) && <SandboxAccount request={request} id={item.id} disabled={disabled} onDone={onRefresh} />}
    </> : <p className="text-sm text-muted-foreground">Application links are available while this sandbox is running.</p>}
    <details className="text-sm"><summary className="cursor-pointer">Resources and access</summary><div className="mt-3 flex flex-col gap-3">
      <p className="text-muted-foreground">{item.mode === "source" ? "Core built from workspace source" : item.mode === "release" ? "Installed Core release" : "Current Core build"}</p>
      {item.limits && <p>Reserved: {(item.limits.memoryBytes / 1073741824).toFixed(1)} GiB memory · {item.limits.cpus} CPUs · {item.limits.pids} PIDs · {(item.limits.diskBytes / 1073741824).toFixed(1)} GiB disk.</p>}
      {item.usage && <p>{item.usage.state === "unknown" ? "Resource usage unavailable; the reservation remains active." : `Observed: ${(item.usage.containerMemoryBytes / 1048576).toFixed(0)} MiB containers · ${(item.usage.coreMemoryBytes / 1048576).toFixed(0)} MiB Core · ${(item.usage.ownedDiskBytes / 1073741824).toFixed(2)} GiB owned data.`}</p>}
      {item.access && <><p>{item.access.state === "operator" ? "Operator launch" : item.access.state === "active" ? item.access.saved ? "Saved launch permission" : "Permission for this run" : item.access.state === "target-changed" ? "Core target changed; review launch permission" : "Launch permission revoked or unavailable"}</p><p className="text-muted-foreground">{item.access.description}</p>
        {item.access.grantId && ["active", "target-changed"].includes(item.access.state) && <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onRevoke}>Revoke launch permission</Button>}</>}
    </div></details>
  </>;
}
function SandboxAccount({ request, id, disabled, onDone }: { request: Request; id: string; disabled: boolean; onDone: () => Promise<void> }) {
  const name = useId();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submitting = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (submitting.current || disabled) return;
    const form = event.currentTarget, data = new FormData(form);
    submitting.current = true; setBusy(true); setError("");
    try {
      const result = await request<{ status: number; body?: { message?: string } }>(`/${id}/setup`, {
        email: data.get("email"), displayName: data.get("displayName"), password: data.get("password"),
      });
      if (result.status !== 200) throw new Error(result.body?.message || "Sandbox account setup failed.");
      if (alive.current) await onDone();
    } catch (cause) { if (alive.current) setError(message(cause)); }
    finally {
      (form.elements.namedItem("password") as HTMLInputElement).value = "";
      submitting.current = false; if (alive.current) setBusy(false);
    }
  };
  return <form aria-label="Sandbox administrator" onSubmit={submit} className="flex flex-col gap-3 rounded-md border p-3">
    <p className="text-sm text-muted-foreground">Use a separate sandbox administrator. For an existing Core, enter its current test account. Parent credentials are not copied.</p>
    <FieldGroup className="gap-3 sm:flex-row">
      <Field><FieldLabel htmlFor={`${name}-name`}>Display name</FieldLabel><Input id={`${name}-name`} name="displayName" required autoComplete="off" disabled={disabled || busy} /></Field>
      <Field><FieldLabel htmlFor={`${name}-email`}>Test email</FieldLabel><Input id={`${name}-email`} name="email" type="email" required autoComplete="off" disabled={disabled || busy} /></Field>
      <Field><FieldLabel htmlFor={`${name}-password`}>Test password</FieldLabel><Input id={`${name}-password`} name="password" type="password" minLength={12} required autoComplete="new-password" disabled={disabled || busy} /></Field>
    </FieldGroup>
    {error && <ErrorNotice>{error}</ErrorNotice>}
    <Button type="submit" variant="outline" size="sm" disabled={disabled || busy}>{busy ? "Connecting…" : "Connect test account"}</Button>
  </form>;
}
function AppSandboxDetails({ item, label, origin, disabled, onCommand, onFinish }: {
  item: SandboxInstance; label: string; origin: string; disabled: boolean; onCommand: (kind: string) => void; onFinish: () => void;
}) {
  const [diagnostics, setDiagnostics] = useState<SandboxDiagnostics | null>(null), [error, setError] = useState("");
  const [logsBusy, setLogsBusy] = useState(false), [embedded, setEmbedded] = useState(false);
  const logsPending = useRef(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const loadLogs = async () => {
    if (logsPending.current) return;
    logsPending.current = true; setLogsBusy(true); setError("");
    const controller = new AbortController(); abort.current = controller;
    try {
      const value = await read<SandboxDiagnostics>(`${origin}/api/sandbox-instances/${item.id}/diagnostics`, controller.signal);
      if (!controller.signal.aborted) setDiagnostics(value);
    } catch (cause) { if (!controller.signal.aborted) setError(message(cause)); }
    finally { logsPending.current = false; if (!controller.signal.aborted) setLogsBusy(false); }
  };
  const preview = safeUrl(item.previewUrl), ready = item.state === "ready";
  const transitioning = ["preparing", "starting", "stopping", "resetting", "disposing"].includes(item.state);
  return <>
    <ul aria-label="Sandbox applications"><li className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <div><span className="font-medium">{label.replace(/ sandbox$/, "")}</span><span className="ml-2 text-muted-foreground">{item.state}</span></div>
      {ready && <PreviewLink href={personaUrl(preview, "core")}>Open preview</PreviewLink>}
    </li></ul>
    <div className="flex flex-wrap items-center gap-2">
      {ready || item.state === "unhealthy" ? <><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onCommand("stop")}>Stop</Button>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onCommand("restart")}>Restart</Button></>
        : ["prepared", "stopped"].includes(item.state) ? <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onCommand("start")}>Start</Button> : null}
      <Button type="button" variant="ghost" size="sm" disabled={disabled || transitioning} onClick={onFinish}>Finish sandbox</Button>
      <Button type="button" variant="outline" size="sm" disabled={logsBusy} onClick={() => void loadLogs()}>View logs</Button>
      {ready && preview && <Button type="button" variant="outline" size="sm" onClick={() => setEmbedded(value => !value)}>{embedded ? "Hide preview" : "Embed preview"}</Button>}
    </div>
    {ready && preview && <details className="text-sm"><summary className="cursor-pointer">Test personas</summary><div className="mt-3 flex flex-wrap gap-2">
      {(item.users ?? []).filter(user => user.enabled).map(user => <PreviewLink key={user.id} href={personaUrl(preview, user.id)}>{user.displayName} · {user.role}</PreviewLink>)}
    </div></details>}
    {error && <ErrorNotice>{error}</ErrorNotice>}
    {diagnostics && <details open className="text-sm"><summary className="cursor-pointer">Service logs · {diagnostics.state}</summary>
      {diagnostics.errorCode && <p className="text-destructive-foreground">{diagnostics.errorCode}</p>}
      {diagnostics.services.map(log => <div key={log.service} className="mt-3 flex flex-col gap-1"><p>{log.service} · {log.state}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{log.text || "No retained output."}</pre></div>)}
    </details>}
    <details className="text-sm"><summary className="cursor-pointer">Resources</summary><div className="mt-3 flex flex-col gap-2 text-xs text-muted-foreground">
      <p>{item.source.kind} · {item.users?.length ?? 0} test users</p>
      {item.metrics && <p>RAM {item.metrics.memoryBytes == null ? "unknown" : `${(item.metrics.memoryBytes / 1048576).toFixed(1)} MiB`} · Sampled peak {item.metrics.sampledPeakMemoryBytes == null ? "unknown" : `${(item.metrics.sampledPeakMemoryBytes / 1048576).toFixed(1)} MiB`}</p>}
      {item.storage && <p>Data {(item.storage.dataBytes / 1048576).toFixed(1)} MiB · Cache {(item.storage.cacheBytes / 1048576).toFixed(1)} MiB · Evidence {(item.storage.evidenceBytes / 1048576).toFixed(1)} MiB{item.storage.warning ? " · Storage near limit" : ""}</p>}
    </div></details>
    {embedded && ready && preview && <div className="flex flex-col gap-2"><p className="text-xs text-muted-foreground">Use Open preview to sign in with your Core account, then refresh this embedded view.</p>
      <iframe key={`${item.id}:${item.generation}:${item.dataRevision}`} title={`${label} preview`} src={preview} className="h-[32rem] w-full rounded border"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" />
    </div>}
  </>;
}
