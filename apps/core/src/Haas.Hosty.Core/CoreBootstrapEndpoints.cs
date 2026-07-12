namespace Haas.Hosty.Core;

// Host-admin surface over the generic bootstrap: what the release's distribution list offers, what
// the operator chose, and a live toggle. The Shell platform panel's Extensions section is the
// consumer; the CLI does not call these (hosty setup writes the choices file directly). See
// docs/ideas/generic-bootstrap.md (Phase 3).
internal static class CoreBootstrapEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/core/bootstrap", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            SystemAppBootstrapService bootstrap,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => CoreJson.Json(await BuildStateAsync(bootstrap, actionError: null, cancellationToken)),
                cancellationToken: cancellationToken));

        app.MapPost("/api/core/bootstrap/choices", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            SystemAppBootstrapService bootstrap,
            CoreBootstrapChoiceRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () =>
                {
                    if (string.IsNullOrWhiteSpace(input.AppId) || input.Enabled is not bool enabled)
                    {
                        return CoreJson.Json(
                            new ErrorResponse("bootstrap_choice_invalid", "appId and enabled are required."),
                            statusCode: StatusCodes.Status400BadRequest);
                    }

                    string? actionError;
                    try
                    {
                        actionError = await bootstrap.SetChoiceAsync(input.AppId.Trim(), enabled, cancellationToken);
                    }
                    catch (AppLifecycleException ex)
                    {
                        var statusCode = string.Equals(ex.Code, "bootstrap_app_unknown", StringComparison.Ordinal)
                            ? StatusCodes.Status404NotFound
                            : StatusCodes.Status400BadRequest;
                        return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: statusCode);
                    }

                    return CoreJson.Json(await BuildStateAsync(bootstrap, actionError, cancellationToken));
                },
                requireCsrf: true,
                cancellationToken: cancellationToken));
    }

    private static async Task<CoreBootstrapStateResponse> BuildStateAsync(
        SystemAppBootstrapService bootstrap,
        string? actionError,
        CancellationToken cancellationToken)
    {
        var state = await bootstrap.GetStateAsync(cancellationToken);
        return new CoreBootstrapStateResponse(
            state.Source,
            state.Problems,
            state.Apps.Select(status => new CoreBootstrapAppResponse(
                status.Entry.Id,
                status.Entry.Title,
                status.Entry.Description,
                status.Entry.DefaultEnabled,
                status.Enabled,
                status.Choice,
                Installed: status.Installed is not null,
                RuntimeState: status.Installed?.RuntimeState,
                InstallOrigin: status.Installed?.InstallOrigin)).ToArray(),
            actionError);
    }
}

internal sealed record CoreBootstrapChoiceRequest(string? AppId, bool? Enabled);

internal sealed record CoreBootstrapAppResponse(
    string Id,
    string Title,
    string? Description,
    bool DefaultEnabled,
    // Effective enablement for the next boot (choice > legacy env > default).
    bool Enabled,
    // The operator's explicit choice, when one is recorded; null means "following defaults".
    bool? Choice,
    bool Installed,
    string? RuntimeState,
    string? InstallOrigin);

internal sealed record CoreBootstrapStateResponse(
    string Source,
    IReadOnlyList<string> Problems,
    IReadOnlyList<CoreBootstrapAppResponse> Apps,
    // Set when a live enable saved the choice but the immediate install/start did not complete;
    // the boot reconcile retries it. Null on full success.
    string? ActionError);
