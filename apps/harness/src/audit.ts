// Reports session lifecycle and approved actions to Core's audit log (decision 2026-08-08:
// lifecycle + approvals only, never transcript content). Fire-and-forget: the assistant must keep
// working when Core is briefly unreachable, so failures are logged once and dropped.
export class AuditReporter {
  private warned = false;

  constructor(
    private readonly coreOrigin: string | null,
    private readonly serviceToken: string | null,
    private readonly appId: string,
  ) {}

  report(action: string, details: Record<string, string>): void {
    if (!this.coreOrigin || !this.serviceToken) {
      return;
    }

    void fetch(`${this.coreOrigin}/api/internal/apps/${encodeURIComponent(this.appId)}/audit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.serviceToken}`,
      },
      body: JSON.stringify({ action, details }),
      signal: AbortSignal.timeout(1_500),
    })
      .then((response) => {
        if (!response.ok && !this.warned) {
          this.warned = true;
          console.warn(`[audit] Core returned ${response.status} for ${action}; further failures muted`);
        }
      })
      .catch((error) => {
        if (!this.warned) {
          this.warned = true;
          console.warn(`[audit] report failed (${String(error)}); further failures muted`);
        }
      });
  }
}
