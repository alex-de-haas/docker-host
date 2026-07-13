using System.Globalization;

namespace Haas.Hosty.Core;

// Configurable idle + absolute lifetimes for app session grants and Core browser sessions. This record
// is immutable, but the effective value is no longer a startup snapshot: CoreSettingsService owns it
// and AuthLifetimes is DI-registered as a transient resolved from that service, so operator edits from
// the platform panel apply live (idle immediately, absolute for sessions/grants issued afterward) — see
// CoreSettings.cs and docs/ideas/core-settings.md. Because every revalidation re-checks role /
// assignment / disabled online and grants are instantly revocable server-side, the defaults are days,
// not hours — short TTLs would recreate the daily-login problem without adding real security. System
// apps (all host.admin) get a tighter window than regular apps. See docs/ideas/auth-session-lifecycle.md.
internal sealed record AuthLifetimes(
    TimeSpan AppGrantIdle,
    TimeSpan AppGrantAbsolute,
    TimeSpan SystemGrantIdle,
    TimeSpan SystemGrantAbsolute,
    TimeSpan CliGrantLifetime,
    TimeSpan CoreSessionIdle,
    TimeSpan CoreSessionAbsolute)
{
    public static AuthLifetimes Defaults { get; } = new(
        AppGrantIdle: TimeSpan.FromDays(7),
        AppGrantAbsolute: TimeSpan.FromDays(30),
        SystemGrantIdle: TimeSpan.FromDays(3),
        SystemGrantAbsolute: TimeSpan.FromDays(14),
        CliGrantLifetime: TimeSpan.FromHours(12),
        CoreSessionIdle: TimeSpan.FromDays(7),
        CoreSessionAbsolute: TimeSpan.FromDays(30));

    public static AuthLifetimes FromEnvironment()
        => new(
            AppGrantIdle: ReadHours("HOSTY_AUTH_APP_GRANT_IDLE_HOURS", Defaults.AppGrantIdle),
            AppGrantAbsolute: ReadHours("HOSTY_AUTH_APP_GRANT_ABSOLUTE_HOURS", Defaults.AppGrantAbsolute),
            SystemGrantIdle: ReadHours("HOSTY_AUTH_SYSTEM_GRANT_IDLE_HOURS", Defaults.SystemGrantIdle),
            SystemGrantAbsolute: ReadHours("HOSTY_AUTH_SYSTEM_GRANT_ABSOLUTE_HOURS", Defaults.SystemGrantAbsolute),
            CliGrantLifetime: ReadHours("HOSTY_AUTH_CLI_GRANT_HOURS", Defaults.CliGrantLifetime),
            CoreSessionIdle: ReadHours("HOSTY_AUTH_CORE_SESSION_IDLE_HOURS", Defaults.CoreSessionIdle),
            CoreSessionAbsolute: ReadHours("HOSTY_AUTH_CORE_SESSION_ABSOLUTE_HOURS", Defaults.CoreSessionAbsolute));

    // Idle and absolute window for an app grant, chosen by whether the app is a system app and how the
    // grant was issued. CLI-diagnostic grants are probe credentials: a single short fixed lifetime.
    public (TimeSpan Idle, TimeSpan Absolute) ForGrant(bool systemApp, string issuedVia)
    {
        if (string.Equals(issuedVia, AppGrantIssuedVia.CliDiagnostic, StringComparison.Ordinal))
        {
            return (CliGrantLifetime, CliGrantLifetime);
        }

        return systemApp
            ? (SystemGrantIdle, SystemGrantAbsolute)
            : (AppGrantIdle, AppGrantAbsolute);
    }

    private static TimeSpan ReadHours(string name, TimeSpan fallback)
    {
        var raw = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }

        // A non-positive or unparseable value is ignored in favor of the safe default rather than
        // producing a zero/negative window that would expire every session immediately.
        if (!double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var hours) || hours <= 0)
        {
            return fallback;
        }

        try
        {
            return TimeSpan.FromHours(hours);
        }
        catch (OverflowException)
        {
            // An absurd value (typo, or Infinity) must not crash startup — this runs during service config.
            return fallback;
        }
    }
}

internal static class AppGrantIssuedVia
{
    public const string Code = "code";
    public const string CliDiagnostic = "cli-diagnostic";
}
