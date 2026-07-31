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
    TimeSpan CoreSessionAbsolute,
    TimeSpan AccessTokenIdle)
{
    public static AuthLifetimes Defaults { get; } = new(
        AppGrantIdle: TimeSpan.FromDays(7),
        AppGrantAbsolute: TimeSpan.FromDays(30),
        SystemGrantIdle: TimeSpan.FromDays(3),
        SystemGrantAbsolute: TimeSpan.FromDays(14),
        CliGrantLifetime: TimeSpan.FromHours(12),
        CoreSessionIdle: TimeSpan.FromDays(7),
        CoreSessionAbsolute: TimeSpan.FromDays(30),
        AccessTokenIdle: TimeSpan.FromDays(90));

    // The idle window for a credential, chosen by its kind. A browser session (null kind) keeps the
    // window it always had; an access token gets its own, longer one, because a console in a pocket or a
    // token in a keychain is not a browser tab and should not expire on a browser tab's schedule.
    public TimeSpan IdleFor(string? kind)
        => AccessTokenKinds.IsAccessToken(kind) ? AccessTokenIdle : CoreSessionIdle;

    public static AuthLifetimes FromEnvironment()
        => new(
            AppGrantIdle: ReadHours("HOSTY_AUTH_APP_GRANT_IDLE_HOURS", Defaults.AppGrantIdle),
            AppGrantAbsolute: ReadHours("HOSTY_AUTH_APP_GRANT_ABSOLUTE_HOURS", Defaults.AppGrantAbsolute),
            SystemGrantIdle: ReadHours("HOSTY_AUTH_SYSTEM_GRANT_IDLE_HOURS", Defaults.SystemGrantIdle),
            SystemGrantAbsolute: ReadHours("HOSTY_AUTH_SYSTEM_GRANT_ABSOLUTE_HOURS", Defaults.SystemGrantAbsolute),
            CliGrantLifetime: ReadHours("HOSTY_AUTH_CLI_GRANT_HOURS", Defaults.CliGrantLifetime),
            CoreSessionIdle: ReadHours("HOSTY_AUTH_CORE_SESSION_IDLE_HOURS", Defaults.CoreSessionIdle),
            CoreSessionAbsolute: ReadHours("HOSTY_AUTH_CORE_SESSION_ABSOLUTE_HOURS", Defaults.CoreSessionAbsolute),
            AccessTokenIdle: ReadHours("HOSTY_AUTH_ACCESS_TOKEN_IDLE_HOURS", Defaults.AccessTokenIdle));

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

// How a non-browser credential came to exist. Both kinds are the same record with the same powers and
// the same revocation; the distinction exists so the credential list can say where one came from.
//
// A null kind is not in this set: that is a browser session, and every record written before access
// tokens shipped has one.
internal static class AccessTokenKinds
{
    // Approved through the device authorization flow by a user looking at Shell.
    public const string Device = "device";

    // Created directly in Shell, its value shown once. The only source for `hosty login --token`, and
    // the path for a client that cannot run the device flow at all.
    public const string Manual = "manual";

    public static bool IsAccessToken(string? kind)
        => string.Equals(kind, Device, StringComparison.Ordinal) ||
            string.Equals(kind, Manual, StringComparison.Ordinal);

    public static bool IsKnown(string? kind) => IsAccessToken(kind);
}
