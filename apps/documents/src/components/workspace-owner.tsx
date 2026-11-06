"use client";

import { ExternalLinkIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Workspace } from "@/lib/types";

export function WorkspaceOwner({ workspace }: { workspace: Workspace }) {
  if (workspace.ownerKind !== "external") return null;
  return (
    <Badge variant="outline">{`External / ${workspace.ownerLabel?.trim() || "Agent"}`}</Badge>
  );
}

export function WorkspaceSessionLink({
  workspace,
  button = false,
}: {
  workspace: Workspace;
  button?: boolean;
}) {
  if (workspace.ownerKind === "external")
    return (
      <span className="text-xs text-muted-foreground">
        Conversation stays in the external agent.
      </span>
    );
  if (!workspace.sessionUrl)
    return (
      <span className="text-xs text-muted-foreground">
        Session link unavailable:{" "}
        {workspace.sessionUrlError ??
          "the assistant installation is unavailable"}
        .
      </span>
    );
  const link = (
    <a
      className={
        button
          ? undefined
          : "underline underline-offset-4 focus-visible:outline-ring"
      }
      href={workspace.sessionUrl}
      target="_blank"
      rel="noopener noreferrer"
    >
      Open assistant session
      {button && <ExternalLinkIcon data-icon="inline-end" />}
    </a>
  );
  return button ? (
    <Button variant="outline" size="sm" asChild>
      {link}
    </Button>
  ) : (
    link
  );
}

export function WorkspacePullRequests({ workspace }: { workspace: Workspace }) {
  if (!workspace.pullRequests.length)
    return (
      <p className="text-xs text-muted-foreground">
        No pull request recorded for this workspace.
      </p>
    );
  return (
    <section aria-label="Workspace pull requests" className="space-y-3 text-xs">
      {workspace.pullRequests.map((url) => {
        const detail = workspace.pullRequestDetails?.find(
          (item) => item.url === url,
        );
        const observed = detail?.observation;
        const published = observed?.head ?? detail?.publishedHead;
        const differs =
          workspace.hasLocalChanges ||
          !!(workspace.head && published && workspace.head !== published);
        return (
          <div key={url} className="space-y-2 rounded-md border p-3">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium underline underline-offset-4"
            >
              {observed?.title || `Pull request ${url.split("/").at(-1)}`}
            </a>
            <p>
              {observed
                ? `${observed.draft ? "Draft · " : ""}${observed.state}`
                : "State unavailable"}{" "}
              · related through this workspace
            </p>
            <p className="text-muted-foreground">
              {differs
                ? "Local work differs from the published head. Local deliverables may not be in this PR."
                : published && workspace.head
                  ? "Workspace and observed published heads match."
                  : "Published-head comparison unavailable."}
            </p>
            <details>
              <summary className="cursor-pointer">
                CI and review observations
              </summary>
              <div className="mt-2 space-y-2 text-muted-foreground">
                <p>
                  {detail?.unavailable ||
                    observed?.error ||
                    (observed
                      ? `Observed ${new Date(observed.at).toLocaleString()}`
                      : "Core has no observation for this PR yet.")}
                </p>
                {observed && (
                  <>
                    <p>
                      Review: {observed.reviewDecision || "unknown"} ·{" "}
                      {observed.unresolvedThreads} unresolved threads
                    </p>
                    <p>
                      Observation {observed.complete ? "complete" : "partial"};
                      CI is separate from merge state.
                    </p>
                    {observed.checks?.map((check, index) => (
                      <p key={index}>
                        {check.name}: {check.state}
                      </p>
                    ))}
                  </>
                )}
              </div>
            </details>
          </div>
        );
      })}
    </section>
  );
}
