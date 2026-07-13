namespace Haas.Hosty.Core;

// Registry of platform capability slots an app can declare via the manifest's top-level `provides`.
// Core keys two things off a provided slot: Core-owned provisioning that must run before the app's
// services start, and start ordering relative to other apps. Because the trigger is the declared
// capability (not the app id or the install path), an app installed through the marketplace or a
// direct install gets the same treatment as a bootstrap install — this is what lets the telemetry
// collector, and any third-party app that declares the same slot, work outside the boot path.
// See docs/ideas/generic-bootstrap.md (Phase 4).
internal sealed record PlatformCapability(
    string Slot,
    // Higher starts earlier in autostart ordering. A provider of OTLP, for example, must be up before
    // the apps that export to it so its endpoint URL is resolved and persisted first.
    int StartPriority,
    // Core-owned provisioning for the slot, run on the start path before the app's services launch.
    // Null means the slot only affects ordering. Receives the concrete app id so a provider with any
    // id (not just the first-party one) is provisioned into its own app-data dir.
    Func<CoreLifecycleService, string, CancellationToken, Task>? ProvisionAsync);

internal static class PlatformCapabilities
{
    public const string OtlpCollector = "otlp-collector";

    private static readonly IReadOnlyDictionary<string, PlatformCapability> Registry =
        new Dictionary<string, PlatformCapability>(StringComparer.Ordinal)
        {
            [OtlpCollector] = new(
                OtlpCollector,
                StartPriority: 100,
                ProvisionAsync: CollectorBootstrap.ProvisionAsync),
        };

    // Start priority for an app: the highest priority across the slots it provides that Core knows,
    // or 0 (no ordering preference) when it provides none. Unknown slots are ignored.
    public static int StartPriority(IReadOnlyList<string>? provides)
    {
        if (provides is null)
        {
            return 0;
        }

        var priority = 0;
        foreach (var slot in provides)
        {
            if (Registry.TryGetValue(slot, out var capability) && capability.StartPriority > priority)
            {
                priority = capability.StartPriority;
            }
        }

        return priority;
    }

    // Runs Core-owned provisioning for every provided slot Core has a handler for, before the app's
    // services start. Idempotent by construction (each provisioner rewrites its own files), so it is
    // safe to run on every start. Unknown or handler-less slots are inert.
    public static async Task ProvisionAsync(
        CoreLifecycleService lifecycle,
        string appId,
        IReadOnlyList<string>? provides,
        CancellationToken cancellationToken)
    {
        if (provides is null)
        {
            return;
        }

        foreach (var slot in provides)
        {
            if (Registry.TryGetValue(slot, out var capability) && capability.ProvisionAsync is not null)
            {
                await capability.ProvisionAsync(lifecycle, appId, cancellationToken);
            }
        }
    }
}
