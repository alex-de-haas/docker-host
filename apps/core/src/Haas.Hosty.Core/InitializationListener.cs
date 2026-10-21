using Haas.Hosty.Initialization;

namespace Haas.Hosty.Core;

internal sealed record InitializationListenerState(int Port, bool Automatic, bool Ready);

internal static class InitializationListener
{
    internal static string PathFor(string root) => Path.Combine(root, "core", "initialization-listener.json");
    internal static async Task<(HostyCoreRuntimeConfig Config, InitializationListenerState? State)> PrepareAsync(
        HostyCoreRuntimeConfig config, bool explicitlyBound, CancellationToken ct = default)
    {
        if (!InitializationFiles.Requested(config.DataRoot)) return (config, null);
        var state = await JsonStorage.ReadAsync<InitializationListenerState>(PathFor(config.DataRoot), ct);
        if (state is null)
        {
            // A pre-existing settings port is an operator/legacy binding. Never silently renumber it.
            var automatic = !explicitlyBound && CoreSettingsStore.TryReadStoredPort(Path.Combine(config.DataRoot, "core")) is null;
            state = new(config.CorePort, automatic, false);
        }
        if (state.Port is < 1024 or > 65535)
            throw new IOException("Invalid initialization listener state. Preserve this data root and repair its saved port.");
        if (state.Ready) return (config, state);
        if (explicitlyBound && config.CorePort != state.Port)
            throw new IOException("Initialization already accepted a Core port. Resume without a new --port override.");
        if (state.Automatic && !RuntimePortHelper.IsLoopbackTcpPortAvailable(state.Port))
            state = state with { Port = RuntimePortHelper.AllocateLoopbackPort() };
        // Persist before binding so a collision/crash is distinguishable from a stable installation.
        await JsonStorage.WriteAsync(PathFor(config.DataRoot), state, restrictToOwner: true, ct);
        return (config with { CorePort = state.Port, ListenUrl = explicitlyBound ? config.ListenUrl : $"http://localhost:{state.Port}" }, state);
    }
    internal static Task MarkReadyAsync(string root, InitializationListenerState state)
        => JsonStorage.WriteAsync(PathFor(root), state with { Ready = true }, restrictToOwner: true);
}
