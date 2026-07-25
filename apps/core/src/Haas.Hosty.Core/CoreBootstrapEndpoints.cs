namespace Haas.Hosty.Core;

// Host-admin view of the distribution catalog: what this release offers and what the host currently
// has installed. There is no enable/disable here — installing and uninstalling are the only states,
// through the ordinary app lifecycle. The control-plane install is what `hosty setup` calls to add an
// entry back (including recovering a removed Shell). See docs/features/removable-system-apps/.
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
                async () => CoreJson.Json(await BuildStateAsync(bootstrap, cancellationToken)),
                cancellationToken: cancellationToken));

        app.MapGet("/control/v1/core/bootstrap", async (
            HttpRequest request,
            ControlSecret secret,
            SystemAppBootstrapService bootstrap,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                CoreJson.Json(await BuildStateAsync(bootstrap, cancellationToken))));

        // Installs one catalog entry by id, so the CLI never has to know manifest URLs or feed
        // locations — those belong to the release's distribution list, which Core already resolves.
        // Removal is not mirrored here: it is the ordinary app remove, identical for every app.
        app.MapPost("/control/v1/core/bootstrap/{appId}/install", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            SystemAppBootstrapService bootstrap,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
            {
                try
                {
                    await bootstrap.InstallAsync(appId, cancellationToken);
                }
                catch (AppLifecycleException ex)
                {
                    var statusCode = string.Equals(ex.Code, "bootstrap_app_unknown", StringComparison.Ordinal)
                        ? StatusCodes.Status404NotFound
                        : StatusCodes.Status400BadRequest;
                    return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: statusCode);
                }

                return CoreJson.Json(await BuildStateAsync(bootstrap, cancellationToken));
            }));
    }

    private static async Task<CoreBootstrapStateResponse> BuildStateAsync(
        SystemAppBootstrapService bootstrap,
        CancellationToken cancellationToken)
    {
        var state = await bootstrap.GetStateAsync(cancellationToken);
        return new CoreBootstrapStateResponse(
            state.Source,
            state.Problems,
            state.Seeded,
            state.Apps.Select(status => new CoreBootstrapAppResponse(
                status.Entry.Id,
                status.Entry.Title,
                status.Entry.Description,
                status.Entry.DefaultEnabled,
                Installed: status.Installed is not null,
                RuntimeState: status.Installed?.RuntimeState,
                InstallOrigin: status.Installed?.InstallOrigin)).ToArray());
    }
}

internal sealed record CoreBootstrapAppResponse(
    string Id,
    string Title,
    string? Description,
    // What a fresh host would have seeded. Descriptive of the release, not of this host's state.
    bool DefaultEnabled,
    bool Installed,
    string? RuntimeState,
    string? InstallOrigin);

internal sealed record CoreBootstrapStateResponse(
    string Source,
    IReadOnlyList<string> Problems,
    // False only on a host whose first-boot seeding has not completed yet.
    bool Seeded,
    IReadOnlyList<CoreBootstrapAppResponse> Apps);
