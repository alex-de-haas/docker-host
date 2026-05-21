'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { AdminShell, HostPageHeader } from '@/components/AdminShell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

interface AuthAuditEvent {
  id: string;
  type: string;
  createdAt: string;
  actorUserId?: string;
  success?: boolean;
  target?: {
    type: string;
    id: string;
  };
}

interface AuthSessionSummary {
  id: string;
  userId: string;
  userEmail?: string;
  userRole?: string;
  authProvider?: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt?: string;
  reauthenticatedAt?: string;
  active: boolean;
  current: boolean;
  request?: {
    userAgent?: string;
  };
}

interface AuthDiagnosticCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  message: string;
  nextStep?: string;
}

export function SecuritySettingsClient() {
  const [auditEvents, setAuditEvents] = useState<AuthAuditEvent[]>([]);
  const [sessions, setSessions] = useState<AuthSessionSummary[]>([]);
  const [diagnostics, setDiagnostics] = useState<{
    oidc: AuthDiagnosticCheck[];
    trustedProxy: AuthDiagnosticCheck[];
  }>({ oidc: [], trustedProxy: [] });
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [reauthPassword, setReauthPassword] = useState('');
  const [recoveryToken, setRecoveryToken] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentSession = useMemo(
    () => sessions.find(session => session.current),
    [sessions]
  );

  const loadSecurityState = useCallback(async () => {
    setError(null);
    const [auditResponse, sessionsResponse, diagnosticsResponse] = await Promise.all([
      fetch('/api/auth/audit?limit=25'),
      fetch('/api/auth/sessions?includeRevoked=true'),
      fetch('/api/auth/diagnostics'),
    ]);

    if (!auditResponse.ok || !sessionsResponse.ok || !diagnosticsResponse.ok) {
      throw new Error('Unable to load security settings.');
    }

    const auditData = await auditResponse.json() as { events?: AuthAuditEvent[] };
    const sessionData = await sessionsResponse.json() as { sessions?: AuthSessionSummary[] };
    const diagnosticData = await diagnosticsResponse.json() as {
      oidc?: AuthDiagnosticCheck[];
      trustedProxy?: AuthDiagnosticCheck[];
    };
    setAuditEvents(auditData.events || []);
    setSessions(sessionData.sessions || []);
    setDiagnostics({
      oidc: diagnosticData.oidc || [],
      trustedProxy: diagnosticData.trustedProxy || [],
    });
  }, []);

  useEffect(() => {
    setLoading(true);
    loadSecurityState()
      .catch(caught => setError(caught instanceof Error ? caught.message : 'Unable to load security settings.'))
      .finally(() => setLoading(false));
  }, [loadSecurityState]);

  async function handleReauth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingAction('reauth');
    setError(null);
    setMessage(null);

    try {
      const response = await fetch('/api/auth/reauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: reauthPassword || undefined,
          recoveryToken: recoveryToken || undefined,
        }),
      });
      const data = await response.json() as { error?: { message?: string } };

      if (!response.ok) {
        setError(data.error?.message || 'Unable to reauthenticate.');
        return;
      }

      setReauthPassword('');
      setRecoveryToken('');
      setMessage('Recent administrator reauthentication is active.');
      await loadSecurityState();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to reauthenticate.');
    } finally {
      setPendingAction(null);
    }
  }

  async function revokeSession(sessionId: string) {
    setPendingAction(`revoke-${sessionId}`);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/auth/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
      const data = await response.json() as { error?: { message?: string; nextStep?: string } };

      if (!response.ok) {
        setError(data.error?.nextStep || data.error?.message || 'Unable to revoke session.');
        return;
      }

      setMessage('Session revoked.');
      await loadSecurityState();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to revoke session.');
    } finally {
      setPendingAction(null);
    }
  }

  async function purgeAudit() {
    setPendingAction('purge-audit');
    setError(null);
    setMessage(null);

    try {
      const response = await fetch('/api/auth/audit?retentionDays=90', {
        method: 'DELETE',
      });
      const data = await response.json() as { error?: { message?: string; nextStep?: string }; deletedCount?: number };

      if (!response.ok) {
        setError(data.error?.nextStep || data.error?.message || 'Unable to purge audit events.');
        return;
      }

      setMessage(`Audit retention applied. Deleted ${data.deletedCount ?? 0} event${data.deletedCount === 1 ? '' : 's'}.`);
      await loadSecurityState();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to purge audit events.');
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <AdminShell contentClassName="space-y-6">
        <HostPageHeader
          title="Security settings"
          description="Sessions, reauthentication, diagnostics, and audit events"
          actions={(
            <Button variant="outline" size="icon" onClick={() => void loadSecurityState()} disabled={loading} aria-label="Refresh security settings">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          )}
        />

        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {message && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-950 dark:text-emerald-200">
            {message}
          </div>
        )}

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="min-w-0 rounded-lg">
            <CardHeader>
              <CardTitle>Sessions</CardTitle>
              <CardDescription>Active and recently revoked browser sessions.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Last seen</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map(session => (
                    <TableRow key={session.id}>
                      <TableCell>
                        <div className="font-medium">{session.userEmail || session.userId}</div>
                        <div className="text-xs text-muted-foreground">{session.userRole || 'unknown role'}</div>
                      </TableCell>
                      <TableCell>{formatDate(session.lastSeenAt)}</TableCell>
                      <TableCell>
                        <Badge variant={session.active ? 'secondary' : 'outline'}>
                          {session.current ? 'current' : session.active ? 'active' : 'revoked'}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-56 truncate text-muted-foreground">
                        {session.request?.userAgent || 'Unknown client'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!session.active || session.current || pendingAction === `revoke-${session.id}`}
                          onClick={() => void revokeSession(session.id)}
                        >
                          {pendingAction === `revoke-${session.id}` ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {sessions.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                        No sessions found.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card className="min-w-0 rounded-lg">
            <CardHeader>
              <CardTitle>Reauthentication</CardTitle>
              <CardDescription>Required before sensitive auth operations.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleReauth} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="reauth-password">Password</Label>
                  <Input
                    id="reauth-password"
                    type="password"
                    autoComplete="current-password"
                    value={reauthPassword}
                    onChange={event => setReauthPassword(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="recovery-token">Recovery token</Label>
                  <Input
                    id="recovery-token"
                    type="password"
                    autoComplete="one-time-code"
                    value={recoveryToken}
                    onChange={event => setRecoveryToken(event.target.value)}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={pendingAction === 'reauth'}>
                  {pendingAction === 'reauth' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  Reauthenticate
                </Button>
                <p className="text-xs text-muted-foreground">
                  {currentSession?.reauthenticatedAt
                    ? `Last reauthenticated ${formatDate(currentSession.reauthenticatedAt)}.`
                    : 'No recent reauthentication recorded for this session.'}
                </p>
              </form>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <DiagnosticsCard title="OIDC diagnostics" checks={diagnostics.oidc} />
          <DiagnosticsCard title="Trusted proxy diagnostics" checks={diagnostics.trustedProxy} />
        </section>

        <Card className="min-w-0 rounded-lg">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Audit log</CardTitle>
              <CardDescription>Latest sanitized security and operations events.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => void purgeAudit()} disabled={pendingAction === 'purge-audit'}>
              {pendingAction === 'purge-audit' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Apply 90-day retention
            </Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditEvents.map(event => (
                  <TableRow key={event.id}>
                    <TableCell>{formatDate(event.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{event.type}</TableCell>
                    <TableCell>{event.actorUserId || ''}</TableCell>
                    <TableCell>{event.target ? `${event.target.type}:${event.target.id}` : ''}</TableCell>
                    <TableCell>
                      <Badge variant={event.success === false ? 'destructive' : 'secondary'}>
                        {event.success === false ? 'failed' : 'ok'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {auditEvents.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      No audit events found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
    </AdminShell>
  );
}

function DiagnosticsCard({ title, checks }: { title: string; checks: AuthDiagnosticCheck[] }) {
  return (
    <Card className="min-w-0 rounded-lg">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Configuration checks for login and assertion mapping.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {checks.map(check => (
          <div key={check.id} className="flex items-start gap-3 rounded-md border p-3">
            {check.status === 'pass' ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" />
            ) : check.status === 'fail' ? (
              <XCircle className="mt-0.5 h-4 w-4 text-destructive" />
            ) : (
              <ShieldCheck className="mt-0.5 h-4 w-4 text-muted-foreground" />
            )}
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">{check.label}</p>
                <Badge variant={check.status === 'fail' ? 'destructive' : 'outline'}>{check.status}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{check.message}</p>
              {check.nextStep && <p className="text-xs text-muted-foreground">{check.nextStep}</p>}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function formatDate(value: string | undefined) {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
