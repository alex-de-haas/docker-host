using Microsoft.Extensions.Configuration;

namespace HostySdk.App;

/// <summary>
/// Strongly-typed view over the generic <c>HOSTY_*</c> environment Hosty Core injects into
/// every service. App-specific variables (extra ports, public origins for named endpoints,
/// derived paths) stay app-side — compose this record rather than extending it.
/// </summary>
public sealed class HostyAppOptions
{
    /// <summary>The app's stable reverse-DNS id (token audience for identity validation).</summary>
    public required string AppId { get; init; }

    /// <summary>Service token used as the bearer when calling Core's internal/app APIs.</summary>
    public string? ServiceToken { get; init; }

    /// <summary>Process-to-Core origin (e.g. <c>http://host.docker.internal:7070</c>).</summary>
    public required string CoreOrigin { get; init; }

    /// <summary>Browser-facing Core origin (standalone recovery, links back to the Shell).</summary>
    public string? CorePublicOrigin { get; init; }

    /// <summary>Primary app data directory.</summary>
    public string? AppDataDir { get; init; }

    /// <summary>True when running inside a container (set by the .NET base image).</summary>
    public bool RunningInContainer { get; init; }

    /// <summary>True only when Core has provisioned a service token, i.e. we run under Core.</summary>
    public bool IsCoreManaged => !string.IsNullOrWhiteSpace(ServiceToken);

    /// <summary>
    /// Reads the options from configuration. Falls back to sane defaults so the app still
    /// boots for standalone local runs (outside Core); identity validation simply stays
    /// disabled without a service token.
    /// </summary>
    public static HostyAppOptions FromConfiguration(IConfiguration configuration, string appIdFallback)
    {
        string? Read(string key) => configuration[key] is { Length: > 0 } value ? value : null;

        return new HostyAppOptions
        {
            AppId = Read("HOSTY_APP_ID") ?? appIdFallback,
            ServiceToken = Read("HOSTY_APP_SERVICE_TOKEN"),
            CoreOrigin = Read("HOSTY_CORE_ORIGIN") ?? "http://localhost:7070",
            CorePublicOrigin = Read("HOSTY_CORE_PUBLIC_ORIGIN"),
            AppDataDir = Read("HOSTY_APP_DATA_DIR"),
            RunningInContainer = string.Equals(Read("DOTNET_RUNNING_IN_CONTAINER"), "true", StringComparison.OrdinalIgnoreCase),
        };
    }
}
