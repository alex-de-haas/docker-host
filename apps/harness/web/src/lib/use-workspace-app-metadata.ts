"use client";
import { useEffect, useState } from "react";
import { APP_SESSION_RESTORED } from "@hosty-sdk/app/browser-auth";
import { selectedContextApps, type ContextApp } from "./assistant-api";
import type { Worktree } from "./development-api";

/** Workspace apps exist independently of a user's accessible conversations. */
export function useWorkspaceAppMetadata(workspaceId: string, trees: readonly Worktree[], seed: readonly ContextApp[], refresh: number) {
  const ids = [...new Set(trees.flatMap(tree => tree.apps.map(app => app.appId)))].sort();
  const missing = ids.filter(id => !seed.some(app => app.id === id && (app.icon || app.iconUrl)));
  const selection = JSON.stringify([workspaceId, missing]);
  const [resolved, setResolved] = useState<{ selection: string; apps: ContextApp[] } | null>(null);
  useEffect(() => {
    const [, requestedIds] = JSON.parse(selection) as [string, string[]];
    if (!requestedIds.length) return;
    let request: AbortController | undefined;
    const read = () => {
      request?.abort();
      const abort = new AbortController(); request = abort;
      // The selection endpoint accepts at most 16 IDs; a workspace can bind more applications.
      const batches = Array.from({ length: Math.ceil(requestedIds.length / 16) }, (_, i) => requestedIds.slice(i * 16, i * 16 + 16));
      void Promise.all(batches.map(batch => selectedContextApps(batch, abort.signal))).then(apps => {
        if (!abort.signal.aborted) setResolved({ selection, apps: apps.flat() });
      }).catch(() => {
        if (!abort.signal.aborted) setResolved({ selection, apps: [] });
      });
    };
    read();
    window.addEventListener(APP_SESSION_RESTORED, read);
    return () => { request?.abort(); window.removeEventListener(APP_SESSION_RESTORED, read); };
  }, [selection, refresh]);
  const found = resolved?.selection === selection ? resolved.apps : [];
  return ids.map(id => seed.find(app => app.id === id && (app.icon || app.iconUrl)) ?? found.find(app => app.id === id) ?? seed.find(app => app.id === id)).filter((app): app is ContextApp => !!app);
}
