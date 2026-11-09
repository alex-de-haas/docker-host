using System.Globalization;

namespace Haas.Hosty.Core;

internal sealed record CoreDiagnosticsSettings(
    bool CountersEnabled = true, int SustainedRequests = 50, int BurstRequests = 200,
    int RecoverySeconds = 60, double TraceSampleRatio = 0.1);

internal sealed record CoreDiagnosticSetting(string Key, string Label, string Description, double Default, double Min, double Max, bool Integer = true);

internal static class CoreDiagnosticSettings
{
    public const string Enabled = "HOSTY_API_ACTIVITY_ENABLED";
    public const string Sustained = "HOSTY_API_ACTIVITY_SUSTAINED_REQUESTS";
    public const string Burst = "HOSTY_API_ACTIVITY_BURST_REQUESTS";
    public const string Recovery = "HOSTY_API_ACTIVITY_RECOVERY_SECONDS";
    public const string Sampling = "HOSTY_CORE_TRACE_SAMPLE_RATIO";
    public static readonly CoreDiagnosticSetting[] All =
    [
        new(Enabled, "API activity counters", "1 enables exact app request counters; 0 disables accounting for controlled diagnostics.", 1, 0, 1),
        new(Sustained, "Sustained API activity", "Warn above this request count in each of three consecutive 10-second windows. Never limits requests.", 50, 1, 1000000),
        new(Burst, "API request burst", "Warn above this request count in a rolling 10-second window. Never limits requests.", 200, 1, 1000000),
        new(Recovery, "API warning recovery", "Seconds continuously below half the sustained threshold before clearing a warning.", 60, 10, 3600),
        new(Sampling, "Core trace sampling", "Root trace ratio while an authorized reader is active (0–1). Parent sampling is respected; 1 records all roots for diagnosis.", 0.1, 0, 1, false),
    ];
    public static bool IsKnown(string key) => All.Any(d => d.Key == key);
    public static string? Normalize(string key, string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var d = All.Single(d => d.Key == key);
        if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) || !double.IsFinite(value)
            || value < d.Min || value > d.Max || (d.Integer && value != Math.Truncate(value)))
            throw new AppLifecycleException("core_setting_invalid", $"'{key}' must be {(d.Integer ? "an integer" : "a number")} between {d.Min} and {d.Max}.");
        return value.ToString(CultureInfo.InvariantCulture);
    }
    public static void Validate(IReadOnlyDictionary<string, string> values)
    {
        var settings = Compute(values);
        if (settings.BurstRequests < settings.SustainedRequests)
            throw new AppLifecycleException("core_setting_invalid", "The burst threshold must be at least the sustained threshold.");
    }
    public static Dictionary<string, string> Load(CoreSettingsDocument document)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, raw) in document.Diagnostics)
        {
            if (!IsKnown(key)) continue;
            try { if (Normalize(key, raw) is { } value) values[key] = value; }
            catch (AppLifecycleException) { /* Invalid persisted overrides fall back to defaults. */ }
        }
        if (Compute(values) is { } settings && settings.BurstRequests < settings.SustainedRequests)
        { values.Remove(Sustained); values.Remove(Burst); }
        return values;
    }
    public static CoreDiagnosticsSettings Compute(IReadOnlyDictionary<string, string> values)
    {
        double Value(string key) => values.TryGetValue(key, out var raw) ? double.Parse(raw, CultureInfo.InvariantCulture) : All.Single(d => d.Key == key).Default;
        return new(Value(Enabled) == 1, (int)Value(Sustained), (int)Value(Burst), (int)Value(Recovery), Value(Sampling));
    }
}

internal sealed partial class CoreSettingsService
{
    private Dictionary<string, string> diagnosticOverrides = new(StringComparer.Ordinal);
    private volatile CoreDiagnosticsSettings diagnostics = new();
    public CoreDiagnosticsSettings Diagnostics => diagnostics;
    public IEnumerable<CoreSettingSummary> GetDiagnosticRows() => CoreDiagnosticSettings.All.Select(d => new CoreSettingSummary(
        d.Key, "number", diagnosticOverrides.GetValueOrDefault(d.Key) ?? d.Default.ToString(CultureInfo.InvariantCulture),
        d.Default.ToString(CultureInfo.InvariantCulture), "Diagnostics", d.Label, d.Description, diagnosticOverrides.ContainsKey(d.Key)));
}
