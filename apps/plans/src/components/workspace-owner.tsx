"use client";

import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Workspace } from "@/lib/types";

export function WorkspaceOwner({ workspace }: { workspace: Workspace }) {
  if (workspace.ownerKind !== "external") return null;
  return <Badge variant="outline">{`External / ${workspace.ownerLabel?.trim() || "Agent"}`}</Badge>;
}

export function WorkspaceSessionLink({ workspace, button = false }: { workspace: Workspace; button?: boolean }) {
  if (workspace.ownerKind === "external") return <span className="text-xs text-muted-foreground">Conversation stays in the external agent.</span>;
  if (!workspace.sessionUrl) return <span className="text-xs text-muted-foreground">Session link unavailable: {workspace.sessionUrlError ?? "the assistant installation is unavailable"}.</span>;
  const link = <a className={button ? undefined : "underline underline-offset-4 focus-visible:outline-ring"} href={workspace.sessionUrl} target="_blank" rel="noopener noreferrer">Open assistant session{button && <ExternalLinkIcon data-icon="inline-end" />}</a>;
  return button ? <Button variant="outline" size="sm" asChild>{link}</Button> : link;
}
