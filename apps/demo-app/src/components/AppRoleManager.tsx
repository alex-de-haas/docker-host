"use client";

import { useMemo, useState } from "react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DemoAlert, DemoEmpty } from "./DemoFeedback";
import { HostyLoader } from "../../../../shared/web/hosty-states";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import type { DemoRoleManagementSnapshot } from "@/lib/app-role-management";
import type { DemoAppRole } from "@/lib/app-roles";
import { StateBadge } from "./DemoAppUi";

type DraftRoles = Record<string, DemoAppRole | "">;

export function AppRoleManager({
  initialSnapshot,
}: {
  initialSnapshot: DemoRoleManagementSnapshot;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [drafts, setDrafts] = useState<DraftRoles>(() => createDrafts(initialSnapshot));
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const roleOptions = useMemo(() => snapshot.roles, [snapshot.roles]);

  async function updateRole(userId: string, overrideRole?: DemoAppRole | "") {
    const role = overrideRole ?? drafts[userId] ?? "";
    const previousAssignments = createDrafts(snapshot);
    setPendingUserId(userId);
    setMessage(null);

    try {
      const response = await appFetch(`/api/roles/${encodeURIComponent(userId)}`, {
        method: role ? "PUT" : "DELETE",
        headers: role ? { "Content-Type": "application/json" } : undefined,
        body: role ? JSON.stringify({ role }) : undefined,
      });
      const payload = await response.json() as RoleMutationResponse;

      if (!response.ok || !payload.snapshot) {
        throw new Error(payload.error?.message || "Role update failed.");
      }

      setSnapshot(payload.snapshot);
      // Preserve edits only; clean rows adopt authoritative concurrent changes.
      const nextDrafts = createDrafts(payload.snapshot);
      setDrafts(previous => Object.fromEntries(Object.entries(nextDrafts).map(([id, next]) => [
        id, id !== userId && previous[id] !== undefined && previous[id] !== previousAssignments[id]
          ? previous[id] : next,
      ])));
      setMessage({ tone: "success", text: "App role assignment saved." });
    } catch (error) {
      setMessage({
        tone: "danger",
        text: error instanceof Error ? error.message : "Role update failed.",
      });
    } finally {
      setPendingUserId(null);
    }
  }

  function setDraft(userId: string, role: DemoAppRole | "") {
    setDrafts(previous => ({
      ...previous,
      [userId]: role,
    }));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 rounded-lg border bg-muted/30 p-4 sm:grid-cols-3">
        <div>
          <div className="text-xs font-medium text-muted-foreground">
            Current principal
          </div>
          <div className="mt-1 break-all text-sm font-medium">{snapshot.current.principal}</div>
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground">
            Effective role
          </div>
          <div className="mt-1">
            <StateBadge tone={snapshot.current.role === "admin" ? "success" : "neutral"}>
              {snapshot.current.roleLabel}
            </StateBadge>
          </div>
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground">
            Source
          </div>
          <div className="mt-1 text-sm font-medium">
            {snapshot.roleSourceLabels[snapshot.current.source] ?? snapshot.current.source}
          </div>
        </div>
      </div>

      {!snapshot.canManage && (
        <DemoAlert tone="warning">Your app access is read only. Managing assignments requires demo.roles.manage.</DemoAlert>
      )}

      {message && <DemoAlert tone={message.tone}>{message.text}</DemoAlert>}

      <div className="grid gap-3">
        {snapshot.users.length > 0 ? (
          snapshot.users.map(user => {
            const pending = pendingUserId === user.id;
            const draft = drafts[user.id] ?? "";
            const dirty = draft !== (user.appRole.assignment?.role ?? "");
            const sourceLabel =
              snapshot.roleSourceLabels[user.appRole.source] ?? user.appRole.source;

            return (
              <div
                className="grid gap-3 rounded-lg border p-4 lg:grid-cols-[minmax(0,1fr)_minmax(190px,0.45fr)_auto]"
                key={user.id}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {user.displayName || user.email || user.id}
                  </div>
                  <div className="truncate text-sm text-muted-foreground">
                    {user.email || user.id}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <StateBadge tone={user.hostRole === "host.admin" ? "success" : "neutral"}>
                      {user.hostRole || "Unknown host role"}
                    </StateBadge>
                    <StateBadge tone={user.appRole.role === "admin" ? "success" : "neutral"}>
                      {user.appRole.roleLabel}
                    </StateBadge>
                    <StateBadge tone="neutral">{sourceLabel}</StateBadge>
                  </div>
                </div>

                <label className="grid gap-2 text-sm font-medium">
                  App role
                  <Select disabled={!snapshot.canManage || pendingUserId !== null} value={draft || "default"}
                    onValueChange={value => setDraft(user.id, value === "default" ? "" : value as DemoAppRole)}>
                    <SelectTrigger className="w-full" aria-label={`App role for ${user.displayName || user.email || user.id}`}><SelectValue /></SelectTrigger>
                    <SelectContent position="popper"><SelectGroup>
                      <SelectItem value="default">Default ({user.appRole.roleLabel})</SelectItem>
                      {roleOptions.map(role => <SelectItem key={role.role} value={role.role}>{role.label}</SelectItem>)}
                    </SelectGroup></SelectContent>
                  </Select>
                </label>

                <div className="flex items-end gap-2 lg:justify-end">
                  <Button
                    disabled={!snapshot.canManage || pendingUserId !== null || !dirty}
                    onClick={() => void updateRole(user.id)}
                    size="sm"
                    type="button"
                  >
                    {pending ? <HostyLoader label={null} className="size-4" /> : <Check data-icon="inline-start" aria-hidden="true" />}
                    {pending ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    disabled={!snapshot.canManage || pendingUserId !== null || !user.appRole.assignment}
                    onClick={() => {
                      setDraft(user.id, "");
                      void updateRole(user.id, "");
                    }}
                    size="icon-sm"
                    title="Reset to default"
                    aria-label={`Reset role for ${user.displayName || user.email || user.id} to default`}
                    type="button"
                    variant="outline"
                  >
                    <RotateCcw data-icon="inline-start" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            );
          })
        ) : (
          snapshot.directory.error ? <DemoAlert>{snapshot.directory.error.message}</DemoAlert> : <DemoEmpty title="No assigned users">Assign users to this app in Core to manage their roles here.</DemoEmpty>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {snapshot.roles.map(role => (
          <div className="rounded-lg border bg-muted/20 p-4" key={role.role}>
            <div className="text-sm font-semibold">{role.label}</div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{role.description}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {role.permissions.map(permission => (
                <code
                  className="wrap-anywhere rounded border bg-background px-1.5 py-0.5 text-xs leading-5 text-muted-foreground"
                  key={permission}
                >
                  {permission}
                </code>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface RoleMutationResponse {
  snapshot?: DemoRoleManagementSnapshot;
  error?: {
    message?: string;
  };
}

function createDrafts(snapshot: DemoRoleManagementSnapshot): DraftRoles {
  return Object.fromEntries(
    snapshot.users.map(user => [user.id, user.appRole.assignment?.role ?? ""])
  );
}
