/** Negative observations belong to a concrete native runtime, never to an account or model. */
export class PredictionSupportCache {
  private readonly unsupported = new Map<string, number>();
  constructor(private readonly ttl = 24 * 60 * 60_000) {}
  key(command: string, userAgent: unknown): string | null {
    // An unversioned/malformed handshake cannot establish a durable unsupported verdict.
    return typeof userAgent === "string" && userAgent.length <= 512 && /\b\d+\.\d+\.\d+\b/.test(userAgent)
      ? `${command}\n${userAgent}` : null;
  }
  shouldRequest(key: string | null, now = Date.now()): boolean {
    if (!key) return true;
    const until = this.unsupported.get(key);
    if (until !== undefined && until > now) return false;
    this.unsupported.delete(key); return true;
  }
  observeFailure(key: string | null, error: unknown, now = Date.now()): boolean {
    const value = error as { code?: unknown; message?: unknown } | null;
    // Only the protocol's method-not-found verdict is global. Auth, quota, model, timeout and
    // generic experimental errors remain eligible on the next explicit interactive turn.
    const unsupported = value?.code === -32601 && typeof value.message === "string"
      && /method not found|thread\/prediction\/request.*not implemented/i.test(value.message);
    if (unsupported && key) {
      this.unsupported.delete(key); this.unsupported.set(key, now + this.ttl);
      while (this.unsupported.size > 32) this.unsupported.delete(this.unsupported.keys().next().value!);
    }
    return unsupported;
  }
}
export const codexPredictionSupport = new PredictionSupportCache();
