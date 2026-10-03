"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import type { DemoAuthSnapshot } from "@/lib/host-auth";

const AuthContext = createContext<DemoAuthSnapshot | null>(null);

export function DemoResource<T>({ path, children }: { path: string; children: (value: T) => ReactNode }) {
  const [state, setState] = useState<{ value?: T; error?: string }>({});
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void appFetch(path, { cache: "no-store", signal: controller.signal }).then(async response => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error?.message ?? value.appSession?.error?.message ?? "Could not load app data.");
      if (!controller.signal.aborted) setState({ value });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : "Could not load app data." });
    });
    return () => controller.abort();
  }, [path, attempt]);
  if (state.error) return <div role="alert" className="p-4">{state.error} <button type="button"
    onClick={() => { setState({}); setAttempt(value => value + 1); }}>Retry</button></div>;
  if (!state.value) return <p role="status" className="p-4">Loading app data…</p>;
  return children(state.value);
}

export function DemoSession({ children }: { children: ReactNode }) {
  return <DemoResource<DemoAuthSnapshot> path="/api/auth/identity">{auth =>
    <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>
  }</DemoResource>;
}

export function useDemoAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("DemoSession must wrap authenticated app content.");
  return auth;
}
