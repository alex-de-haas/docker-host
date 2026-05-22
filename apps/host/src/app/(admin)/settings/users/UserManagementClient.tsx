'use client';

import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  CheckCircle2,
  Copy,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  UserCog,
  UserPlus,
  UserX,
  XCircle,
} from 'lucide-react';
import { AdminShell, HostPageHeader } from '@/components/AdminShell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { HostRole } from '@/types/auth';

interface HostUserSummary {
  id: string;
  email?: string;
  displayName?: string;
  role: HostRole;
  authProvider?: 'local' | 'oidc' | 'trusted-proxy';
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  activeSessionCount: number;
  activeCliTokenCount: number;
  assignedModuleIds: string[];
  lastSeenAt?: string;
}

interface UserInvitationSummary {
  id: string;
  email: string;
  displayName?: string;
  role: HostRole;
  assignedModuleIds: string[];
  createdByUserId?: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  revokedAt?: string;
  status: 'pending' | 'expired' | 'used' | 'revoked';
}

interface AssignableModule {
  id: string;
  name: string;
  version?: string;
  operationStatus?: string;
}

interface InviteTtlOption {
  label: string;
  ttlMs: number;
}

interface UserManagementResponse {
  users?: HostUserSummary[];
  invitations?: UserInvitationSummary[];
  modules?: AssignableModule[];
  inviteTtlOptions?: InviteTtlOption[];
  error?: ApiError;
}

interface ApiError {
  code?: string;
  message?: string;
  nextStep?: string;
}

type PendingAction =
  | { type: 'create-invite' }
  | { type: 'role'; userId: string; role: HostRole }
  | { type: 'disable'; userId: string }
  | { type: 'assignments'; userId: string; assignedModuleIds: string[] }
  | { type: 'revoke-invite'; inviteId: string };

const defaultInviteTtlOptions: InviteTtlOption[] = [
  { label: '15 minutes', ttlMs: 15 * 60 * 1000 },
  { label: '24 hours', ttlMs: 24 * 60 * 60 * 1000 },
  { label: '7 days', ttlMs: 7 * 24 * 60 * 60 * 1000 },
];

export function UserManagementClient() {
  const [users, setUsers] = useState<HostUserSummary[]>([]);
  const [invitations, setInvitations] = useState<UserInvitationSummary[]>([]);
  const [modules, setModules] = useState<AssignableModule[]>([]);
  const [inviteTtlOptions, setInviteTtlOptions] = useState<InviteTtlOption[]>(defaultInviteTtlOptions);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<PendingAction | null>(null);
  const [reauthPassword, setReauthPassword] = useState('');
  const [reauthRecoveryToken, setReauthRecoveryToken] = useState('');
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteDisplayName, setInviteDisplayName] = useState('');
  const [inviteRole, setInviteRole] = useState<HostRole>('host.user');
  const [inviteTtlMs, setInviteTtlMs] = useState(defaultInviteTtlOptions[1]?.ttlMs ?? 24 * 60 * 60 * 1000);
  const [inviteModuleIds, setInviteModuleIds] = useState<string[]>([]);
  const [createdInvite, setCreatedInvite] = useState<{ setupUrl: string; token: string } | null>(null);
  const [copiedInviteField, setCopiedInviteField] = useState<'url' | 'token' | null>(null);
  const [accessUserId, setAccessUserId] = useState<string | null>(null);
  const [accessModuleIds, setAccessModuleIds] = useState<string[]>([]);

  const accessUser = users.find(user => user.id === accessUserId) ?? null;
  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return users;
    }

    return users.filter(user =>
      user.id.toLowerCase().includes(query) ||
      user.email?.toLowerCase().includes(query) ||
      user.displayName?.toLowerCase().includes(query) ||
      user.role.toLowerCase().includes(query)
    );
  }, [search, users]);
  const pendingInvitations = invitations.filter(invitation => invitation.status === 'pending');

  useEffect(() => {
    void loadState();
  }, []);

  async function loadState() {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/users');
      const data = await readJson<UserManagementResponse>(response);
      if (!response.ok) {
        setError(data?.error?.message || 'Unable to load users.');
        return;
      }

      setUsers(data?.users ?? []);
      setInvitations(data?.invitations ?? []);
      setModules(data?.modules ?? []);
      setInviteTtlOptions(data?.inviteTtlOptions?.length ? data.inviteTtlOptions : defaultInviteTtlOptions);
      if (data?.inviteTtlOptions?.[1]?.ttlMs) {
        setInviteTtlMs(data.inviteTtlOptions[1].ttlMs);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load users.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction({ type: 'create-invite' });
  }

  async function runAction(action: PendingAction, allowReauthPrompt = true) {
    setPendingAction(actionKey(action));
    setError(null);

    try {
      const response = await performAction(action);
      const data = await readJson<Record<string, unknown> & { error?: ApiError }>(response);
      if (!response.ok) {
        if (allowReauthPrompt && data?.error?.code === 'reauth_required') {
          setRetryAction(action);
          setReauthError(null);
          return;
        }

        setError(data?.error?.nextStep || data?.error?.message || 'Action failed.');
        return;
      }

      if (action.type === 'create-invite') {
        const setupUrl = typeof data?.setupUrl === 'string' ? data.setupUrl : '';
        const token = typeof data?.token === 'string' ? data.token : '';
        setCreatedInvite(setupUrl && token ? { setupUrl, token } : null);
        setInviteEmail('');
        setInviteDisplayName('');
        setInviteRole('host.user');
        setInviteModuleIds([]);
        setInviteOpen(false);
      }

      if (action.type === 'assignments') {
        setAccessUserId(null);
      }

      await loadState();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Action failed.');
    } finally {
      setPendingAction(null);
    }
  }

  async function performAction(action: PendingAction) {
    switch (action.type) {
      case 'create-invite':
        return fetch('/api/auth/invitations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: inviteEmail,
            displayName: inviteDisplayName || undefined,
            role: inviteRole,
            ttlMs: inviteTtlMs,
            assignedModuleIds: inviteModuleIds,
          }),
        });
      case 'role':
        return fetch(`/api/auth/users/${encodeURIComponent(action.userId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: action.role }),
        });
      case 'disable':
        return fetch(`/api/auth/users/${encodeURIComponent(action.userId)}`, {
          method: 'DELETE',
        });
      case 'assignments':
        return fetch(`/api/auth/users/${encodeURIComponent(action.userId)}/assignments`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignedModuleIds: action.assignedModuleIds }),
        });
      case 'revoke-invite':
        return fetch(`/api/auth/invitations/${encodeURIComponent(action.inviteId)}`, {
          method: 'DELETE',
        });
    }
  }

  async function handleReauth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!retryAction) {
      return;
    }

    setPendingAction('reauth');
    setReauthError(null);

    try {
      const response = await fetch('/api/auth/reauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: reauthPassword || undefined,
          recoveryToken: reauthRecoveryToken || undefined,
        }),
      });
      const data = await readJson<{ error?: ApiError }>(response);
      if (!response.ok) {
        setReauthError(data?.error?.message || 'Unable to reauthenticate.');
        return;
      }

      const action = retryAction;
      setRetryAction(null);
      setReauthPassword('');
      setReauthRecoveryToken('');
      await runAction(action, false);
    } catch (caught) {
      setReauthError(caught instanceof Error ? caught.message : 'Unable to reauthenticate.');
    } finally {
      setPendingAction(null);
    }
  }

  function openAccessDialog(user: HostUserSummary) {
    setAccessUserId(user.id);
    setAccessModuleIds(user.assignedModuleIds);
  }

  function toggleModuleSelection(moduleId: string, selected: boolean, source: 'invite' | 'access') {
    const setter = source === 'invite' ? setInviteModuleIds : setAccessModuleIds;
    setter(previous => selected
      ? Array.from(new Set([...previous, moduleId])).sort()
      : previous.filter(candidate => candidate !== moduleId)
    );
  }

  async function copyInviteField(field: 'url' | 'token', value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedInviteField(field);
      window.setTimeout(() => setCopiedInviteField(null), 1400);
    } catch {
      setError('Clipboard access failed.');
    }
  }

  return (
    <AdminShell contentClassName="space-y-6">
      <HostPageHeader
        title="User Management"
        description="Manage Host accounts, invitations, roles, and app access."
        actions={(
          <>
            <Button variant="outline" size="icon" onClick={() => void loadState()} disabled={loading} aria-label="Refresh users">
              <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            </Button>
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus className="h-4 w-4" />
              Invite user
            </Button>
          </>
        )}
      />

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="gap-4 sm:grid-cols-[1fr_auto]">
          <div className="space-y-2">
            <CardTitle>Users</CardTitle>
            <CardDescription>{users.length} account{users.length === 1 ? '' : 's'}</CardDescription>
          </div>
          <Input
            className="w-full sm:w-72"
            placeholder="Search users"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
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
              {filteredUsers.map(user => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="min-w-48">
                      <div className="font-medium">{user.displayName || user.email || user.id}</div>
                      <div className="text-xs text-muted-foreground">{user.email || user.id}</div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <RoleBadge role={user.role} disabled={user.disabled} />
                  </TableCell>
                  <TableCell>{formatProvider(user.authProvider)}</TableCell>
                  <TableCell>{formatAccessCount(user.assignedModuleIds.length)}</TableCell>
                  <TableCell>{user.activeSessionCount}</TableCell>
                  <TableCell>{formatDateTime(user.lastSeenAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openAccessDialog(user)}
                        disabled={user.disabled || modules.length === 0}
                      >
                        <UserCog className="h-4 w-4" />
                        Access
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void runAction({
                          type: 'role',
                          userId: user.id,
                          role: user.role === 'host.admin' ? 'host.user' : 'host.admin',
                        })}
                        disabled={user.disabled || (user.authProvider !== undefined && user.authProvider !== 'local') || pendingAction === `role-${user.id}`}
                      >
                        {pendingAction === `role-${user.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                        {user.role === 'host.admin' ? 'Make user' : 'Make admin'}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void runAction({ type: 'disable', userId: user.id })}
                        disabled={user.disabled || pendingAction === `disable-${user.id}`}
                      >
                        {pendingAction === `disable-${user.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <UserX className="h-4 w-4" />}
                        Disable
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {filteredUsers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    No users found.
                  </TableCell>
                </TableRow>
              )}
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
              {pendingInvitations.map(invitation => (
                <TableRow key={invitation.id}>
                  <TableCell>
                    <div className="font-medium">{invitation.displayName || invitation.email}</div>
                    <div className="text-xs text-muted-foreground">{invitation.email}</div>
                  </TableCell>
                  <TableCell><RoleBadge role={invitation.role} /></TableCell>
                  <TableCell>{formatAccessCount(invitation.assignedModuleIds.length)}</TableCell>
                  <TableCell>{formatDateTime(invitation.expiresAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void runAction({ type: 'revoke-invite', inviteId: invitation.id })}
                        disabled={pendingAction === `revoke-invite-${invitation.id}`}
                      >
                        {pendingAction === `revoke-invite-${invitation.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                        Revoke
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {pendingInvitations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                    No pending invitations.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
            <DialogDescription>Generate a one-time setup link.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateInvite} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  value={inviteEmail}
                  onChange={event => setInviteEmail(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-display-name">Display name</Label>
                <Input
                  id="invite-display-name"
                  value={inviteDisplayName}
                  onChange={event => setInviteDisplayName(event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="invite-role">Role</Label>
                <select
                  id="invite-role"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                  value={inviteRole}
                  onChange={event => setInviteRole(event.target.value === 'host.admin' ? 'host.admin' : 'host.user')}
                >
                  <option value="host.user">Host user</option>
                  <option value="host.admin">Host administrator</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="invite-ttl">Expires</Label>
                <select
                  id="invite-ttl"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                  value={inviteTtlMs}
                  onChange={event => setInviteTtlMs(Number(event.target.value))}
                >
                  {inviteTtlOptions.map(option => (
                    <option key={option.ttlMs} value={option.ttlMs}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <ModulePicker
              modules={modules}
              selectedModuleIds={inviteModuleIds}
              onToggle={(moduleId, selected) => toggleModuleSelection(moduleId, selected, 'invite')}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setInviteOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pendingAction === 'create-invite'}>
                {pendingAction === 'create-invite' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                Generate link
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(createdInvite)} onOpenChange={open => !open && setCreatedInvite(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Invitation generated</DialogTitle>
            <DialogDescription>The token is visible only once.</DialogDescription>
          </DialogHeader>
          {createdInvite && (
            <div className="space-y-4">
              <CopyField
                id="invite-url"
                label="Setup URL"
                value={createdInvite.setupUrl}
                copied={copiedInviteField === 'url'}
                onCopy={() => void copyInviteField('url', createdInvite.setupUrl)}
              />
              <CopyField
                id="invite-token"
                label="Setup token"
                value={createdInvite.token}
                copied={copiedInviteField === 'token'}
                onCopy={() => void copyInviteField('token', createdInvite.token)}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(accessUser)} onOpenChange={open => !open && setAccessUserId(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>App access</DialogTitle>
            <DialogDescription>{accessUser?.displayName || accessUser?.email || accessUser?.id}</DialogDescription>
          </DialogHeader>
          <ModulePicker
            modules={modules}
            selectedModuleIds={accessModuleIds}
            onToggle={(moduleId, selected) => toggleModuleSelection(moduleId, selected, 'access')}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAccessUserId(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => accessUser && void runAction({
                type: 'assignments',
                userId: accessUser.id,
                assignedModuleIds: accessModuleIds,
              })}
              disabled={!accessUser || pendingAction === `assignments-${accessUser?.id}`}
            >
              {pendingAction === `assignments-${accessUser?.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Save access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(retryAction)}
        onOpenChange={open => {
          if (!open) {
            setRetryAction(null);
            setReauthError(null);
            setReauthPassword('');
            setReauthRecoveryToken('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm administrator access</DialogTitle>
            <DialogDescription>Recent reauthentication is required.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleReauth} className="space-y-4">
            {reauthError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {reauthError}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="users-reauth-password">Password</Label>
              <Input
                id="users-reauth-password"
                type="password"
                value={reauthPassword}
                onChange={event => setReauthPassword(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="users-reauth-recovery">Recovery token</Label>
              <Input
                id="users-reauth-recovery"
                type="password"
                value={reauthRecoveryToken}
                onChange={event => setReauthRecoveryToken(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRetryAction(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pendingAction === 'reauth'}>
                {pendingAction === 'reauth' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Confirm
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function RoleBadge({ role, disabled = false }: { role: HostRole; disabled?: boolean }) {
  if (disabled) {
    return <Badge variant="outline">Disabled</Badge>;
  }

  return role === 'host.admin'
    ? <Badge>Admin</Badge>
    : <Badge variant="secondary">User</Badge>;
}

function ModulePicker({
  modules,
  selectedModuleIds,
  onToggle,
}: {
  modules: AssignableModule[];
  selectedModuleIds: string[];
  onToggle: (moduleId: string, selected: boolean) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>App access</Label>
      <div className="max-h-72 overflow-y-auto rounded-md border">
        {modules.map(module => {
          const checked = selectedModuleIds.includes(module.id);
          return (
            <label key={module.id} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-muted/50">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={checked}
                onChange={event => onToggle(module.id, event.target.checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{module.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{module.id}</span>
              </span>
            </label>
          );
        })}
        {modules.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No apps available.
          </div>
        )}
      </div>
    </div>
  );
}

function CopyField({
  id,
  label,
  value,
  copied,
  onCopy,
}: {
  id: string;
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input id={id} value={value} readOnly className="font-mono text-xs" />
        <Button type="button" variant="outline" onClick={onCopy}>
          {copied ? <CheckCircle2 className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}

function actionKey(action: PendingAction) {
  switch (action.type) {
    case 'create-invite':
      return 'create-invite';
    case 'role':
      return `role-${action.userId}`;
    case 'disable':
      return `disable-${action.userId}`;
    case 'assignments':
      return `assignments-${action.userId}`;
    case 'revoke-invite':
      return `revoke-invite-${action.inviteId}`;
  }
}

function formatProvider(provider: HostUserSummary['authProvider']) {
  switch (provider) {
    case 'oidc':
      return 'OIDC';
    case 'trusted-proxy':
      return 'Trusted proxy';
    case 'local':
    case undefined:
      return 'Local';
  }
}

function formatAccessCount(count: number) {
  return count === 0 ? 'All authenticated' : `${count} assigned`;
}

function formatDateTime(value: string | undefined) {
  if (!value) {
    return 'Never';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

async function readJson<T>(response: Response): Promise<T | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  try {
    return await response.json() as T;
  } catch {
    return null;
  }
}
