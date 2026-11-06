namespace Haas.Hosty.Core;

internal static class CorePublicationApi
{
    internal static void Map(WebApplication app)
    {
        const string root = "/api/publications/v1";
        app.MapGet(root + "/connections", async (HttpRequest request, CorePublicationAdapter service, CancellationToken ct) =>
            await PublicationEndpoints.Handle(() => service.Connections(request, ct)));
        app.MapPost(root + "/query", async (CorePublicationQuery input, HttpRequest request, CorePublicationAdapter service, CancellationToken ct) =>
            await PublicationEndpoints.Handle(() => service.List(request, input, ct)));
        app.MapPost(root + "/get", async (CorePublicationGet input, HttpRequest request, CorePublicationAdapter service, CancellationToken ct) =>
            await PublicationEndpoints.Handle(() => service.Get(request, input.WorktreeId, ct)));
        app.MapPost(root + "/commands/{kind}", async (string kind, CorePublicationMutation input, HttpRequest request, CorePublicationAdapter service, CancellationToken ct) =>
            await PublicationEndpoints.Handle(() => service.Command(request, kind, input, ct)));
        app.MapPost(root + "/remote/get", async (CoreRemoteQuery input, HttpRequest request, CorePublicationAdapter service, CancellationToken ct) =>
            await PublicationEndpoints.Handle(() => service.RemoteStatus(request, input, ct)));
        app.MapPost(root + "/remote/{kind}", async (string kind, CoreRemoteMutation input, HttpRequest request, CorePublicationAdapter service, CancellationToken ct) =>
            await PublicationEndpoints.Handle(() => service.RemoteCommand(request, kind, input, ct)));
    }
}
