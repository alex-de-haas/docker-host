using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// Private persisted digest of the settings and external mounts actually supplied at start.
// Hash inputs never reach the API: settings may include secrets. Runtime metadata and policy
// switches (autostart, update policy) do not change the process configuration.
internal static class AppConfigurationFingerprint
{
    public static IReadOnlyList<RuntimeMount> ResolveMounts(AppRecord app, GlobalMountState library)
    {
        var (bindings, readOnly) = RuntimeMountPlanner.MaterializeBindings(
            app.Mounts, library.Mounts.ToDictionary(mount => mount.Name, StringComparer.Ordinal));
        return RuntimeMountPlanner.Resolve(app.MountSlots, bindings)
            .Select(mount => readOnly.Contains((mount.Key, mount.Label)) ? mount with { ReadOnly = true } : mount)
            .ToArray();
    }

    private static string? ComputeDesired(AppRecord app, GlobalMountState library)
    {
        try
        {
            return Compute(app, ResolveMounts(app, library)
                .Select(mount => mount with { HostPath = MountPathPolicy.ResolveRealPath(mount.HostPath) })
                .ToArray());
        }
        catch (Exception error) when (error is AppLifecycleException or IOException or UnauthorizedAccessException or ArgumentException)
        {
            // A broken path must not break app listing or prevent the operator from repairing it.
            return null;
        }
    }

    public static string Compute(AppRecord app, IReadOnlyList<RuntimeMount> mounts)
    {
        using var stream = new MemoryStream();
        using (var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true))
        {
            writer.Write("hosty-app-configuration-v1");
            writer.Write(app.Settings.Count);
            foreach (var (key, setting) in app.Settings.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            {
                writer.Write(key);
                writer.Write(setting.Value is not null);
                if (setting.Value is not null) writer.Write(setting.Value);
            }
            writer.Write(mounts.Count);
            foreach (var mount in mounts.OrderBy(mount => mount.Key, StringComparer.Ordinal).ThenBy(mount => mount.Label, StringComparer.Ordinal))
            {
                writer.Write(mount.Key);
                writer.Write(mount.Label);
                writer.Write(mount.HostPath);
                writer.Write(mount.ContainerPath);
                writer.Write(mount.ReadOnly);
                writer.Write(mount.Service ?? "");
            }
        }
        return Convert.ToHexString(SHA256.HashData(stream.ToArray()));
    }

    // Older Core versions did not record the applied snapshot. Capture the pre-edit configuration
    // on the first supported edit, rather than marking every existing running app as needing restart.
    public static AppRecord CaptureLegacyBaseline(AppRecord app, GlobalMountState library)
        => app.AppliedConfigurationHash is null && AppRuntimeStates.IsUp(app.RuntimeState)
            ? app with { AppliedConfigurationHash = ComputeDesired(app, library) ?? "" }
            : app;

    public static bool RequiresRestart(AppRecord app, GlobalMountState library)
        => AppRuntimeStates.IsUp(app.RuntimeState) && app.AppliedConfigurationHash is { } applied
            && !string.Equals(applied, ComputeDesired(app, library), StringComparison.Ordinal);
}
