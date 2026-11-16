import { AgentApiError } from "@hosty-sdk/app/agent";
import type { HarnessAdapter, HarnessRun } from "./internal/harness/adapter.js";
import type { TrackedNativeProcesses } from "./tracked-process.js";

/** An SDK stream ending is separate from proof that the known native process tree stopped. */
export function trackedAdapter(adapter: HarnessAdapter, processes: TrackedNativeProcesses): HarnessAdapter {
  const confirm = async () => {
    const evidence = await processes.stop();
    if (!evidence.stopped || !evidence.allClosed) throw new AgentApiError("exit_unconfirmed", "Provider-owned receipts have not confirmed native process-tree exit.", 503, false, { reason: evidence.reason });
  };
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
        let sdkError: unknown, cleanupError: unknown;
        try {
          if (!run.stopAndWait) {
            await run.stop();
            throw new AgentApiError("exit_unconfirmed", "The native SDK does not provide a confirmed stop operation.", 503);
          }
          await run.stopAndWait();
          await processes.confirmSdkStop();
        } catch (error) { sdkError = error; }
        // Cleanup is still necessary when the SDK cannot confirm stop, but receipts alone
        // cannot erase that uncertainty or authorize a subsequent native turn.
        try { await confirm(); } catch (error) { cleanupError = error; }
        if (sdkError) throw sdkError;
        if (cleanupError) throw cleanupError;
      };
      const wrapped: HarnessRun = { send: text => run.send(text), resolveApproval: (...args) => run.resolveApproval(...args), resolveQuestion: (...args) => run.resolveQuestion(...args),
        setMcpServers: value => run.setMcpServers(value), interrupt: () => run.interrupt(), stop, stopAndWait: stop };
      if (run.readUsage) wrapped.readUsage = () => run.readUsage!();
      if (run.disableSuggestions) wrapped.disableSuggestions = () => run.disableSuggestions!();
      if (run.finishSuggestions) wrapped.finishSuggestions = () => run.finishSuggestions!();
      return wrapped;
    },
  };
}
