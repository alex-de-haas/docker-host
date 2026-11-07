"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCore } from "../core-transport.js";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import type { ShellActionsContextValue } from "../shell-context";
import type { StorageState } from "./storage-data";

// A scan is a finite operation. Observe it briefly; idle pages never sample the disk or poll Core.
const OBSERVATION_LIMIT = 60;
const OBSERVATION_INTERVAL_MS = 2000;
type RecountRequest = { coreOrigin: string; requestId: string };

export function useStorage(coreOrigin: string, sendCsrfJson: ShellActionsContextValue["sendCsrfJson"]) {
  const [state, setState] = useState<StorageState>({ snapshot: null, isScanning: false, lastError: null });
  const [loading, setLoading] = useState(true);
  const [activeRecount, setActiveRecount] = useState<RecountRequest | null>(null);
  const [retryRecountOrigin, setRetryRecountOrigin] = useState<string | null>(null);
  const refreshing = activeRecount?.coreOrigin === coreOrigin;
  const retryRecount = retryRecountOrigin === coreOrigin;
  const [error, setError] = useState<string | null>(null);
  const [observationPaused, setObservationPaused] = useState(false);
  const scanReads = useRef(0);
  const requestIds = useRef(new Map<string, string>());
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const apply = useCallback((next: StorageState) => {
    setState(next);
    setError(null);
    if (!next.isScanning) { scanReads.current = 0; setObservationPaused(false); }
  }, []);

  const read = useCallback((signal?: AbortSignal) =>
    fetchCore(`${coreOrigin}/api/storage`, { credentials: "include", signal }).then(async response => {
      signal?.throwIfAborted();
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (response.status === 404) throw new Error("Storage reporting is not available in this Core version.");
      if (!response.ok) throw new Error(await readCoreError(response));
      return response.json() as Promise<StorageState>;
    }).then(next => {
      if (mounted.current && !signal?.aborted) apply(next);
    }).catch((cause: unknown) => {
      if (mounted.current && !signal?.aborted && !isAuthRequiredRedirectError(cause)) {
        setError(cause instanceof Error ? cause.message : "Could not load storage usage.");
        setObservationPaused(true);
      }
    }).finally(() => {
      if (mounted.current && !signal?.aborted) setLoading(false);
    }), [coreOrigin, apply]);

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    controller.current = abort;
    void read(abort.signal);
    return () => { mounted.current = false; abort.abort(); };
  }, [read]);

  useEffect(() => {
    if (!state.isScanning || observationPaused) return;
    const signal = controller.current?.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (document.visibilityState === "hidden") return;
      if (scanReads.current >= OBSERVATION_LIMIT) { setObservationPaused(true); return; }
      timer = setTimeout(() => {
        if (signal?.aborted) return;
        scanReads.current++;
        void read(signal);
      }, OBSERVATION_INTERVAL_MS);
    };
    const onVisibility = () => { clearTimeout(timer); schedule(); };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [state, observationPaused, read]);

  const checkStatus = useCallback(async () => {
    scanReads.current = 0;
    setObservationPaused(false);
    await read(controller.current?.signal);
  }, [read]);

  const recount = useCallback(async () => {
    if (refreshing) return;
    const signal = controller.current?.signal;
    setError(null);
    // An uncertain response retries the original operation instead of scheduling another scan.
    const requestId = requestIds.current.get(coreOrigin) ?? crypto.randomUUID();
    requestIds.current.set(coreOrigin, requestId);
    const operation = { coreOrigin, requestId };
    setActiveRecount(operation);
    try {
      const response = await sendCsrfJson(`${coreOrigin}/api/storage/refresh`, { requestId }, "POST", signal);
      signal?.throwIfAborted();
      if (!response.ok) throw new Error(await readCoreError(response));
      const next = await response.json() as StorageState;
      if (mounted.current && !signal?.aborted) {
        requestIds.current.delete(coreOrigin);
        setRetryRecountOrigin(null);
        scanReads.current = 0;
        setObservationPaused(false);
        apply(next);
      }
    } catch (cause) {
      if (mounted.current && !signal?.aborted && !isAuthRequiredRedirectError(cause)) {
        setRetryRecountOrigin(coreOrigin);
        setError(cause instanceof Error ? cause.message : "Could not start the storage recount.");
      }
    } finally {
      if (mounted.current) setActiveRecount(current => current === operation ? null : current);
    }
  }, [refreshing, sendCsrfJson, coreOrigin, apply]);

  return { ...state, loading, refreshing, error, observationPaused, retryRecount, recount, checkStatus };
}
