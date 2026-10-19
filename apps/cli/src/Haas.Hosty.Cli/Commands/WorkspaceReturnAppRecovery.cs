using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Cli.Commands;

// Older Core versions reconcile autostart after their HTTP listener is ready. A manual Docker
// app can therefore be stopped by that boot after its Return already restored it. Preserve the
// exact returned installation/target and reconcile only that boot-induced running-state change.
internal static class WorkspaceReturnAppRecovery
{
    internal static WorkspaceReturnAppState[] Capture(JsonElement response, string[] returned)
        => returned.Select(id =>
        {
            var app = Find(response, id);
            if (string.IsNullOrWhiteSpace(Text(app, "installationId")))
                throw new IOException($"Returned app {id} has no verifiable installation identity.");
            var running = Running(app);
            if (!running && Text(app, "runtimeState") != "stopped")
                throw new IOException($"Returned app {id} is not in a stable running/stopped state.");
            var runtime = app.GetProperty("runtimeProfiles").EnumerateArray().Single(p => Text(p, "key") == Text(app, "selectedRuntime"));
            // Native processes are adopted before autostart reconciliation. A live development
            // journal also retains manual Docker services; never take over a newer dev binding.
            var retained = running && (Text(runtime, "type") != "docker" ||
                app.TryGetProperty("devMode", out var dev) && dev.ValueKind == JsonValueKind.Object);
            var configured = !app.TryGetProperty("configurationReadiness", out var readiness) ||
                !readiness.TryGetProperty("required", out var required) || !required.GetBoolean();
            var autostart = !app.TryGetProperty("autostart", out var auto) || auto.ValueKind == JsonValueKind.Null || auto.GetBoolean();
            return new WorkspaceReturnAppState(id, Target(app), running, retained || autostart && configured);
        }).ToArray();

    internal static async Task RestoreAsync(WorkspaceReturnAppState[] states, Func<Task<JsonElement>> read,
        Func<string, bool, Task> setRunning, Action<string> markBootObserved, Action checkCancellation, TimeSpan? timeout = null, TimeSpan? interval = null)
    {
        var deadline = DateTimeOffset.UtcNow + (timeout ?? TimeSpan.FromMinutes(10));
        foreach (var state in states)
        {
            var changed = state.BootObserved;
            while (true)
            {
                checkCancellation();
                var app = Find(await read(), state.AppId);
                if (Target(app) != state.Target)
                    throw new IOException($"Returned app {state.AppId} changed installation or runtime target. No unrelated binding was changed.");
                var up = Running(app); var stopped = Text(app, "runtimeState") == "stopped";
                if (changed || state.WasRunning == state.BootRunning)
                {
                    if (state.WasRunning ? up : stopped) break;
                    if (up || stopped) await setRunning(state.AppId, state.WasRunning);
                }
                else if (state.BootRunning ? up : stopped)
                {
                    // Persist the boot boundary before mutation so a lost response can resume
                    // by observing the desired state, without waiting for a second Core boot.
                    markBootObserved(state.AppId);
                    changed = true;
                    await setRunning(state.AppId, state.WasRunning);
                    continue;
                }
                if (DateTimeOffset.UtcNow >= deadline)
                    throw new IOException($"Returned app {state.AppId} has not confirmed its previous running state. Retain this Return request and inspect startup diagnostics.");
                await Task.Delay(interval ?? TimeSpan.FromSeconds(1));
            }
        }
    }

    private static JsonElement Find(JsonElement response, string id)
        => response.GetProperty("apps").EnumerateArray().SingleOrDefault(a => Text(a, "id") == id) is { ValueKind: JsonValueKind.Object } app
            ? app : throw new IOException($"Returned app {id} is no longer installed.");
    private static bool Running(JsonElement app) => Text(app, "runtimeState") == "running";
    private static string? Text(JsonElement value, string key) => value.TryGetProperty(key, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;
    private static string Target(JsonElement app)
    {
        var fields = new[] { "id", "installationId", "selectedRuntime", "sourceOverridePath", "sourceLivePath", "version" };
        var value = string.Join("\n", fields.Select(key => key + ":" + Text(app, key)));
        if (app.TryGetProperty("devMode", out var dev) && dev.ValueKind == JsonValueKind.Object) value += "\ndev:" + Text(dev, "operationId");
        if (app.TryGetProperty("artifactLocks", out var artifacts) && artifacts.ValueKind == JsonValueKind.Object)
            foreach (var entry in artifacts.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                foreach (var key in new[] { "kind", "imageDigest", "bundleHash", "commit", "resolvedFromRef" }) value += "\n" + entry.Name + ":" + key + ":" + Text(entry.Value, key);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    }
}
