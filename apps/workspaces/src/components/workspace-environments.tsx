"use client";
import { useMemo } from "react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { CoreEnvironmentPanel, type EnvironmentRequest } from "@hosty-sdk/app/sandbox/react";
import type { Workspace } from "@/lib/types";
import { repositoryName } from "@/lib/model";
const request: EnvironmentRequest = async (path, body, signal) => {
  const response = await appFetch(`/api/environments${path}`, { method: body ? "POST" : "GET", cache: "no-store", signal,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message ?? "Sandbox request failed."), { status: response.status });
  return data;
};
export function WorkspaceEnvironments({ workspace }: { workspace: Workspace }) {
  const selected = useMemo(() => ({ id: workspace.id, worktrees: workspace.worktrees.map(t => ({ id: t.id, label: `${repositoryName(t.repository)} · ${t.branch}`, state: t.state })) }), [workspace]);
  return <CoreEnvironmentPanel request={request} storageKey={`hosty:workspace-environment:${workspace.id}`} workspace={selected} />;
}
