using System.Globalization;

namespace Haas.Hosty.Core;

// Host-admin surface over Core's own behavior settings (auth session/grant lifetimes for now). The
// Shell platform panel's Settings section is the consumer; the payload mirrors the per-app settings
// shape (key/type/value/label/description) so Shell renders it with the same form components. Core
// stays the kernel — this is not an installed app, just its settings presented in the app shape.
// See docs/ideas/core-settings.md.
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

                    var parsed = new Dictionary<string, double?>(StringComparer.Ordinal);
                    foreach (var (key, raw) in submitted)
                    {
                        // Null or blank clears the override for that key so it falls back to env/default.
                        if (string.IsNullOrWhiteSpace(raw))
                        {
                            parsed[key] = null;
                            continue;
                        }

                        if (!double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var hours))
                        {
                            return CoreJson.Json(
                                new ErrorResponse("core_setting_invalid", $"'{key}' must be a number of hours."),
                                statusCode: StatusCodes.Status400BadRequest);
                        }

                        parsed[key] = hours;
                    }

                    try
                    {
                        await settings.UpdateAsync(parsed, cancellationToken);
                    }
                    catch (AppLifecycleException ex)
                    {
                        return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: StatusCodes.Status400BadRequest);
                    }

                    return CoreJson.Json(Build(settings));
                },
                requireCsrf: true,
                cancellationToken: cancellationToken));
    }

    private static CoreSettingsResponse Build(CoreSettingsService settings)
        => new(settings.GetAuthRows()
            .Select(row => new CoreSettingSummary(
                row.Definition.Key,
                Type: "number",
                Value: CoreSettingsService.FormatHours(row.EffectiveHours),
                Default: CoreSettingsService.FormatHours(row.Definition.DefaultHours),
                Group: row.Definition.Group,
                Label: row.Definition.Label,
                Description: row.Definition.Description,
                Overridden: row.Overridden))
            .ToArray());
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
    bool Overridden);

internal sealed record CoreSettingsResponse(IReadOnlyList<CoreSettingSummary> Settings);

// A null or blank value for a key clears its override (falls back to env/default).
internal sealed record CoreSettingsUpdateRequest(IReadOnlyDictionary<string, string?>? Settings);
