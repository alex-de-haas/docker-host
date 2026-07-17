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

// The persisted overrides. `Auth` maps an auth setting key (the HOSTY_AUTH_* name) -> value in hours;
// `Ingress` maps an ingress setting key (the HOSTY_INGRESS_* name) -> its string value. Only keys the
// operator has explicitly set live here; an absent key falls back to the env var, then the built-in
// default. Env stays an ambient dev/fork override — the store simply wins over it when present. Both
// sections share one file and one schema version (adding `Ingress` is additive: an older auth-only file
// still parses, so the version is deliberately NOT bumped).
internal sealed class CoreSettingsDocument
{
    public string? SchemaVersion { get; init; }
    public IReadOnlyDictionary<string, double> Auth { get => field ?? EmptyAuth; init; } = EmptyAuth;
    public IReadOnlyDictionary<string, string> Ingress { get => field ?? EmptyIngress; init; } = EmptyIngress;
    // Update-check overrides (the background fleet sweep cadence). String-valued like `Ingress`;
    // additive to the schema for the same reason, so the version is deliberately NOT bumped.
    public IReadOnlyDictionary<string, string> Updates { get => field ?? EmptyUpdates; init; } = EmptyUpdates;
    // User-management overrides (currently just the disabled-user retention window). String-valued like
    // `Ingress`/`Updates`; additive to the schema for the same reason, so the version is NOT bumped.
    public IReadOnlyDictionary<string, string> Users { get => field ?? EmptyUsers; init; } = EmptyUsers;

    private static readonly IReadOnlyDictionary<string, double> EmptyAuth =
        new Dictionary<string, double>(StringComparer.Ordinal);

    private static readonly IReadOnlyDictionary<string, string> EmptyIngress =
        new Dictionary<string, string>(StringComparer.Ordinal);

    private static readonly IReadOnlyDictionary<string, string> EmptyUpdates =
        new Dictionary<string, string>(StringComparer.Ordinal);

    private static readonly IReadOnlyDictionary<string, string> EmptyUsers =
        new Dictionary<string, string>(StringComparer.Ordinal);
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

// The live ingress configuration Core hands to the cloudflared controller. Previously env-only and
// baked into HostyCoreRuntimeConfig at startup; now owned by CoreSettingsService so operator edits from
// the platform panel apply without a restart (config.yml is re-rendered on save). The config.yml output
// path stays a launch-only knob on HostyCoreRuntimeConfig — it is plumbing, not a behavior setting.
internal sealed record IngressSettings(
    string Provider,
    string? BaseDomain,
    string? TunnelId,
    string? CredentialsFile)
{
    public const string ProviderNone = "none";
    public const string ProviderCloudflared = "cloudflared";

    // The built-in baseline (no env, no override): ingress off.
    public static IngressSettings Defaults { get; } = new(ProviderNone, null, null, null);

    // True when a provider derives HOSTY_PUBLIC_ORIGIN_* and writes tunnel config; false ("none") leaves
    // exposure and origins to the operator.
    public bool ManagesPublicOrigins =>
        string.Equals(Provider, ProviderCloudflared, StringComparison.OrdinalIgnoreCase);

    public static IngressSettings FromEnvironment()
        => new(
            Provider: ReadValue("HOSTY_INGRESS_PROVIDER") ?? ProviderNone,
            BaseDomain: ReadValue("HOSTY_INGRESS_BASE_DOMAIN"),
            TunnelId: ReadValue("HOSTY_INGRESS_TUNNEL_ID"),
            // The credentials path is written verbatim into config.yml; cloudflared (run from another cwd
            // or as a service) cannot resolve relative or ~ paths, so resolve to absolute up front.
            CredentialsFile: ReadValue("HOSTY_INGRESS_CREDENTIALS_FILE") is { } path ? NormalizePath(path) : null);

    // Same shape as HostyCoreRuntimeConfig's former BuildIngressWarnings(), moved here so /api/core/status
    // reflects the live provider/domain after a save rather than the startup snapshot.
    public IReadOnlyList<string> BuildWarnings()
    {
        if (!ManagesPublicOrigins)
        {
            return [];
        }

        var warnings = new List<string>();
        if (string.IsNullOrWhiteSpace(BaseDomain))
        {
            warnings.Add("Ingress provider 'cloudflared' requires a base domain; tunnel config will not be written.");
        }
        else if (!CloudflaredIngressPlanner.IsValidHostname(BaseDomain))
        {
            warnings.Add($"Ingress base domain '{BaseDomain}' is not a valid lowercase domain; ingress hostnames will be skipped.");
        }

        if (string.IsNullOrWhiteSpace(TunnelId))
        {
            warnings.Add("Ingress provider 'cloudflared' requires a tunnel ID; tunnel config will not be written.");
        }

        if (string.IsNullOrWhiteSpace(CredentialsFile))
        {
            warnings.Add("Ingress provider 'cloudflared' requires a credentials file; tunnel config will not be written.");
        }

        return warnings;
    }

    private static string? ReadValue(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
    }

    internal static string NormalizePath(string path)
    {
        try
        {
            if (path.StartsWith("~/", StringComparison.Ordinal) || path.StartsWith("~\\", StringComparison.Ordinal))
            {
                var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                path = Path.Combine(home, path[2..]);
            }

            return Path.GetFullPath(path);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException or System.Security.SecurityException)
        {
            // A pathological credentials path (invalid chars, too long) must not crash Core — this runs at
            // startup via FromEnvironment (CoreSettingsService construction) and on the save path via
            // NormalizeIngressValue. Keep the raw value; the credentials-file warning / cloudflared surface
            // the bad path instead.
            return path;
        }
    }
}

// The background fleet update-check cadence (plan-first updates, phase 2). Interval in minutes; 0
// disables the scheduler entirely — manual checks (POST /api/apps/update-check and the per-app
// refresh) stay available either way. Env baseline with a persisted override on top, like the other
// Core settings sections.
internal sealed record UpdateCheckSettings(int IntervalMinutes)
{
    public const string IntervalKey = "HOSTY_UPDATE_CHECK_INTERVAL_MINUTES";
    public const int DefaultIntervalMinutes = 60;
    // A week; anything longer means "use 0 and check manually".
    public const int MaxIntervalMinutes = 10080;

    public static UpdateCheckSettings Defaults { get; } = new(DefaultIntervalMinutes);

    public bool Enabled => IntervalMinutes > 0;

    public TimeSpan Interval => TimeSpan.FromMinutes(IntervalMinutes);

    public static UpdateCheckSettings FromEnvironment()
    {
        var raw = Environment.GetEnvironmentVariable(IntervalKey);
        return TryParseIntervalMinutes(raw, out var minutes)
            ? new UpdateCheckSettings(minutes)
            : Defaults;
    }

    public static bool TryParseIntervalMinutes(string? raw, out int minutes)
    {
        minutes = 0;
        return int.TryParse(raw?.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out minutes)
            && minutes is >= 0 and <= MaxIntervalMinutes;
    }
}

internal static class CoreUpdateCheckSettings
{
    public const string Group = "App updates";

    public const string IntervalLabel = "Background check interval";

    public const string IntervalDescription =
        "How often Core checks installed apps for updates in the background, in minutes. Apps "
        + "running live from a source folder have no reviewed-update path and are not checked. "
        + "0 disables the background check; manual checks stay available.";

    public static bool IsKnown(string key)
        => string.Equals(key, UpdateCheckSettings.IntervalKey, StringComparison.Ordinal);
}

// The update-check equivalent of CoreSettingRow: a single numeric row.
internal sealed record CoreUpdateCheckSettingRow(int EffectiveIntervalMinutes, bool Overridden);

// How long a disabled ("deleted") user's record is retained before the background purge removes it for
// good — the record, its password credential, and any leftover sessions/assignments. Days; 0 disables
// the automatic purge entirely (records then linger until an admin deletes them by hand). Env baseline
// with a persisted override on top, like the other Core settings sections.
internal sealed record UserRetentionSettings(int DisabledRetentionDays)
{
    public const string DisabledRetentionDaysKey = "HOSTY_USERS_DISABLED_RETENTION_DAYS";
    public const int DefaultDisabledRetentionDays = 10;
    // Ten years; anything longer means "use 0 and delete by hand".
    public const int MaxDisabledRetentionDays = 3650;

    public static UserRetentionSettings Defaults { get; } = new(DefaultDisabledRetentionDays);

    // 0 turns the automatic purge off; manual permanent deletion stays available either way.
    public bool AutoPurgeEnabled => DisabledRetentionDays > 0;

    public TimeSpan DisabledRetention => TimeSpan.FromDays(DisabledRetentionDays);

    public static UserRetentionSettings FromEnvironment()
    {
        var raw = Environment.GetEnvironmentVariable(DisabledRetentionDaysKey);
        return TryParseRetentionDays(raw, out var days)
            ? new UserRetentionSettings(days)
            : Defaults;
    }

    public static bool TryParseRetentionDays(string? raw, out int days)
    {
        days = 0;
        return int.TryParse(raw?.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out days)
            && days is >= 0 and <= MaxDisabledRetentionDays;
    }
}

internal static class CoreUserRetentionSettings
{
    public const string Group = "User management";

    public const string RetentionLabel = "Delete disabled users after";

    public const string RetentionDescription =
        "How many days a disabled user is kept before Core permanently deletes the account — its "
        + "record, password credential, and any leftover sessions. The countdown starts when the user "
        + "is disabled. 0 keeps disabled users indefinitely; you can still delete them by hand. Deleting "
        + "an account frees its email to be invited again.";

    public static bool IsKnown(string key)
        => string.Equals(key, UserRetentionSettings.DisabledRetentionDaysKey, StringComparison.Ordinal);
}

// The user-retention equivalent of CoreSettingRow: a single numeric row.
internal sealed record CoreUserRetentionSettingRow(int EffectiveRetentionDays, bool Overridden);

// A choice for a select-typed setting: the stored value and the label the Shell shows.
internal sealed record CoreSettingOption(string Value, string Label);

// One editable ingress setting: its stable key (the env var name), presentation metadata, and the
// projection to/from IngressSettings so the store, the endpoint, and the effective value share one
// source of truth. Mirrors CoreAuthSettingDefinition but for string values.
internal sealed record CoreIngressSettingDefinition(
    string Key,
    string Group,
    string Label,
    string Description,
    string Type,
    IReadOnlyList<CoreSettingOption>? Options,
    Func<IngressSettings, string?> Get,
    Func<IngressSettings, string, IngressSettings> With)
{
    public string DefaultValue => Get(IngressSettings.Defaults) ?? string.Empty;
}

internal static class CoreIngressSettings
{
    public const string Group = "Public ingress";

    public static readonly IReadOnlyList<CoreIngressSettingDefinition> All =
    [
        new("HOSTY_INGRESS_PROVIDER", Group, "Provider",
            "How app ports are exposed to the internet. 'Cloudflare Tunnel' writes a tunnel config that an "
            + "operator-run cloudflared reads and derives https public origins; 'Disabled' leaves exposure to "
            + "you. You must create the tunnel, its credentials file, and a wildcard DNS record and run "
            + "cloudflared yourself — Hosty only writes its config. See docs/features/cloudflared-ingress.md.",
            "select",
            [new(IngressSettings.ProviderNone, "Disabled"), new(IngressSettings.ProviderCloudflared, "Cloudflare Tunnel")],
            x => x.Provider, (x, v) => x with { Provider = v }),
        new("HOSTY_INGRESS_BASE_DOMAIN", Group, "Base domain",
            "The domain apps are published under, e.g. example.com. Each app gets a single-level subdomain "
            + "(app.example.com) covered by one wildcard CNAME.",
            "text", Options: null,
            x => x.BaseDomain, (x, v) => x with { BaseDomain = v }),
        new("HOSTY_INGRESS_TUNNEL_ID", Group, "Tunnel ID",
            "The cloudflared tunnel UUID (from `cloudflared tunnel create`) written into the tunnel config.",
            "text", Options: null,
            x => x.TunnelId, (x, v) => x with { TunnelId = v }),
        new("HOSTY_INGRESS_CREDENTIALS_FILE", Group, "Credentials file",
            "Absolute path to the tunnel's credentials JSON on this host, written verbatim into the tunnel "
            + "config for cloudflared to read.",
            "text", Options: null,
            x => x.CredentialsFile, (x, v) => x with { CredentialsFile = v }),
    ];

    private static readonly IReadOnlySet<string> Keys = All.Select(d => d.Key).ToHashSet(StringComparer.Ordinal);

    public static bool IsKnown(string key) => Keys.Contains(key);

    public static CoreIngressSettingDefinition Get(string key) => All.Single(d => d.Key == key);
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

// The ingress equivalent of CoreSettingRow: string-valued rather than hours.
internal sealed record CoreIngressSettingRow(CoreIngressSettingDefinition Definition, string EffectiveValue, bool Overridden);

// Singleton source of truth for editable Core behavior settings. Holds the current effective
// AuthLifetimes (env baseline overlaid with persisted overrides) so grant/session issuance reads the
// live value rather than a startup snapshot. Writes go through UpdateAsync, which persists and
// recomputes atomically; the cached record is swapped by reference, so readers are lock-free.
internal sealed class CoreSettingsService
{
    private readonly CoreSettingsStore store;
    private readonly SemaphoreSlim gate = new(1, 1);
    private Dictionary<string, double> overrides;
    private Dictionary<string, string> ingressOverrides;
    private Dictionary<string, string> updateCheckOverrides;
    private Dictionary<string, string> userRetentionOverrides;
    private volatile AuthLifetimes current;
    private volatile IngressSettings currentIngress;
    private volatile UpdateCheckSettings currentUpdateCheck;
    private volatile UserRetentionSettings currentUserRetention;

    public CoreSettingsService(CoreSettingsStore store)
    {
        this.store = store;
        var document = store.Load();
        overrides = LoadOverrides(document);
        ingressOverrides = LoadIngressOverrides(document);
        updateCheckOverrides = LoadUpdateCheckOverrides(document);
        userRetentionOverrides = LoadUserRetentionOverrides(document);
        current = Compute(overrides);
        currentIngress = ComputeIngress(ingressOverrides);
        currentUpdateCheck = ComputeUpdateCheck(updateCheckOverrides);
        currentUserRetention = ComputeUserRetention(userRetentionOverrides);
    }

    // The live auth lifetimes: env-or-default baseline with persisted overrides applied.
    public AuthLifetimes AuthLifetimes => current;

    // The live ingress config: env-or-default baseline with persisted overrides applied. Read by the
    // cloudflared controller (per reconcile) and /api/core/status, so a save takes effect without restart.
    public IngressSettings Ingress => currentIngress;

    // The live update-check cadence: env-or-default baseline with a persisted override applied. Read by
    // the sweep scheduler each cycle, so a save takes effect without restart.
    public UpdateCheckSettings UpdateCheck => currentUpdateCheck;

    // The live disabled-user retention window: env-or-default baseline with a persisted override applied.
    // Read by the purge scheduler each cycle, so a save takes effect without restart.
    public UserRetentionSettings UserRetention => currentUserRetention;

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

    public IReadOnlyList<CoreIngressSettingRow> GetIngressRows()
    {
        var ingress = currentIngress;
        var active = ingressOverrides;
        return CoreIngressSettings.All
            .Select(definition => new CoreIngressSettingRow(
                definition,
                definition.Get(ingress) ?? string.Empty,
                Overridden: active.ContainsKey(definition.Key)))
            .ToArray();
    }

    public CoreUpdateCheckSettingRow GetUpdateCheckRow()
        => new(currentUpdateCheck.IntervalMinutes, Overridden: updateCheckOverrides.ContainsKey(UpdateCheckSettings.IntervalKey));

    public CoreUserRetentionSettingRow GetUserRetentionRow()
        => new(currentUserRetention.DisabledRetentionDays, Overridden: userRetentionOverrides.ContainsKey(UserRetentionSettings.DisabledRetentionDaysKey));

    // True when at least one of the submitted keys is an ingress setting — the endpoint uses this to
    // decide whether a save must re-render the tunnel config.
    public static bool TouchesIngress(IReadOnlyDictionary<string, string?> input)
        => input.Keys.Any(CoreIngressSettings.IsKnown);

    // Applies the submitted overrides, persists them, and recomputes the effective auth + ingress
    // settings. Values arrive as raw strings (the PUT payload shape); a null or blank value clears the
    // override for that key so it falls back to the env var / built-in default — the per-app settings
    // "null to clear" contract. Unknown keys or invalid values throw AppLifecycleException (surfaced as
    // 400). Auth keys carry a number of hours; ingress keys carry their string value.
    public async Task UpdateAsync(IReadOnlyDictionary<string, string?> input, CancellationToken cancellationToken = default)
    {
        // Parse + validate everything before touching state, so a single bad key rejects the whole PUT.
        var authChanges = new Dictionary<string, double?>(StringComparer.Ordinal);
        var ingressChanges = new Dictionary<string, string?>(StringComparer.Ordinal);
        var updateCheckChanges = new Dictionary<string, string?>(StringComparer.Ordinal);
        var userRetentionChanges = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var (key, raw) in input)
        {
            if (CoreAuthSettings.IsKnown(key))
            {
                authChanges[key] = ParseAuthValue(key, raw);
            }
            else if (CoreIngressSettings.IsKnown(key))
            {
                ingressChanges[key] = NormalizeIngressValue(key, raw);
            }
            else if (CoreUpdateCheckSettings.IsKnown(key))
            {
                updateCheckChanges[key] = NormalizeUpdateCheckValue(key, raw);
            }
            else if (CoreUserRetentionSettings.IsKnown(key))
            {
                userRetentionChanges[key] = NormalizeUserRetentionValue(key, raw);
            }
            else
            {
                throw new AppLifecycleException("core_setting_unknown", $"Unknown Core setting '{key}'.");
            }
        }

        await gate.WaitAsync(cancellationToken);
        try
        {
            var mergedAuth = Apply(overrides, authChanges);
            var mergedIngress = Apply(ingressOverrides, ingressChanges);
            var mergedUpdateCheck = Apply(updateCheckOverrides, updateCheckChanges);
            var mergedUserRetention = Apply(userRetentionOverrides, userRetentionChanges);

            await store.SaveAsync(
                new CoreSettingsDocument
                {
                    SchemaVersion = CoreSettingsSchema.Version,
                    Auth = mergedAuth,
                    Ingress = mergedIngress,
                    Updates = mergedUpdateCheck,
                    Users = mergedUserRetention,
                },
                cancellationToken);
            overrides = mergedAuth;
            ingressOverrides = mergedIngress;
            updateCheckOverrides = mergedUpdateCheck;
            userRetentionOverrides = mergedUserRetention;
            current = Compute(mergedAuth);
            currentIngress = ComputeIngress(mergedIngress);
            currentUpdateCheck = ComputeUpdateCheck(mergedUpdateCheck);
            currentUserRetention = ComputeUserRetention(mergedUserRetention);
        }
        finally
        {
            gate.Release();
        }
    }

    // Overlays the parsed changes onto a copy of the current overrides: a present value sets it, a null
    // removes it (clear -> fall back to env/default).
    private static Dictionary<string, T> Apply<T>(Dictionary<string, T> current, Dictionary<string, T?> changes)
        where T : struct
    {
        var merged = new Dictionary<string, T>(current, StringComparer.Ordinal);
        foreach (var (key, value) in changes)
        {
            if (value is { } present)
            {
                merged[key] = present;
            }
            else
            {
                merged.Remove(key);
            }
        }

        return merged;
    }

    private static Dictionary<string, string> Apply(Dictionary<string, string> current, Dictionary<string, string?> changes)
    {
        var merged = new Dictionary<string, string>(current, StringComparer.Ordinal);
        foreach (var (key, value) in changes)
        {
            if (value is { } present)
            {
                merged[key] = present;
            }
            else
            {
                merged.Remove(key);
            }
        }

        return merged;
    }

    private static double? ParseAuthValue(string key, string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        if (!double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var hours) ||
            !TryFromHours(hours, out _))
        {
            throw new AppLifecycleException("core_setting_invalid", $"'{key}' must be a positive number of hours within range.");
        }

        return hours;
    }

    // Validates an update-check value for persistence, or null to clear. Stored as the canonical
    // integer string so the document stays culture-stable.
    private static string? NormalizeUpdateCheckValue(string key, string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        if (!UpdateCheckSettings.TryParseIntervalMinutes(raw, out var minutes))
        {
            throw new AppLifecycleException(
                "core_setting_invalid",
                $"'{key}' must be a whole number of minutes between 0 (disabled) and {UpdateCheckSettings.MaxIntervalMinutes}.");
        }

        return minutes.ToString(CultureInfo.InvariantCulture);
    }

    // Validates a disabled-user retention value for persistence, or null to clear. Stored as the
    // canonical integer string so the document stays culture-stable.
    private static string? NormalizeUserRetentionValue(string key, string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        if (!UserRetentionSettings.TryParseRetentionDays(raw, out var days))
        {
            throw new AppLifecycleException(
                "core_setting_invalid",
                $"'{key}' must be a whole number of days between 0 (never delete) and {UserRetentionSettings.MaxDisabledRetentionDays}.");
        }

        return days.ToString(CultureInfo.InvariantCulture);
    }

    // Validates and canonicalizes an ingress value for persistence, or null to clear. Missing pieces for
    // a cloudflared provider are surfaced as /api/core/status warnings, not rejected here, so an operator
    // can fill the fields in any order.
    private static string? NormalizeIngressValue(string key, string? raw)
    {
        var value = raw?.Trim();
        if (string.IsNullOrEmpty(value))
        {
            return null;
        }

        if (key == "HOSTY_INGRESS_PROVIDER")
        {
            var provider = value.ToLowerInvariant();
            if (provider is not (IngressSettings.ProviderNone or IngressSettings.ProviderCloudflared))
            {
                throw new AppLifecycleException("core_setting_invalid",
                    $"Ingress provider must be '{IngressSettings.ProviderNone}' or '{IngressSettings.ProviderCloudflared}'.");
            }

            return provider;
        }

        if (key == "HOSTY_INGRESS_BASE_DOMAIN")
        {
            // Canonicalize to lowercase before validating/persisting: DNS is case-insensitive but the
            // planner's hostname regex and Cloudflare expect lowercase, so accept "Example.com".
            var domain = value.ToLowerInvariant();
            if (!CloudflaredIngressPlanner.IsValidHostname(domain))
            {
                throw new AppLifecycleException("core_setting_invalid",
                    $"'{value}' is not a valid domain.");
            }

            return domain;
        }

        if (key == "HOSTY_INGRESS_CREDENTIALS_FILE")
        {
            return IngressSettings.NormalizePath(value);
        }

        return value;
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

    private static Dictionary<string, string> LoadIngressOverrides(CoreSettingsDocument document)
    {
        var overrides = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, value) in document.Ingress)
        {
            // Same per-entry tolerance as the auth overrides: skip unknown keys, blanks, and a
            // hand-edited provider that is neither 'none' nor 'cloudflared' rather than crashing startup.
            if (!CoreIngressSettings.IsKnown(key) || string.IsNullOrWhiteSpace(value))
            {
                continue;
            }

            if (key == "HOSTY_INGRESS_PROVIDER" &&
                value is not (IngressSettings.ProviderNone or IngressSettings.ProviderCloudflared))
            {
                continue;
            }

            overrides[key] = value;
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

    private static IngressSettings ComputeIngress(IReadOnlyDictionary<string, string> overrides)
    {
        var ingress = IngressSettings.FromEnvironment();
        foreach (var definition in CoreIngressSettings.All)
        {
            if (overrides.TryGetValue(definition.Key, out var value))
            {
                ingress = definition.With(ingress, value);
            }
        }

        return ingress;
    }

    private static Dictionary<string, string> LoadUpdateCheckOverrides(CoreSettingsDocument document)
    {
        var loaded = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, value) in document.Updates)
        {
            // Same per-entry tolerance as the other sections: skip unknown keys and hand-edited
            // values that do not parse rather than crashing startup.
            if (!CoreUpdateCheckSettings.IsKnown(key) || !UpdateCheckSettings.TryParseIntervalMinutes(value, out _))
            {
                continue;
            }

            loaded[key] = value;
        }

        return loaded;
    }

    private static UpdateCheckSettings ComputeUpdateCheck(IReadOnlyDictionary<string, string> overrides)
    {
        var settings = UpdateCheckSettings.FromEnvironment();
        if (overrides.TryGetValue(UpdateCheckSettings.IntervalKey, out var raw) &&
            UpdateCheckSettings.TryParseIntervalMinutes(raw, out var minutes))
        {
            settings = settings with { IntervalMinutes = minutes };
        }

        return settings;
    }

    private static Dictionary<string, string> LoadUserRetentionOverrides(CoreSettingsDocument document)
    {
        var loaded = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, value) in document.Users)
        {
            // Same per-entry tolerance as the other sections: skip unknown keys and hand-edited
            // values that do not parse rather than crashing startup.
            if (!CoreUserRetentionSettings.IsKnown(key) || !UserRetentionSettings.TryParseRetentionDays(value, out _))
            {
                continue;
            }

            loaded[key] = value;
        }

        return loaded;
    }

    private static UserRetentionSettings ComputeUserRetention(IReadOnlyDictionary<string, string> overrides)
    {
        var settings = UserRetentionSettings.FromEnvironment();
        if (overrides.TryGetValue(UserRetentionSettings.DisabledRetentionDaysKey, out var raw) &&
            UserRetentionSettings.TryParseRetentionDays(raw, out var days))
        {
            settings = settings with { DisabledRetentionDays = days };
        }

        return settings;
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
