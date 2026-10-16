using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// Launch progress describes Core-owned preparation. It does not attest to a dev server's compiler.
internal sealed record AppLaunchProgress(string Stage, DateTimeOffset ChangedAt, string? Service = null, string? BuildState = null);
internal sealed record AppDevelopmentStatus(string ReloadMode, string ManifestState, bool? RestartRequired);

internal sealed partial class CoreLifecycleService
{
    private async Task SetLaunchProgressAsync(string appId, string stage, string? service, CancellationToken ct)
    {
        await apps.UpdateAppAsync(appId, current => current with
        {
            LaunchProgress = new(stage, clock.UtcNow, service, stage switch
            {
                "building" => "building",
                "build-ready" => "ready",
                "build-reused" => current.LaunchProgress?.BuildState == "ready" ? "ready" : "reused",
                _ => current.LaunchProgress?.BuildState,
            }),
        }, ct);
    }

    private static async Task<AppDevelopmentStatus?> ReadDevelopmentStatusAsync(AppRecord app, string? liveRoot, CancellationToken ct)
    {
        if (liveRoot is null) return null;
        try
        {
            var manifest = Path.Combine(CombineManifestSubpath(liveRoot, app.SourceState?.ManifestSubpath), "manifest.json");
            // Bounded reads, including same-size/same-mtime edits; no repository-wide scan on inventory.
            await using var stream = File.OpenRead(manifest);
            if (stream.Length > 2 * 1024 * 1024) return new("application-managed", "unavailable", null);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var buffer = new char[checked((int)stream.Length) + 1];
            var length = await reader.ReadBlockAsync(buffer.AsMemory(), ct);
            if (length == buffer.Length) return new("application-managed", "unavailable", null);
            var text = new string(buffer, 0, length);
            var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
            if (app.AppliedSourceManifestDigest is null) return new("application-managed", "unobserved", null);
            var changed = digest != app.AppliedSourceManifestDigest ||
                app.ActiveSourcePaths is { Count: > 0 } paths && !paths.Any(path => string.Equals(MountPathPolicy.ResolveRealPath(path), MountPathPolicy.ResolveRealPath(liveRoot), PathComparison));
            return new("application-managed", changed ? "changed" : "current", changed && AppRuntimeStates.IsUp(app.RuntimeState));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        { return new("application-managed", "unavailable", null); }
    }
}
