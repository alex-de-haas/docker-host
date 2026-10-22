/** Latest context observation, never cumulative billed token usage. */
export interface ContextUsage {
  usedTokens: number;
  maxTokens: number | null;
  estimated: boolean;
  observedAt: string;
}

const tokenCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function contextUsage(used: unknown, limit: unknown, estimated: boolean): ContextUsage | null {
  if (!tokenCount(used)) return null;
  return { usedTokens: used, maxTokens: tokenCount(limit) && limit > 0 ? limit : null,
    estimated, observedAt: new Date().toISOString() };
}

export function codexContextUsage(value: unknown): ContextUsage | null {
  const usage = value as { last?: { totalTokens?: unknown }; modelContextWindow?: unknown } | null;
  // Cached input and reasoning output are already included in totalTokens.
  return contextUsage(usage?.last?.totalTokens, usage?.modelContextWindow, true);
}

export function claudeContextUsage(value: unknown): ContextUsage | null {
  const usage = value as { totalTokens?: unknown; maxTokens?: unknown } | null;
  return contextUsage(usage?.totalTokens, usage?.maxTokens, true);
}

/** One bounded diagnostic at a time; intermediate requests collapse into one fresh read. */
export class ContextUsageReader {
  private pending: Promise<void> | null = null;
  private dirty = false;
  private closed = false;
  private disabled = false;
  private cancel: (() => void) | undefined;

  constructor(private readonly read: () => Promise<ContextUsage | null>,
    private readonly report: (usage: ContextUsage | null) => void, private readonly timeoutMs = 1500) {}

  refresh(): Promise<void> {
    if (this.closed || this.disabled) return Promise.resolve();
    this.dirty = true;
    if (!this.pending) this.pending = this.drain();
    return this.pending;
  }

  close(): void {
    this.closed = true;
    this.cancel?.();
  }

  private async drain(): Promise<void> {
    try {
      while (this.dirty && !this.closed && !this.disabled) {
        this.dirty = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const usage = await Promise.race([
            Promise.resolve().then(() => this.closed ? null : this.read()),
            new Promise<never>((_, reject) => {
              this.cancel = () => reject(new Error("Context diagnostic closed."));
              timer = setTimeout(() => {
                // The control request cannot be cancelled independently. Do not pile up
                // further requests behind a stuck one, or let its late response overwrite state.
                this.disabled = true;
                reject(new Error("Context diagnostic timed out."));
              }, this.timeoutMs);
            }),
          ]);
          if (!this.closed && !this.dirty) this.report(usage);
        } catch {
          if (!this.closed && (!this.dirty || this.disabled)) this.report(null);
        } finally {
          clearTimeout(timer);
          this.cancel = undefined;
        }
      }
    } finally {
      // Clear synchronously with drain completion so a refresh queued by the report
      // cannot join an already-completed promise and lose its final observation.
      this.pending = null;
    }
  }
}
