import type { CoreEnvironment, SandboxInstance } from "@hosty-sdk/app/sandbox/server";
import { CoreEventNames, subscribeToCoreEvents, type CoreStreamState } from "./core-event-stream";

export type SandboxSnapshot = {
  environments: CoreEnvironment[] | null;
  instances: SandboxInstance[] | null;
  coreError?: string | null;
  appError?: string | null;
};
function isSnapshot(value: unknown): value is SandboxSnapshot {
  const data = value as SandboxSnapshot | null;
  return !!data && (Array.isArray(data.environments) || data.environments === null && typeof data.coreError === "string") &&
    (Array.isArray(data.instances) || data.instances === null && typeof data.appError === "string");
}

/** Complete snapshots supersede missed frames; reopening the stream sends current state again. */
export function watchSandboxEvents(origin: string, refresh: () => Promise<void>, render: (data: SandboxSnapshot) => void) {
  let state: CoreStreamState = "connecting";
  let fallback: ReturnType<typeof setInterval> | undefined;
  let initialDeadline: ReturnType<typeof setTimeout> | undefined;
  const read = () => { if (document.visibilityState === "visible") void refresh(); };
  const stopTimers = () => { clearInterval(fallback); clearTimeout(initialDeadline); fallback = undefined; initialDeadline = undefined; };
  const unsubscribe = subscribeToCoreEvents(origin, {
    topic: "sandboxes", names: [CoreEventNames.sandboxSnapshot], receiveWhileSyncing: true,
    onStreamState: next => {
      state = next; stopTimers();
      if (next === "legacy" || next === "error") fallback = setInterval(read, 5000);
      // Initial data may fail after headers were sent; bounded recovery also handles that case.
      if (next === "stream") initialDeadline = setTimeout(read, 15_000);
    },
    onSync: () => { if (state === "legacy") read(); },
    onEvent: (_name, data) => {
      if (state !== "stream") return;
      clearTimeout(initialDeadline); initialDeadline = undefined;
      if (isSnapshot(data)) render(data);
      else read();
    },
  });
  return () => { unsubscribe(); stopTimers(); };
}
