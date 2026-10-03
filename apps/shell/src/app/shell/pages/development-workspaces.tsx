"use client";

import { SourceToolsLink } from "../source/source-changes";

export function DevelopmentWorkspaces() {
  return <section aria-label="Development workspaces" className="space-y-2 rounded-lg border p-4">
    <h2 className="font-medium">Development workspaces</h2>
    <SourceToolsLink context="development workspaces" />
  </section>;
}
