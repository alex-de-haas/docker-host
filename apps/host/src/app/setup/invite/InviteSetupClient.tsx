'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Boxes, KeyRound, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { HostRole } from '@/types/auth';

interface InvitationPreview {
  email: string;
  displayName?: string;
  role: HostRole;
  assignedModuleIds: string[];
  expiresAt: string;
}

interface InvitationPreviewResponse {
  invitation?: InvitationPreview;
  error?: {
    message?: string;
  };
}

interface InvitationAcceptResponse {
  redirectTo?: string;
  error?: {
    message?: string;
  };
}

export function InviteSetupClient({ initialSetupToken = '' }: { initialSetupToken?: string }) {
  const [setupToken, setSetupToken] = useState(initialSetupToken);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(Boolean(initialSetupToken));
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!initialSetupToken) {
      return;
    }

    void loadPreview(initialSetupToken);
  }, [initialSetupToken]);

  async function loadPreview(token: string) {
    setLoadingPreview(true);
    setError(null);

    try {
      const response = await fetch(`/api/auth/invitations/accept?setupToken=${encodeURIComponent(token)}`);
      const data = await readJson<InvitationPreviewResponse>(response);
      if (!response.ok || !data?.invitation) {
        setError(data?.error?.message || 'Invitation token is invalid or expired.');
        setPreview(null);
        return;
      }

      setPreview(data.invitation);
      setDisplayName(data.invitation.displayName || '');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load invitation.');
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setPending(true);

    try {
      const response = await fetch('/api/auth/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setupToken,
          email: preview?.email,
          displayName,
          password,
        }),
      });
      const data = await readJson<InvitationAcceptResponse>(response);

      if (!response.ok) {
        setError(data?.error?.message || 'Unable to accept invitation.');
        return;
      }

      window.location.href = data?.redirectTo || '/apps';
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to accept invitation.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-10">
      <section className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-md border">
            <Boxes className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Docker Host invitation</h1>
            <p className="text-sm text-muted-foreground">{preview ? roleLabel(preview.role) : 'Create your account'}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="invite-setup-token">Setup token</Label>
            <div className="flex gap-2">
              <Input
                id="invite-setup-token"
                type="password"
                autoComplete="one-time-code"
                value={setupToken}
                onChange={event => setSetupToken(event.target.value)}
                required
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadPreview(setupToken)}
                disabled={loadingPreview || !setupToken}
              >
                {loadingPreview ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                Check
              </Button>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={preview?.email || ''}
                readOnly
                disabled={!preview}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-display-name">Display name</Label>
              <Input
                id="invite-display-name"
                value={displayName}
                onChange={event => setDisplayName(event.target.value)}
                disabled={!preview}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="invite-password">Password</Label>
              <Input
                id="invite-password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={password}
                onChange={event => setPassword(event.target.value)}
                disabled={!preview}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-confirm-password">Confirm password</Label>
              <Input
                id="invite-confirm-password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                value={confirmPassword}
                onChange={event => setConfirmPassword(event.target.value)}
                disabled={!preview}
                required
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={pending || !preview}>
            {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Create account
          </Button>
        </form>
      </section>
    </main>
  );
}

function roleLabel(role: HostRole) {
  return role === 'host.admin' ? 'Host administrator' : 'Host user';
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
