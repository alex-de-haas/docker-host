import { AgentApiError } from "@hosty-sdk/app/agent";
import { withRunLifecycle, type HarnessAdapter, type HarnessRun } from "./internal/harness/adapter.js";
import type { TrackedNativeProcesses } from "./tracked-process.js";

/** An SDK stream ending is separate from proof that the known native process tree stopped. */
export function trackedAdapter(adapter: HarnessAdapter, processes: TrackedNativeProcesses): HarnessAdapter {
  return {
    name: adapter.name, capabilities: adapter.capabilities, probe: () => adapter.probe(),
    // Disposing a probe that never returned a run cleans resources without inventing SDK proof.
    dispose: async () => { try { await processes.stop(); } finally { await adapter.dispose?.(); } },
    start: options => {
      let run: HarnessRun;
      try { run = adapter.start({ ...options, processTransport: processes.transport }); }
      catch (error) {
        const uncertainStop = async (): Promise<never> => {
          try { await processes.stop(); }
          finally { throw new AgentApiError("exit_unconfirmed", "Native startup failed without a supported SDK stop handle. Owned process cleanup does not confirm SDK completion.", 503); }
        };
        // Let the engine retain an active handle before send reports startup failure. Otherwise
        // a constructor that spawned and then threw would look like an execution with no effects.
        return { send() { throw error; }, resolveApproval: () => false, resolveQuestion: () => false,
          setMcpServers: async () => false, interrupt: async () => { await processes.stop(); }, stop: uncertainStop, stopAndWait: uncertainStop };
      }
      const stop = async () => {
        try {
          if (!run.stopAndWait) {
            await run.stop();
            throw new AgentApiError("exit_unconfirmed", "The native SDK does not provide a confirmed stop operation.", 503);
          }
          await run.stopAndWait();
          await processes.confirmSdkStop();
        } finally {
          // The native runners own descendant cleanup independently of the SDK and root slot.
          // A terminal attempt still needs separate writer-scope proof before physical release.
          void processes.stop().catch(() => {});
        }
      };
      let stopping: ReturnType<NonNullable<HarnessRun["stopForCancellation"]>> | undefined;
      const stopForCancellation = run.stopForCancellation && (() => stopping ??= (async () => {
        try {
          const { drained } = await run.stopForCancellation!();
          await processes.confirmSdkStop(true);
          return { drained: drained.catch(() => {}).then(() => processes.stop()).then(() => {}) };
        } catch (error) {
          void processes.stop().catch(() => {});
          throw error;
        }
      })());
      return withRunLifecycle(run, { stop, stopAndWait: stop, stopForCancellation });
    },
  };
}
