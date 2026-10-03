"use client";

import { useEffect, useState } from "react";
import { fetchCore } from "../core-transport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";

type Profile = { id: string; email?: string; displayName?: string };
type Send = (url: string, body?: unknown, method?: string) => Promise<Response>;
export function UserProfilePage({ coreOrigin, sendCsrfJson, onSaved }: { coreOrigin: string; sendCsrfJson: Send; onSaved: () => Promise<void> }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `${coreOrigin}/api/profile`;
  useEffect(() => {
    const controller = new AbortController();
    void fetchCore(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      redirectToCoreLoginIfAuthRequired(response, coreOrigin);
      if (!response.ok) throw new Error(await readCoreError(response));
      return await response.json() as Profile;
    }).then(value => { if (!controller.signal.aborted) { setProfile(value); setName(value.displayName ?? ""); } })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [endpoint, coreOrigin]);
  async function save() {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await sendCsrfJson(endpoint, { displayName: name }, "PUT");
      const updated = await response.json() as Profile;
      setProfile(updated); setName(updated.displayName ?? ""); setNotice("Profile saved."); await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="flex max-w-2xl flex-col gap-6" aria-label="Your profile">
    <h2 className="text-lg font-medium">Your profile</h2>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {!profile && !error && <p>Loading profile…</p>}
    {profile && <form className="flex flex-col gap-3 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="text-sm text-muted-foreground">{profile.email}</p>
      <Label htmlFor="profile-name">Display name</Label>
      <Input id="profile-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} required />
      <Button type="submit" disabled={busy || !name.trim()}>Save profile</Button>
    </form>}
  </section>;
}
