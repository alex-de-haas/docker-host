"use client";

import { Button } from "@/components/ui/button";

export function SettingsTokensSection({ coreOrigin }: { coreOrigin: string;
  sendCsrfJson: (url: string, body: unknown, method?: string) => Promise<Response> }) {
  return <section className="max-w-2xl space-y-4" aria-label="Tokens and devices">
    <h2 className="text-lg font-medium">Tokens and devices</h2>
    <p className="text-sm text-muted-foreground">Create and revoke personal tokens, authorize devices and manage OAuth clients in Core.</p>
    <Button asChild><a href={`${coreOrigin}/account/tokens`} target="_blank" rel="noopener noreferrer">Open tokens in Core</a></Button>
  </section>;
}
