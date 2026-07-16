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
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                () => Task.FromResult(CoreJson.Json(Build(settings))),
                cancellationToken: cancellationToken));

        app.MapPut("/api/core/settings", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreSettingsService settings,
            CoreLifecycleService lifecycle,
            CoreSettingsUpdateRequest? input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () =>
                {
                    if (input?.Settings is not { Count: > 0 } submitted)
                    {
                        return CoreJson.Json(
                            new ErrorResponse("core_setting_invalid", "settings is required and must not be empty."),
                            statusCode: StatusCodes.Status400BadRequest);
                    }

                    // The service does the per-key parse/validate (auth hours vs ingress strings); the
                    // endpoint just forwards the raw values and maps a validation failure to 400.
                    try
                    {
                        await settings.UpdateAsync(submitted, cancellationToken);
                    }
                    catch (AppLifecycleException ex)
                    {
                        return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: StatusCodes.Status400BadRequest);
                    }

                    // Live-apply ingress: an ingress change re-renders the tunnel config immediately from
                    // the running-app set (best-effort; never fails the save). Auth-only saves skip this.
                    if (CoreSettingsService.TouchesIngress(submitted))
                    {
                        await lifecycle.ReconcileIngressAsync(cancellationToken);
                    }

                    return CoreJson.Json(Build(settings));
                },
                requireCsrf: true,
                cancellationToken: cancellationToken));
    }

    private static CoreSettingsResponse Build(CoreSettingsService settings)
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
