using System.Globalization;

namespace Haas.Hosty.Core;

// Host-admin surface over Core's own behavior settings (auth session/grant lifetimes and cloudflared
// ingress). The Shell platform panel's Settings section is the consumer; the payload mirrors the
// per-app settings shape (key/type/value/label/description) so Shell renders it with the same form
// components. Core stays the kernel — this is not an installed app, just its settings presented in the
// app shape. See docs/ideas/core-settings.md.
internal static class CoreSettingsEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/core/settings", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreSettingsService settings,
            CorePublicOriginResolver origins,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                () => Task.FromResult(CoreJson.Json(Build(settings, origins))),
                cancellationToken: cancellationToken));

        app.MapPut("/api/core/settings", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreSettingsService settings,
            CorePublicOriginResolver origins,
            CoreLifecycleService lifecycle,
            CoreSettingsUpdateRequest? input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                () => ApplyUpdateAsync(settings, origins, lifecycle, input, cancellationToken),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        // The same settings over the loopback control plane, for `hosty core settings`: on a headless
        // host (Shell optional, no admin browser session) this is the only way to edit a Core setting
        // at all — and the recovery path for a value that broke the UI. Same Build/ApplyUpdateAsync as
        // the admin surface, so the two can never diverge in shape or validation.
        app.MapGet("/control/v1/settings", (HttpRequest request, ControlSecret secret, CoreSettingsService settings, CorePublicOriginResolver origins) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => CoreJson.Json(Build(settings, origins))));
        app.MapPut("/control/v1/settings", async (
            HttpRequest request,
            ControlSecret secret,
            CoreSettingsService settings,
            CorePublicOriginResolver origins,
            CoreLifecycleService lifecycle,
            CoreSettingsUpdateRequest? input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(
                request,
                secret,
                () => ApplyUpdateAsync(settings, origins, lifecycle, input, cancellationToken)));
    }

    // One apply path for both surfaces (admin PUT and the control plane): the service does the
    // per-key parse/validate; this forwards the raw values, maps a validation failure to 400, and
    // live-applies ingress — an ingress change re-renders the tunnel config immediately from the
    // running-app set (best-effort; never fails the save). Non-ingress saves skip that.
    private static async Task<IResult> ApplyUpdateAsync(
        CoreSettingsService settings,
        CorePublicOriginResolver origins,
        CoreLifecycleService lifecycle,
        CoreSettingsUpdateRequest? input,
        CancellationToken cancellationToken)
    {
        if (input?.Settings is not { Count: > 0 } submitted)
        {
            return CoreJson.Json(
                new ErrorResponse("core_setting_invalid", "settings is required and must not be empty."),
                statusCode: StatusCodes.Status400BadRequest);
        }

        try
        {
            await settings.UpdateAsync(submitted, cancellationToken);
        }
        catch (AppLifecycleException ex)
        {
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: StatusCodes.Status400BadRequest);
        }

        if (CoreSettingsService.TouchesIngress(submitted))
        {
            await lifecycle.ReconcileIngressAsync(cancellationToken);
        }

        return CoreJson.Json(Build(settings, origins));
    }

    private static CoreSettingsResponse Build(CoreSettingsService settings, CorePublicOriginResolver origins)
    {
        var rows = new List<CoreSettingSummary>();
        foreach (var row in settings.GetAuthRows())
        {
            rows.Add(new CoreSettingSummary(
                row.Definition.Key,
                Type: "number",
                Value: CoreSettingsService.FormatHours(row.EffectiveHours),
                Default: CoreSettingsService.FormatHours(row.Definition.DefaultHours),
                Group: row.Definition.Group,
                Label: row.Definition.Label,
                Description: row.Definition.Description,
                Overridden: row.Overridden,
                Unit: "h",
                Options: null));
        }

        foreach (var row in settings.GetIngressRows())
        {
            rows.Add(new CoreSettingSummary(
                row.Definition.Key,
                Type: row.Definition.Type,
                Value: row.EffectiveValue,
                Default: row.Definition.DefaultValue,
                Group: row.Definition.Group,
                Label: row.Definition.Label,
                Description: row.Definition.Description,
                Overridden: row.Overridden,
                Unit: null,
                Options: row.Definition.Options));
        }

        var updateCheck = settings.GetUpdateCheckRow();
        rows.Add(new CoreSettingSummary(
            UpdateCheckSettings.IntervalKey,
            Type: "number",
            Value: updateCheck.EffectiveIntervalMinutes.ToString(CultureInfo.InvariantCulture),
            Default: UpdateCheckSettings.DefaultIntervalMinutes.ToString(CultureInfo.InvariantCulture),
            Group: CoreUpdateCheckSettings.Group,
            Label: CoreUpdateCheckSettings.IntervalLabel,
            Description: CoreUpdateCheckSettings.IntervalDescription,
            Overridden: updateCheck.Overridden,
            Unit: "min",
            Options: null));

        var userRetention = settings.GetUserRetentionRow();
        rows.Add(new CoreSettingSummary(
            UserRetentionSettings.DisabledRetentionDaysKey,
            Type: "number",
            Value: userRetention.EffectiveRetentionDays.ToString(CultureInfo.InvariantCulture),
            Default: UserRetentionSettings.DefaultDisabledRetentionDays.ToString(CultureInfo.InvariantCulture),
            Group: CoreUserRetentionSettings.Group,
            Label: CoreUserRetentionSettings.RetentionLabel,
            Description: CoreUserRetentionSettings.RetentionDescription,
            Overridden: userRetention.Overridden,
            Unit: "day",
            Options: null));

        var server = settings.GetServerRow();
        rows.Add(new CoreSettingSummary(
            ServerSettings.PortKey,
            Type: "number",
            Value: server.StoredOrDefaultPort.ToString(CultureInfo.InvariantCulture),
            Default: ServerSettings.DefaultPort.ToString(CultureInfo.InvariantCulture),
            Group: CoreServerSettings.Group,
            Label: CoreServerSettings.PortLabel,
            Description: CoreServerSettings.PortDescription,
            Overridden: server.Overridden,
            Unit: null,
            Options: null));

        // `Default` is what a reset lands on rather than a constant: clearing this falls back to the
        // environment baseline and only then to the listen URL, so a host launched with the variable set
        // must not be offered "reset to http://localhost:7070".
        var publicOrigin = origins.GetRow();
        rows.Add(new CoreSettingSummary(
            CoreOriginSettings.PublicOriginKey,
            Type: "url",
            Value: publicOrigin.EffectiveOrigin,
            Default: publicOrigin.BaselineOrigin,
            Group: CoreServerSettings.Group,
            Label: CoreServerSettings.PublicOriginLabel,
            Description: CoreServerSettings.PublicOriginDescription,
            Overridden: publicOrigin.Overridden,
            Unit: null,
            Options: null));

        var oauth = settings.GetOAuthRow();
        rows.Add(new CoreSettingSummary(
            OAuthSettings.DynamicRegistrationKey,
            Type: "select",
            Value: oauth.Enabled ? "true" : "false",
            Default: "false",
            Group: CoreOAuthSettings.Group,
            Label: CoreOAuthSettings.DynamicRegistrationLabel,
            Description: CoreOAuthSettings.DynamicRegistrationDescription,
            Overridden: oauth.Overridden,
            Unit: null,
            Options: [new CoreSettingOption("false", "Off"), new CoreSettingOption("true", "On")]));

        return new CoreSettingsResponse(rows);
    }
}

internal sealed record CoreSettingSummary(
    string Key,
    string Type,
    string Value,
    string Default,
    string Group,
    string? Label,
    string? Description,
    // True when a persisted override is driving Value (vs. env/default), so the UI can offer a reset.
    bool Overridden,
    // A display unit appended after Value/Default in the UI (e.g. "h" for hours), or null for none.
    string? Unit = null,
    // Choices for a select-typed setting, or null for free-form inputs.
    IReadOnlyList<CoreSettingOption>? Options = null);

internal sealed record CoreSettingsResponse(IReadOnlyList<CoreSettingSummary> Settings);

// A null or blank value for a key clears its override (falls back to env/default).
internal sealed record CoreSettingsUpdateRequest(IReadOnlyDictionary<string, string?>? Settings);
