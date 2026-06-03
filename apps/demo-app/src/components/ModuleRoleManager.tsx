"use client";

import { useMemo, useState } from "react";
import { Check, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DemoRoleManagementSnapshot } from "@/lib/module-role-management";
import type { DemoModuleRole } from "@/lib/module-roles";
import { StateBadge } from "./DemoModuleUi";

type DraftRoles = Record<string, DemoModuleRole | "">;

export function ModuleRoleManager({
  initialSnapshot,
}: {
  initialSnapshot: DemoRoleManagementSnapshot;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [drafts, setDrafts] = useState<DraftRoles>(() => createDrafts(initialSnapshot));
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const roleOptions = useMemo(() => snapshot.roles, [snapshot.roles]);

  async function updateRole(userId: string, overrideRole?: DemoModuleRole | "") {
    const role = overrideRole ?? drafts[userId] ?? "";
    setPendingUserId(userId);
    setMessage(null);

    try {
      const response = await fetch(`/api/roles/${encodeURIComponent(userId)}`, {
        method: role ? "PUT" : "DELETE",
        headers: role ? { "Content-Type": "application/json" } : undefined,
        body: role ? JSON.stringify({ role }) : undefined,
      });
      const payload = await response.json() as RoleMutationResponse;

      if (!response.ok || !payload.snapshot) {
        throw new Error(payload.error?.message || "Role update failed.");
      }

      setSnapshot(payload.snapshot);
      setDrafts(createDrafts(payload.snapshot));
      setMessage({ tone: "success", text: "Module role assignment saved." });
    } catch (error) {
      setMessage({
        tone: "danger",
        text: error instanceof Error ? error.message : "Role update failed.",
      });
    } finally {
      setPendingUserId(null);
    }
  }

  function setDraft(userId: string, role: DemoModuleRole | "") {
    setDrafts(previous => ({
      ...previous,
      [userId]: role,
    }));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 rounded-lg border bg-muted/30 p-4 sm:grid-cols-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
            Current principal
          </div>
          <div className="mt-1 break-all text-sm font-medium">{snapshot.current.principal}</div>
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
            Effective role
          </div>
          <div className="mt-1">
            <StateBadge tone={snapshot.current.role === "admin" ? "success" : "neutral"}>
              {snapshot.current.roleLabel}
            </StateBadge>
          </div>
        </div>
        <div>
          <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">
            Source
          </div>
          <div className="mt-1 text-sm font-medium">
            {snapshot.roleSourceLabels[snapshot.current.source] ?? snapshot.current.source}
          </div>
        </div>
      </div>

      {!snapshot.canManage && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Current app permissions do not include demo.roles.manage.
        </div>
      )}

      {message && (
        <div
          className={cn(
            "rounded-lg border p-4 text-sm",
            message.tone === "success"
              ? "border-green-600/30 bg-green-600/5 text-green-700"
              : "border-destructive/30 bg-destructive/5 text-destructive"
          )}
        >
          {message.text}
        </div>
      )}

      <div className="grid gap-3">
        {snapshot.users.length > 0 ? (
          snapshot.users.map(user => {
            const pending = pendingUserId === user.id;
            const draft = drafts[user.id] ?? "";
            const dirty = draft !== (user.moduleRole.assignment?.role ?? "");
            const sourceLabel =
              snapshot.roleSourceLabels[user.moduleRole.source] ?? user.moduleRole.source;

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
                      {user.hostRole}
                    </StateBadge>
                    <StateBadge tone={user.moduleRole.role === "admin" ? "success" : "neutral"}>
                      {user.moduleRole.roleLabel}
                    </StateBadge>
                    <StateBadge tone="neutral">{sourceLabel}</StateBadge>
                  </div>
                </div>

                <label className="grid gap-2 text-sm font-medium">
                  Module role
                  <select
                    className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!snapshot.canManage || pending}
                    onChange={event => setDraft(user.id, event.target.value as DemoModuleRole | "")}
                    value={draft}
                  >
                    <option value="">Default ({user.moduleRole.roleLabel})</option>
                    {roleOptions.map(role => (
                      <option key={role.role} value={role.role}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex items-end gap-2 lg:justify-end">
                  <Button
                    disabled={!snapshot.canManage || pending || !dirty}
                    onClick={() => void updateRole(user.id)}
                    size="sm"
                    type="button"
                  >
                    {pending ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
                    Save
                  </Button>
                  <Button
                    disabled={!snapshot.canManage || pending || !user.moduleRole.assignment}
                    onClick={() => {
                      setDraft(user.id, "");
                      void updateRole(user.id, "");
                    }}
                    size="icon-sm"
                    title="Reset to default"
                    type="button"
                    variant="outline"
                  >
                    <RotateCcw className="size-4" />
                  </Button>
                </div>
              </div>
            );
          })
        ) : (
          <p className="rounded-lg border p-4 text-sm leading-6 text-muted-foreground">
            {snapshot.directory.error?.message || "No assigned Host users were returned."}
          </p>
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
                  className="rounded border bg-background px-1.5 py-0.5 text-[11px] leading-5 text-muted-foreground"
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
    snapshot.users.map(user => [user.id, user.moduleRole.assignment?.role ?? ""])
  );
}
