"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { Check, CheckCircle2, LoaderCircle, MoreHorizontal, RefreshCw, Trash2, UserCog, UserPlus, UserX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatDateTime } from "../app-helpers";
import { copyTextToClipboard } from "../clipboard";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import type { AssignableAppSummary, HostUserSummary, InviteTtlOption, SessionResponse, UserInvitationSummary, UserManagementResponse } from "../types";
import { CopyField, InlineError, PageHeader, RoleBadge } from "../ui";

export function UserManagementPanel({
  coreOrigin,
  activeUser,
  sendCsrfJson,
}: {
  coreOrigin: string;
  activeUser: SessionResponse["user"] | null;
  sendCsrfJson: (endpoint: string, body?: unknown, method?: string) => Promise<Response>;
}) {
  const [users, setUsers] = useState<HostUserSummary[]>([]);
  const [invitations, setInvitations] = useState<UserInvitationSummary[]>([]);
  const [apps, setApps] = useState<AssignableAppSummary[]>([]);
  const [ttlOptions, setTtlOptions] = useState<InviteTtlOption[]>([
    { label: "15 minutes", ttlMs: 15 * 60 * 1000 },
    { label: "24 hours", ttlMs: 24 * 60 * 60 * 1000 },
    { label: "7 days", ttlMs: 7 * 24 * 60 * 60 * 1000 },
  ]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteDisplayName, setInviteDisplayName] = useState("");
  const [inviteRole, setInviteRole] = useState<"host.admin" | "host.user">("host.user");
  const [inviteTtlMs, setInviteTtlMs] = useState(24 * 60 * 60 * 1000);
  const [inviteAppIds, setInviteAppIds] = useState<string[]>([]);
  const [createdInvite, setCreatedInvite] = useState<{ setupUrl: string; token: string } | null>(null);
  const [copiedInviteField, setCopiedInviteField] = useState<"url" | "token" | null>(null);
  const [accessUserId, setAccessUserId] = useState<string | null>(null);
  const [accessAppIds, setAccessAppIds] = useState<string[]>([]);

  const accessUser = users.find((user) => user.id === accessUserId) ?? null;
  const pendingInvitations = invitations.filter((invitation) => invitation.status === "pending");
  const filteredUsers = users.filter((user) => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return user.id.toLowerCase().includes(query) ||
      user.email?.toLowerCase().includes(query) ||
      user.displayName?.toLowerCase().includes(query) ||
      user.role.toLowerCase().includes(query);
  });

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${coreOrigin}/api/auth/users`, { credentials: "include" });
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) {
        throw new Error(await readCoreError(response));
      }

      const payload = (await response.json()) as UserManagementResponse;
      setUsers(payload.users || []);
      setInvitations(payload.invitations || []);
      setApps(payload.apps || []);
      if (payload.inviteTtlOptions?.length) {
        setTtlOptions(payload.inviteTtlOptions);
        setInviteTtlMs(payload.inviteTtlOptions[1]?.ttlMs ?? payload.inviteTtlOptions[0].ttlMs);
      }
    } catch (caught) {
      if (isAuthRequiredRedirectError(caught)) {
        return;
      }

      setError(caught instanceof Error ? caught.message : "Unable to load users.");
    } finally {
      setLoading(false);
    }
  }, [coreOrigin]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const runUserAction = useCallback(
    async (actionKey: string, action: () => Promise<void>) => {
      setPendingAction(actionKey);
      setError(null);
      try {
        await action();
        await loadUsers();
      } catch (caught) {
        if (isAuthRequiredRedirectError(caught)) {
          return;
        }

        setError(caught instanceof Error ? caught.message : "User action failed.");
      } finally {
        setPendingAction(null);
      }
    },
    [loadUsers],
  );

  const submitInvite = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runUserAction("invite", async () => {
      const response = await sendCsrfJson(`${coreOrigin}/api/auth/invitations`, {
        email: inviteEmail,
        displayName: inviteDisplayName || null,
        role: inviteRole,
        ttlMs: inviteTtlMs,
        assignedAppIds: inviteRole === "host.user" ? inviteAppIds : [],
      });
      const payload = (await response.json()) as { setupUrl: string; token: string };
      setCreatedInvite({ setupUrl: payload.setupUrl, token: payload.token });
      setInviteEmail("");
      setInviteDisplayName("");
      setInviteRole("host.user");
      setInviteAppIds([]);
      setInviteOpen(false);
      toast.success("Invitation created");
    });
  };

  function updateRole(user: HostUserSummary) {
    const nextRole = user.role === "host.admin" ? "host.user" : "host.admin";
    if (user.id === activeUser?.id && user.role === "host.admin" && nextRole === "host.user") {
      setError("Administrators cannot change their own role to user.");
      return;
    }

    void runUserAction(`role:${user.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/users/${encodeURIComponent(user.id)}`, { role: nextRole }, "PATCH");
    });
  }

  function disableUser(user: HostUserSummary) {
    if (user.id === activeUser?.id) {
      setError("Administrators cannot disable their own account.");
      return;
    }

    if (!window.confirm(`Disable ${user.displayName || user.email || user.id}?`)) {
      return;
    }

    void runUserAction(`disable:${user.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/users/${encodeURIComponent(user.id)}`, undefined, "DELETE");
    });
  }

  function purgeUser(user: HostUserSummary) {
    if (!window.confirm(`Permanently delete ${user.displayName || user.email || user.id}? This removes the account and its sign-in credential for good and cannot be undone. The email becomes available to invite again.`)) {
      return;
    }

    void runUserAction(`purge:${user.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/users/${encodeURIComponent(user.id)}/record`, undefined, "DELETE");
      toast.success("User deleted");
    });
  }

  function revokeInvite(invitation: UserInvitationSummary) {
    void runUserAction(`invite:${invitation.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/invitations/${encodeURIComponent(invitation.id)}`, undefined, "DELETE");
    });
  }

  function openAccessEditor(user: HostUserSummary) {
    setAccessUserId(user.id);
    setAccessAppIds(user.assignedAppIds);
  }

  function saveAccess() {
    if (!accessUser) {
      return;
    }

    void runUserAction(`access:${accessUser.id}`, async () => {
      await sendCsrfJson(`${coreOrigin}/api/auth/users/${encodeURIComponent(accessUser.id)}/assignments`, { assignedAppIds: accessAppIds }, "PUT");
      setAccessUserId(null);
    });
  }

  async function copyInviteField(field: "url" | "token", value: string) {
    try {
      await copyTextToClipboard(value);
      setCopiedInviteField(field);
      window.setTimeout(() => setCopiedInviteField(null), 1400);
    } catch {
      setError("Clipboard access failed.");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="User Management"
        description="Manage Host accounts, invitations, roles, and app access."
        actions={(
          <>
            <Button variant="outline" size="icon" onClick={() => void loadUsers()} disabled={loading} aria-label="Refresh users">
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus className="h-4 w-4" />
              Invite User
            </Button>
          </>
        )}
      />

      {error && <InlineError message={error} />}

      <Card>
        <CardHeader className="gap-4 sm:grid sm:grid-cols-[1fr_auto]">
          <div className="space-y-2">
            <CardTitle>Users</CardTitle>
            <CardDescription>{users.length} account{users.length === 1 ? "" : "s"}</CardDescription>
          </div>
          <Input className="w-full sm:w-72" placeholder="Search users" value={search} onChange={(event) => setSearch(event.target.value)} />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Sessions</TableHead>
                <TableHead>Last seen</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Loading users</TableCell></TableRow>
              ) : filteredUsers.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No users</TableCell></TableRow>
              ) : filteredUsers.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="min-w-48">
                      <div className="font-medium">{user.displayName || user.email || user.id}</div>
                      <div className="text-xs text-muted-foreground">{user.email || user.id}</div>
                    </div>
                  </TableCell>
                  <TableCell><RoleBadge role={user.role} disabled={user.disabled} /></TableCell>
                  <TableCell>{user.authProvider || "Local"}</TableCell>
                  <TableCell>{user.role === "host.admin" ? "All apps" : `${user.assignedAppIds.length} apps`}</TableCell>
                  <TableCell>{user.activeSessionCount}</TableCell>
                  <TableCell>{formatDateTime(user.lastSeenAt)}</TableCell>
                  <TableCell className="text-right">
                    <UserRowActionsMenu
                      user={user}
                      activeUserId={activeUser?.id ?? null}
                      pendingAction={pendingAction}
                      onOpenAccessEditor={openAccessEditor}
                      onUpdateRole={updateRole}
                      onDisableUser={disableUser}
                      onPurgeUser={purgeUser}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending Invitations</CardTitle>
          <CardDescription>{pendingInvitations.length} pending</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pendingInvitations.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">No pending invitations.</TableCell></TableRow>
              ) : pendingInvitations.map((invitation) => (
                <TableRow key={invitation.id}>
                  <TableCell>{invitation.email}</TableCell>
                  <TableCell><RoleBadge role={invitation.role} /></TableCell>
                  <TableCell>{invitation.role === "host.admin" ? "All apps" : `${invitation.assignedAppIds.length} apps`}</TableCell>
                  <TableCell>{new Date(invitation.expiresAt).toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => revokeInvite(invitation)} disabled={pendingAction === `invite:${invitation.id}`}>
                      <Trash2 className="h-4 w-4" />
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Invite User</DialogTitle>
            <DialogDescription>Create a setup link and assign app access.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitInvite} className="flex min-h-0 flex-1 flex-col gap-4">
            <DialogBody className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="inviteEmail">Email</Label>
                  <Input id="inviteEmail" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="inviteDisplayName">Display name</Label>
                  <Input id="inviteDisplayName" value={inviteDisplayName} onChange={(event) => setInviteDisplayName(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="inviteRole">Role</Label>
                  <select id="inviteRole" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={inviteRole} onChange={(event) => {
                    const role = event.target.value === "host.admin" ? "host.admin" : "host.user";
                    setInviteRole(role);
                    if (role === "host.admin") {
                      setInviteAppIds([]);
                    }
                  }}>
                    <option value="host.user">User</option>
                    <option value="host.admin">Admin</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="inviteTtl">Expires</Label>
                  <select id="inviteTtl" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={inviteTtlMs} onChange={(event) => setInviteTtlMs(Number(event.target.value))}>
                    {ttlOptions.map((option) => <option key={option.ttlMs} value={option.ttlMs}>{option.label}</option>)}
                  </select>
                </div>
              </div>
              {inviteRole === "host.user" && (
                <AppAccessPicker apps={apps} selectedAppIds={inviteAppIds} onChange={setInviteAppIds} />
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={pendingAction === "invite"}>
                {pendingAction === "invite" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                Generate link
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(createdInvite)} onOpenChange={(open) => !open && setCreatedInvite(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Setup link generated</DialogTitle>
            <DialogDescription>Send this link to the invited user.</DialogDescription>
          </DialogHeader>
          {createdInvite && (
            <DialogBody className="space-y-3">
              <CopyField label="Setup URL" value={createdInvite.setupUrl} copied={copiedInviteField === "url"} onCopy={() => void copyInviteField("url", createdInvite.setupUrl)} />
              <CopyField label="Token" value={createdInvite.token} copied={copiedInviteField === "token"} onCopy={() => void copyInviteField("token", createdInvite.token)} />
            </DialogBody>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(accessUser)} onOpenChange={(open) => !open && setAccessUserId(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{accessUser ? `App access: ${accessUser.displayName || accessUser.email || accessUser.id}` : "App access"}</DialogTitle>
            <DialogDescription>Select runtime apps this user can open.</DialogDescription>
          </DialogHeader>
          {accessUser && (
            <div className="flex min-h-0 flex-1 flex-col gap-4">
              <DialogBody className="space-y-4">
                <AppAccessPicker apps={apps} selectedAppIds={accessAppIds} onChange={setAccessAppIds} />
              </DialogBody>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAccessUserId(null)}>Cancel</Button>
                <Button type="button" onClick={saveAccess} disabled={pendingAction === `access:${accessUser.id}`}>
                  {pendingAction === `access:${accessUser.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Save access
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UserRowActionsMenu({
  user,
  activeUserId,
  pendingAction,
  onOpenAccessEditor,
  onUpdateRole,
  onDisableUser,
  onPurgeUser,
}: {
  user: HostUserSummary;
  activeUserId: string | null;
  pendingAction: string | null;
  onOpenAccessEditor: (user: HostUserSummary) => void;
  onUpdateRole: (user: HostUserSummary) => void;
  onDisableUser: (user: HostUserSummary) => void;
  onPurgeUser: (user: HostUserSummary) => void;
}) {
  const isSelf = activeUserId === user.id;
  const roleActionKey = `role:${user.id}`;
  const disableActionKey = `disable:${user.id}`;
  const purgeActionKey = `purge:${user.id}`;
  const roleActionDisabled = user.disabled || pendingAction === roleActionKey || (isSelf && user.role === "host.admin");
  const disableActionDisabled = user.disabled || pendingAction === disableActionKey || isSelf;
  const purgeActionDisabled = pendingAction === purgeActionKey;
  const roleActionLabel = user.role === "host.admin" ? "Make user" : "Make admin";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="User actions" title="User actions">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {user.role === "host.user" && (
          <DropdownMenuItem disabled={user.disabled} onClick={() => onOpenAccessEditor(user)}>
            <UserCog className="h-4 w-4" />
            Access
          </DropdownMenuItem>
        )}
        <DropdownMenuItem disabled={roleActionDisabled} onClick={() => onUpdateRole(user)}>
          {pendingAction === roleActionKey ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
          {roleActionLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {user.disabled ? (
          <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={purgeActionDisabled} onClick={() => onPurgeUser(user)}>
            {pendingAction === purgeActionKey ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Delete permanently
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={disableActionDisabled} onClick={() => onDisableUser(user)}>
            {pendingAction === disableActionKey ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <UserX className="h-4 w-4" />}
            Disable
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AppAccessPicker({ apps, selectedAppIds, onChange }: { apps: AssignableAppSummary[]; selectedAppIds: string[]; onChange: (ids: string[]) => void }) {
  const knownIds = new Set(apps.map((app) => app.id));
  const options = [
    ...apps,
    ...selectedAppIds.filter((appId) => !knownIds.has(appId)).map((appId) => ({ id: appId, name: appId, version: "", operationStatus: "unavailable" })),
  ];
  const selected = new Set(selectedAppIds);

  return (
    <div className="space-y-2">
      <Label>Runtime app access</Label>
      <div className="max-h-64 overflow-auto rounded-md border">
        {options.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No runtime apps</div>
        ) : options.map((app) => (
          <label key={app.id} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0">
            <input
              type="checkbox"
              checked={selected.has(app.id)}
              onChange={(event) => {
                if (event.target.checked) {
                  onChange(Array.from(new Set([...selectedAppIds, app.id])).sort());
                } else {
                  onChange(selectedAppIds.filter((candidate) => candidate !== app.id));
                }
              }}
            />
            <span className="min-w-0">
              <span className="block truncate font-medium">{app.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{app.id}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
