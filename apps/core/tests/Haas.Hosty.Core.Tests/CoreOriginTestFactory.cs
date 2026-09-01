using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

// Builds the live public-origin resolver the way production wires it: over a real settings store on the
// fixture's data root, layered on the config's environment baseline. Tests that only need the baseline can
// ignore the returned service; the ones pinning "links follow the live value" write through it.
internal static class CoreOriginTestFactory
{
    public static (CorePublicOriginResolver Resolver, CoreSettingsService Settings) Create(
        HostyCoreRuntimeConfig config,
        CoreDataPaths paths)
    {
        var settings = new CoreSettingsService(new CoreSettingsStore(paths, NullLogger<CoreSettingsStore>.Instance));
        return (new CorePublicOriginResolver(config, settings), settings);
    }

    public static CorePublicOriginResolver CreateResolver(HostyCoreRuntimeConfig config, CoreDataPaths paths)
        => Create(config, paths).Resolver;

    // A resolver with no persisted override, for tests that only care about the environment baseline. The
    // root is a temp path that is never created — the settings store reads a missing file as "no
    // overrides" — which also keeps a config built from the real environment from reading the developer's
    // own settings.json.
    public static CorePublicOriginResolver CreateEnvironmentOnly(HostyCoreRuntimeConfig config)
        => CreateResolver(config, PathsFor(Path.Combine(Path.GetTempPath(), $"hosty-core-origin-tests-{Guid.NewGuid():N}")));

    public static CoreDataPaths PathsFor(string root)
        => new(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

    // Persists a public origin through the same path the settings endpoint uses, so a test exercises the
    // validation and the store rather than a shortcut around them.
    public static Task SetAsync(CoreSettingsService settings, string? origin, CancellationToken cancellationToken = default)
        => settings.UpdateAsync(
            new Dictionary<string, string?>(StringComparer.Ordinal) { ["HOSTY_CORE_PUBLIC_ORIGIN"] = origin },
            cancellationToken);
}
