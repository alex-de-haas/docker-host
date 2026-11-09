"use client";
import { APP_SESSION_ENDED, APP_ACTIVITY_RENEWED } from "@hosty-sdk/app/browser-auth";
import { openEventStream } from "./event-stream";
import { prKey, prRequest, type PrScope } from "./pull-requests-api";

type Consumer = { scope: PrScope; sync: () => Promise<void>; failed: (message: string) => void };
const groups = new Map<string, ReturnType<typeof connection>>();
export function subscribePullRequests(owner: string, consumer: Consumer) {
  let group = groups.get(owner);
  if (!group) { group = connection(() => groups.delete(owner)); groups.set(owner, group); }
  return group.add(consumer);
}
function connection(empty: () => void) {
  const consumers = new Set<Consumer>();
  let active: AbortController | undefined, debounce: ReturnType<typeof setTimeout> | undefined, retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000, loading = false, queued = false;
  let intersecting = true;
  let intersection: IntersectionObserver | undefined;
  const visible = () => intersecting && document.visibilityState !== "hidden";
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let nextRefresh = 0;
  // Observation jobs finish independently across repositories. Their hints must not turn one
  // open page into continuous snapshot reads. Keep one trailing read after the current burst.
  function scheduleRefresh() {
    if (!visible() || !consumers.size) return;
    queued = true;
    if (loading || refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = undefined; void reload(); }, Math.max(150, nextRefresh - Date.now()));
  }
  async function reload() {
    clearTimeout(refreshTimer); refreshTimer = undefined;
    if (!visible() || !consumers.size) { queued = false; return; }
    if (loading) { queued = true; return; }
    loading = true; queued = false;
    try {
      await Promise.all([...consumers].map(c => c.sync().catch(e => {
        if (consumers.has(c)) c.failed(e instanceof Error ? e.message : "PR refresh failed.");
      })));
    } finally {
      loading = false; nextRefresh = Date.now() + 5000;
      if (queued) scheduleRefresh();
    }
  }
  function stop() {
    active?.abort(); active = undefined; clearTimeout(retry); retry = undefined;
    clearTimeout(refreshTimer); refreshTimer = undefined; queued = false;
  }
  function changed() {
    stop(); clearTimeout(debounce);
    if (visible() && consumers.size) debounce = setTimeout(() => { debounce = undefined; void start(); }, 150);
  }
  async function start() {
    if (!visible() || !consumers.size || active) return;
    const controller = new AbortController(); active = controller;
    const repos = new Set<string>(), prs = new Map<string, NonNullable<PrScope["pullRequests"]>[number]>(), workspaces = new Set<string>();
    let allInstalled = false;
    for (const c of consumers) {
      allInstalled ||= !!c.scope.allInstalled;
      c.scope.repositories?.forEach(id => repos.add(id)); c.scope.pullRequests?.forEach(pr => prs.set(prKey(pr), pr));
      c.scope.workspaces?.forEach(id => workspaces.add(id));
    }
    let cleanEnd = false, watchdog: ReturnType<typeof setTimeout> | undefined;
    const touch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), 45_000); };
    try {
      const scope = { allInstalled, repositories: [...repos], pullRequests: [...prs.values()], workspaces: [...workspaces] };
      const ticket = await prRequest<{ id: string }>("/subscriptions", scope, controller.signal);
      const response = await openEventStream(`/api/pull-requests/events?subscriptionId=${ticket.id}`, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error("PR updates disconnected. Reconnecting…");
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
      touch();
      try {
        while (!controller.signal.aborted) {
          const part = await reader.read();
          if (part.done) { cleanEnd = true; break; }
          touch(); buffer += decoder.decode(part.value, { stream: true }).replaceAll("\r\n", "\n");
          if (buffer.length > 1_048_576) throw new Error("PR updates exceeded the buffer limit.");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (/event: stream\.revoked/.test(frame)) { await reload(); throw new Error("PR access changed. Sign in again."); }
            if (/event: stream\.ready/.test(frame)) { delay = 1000; void reload(); }
            else if (/event: pull-requests\.changed/.test(frame)) { delay = 1000; scheduleRefresh(); }
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) {
      if (active === controller) for (const c of consumers) c.failed(error instanceof Error ? error.message : "PR updates disconnected.");
    } finally {
      clearTimeout(watchdog);
      if (active === controller) {
        active = undefined;
        if (visible() && consumers.size) {
          retry = setTimeout(() => { retry = undefined; void start(); }, cleanEnd ? 0 : delay);
          if (!cleanEnd) delay = Math.min(30_000, delay * 2);
        }
      }
    }
  }
  // stream.ready reconciles after scope/visibility changes; an extra pre-connect read duplicates it.
  const visibility = () => changed();
  const ended = () => { stop(); for (const c of consumers) c.failed("PR access changed. Sign in again."); };
  return { add(consumer: Consumer) {
    if (!consumers.size) {
      document.addEventListener("visibilitychange", visibility);
      window.addEventListener(APP_SESSION_ENDED, ended); window.addEventListener(APP_ACTIVITY_RENEWED, visibility);
      if (typeof IntersectionObserver !== "undefined") {
        intersection = new IntersectionObserver(entries => { const next = entries.some(e => e.isIntersecting); if (next !== intersecting) { intersecting = next; visibility(); } });
        intersection.observe(document.documentElement);
      }
    }
    consumers.add(consumer); changed();
    return () => {
      if (!consumers.delete(consumer)) return;
      changed();
      if (!consumers.size) { clearTimeout(debounce); stop(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener(APP_SESSION_ENDED, ended); window.removeEventListener(APP_ACTIVITY_RENEWED, visibility); intersection?.disconnect(); empty(); }
    };
  } };
}
