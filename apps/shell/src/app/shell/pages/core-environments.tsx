"use client";
import { useCallback } from "react";
import { CoreEnvironmentPanel, type EnvironmentRequest } from "@hosty-sdk/app/sandbox/react";
import { fetchCore } from "../core-transport.js";
import { useShellActions } from "../shell-context";
export function CoreEnvironments({ coreOrigin }: { coreOrigin: string }) {
  const { sendCsrfJson } = useShellActions();
  const request = useCallback<EnvironmentRequest>(async (path, body, signal) => {
    const url = `${coreOrigin}/api/core-environments${path}`;
    const response = body ? await sendCsrfJson(url, body) : await fetchCore(url, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message ?? "Sandbox request failed."), { status: response.status });
    return data;
  }, [coreOrigin, sendCsrfJson]);
  return <CoreEnvironmentPanel request={request} storageKey={`hosty:core-environment:${coreOrigin}`} />;
}
