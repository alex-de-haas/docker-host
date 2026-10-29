"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { CircleAlert, Ellipsis, ExternalLink } from "lucide-react";
import type { CoreEnvironment } from "@hosty-sdk/app/sandbox/server";
import type { EnvironmentApps } from "@hosty-sdk/app/sandbox/react";
import { Button } from "@/components/ui/button";
import { OperationStatus, StatusBadge } from "../ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Frame, FramePanel } from "@/components/reui/frame";
import { useConfirmation } from "@/components/reui/confirmation";
import { toast } from "@/components/reui/operation-toast";
import { watchSandboxEvents } from "../events/sandbox-events";
import { fetchCore } from "../core-transport.js";
import { CoreRequestError, readCoreErrorDetail } from "../core-api";
import { useShellActions } from "../shell-context";
import { ResourceUsage } from "../resources/resource-usage";
import { HostyMark } from "../../../../../../shared/web/hosty-mark";
import { EnvironmentSetupDialog, initializationProblem, initializationSummary, useEnvironmentInitialization } from "./environment-initialization";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { HostyLoader } from "../../../../../../shared/web/hosty-states";
import { CreateEnvironmentDialog } from "./create-environment-dialog";
import type { ActivationWorkspace } from "../workspace-sources";

type CorePending = { path: string; body: Record<string, unknown>; id?: string; kind: string };
type Inventory<T> = { loaded: boolean; loading: boolean; items: T[]; error: string };
type Feedback = { id?: string; message: string; failed?: boolean };
type Request = <T>(path: string, body: unknown) => Promise<T>;
const empty = <T,>(): Inventory<T> => ({ loaded: false, loading: true, items: [], error: "" });
const message = (cause: unknown) => cause instanceof Error ? cause.message : "The sandbox request could not be confirmed.";
const normalizeId = (value: string) => value.replaceAll("-", "");

function safeUrl(value?: string): string | undefined {
  try {
    const url = new URL(value ?? "");
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* A missing or unsafe destination has no link. */ }
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

export function DashboardSandboxes(props: { coreOrigin: string; connectedCore: ReactNode; workspaces: ActivationWorkspace[] }) {
  // Inventory, pending receipts and app setup drafts never cross Core instances.
  return <SandboxInventory key={props.coreOrigin} {...props} />;
}

function SandboxInventory({ coreOrigin, connectedCore, workspaces }: { coreOrigin: string; connectedCore: ReactNode; workspaces: ActivationWorkspace[] }) {
  const { sendCsrfJson } = useShellActions();
  const { confirm, dialog } = useConfirmation(coreOrigin);
  const [cores, setCores] = useState<Inventory<CoreEnvironment>>(empty);
  const [corePending, setCorePending] = useState<CorePending | null>(null);
  const corePendingRef = useRef<CorePending | null>(null);
  const [coreBusy, setCoreBusy] = useState(false);
  const coreBusyRef = useRef(false);
  const [coreFeedback, setCoreFeedback] = useState<Feedback | null>(null);
  const [pollVersion, setPollVersion] = useState(0);
  const alive = useRef(false), readEpoch = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const coreKey = `hosty:core-environment:${coreOrigin}`;
  const refresh = useCallback(() => refreshRef.current(), []);
  const saveCorePending = useCallback((value: CorePending | null) => {
    if (value) sessionStorage.setItem(coreKey, JSON.stringify(value));
    else { try { sessionStorage.removeItem(coreKey); } catch { /* The retained receipt is still safe to read. */ } }
    corePendingRef.current = value; if (alive.current) setCorePending(value);
  }, [coreKey]);
  const observeCore = useCallback((item: CoreEnvironment) => {
    const saved = corePendingRef.current;
    if (!saved?.id || saved.id !== item.id) return;
    const operation = item.operations?.find(op => normalizeId(op.id) === normalizeId(String(saved.body.requestId)));
    if (!operation || !["succeeded", "failed"].includes(operation.state)) return;
    const superseded = operation !== item.operations.at(-1);
    if (operation.state === "succeeded" || saved.kind !== "finish" || superseded) saveCorePending(null);
    setCoreFeedback(operation.state === "failed" ? { id: item.id, message: item.error || operation.message || "Sandbox operation failed.", failed: true } : null);
    if (saved.kind === "finish" && operation.state === "succeeded" && item.state === "finished") {
      toast.success(item.label ? `Sandbox "${item.label}" deleted` : "Sandbox deleted");
    }
  }, [saveCorePending]);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    let pending: Promise<void> | null = null, reread = false, streamGeneration = 0;
    const current = () => !controller.signal.aborted;
    const load = (): Promise<void> => {
      if (!current()) return Promise.resolve();
      if (pending) { reread = true; return pending; }
      setCores(previous => ({ ...previous, loading: true }));
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
      void load();
    });
    const stopEvents = watchSandboxEvents(coreOrigin, load, data => {
      if (!current()) return;
      streamGeneration++;
      if (data.environments) {
        setCores({ loaded: true, loading: false, items: data.environments, error: "" });
        for (const item of data.environments) observeCore(item);
      } else setCores(previous => ({ ...previous, loading: false, error: data.coreError || "Core sandbox inventory is unavailable." }));
    });
    return () => {
      alive.current = false; controller.abort(); stopEvents();
      if (refreshRef.current === load) refreshRef.current = async () => {};
    };
  }, [coreOrigin, coreKey, observeCore]);

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
        const created = result;
        if (alive.current) setCores(previous => ({ ...previous, loaded: true, items: [...previous.items.filter(item => item.id !== created.id), created] }));
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

  const survivingCores = cores.items.filter(item => item.state !== "finished");
  const workspaceById = new Map(workspaces.map(workspace => [workspace.id, workspace]));
  const coreDisabled = coreBusy || corePending !== null;
  const pendingEnvironment = corePending && cores.items.find(item => corePending.id ? item.id === corePending.id
    : item.operations?.some(operation => normalizeId(operation.id) === normalizeId(String(corePending.body.requestId))));
  const pendingNotice = corePending && <PendingNotice kind={corePending.kind} busy={coreBusy} onRetry={() => void runCore(corePending)} />;
  return <section aria-label="Core instances" className="space-y-3">
      <div className="flex justify-end">
        <CreateEnvironmentDialog origin={coreOrigin} disabled={coreDisabled} onCreate={body => { void runCore({ path: "", body, kind: "create" }); }} />
      </div>
    <Frame><FramePanel className="min-w-0 p-0">
      {connectedCore}
      {!cores.loaded && cores.loading && <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><HostyLoader label={null} className="size-5 shrink-0" />Loading environments…</p>}
      {cores.error && <ErrorNotice>{cores.error}<Button variant="outline" size="sm" onClick={() => void refresh()}>Retry environments</Button></ErrorNotice>}
      {coreFeedback && <FeedbackNotice value={coreFeedback} />}
      {corePending && !pendingEnvironment && <SandboxRow rowKey="pending"
        label={String(corePending.body.label || "Environment")} state="pending" workspace="" details={false}
        progress={pendingNotice}>{null}</SandboxRow>}
      {survivingCores.map(item => <CoreSandboxRow key={`core:${item.id}`} item={item} origin={coreOrigin} pollVersion={pollVersion}
        disabled={coreDisabled} request={coreRequest} workspace={item.mode === "source" ? workspaceName(item.context?.workspaceId, workspaceById) : item.coreVersion || "Version unavailable"}
        error={item.error || (coreFeedback?.id === item.id && coreFeedback.failed ? coreFeedback.message : undefined)}
        progress={pendingEnvironment?.id === item.id ? pendingNotice : undefined}
        onRefresh={refresh} onCommand={kind => void runCore({ path: `/${item.id}/operations/${kind}`, body: { requestId: crypto.randomUUID(), expectedRevision: item.revision }, id: item.id, kind })}
        onFinish={() => void finishCore(item)} onRevoke={() => void auxiliaryCore(`/${item.id}/consent/revoke`, {})} />)}
    </FramePanel></Frame>
    {dialog}
  </section>;
}

function ErrorNotice({ children }: { children: ReactNode }) {
  return <Alert variant="destructive" className="m-3 w-auto"><AlertDescription>{children}</AlertDescription></Alert>;
}
function FeedbackNotice({ value }: { value: Feedback }) {
  return value.failed ? <ErrorNotice>{value.message}</ErrorNotice> : <p role="status" className="px-3 py-2 text-sm text-muted-foreground">{value.message}</p>;
}
function PendingNotice({ kind, busy, onRetry }: { kind: string; busy: boolean; onRetry: () => void }) {
  const label = ({ create: "Creating", start: "Starting", stop: "Stopping", restart: "Restarting", finish: "Deleting" } as Record<string, string>)[kind] || "Updating";
  return <div className="flex flex-col items-start gap-2">
    <OperationStatus tone={busy ? "working" : "attention"}>{busy ? `${label}…` : "Needs confirmation"}</OperationStatus>
    {!busy && <Button type="button" variant="outline" size="sm" onClick={onRetry}>Retry same request</Button>}
  </div>;
}
function SandboxRow({ rowKey, label, state, workspace, error, children, actions, resources, progress, details = true, open: controlledOpen, onOpenChange }: {
  rowKey: string; label: string; state: string; workspace: string; error?: string; children: ReactNode;
  actions?: ReactNode; resources?: ReactNode; progress?: ReactNode; details?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const showDetails = onOpenChange ?? setOpen;
  return <Dialog open={open} onOpenChange={showDetails}>
    <article data-sandbox-key={rowKey} aria-label={`Environment ${label}`} className="border-t">
      <div className="dashboard-sandbox-row">
      <div className="flex min-w-0 items-center gap-3 px-3 py-3">
        <HostyMark tile className="dashboard-app-icon size-10 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
          <div className="flex max-w-full items-center gap-2">
            {details ? <DialogTrigger asChild><Button type="button" variant="ghost" className="h-auto min-w-0 justify-start rounded-none p-0 hover:bg-transparent hover:text-inherit dark:hover:bg-transparent"
              aria-label={`Environment Details for ${label}`}><span className="truncate">{label}</span></Button></DialogTrigger> : <span className="truncate text-sm font-medium">{label}</span>}
            {error && <TooltipProvider><Tooltip><TooltipTrigger asChild>
              <span role="img" aria-label={`Problem with ${label}`} tabIndex={0}
                className="inline-flex shrink-0 rounded outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-brand">
                <CircleAlert className="size-4 text-destructive-foreground" aria-hidden="true" />
              </span>
            </TooltipTrigger><TooltipContent className="max-w-[min(24rem,calc(100vw-2rem))] whitespace-pre-line break-words text-left" sideOffset={4}>{error}</TooltipContent></Tooltip></TooltipProvider>}
          </div>
          <span className="max-w-full truncate font-mono text-xs text-muted-foreground">{workspace}</span>
        </div>
      </div>
      <div className="dashboard-sandbox-status flex min-w-0 flex-col items-start gap-1 px-3 py-3"><StatusBadge value={state} />{progress}</div>
      <div className="dashboard-sandbox-resources min-w-0 px-3 py-3">{resources}</div>
      {actions && <div className="dashboard-sandbox-actions">{actions}</div>}
      </div>
    </article>
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader><DialogTitle>Environment Details</DialogTitle><DialogDescription>{label} · {workspace}</DialogDescription></DialogHeader>
      <DialogBody className="flex flex-col gap-4">{error && <ErrorNotice>{error}</ErrorNotice>}{children}</DialogBody>
      <DialogFooter><Button type="button" variant="outline" onClick={() => showDetails(false)}>Close</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function PreviewLink({ href, children }: { href?: string; children: ReactNode }) {
  const safe = safeUrl(href);
  return safe ? <Button asChild variant="outline" size="sm"><a href={safe} target="_blank" rel="noreferrer">{children}<ExternalLink data-icon="inline-end" /></a></Button> : null;
}
function CoreSandboxRow({ item, origin, pollVersion, disabled, request, workspace, error, progress, onRefresh, onCommand, onFinish, onRevoke }: {
  item: CoreEnvironment; origin: string; pollVersion: number; disabled: boolean; request: Request; workspace: string; error?: string;
  progress?: ReactNode;
  onRefresh: () => Promise<void>; onCommand: (kind: string) => void; onFinish: () => void; onRevoke: () => void;
}) {
  const [open, setOpen] = useState(false), [legacyState, setLegacyState] = useState<string | null>(null);
  const initialization = useEnvironmentInitialization({ item, origin, pollVersion, request });
  const running = item.state === "running";
  const transitional = ["building", "starting", "stopping", "finishing"].includes(item.state);
  const canStart = ["stopped", "failed", "quota-exceeded"].includes(item.state);
  const needsSetup = initialization.canSetup || running && !item.initializationRequested && legacyState === "setup-required";
  const hasAdministrator = item.initializationRequested ? initialization.status?.hasAdministrator && !initialization.error : ["ready", "sign-in-required"].includes(legacyState || "");
  const login = running && hasAdministrator ? safeUrl(item.previewUrl) : undefined;
  const blocked = disabled || initialization.busy;
  const problem = error || initialization.error || initializationProblem(initialization.status);
  const summary = !problem && running && item.initializationRequested ? initializationSummary(initialization.status) : undefined;
  const setup = () => { if (item.initializationRequested) void initialization.setupAdministrator(); else setOpen(true); };
  const actions = <div className="flex shrink-0 items-center gap-1">
    {needsSetup ? <Button type="button" size="sm" disabled={blocked} onClick={setup}>Sign Up</Button>
      : running ? <Button type="button" variant="outline" size="sm" disabled={blocked} onClick={() => onCommand("stop")}>Stop</Button>
      : canStart ? <Button type="button" variant="outline" size="sm" disabled={blocked} onClick={() => onCommand("start")}>Start</Button>
      : item.state === "cleanup-failed" ? <Button type="button" variant="outline" size="sm" disabled={blocked} onClick={onFinish}>Retry deletion</Button> : null}
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button type="button" size="icon-sm" variant="ghost" aria-label={`More actions for ${item.label || "Core sandbox"}`}><Ellipsis /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => setOpen(true)}>Environment Details</DropdownMenuItem>
          {login && <DropdownMenuItem asChild><a href={new URL("/login", login).href} target="_blank" rel="noreferrer"><ExternalLink />Open Core</a></DropdownMenuItem>}
          {running && needsSetup && <DropdownMenuItem disabled={blocked} onSelect={() => onCommand("stop")}>Stop</DropdownMenuItem>}
          {running && <DropdownMenuItem disabled={blocked} onSelect={() => onCommand("restart")}>Restart</DropdownMenuItem>}
          {initialization.canResume && <DropdownMenuItem disabled={blocked} onSelect={() => void initialization.resume()}>Resume initialization</DropdownMenuItem>}
          {running && item.initializationRequested && <DropdownMenuItem onSelect={initialization.refresh}>Refresh setup status</DropdownMenuItem>}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup><DropdownMenuItem variant="destructive" disabled={blocked || transitional} onSelect={onFinish}>{item.state === "cleanup-failed" ? "Retry deletion" : "Delete sandbox"}</DropdownMenuItem></DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
  return <>
    <SandboxRow rowKey={`core:${item.id}`} label={item.label || "Core environment"} state={item.state} workspace={workspace}
      open={open} onOpenChange={setOpen} actions={actions} error={problem}
      progress={progress || (summary && <OperationStatus tone={initialization.status?.recoveryRequired || initialization.canSetup ? "attention" : "working"}>{summary}</OperationStatus>)}
      resources={running ? <ResourceUsage appId={`core-environment:${item.id}`} label={item.label} /> : <span className="px-1.5 text-muted-foreground" aria-label="Resources unavailable">—</span>}>
      <CoreSandboxDetails item={item} origin={origin} pollVersion={pollVersion} disabled={blocked} request={request}
        onRefresh={onRefresh} onRevoke={onRevoke} onInventory={setLegacyState} />
    </SandboxRow>
    <EnvironmentSetupDialog initialization={initialization} />
  </>;
}

function CoreSandboxDetails({ item, origin, pollVersion, disabled, request, onRefresh, onRevoke, onInventory }: {
  item: CoreEnvironment; origin: string; pollVersion: number; disabled: boolean; request: Request; onRefresh: () => Promise<void>;
  onRevoke: () => void; onInventory: (state: string) => void;
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
      if (!controller.signal.aborted && current === sequence.current) { setInventory(value); setError(""); onInventory(value.state); }
    }).catch(cause => { if (!controller.signal.aborted && current === sequence.current) setError(message(cause)); });
    return () => controller.abort();
  }, [origin, item.id, item.state, pollVersion, detailVersion, onInventory]);
  return <>
    <h3 className="font-medium">Applications</h3>
    {item.state === "running" ? <>
      {error && <ErrorNotice>Application status: {error}</ErrorNotice>}
      {!inventory ? <p role="status" className="text-sm text-muted-foreground">Reading application status…</p>
        : inventory.state === "ready" ? <ul aria-label="Environment applications" className="divide-y">{inventory.apps.map(app => <li key={app.id} className="dashboard-environment-app flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
          <div><span className="font-medium">{app.displayName}</span><span className="ml-2 text-muted-foreground">{app.runtimeState} · {app.health || "Health unknown"}</span></div>
          {app.runtimeState === "running" && <PreviewLink href={app.previewUrl}>Open preview<span className="sr-only"> for {app.displayName}</span></PreviewLink>}
        </li>)}{!inventory.apps.length && <li className="py-2 text-sm text-muted-foreground">No apps installed in this environment yet.</li>}</ul>
          : <p role="status" className="text-sm text-muted-foreground">{inventory.error || (inventory.state === "setup-required" ? "Set up a test administrator for this Core." : "Connect the sandbox's test account to read its apps.")}</p>}
      {!item.initializationRequested && inventory && ["setup-required", "sign-in-required"].includes(inventory.state) && <SandboxAccount request={request} id={item.id} disabled={disabled} onDone={onRefresh} />}
    </> : <p className="text-sm text-muted-foreground">Application links are available while this sandbox is running.</p>}
    <section className="text-sm"><h3 className="font-medium">Resources and access</h3><div className="mt-3 flex flex-col gap-3">
      <p className="text-muted-foreground">{item.mode === "source" ? "Core built from workspace source" : item.mode === "release" ? "Installed Core release" : "Current Core build"}</p>
      {item.limits && <p>Reserved: {(item.limits.memoryBytes / 1073741824).toFixed(1)} GiB memory · {item.limits.cpus} CPUs · {item.limits.pids} PIDs · {(item.limits.diskBytes / 1073741824).toFixed(1)} GiB disk.</p>}
      {item.usage && <p>{item.usage.state === "unknown" ? "Resource usage unavailable; the reservation remains active." : `Observed: ${(item.usage.containerMemoryBytes / 1048576).toFixed(0)} MiB containers · ${(item.usage.coreMemoryBytes / 1048576).toFixed(0)} MiB Core · ${(item.usage.ownedDiskBytes / 1073741824).toFixed(2)} GiB owned data.`}</p>}
      {item.access && <><p>{item.access.state === "operator" ? "Operator launch" : item.access.state === "active" ? item.access.saved ? "Saved launch permission" : "Permission for this run" : item.access.state === "target-changed" ? "Core target changed; review launch permission" : "Launch permission revoked or unavailable"}</p><p className="text-muted-foreground">{item.access.description}</p>
        {item.access.grantId && ["active", "target-changed"].includes(item.access.state) && <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onRevoke}>Revoke launch permission</Button>}</>}
    </div></section>
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
