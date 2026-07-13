using System.Globalization;
using System.Text.Json;

namespace Haas.Hosty.Core;

// Core-owned behavior settings the operator edits from the Shell platform panel (not the CLI's
// launch settings). v1 carries the auth session/grant lifetimes that were previously env-only and
// startup-immutable. Persisted in the core data root; absent file means "follow env/defaults".
// See docs/ideas/core-settings.md.
internal static class CoreSettingsSchema
{
    public const string Version = "core-settings.0.1";
    public const string FileName = "settings.json";
}

// The persisted overrides: auth setting key (the HOSTY_AUTH_* name) -> value in hours. Only keys the
// operator has explicitly set live here; an absent key falls back to the env var, then the built-in
// default. Env stays an ambient dev/fork override — the store simply wins over it when present.
internal sealed class CoreSettingsDocument
{
    public string? SchemaVersion { get; init; }
    public IReadOnlyDictionary<string, double> Auth { get => field ?? EmptyAuth; init; } = EmptyAuth;

    private static readonly IReadOnlyDictionary<string, double> EmptyAuth =
        new Dictionary<string, double>(StringComparer.Ordinal);
}

// One editable auth-lifetime setting: its stable key (the env var name), presentation metadata, and
// the projection to/from the AuthLifetimes record so the store, the endpoint, and the effective value
// all share one source of truth.
internal sealed record CoreAuthSettingDefinition(
    string Key,
    string Group,
    string Label,
    string Description,
    Func<AuthLifetimes, TimeSpan> Get,
    Func<AuthLifetimes, TimeSpan, AuthLifetimes> With)
{
    public double DefaultHours => Get(AuthLifetimes.Defaults).TotalHours;
}

internal static class CoreAuthSettings
{
    private const string IdleDescription =
        "Sign-in expires after this many hours of inactivity. Applies immediately, including to existing sessions.";
    private const string AbsoluteDescription =
        "Hard cap on a session's total lifetime in hours, regardless of activity. Applies to sessions issued after the change; existing ones keep the cap they were issued with.";

    public static readonly IReadOnlyList<CoreAuthSettingDefinition> All =
    [
        new("HOSTY_AUTH_CORE_SESSION_IDLE_HOURS", "Admin session", "Idle timeout", IdleDescription,
            x => x.CoreSessionIdle, (x, t) => x with { CoreSessionIdle = t }),
        new("HOSTY_AUTH_CORE_SESSION_ABSOLUTE_HOURS", "Admin session", "Maximum lifetime", AbsoluteDescription,
            x => x.CoreSessionAbsolute, (x, t) => x with { CoreSessionAbsolute = t }),
        new("HOSTY_AUTH_APP_GRANT_IDLE_HOURS", "App sessions", "Idle timeout", IdleDescription,
            x => x.AppGrantIdle, (x, t) => x with { AppGrantIdle = t }),
        new("HOSTY_AUTH_APP_GRANT_ABSOLUTE_HOURS", "App sessions", "Maximum lifetime", AbsoluteDescription,
            x => x.AppGrantAbsolute, (x, t) => x with { AppGrantAbsolute = t }),
        new("HOSTY_AUTH_SYSTEM_GRANT_IDLE_HOURS", "System-app sessions", "Idle timeout", IdleDescription,
            x => x.SystemGrantIdle, (x, t) => x with { SystemGrantIdle = t }),
        new("HOSTY_AUTH_SYSTEM_GRANT_ABSOLUTE_HOURS", "System-app sessions", "Maximum lifetime", AbsoluteDescription,
            x => x.SystemGrantAbsolute, (x, t) => x with { SystemGrantAbsolute = t }),
        new("HOSTY_AUTH_CLI_GRANT_HOURS", "CLI diagnostic grants", "Lifetime",
            "Fixed lifetime in hours of the short-lived grant minted by `hosty apps identity`. Applies to grants issued after the change.",
            x => x.CliGrantLifetime, (x, t) => x with { CliGrantLifetime = t }),
    ];

    private static readonly IReadOnlySet<string> Keys = All.Select(d => d.Key).ToHashSet(StringComparer.Ordinal);

    public static bool IsKnown(string key) => Keys.Contains(key);
}

// Core-owned store for settings.json in the core data root. Unlike bootstrap-choices this file is
// written only by Core (the CLI has no equivalent), so no re-read-on-write dance is needed. The
// initial read is synchronous so CoreSettingsService can expose auth lifetimes without an async warm-up
// window; writes are atomic temp+rename via JsonStorage.
internal sealed class CoreSettingsStore(CoreDataPaths paths, ILogger<CoreSettingsStore> logger)
{
    private string FilePath => Path.Combine(paths.CoreRoot, CoreSettingsSchema.FileName);

    public CoreSettingsDocument Load()
    {
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(FilePath);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            return new CoreSettingsDocument();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Core settings file at {Path} could not be read; using env/defaults.", FilePath);
            return new CoreSettingsDocument();
        }

        CoreSettingsDocument? document;
        try
        {
            document = JsonSerializer.Deserialize(bytes, CoreJsonSerializerContext.Default.CoreSettingsDocument);
        }
        catch (JsonException ex)
        {
            logger.LogError(ex, "Core settings file at {Path} could not be parsed; using env/defaults. The file is left untouched.", FilePath);
            return new CoreSettingsDocument();
        }

        if (document is null)
        {
            return new CoreSettingsDocument();
        }

        if (!string.Equals(document.SchemaVersion, CoreSettingsSchema.Version, StringComparison.Ordinal))
        {
            logger.LogError(
                "Core settings file at {Path} declares schemaVersion '{SchemaVersion}' but this Core understands '{Expected}'; using env/defaults.",
                FilePath,
                document.SchemaVersion,
                CoreSettingsSchema.Version);
            return new CoreSettingsDocument();
        }

        return document;
    }

    public Task SaveAsync(CoreSettingsDocument document, CancellationToken cancellationToken = default)
        => JsonStorage.WriteAsync(FilePath, document, restrictToOwner: true, cancellationToken);
}

// One row for the settings endpoint: the definition, the current effective value, and whether a
// persisted override is what's driving it (so the UI can offer "reset to default").
internal sealed record CoreSettingRow(CoreAuthSettingDefinition Definition, double EffectiveHours, bool Overridden);

// Singleton source of truth for editable Core behavior settings. Holds the current effective
// AuthLifetimes (env baseline overlaid with persisted overrides) so grant/session issuance reads the
// live value rather than a startup snapshot. Writes go through UpdateAsync, which persists and
// recomputes atomically; the cached record is swapped by reference, so readers are lock-free.
internal sealed class CoreSettingsService
{
    private readonly CoreSettingsStore store;
    private readonly SemaphoreSlim gate = new(1, 1);
    private Dictionary<string, double> overrides;
    private volatile AuthLifetimes current;

    public CoreSettingsService(CoreSettingsStore store)
    {
        this.store = store;
        overrides = LoadOverrides(store.Load());
        current = Compute(overrides);
    }

    // The live auth lifetimes: env-or-default baseline with persisted overrides applied.
    public AuthLifetimes AuthLifetimes => current;

    public IReadOnlyList<CoreSettingRow> GetAuthRows()
    {
        // Pair the effective lifetimes with the override set they were computed from.
        var lifetimes = current;
        var active = overrides;
        return CoreAuthSettings.All
            .Select(definition => new CoreSettingRow(
                definition,
                definition.Get(lifetimes).TotalHours,
                Overridden: active.ContainsKey(definition.Key)))
            .ToArray();
    }

    // Applies the submitted overrides, persists them, and recomputes the effective lifetimes. A null
    // value clears the override for that key so it falls back to the env var / built-in default — the
    // per-app settings "null to clear" contract. Unknown keys or out-of-range values throw
    // AppLifecycleException (surfaced as 400).
    public async Task UpdateAsync(IReadOnlyDictionary<string, double?> input, CancellationToken cancellationToken = default)
    {
        foreach (var (key, hours) in input)
        {
            if (!CoreAuthSettings.IsKnown(key))
            {
                throw new AppLifecycleException("core_setting_unknown", $"Unknown Core setting '{key}'.");
            }

            if (hours is { } value && !TryFromHours(value, out _))
            {
                throw new AppLifecycleException("core_setting_invalid", $"'{key}' must be a positive number of hours within range.");
            }
        }

        await gate.WaitAsync(cancellationToken);
        try
        {
            var merged = new Dictionary<string, double>(overrides, StringComparer.Ordinal);
            foreach (var (key, hours) in input)
            {
                if (hours is { } value)
                {
                    merged[key] = value;
                }
                else
                {
                    merged.Remove(key);
                }
            }

            await store.SaveAsync(
                new CoreSettingsDocument { SchemaVersion = CoreSettingsSchema.Version, Auth = merged },
                cancellationToken);
            overrides = merged;
            current = Compute(merged);
        }
        finally
        {
            gate.Release();
        }
    }

    private static Dictionary<string, double> LoadOverrides(CoreSettingsDocument document)
    {
        var overrides = new Dictionary<string, double>(StringComparer.Ordinal);
        foreach (var (key, hours) in document.Auth)
        {
            // A file hand-edited to an unknown key or a bad value (non-positive, non-finite, or a
            // magnitude that overflows TimeSpan) is ignored per-entry rather than rejecting the whole
            // file or crashing startup — the same tolerance the env parser applies.
            if (CoreAuthSettings.IsKnown(key) && TryFromHours(hours, out _))
            {
                overrides[key] = hours;
            }
        }

        return overrides;
    }

    private static AuthLifetimes Compute(IReadOnlyDictionary<string, double> overrides)
    {
        var lifetimes = AuthLifetimes.FromEnvironment();
        foreach (var definition in CoreAuthSettings.All)
        {
            // Both entry points (LoadOverrides, UpdateAsync) already filter to convertible values, so
            // the guard here is belt-and-suspenders: Compute runs during service construction and must
            // never throw and take down startup.
            if (overrides.TryGetValue(definition.Key, out var hours) && TryFromHours(hours, out var span))
            {
                lifetimes = definition.With(lifetimes, span);
            }
        }

        return lifetimes;
    }

    // Converts an hours value to a TimeSpan, rejecting non-finite, non-positive, and out-of-range
    // magnitudes — TimeSpan.FromHours throws OverflowException for the last. Mirrors
    // AuthLifetimes.ReadHours so a hand-edited settings.json can never crash startup and an absurd PUT
    // value is a 400 rather than a persisted time bomb.
    private static bool TryFromHours(double hours, out TimeSpan span)
    {
        span = default;
        if (!double.IsFinite(hours) || hours <= 0)
        {
            return false;
        }

        try
        {
            span = TimeSpan.FromHours(hours);
            return true;
        }
        catch (OverflowException)
        {
            return false;
        }
    }

    public static string FormatHours(double hours) => hours.ToString(CultureInfo.InvariantCulture);
}
