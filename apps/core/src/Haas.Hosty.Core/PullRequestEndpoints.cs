using System.Text.Json;

namespace Haas.Hosty.Core;

internal static class PullRequestEndpoints
{
    internal static readonly string[] Routes = ["GET /api/pull-requests", "GET /api/pull-requests/repositories",
        "GET /api/pull-requests/{repositoryId}/{number:int}", "GET /api/pull-requests/{repositoryId}/{number:int}/checks",
        "GET /api/pull-requests/{repositoryId}/{number:int}/review", "GET /api/pull-requests/{repositoryId}/{number:int}/diff",
        "GET /api/pull-requests/{repositoryId}/{number:int}/actions", "POST /api/pull-requests/{repositoryId}/{number:int}/actions", "POST /api/pull-requests/{repositoryId}/{number:int}/actions/recover",
        "POST /api/pull-requests/refresh", "POST /api/pull-requests/subscriptions", "GET /api/pull-requests/events"];

    public static void Map(WebApplication app)
    {
        app.MapGet("/api/pull-requests/repositories", (HttpRequest request, PullRequestService service, CancellationToken ct) =>
            Handle(request, actor => Json(() => service.RepositoriesAsync(actor, ct)), ct));
        app.MapGet("/api/pull-requests", (HttpRequest request, PullRequestService service, CancellationToken ct) =>
            Handle(request, actor => Json(() => service.ListAsync(actor, Query(request), ct)), ct));
        app.MapGet("/api/pull-requests/{repositoryId}/{number:int}", (string repositoryId, int number, HttpRequest request, PullRequestService service, CancellationToken ct) =>
            Handle(request, actor => Json(() => service.DetailAsync(actor, repositoryId, number, ct)), ct));
        app.MapGet("/api/pull-requests/{repositoryId}/{number:int}/checks", (string repositoryId, int number, string? cursor, HttpRequest request, PullRequestService service, CancellationToken ct) =>
            Handle(request, actor => Json(() => service.ChecksAsync(actor, repositoryId, number, cursor, ct)), ct));
        app.MapGet("/api/pull-requests/{repositoryId}/{number:int}/review", (string repositoryId, int number, string? cursor, HttpRequest request, PullRequestService service, CancellationToken ct) =>
            Handle(request, actor => Json(() => service.ReviewAsync(actor, repositoryId, number, cursor, ct)), ct));
        app.MapGet("/api/pull-requests/{repositoryId}/{number:int}/diff", (string repositoryId, int number, string? head, string? @base, HttpRequest request, PullRequestService service, CancellationToken ct) =>
            Handle(request, actor => Json(() => service.DiffAsync(actor, repositoryId, number, head ?? "", @base ?? "", ct)), ct));
        app.MapGet("/api/pull-requests/{repositoryId}/{number:int}/actions", (string repositoryId, int number, HttpRequest request, PullRequestService service, CancellationToken ct) =>
            Handle(request, actor => Json(() => service.ActionsAsync(actor, repositoryId, number, ct)), ct));
        app.MapPost("/api/pull-requests/{repositoryId}/{number:int}/actions", (string repositoryId, int number, HttpRequest request, PullRequestService service, CancellationToken ct) =>
            Handle(request, actor => Json(async () => await service.ExecuteActionAsync(actor, repositoryId, number, await Body<PullRequestCommand>(request, ct), ct)), ct));
        app.MapPost("/api/pull-requests/{repositoryId}/{number:int}/actions/recover", (string repositoryId, int number, HttpRequest request, PullRequestService service, CancellationToken ct) =>
            Handle(request, actor => Json(async () => await service.ExecuteActionAsync(actor, repositoryId, number, await Body<PullRequestCommand>(request, ct), ct, recoverOnly: true)), ct));
        app.MapPost("/api/pull-requests/refresh", (HttpRequest request, PullRequestService service, CancellationToken ct) =>
            Handle(request, async actor => await Json(async () => await service.RefreshAsync(actor, await Body<PullRequestRefresh>(request, ct), ct)), ct));
        app.MapPost("/api/pull-requests/subscriptions", (HttpRequest request, PullRequestService service, CancellationToken ct) =>
            Handle(request, async actor => await Json(async () => await service.SubscribeAsync(actor, await Body<PullRequestScope>(request, ct), ct)), ct));
        app.MapGet("/api/pull-requests/events", (string? subscriptionId, HttpRequest request, PullRequestService service, IHostApplicationLifetime lifetime, CancellationToken ct) =>
            Handle(request, actor => Stream(actor, subscriptionId ?? "", request, service, lifetime, ct), ct));
    }
    private static PullRequestQuery Query(HttpRequest request)
    {
        string? Value(string key) => request.Query[key].ToString() is { Length: > 0 } value ? value : null;
        bool? Boolean(string key) => Value(key) is not { } value ? null : bool.TryParse(value, out var parsed) ? parsed :
            throw new PullRequestException("pr_query_invalid", "Invalid boolean filter.", 400);
        var limit = Value("limit") is not { } raw ? 50 : int.TryParse(raw, out var parsed) ? parsed : 0;
        return new(Value("repository"), Value("app"), Value("author"), Boolean("bot"), Boolean("draft"), Value("ci"), Value("review"), Value("search"), limit, Value("cursor"));
    }
    private static async Task<T> Body<T>(HttpRequest request, CancellationToken ct)
    {
        using var buffer = new MemoryStream();
        var block = new byte[4096]; int read;
        while ((read = await request.Body.ReadAsync(block, ct)) > 0)
        { if (buffer.Length + read > 32768) throw new PullRequestException("pr_request_limit", "PR request body exceeds 32 KiB.", 413); buffer.Write(block, 0, read); }
        return JsonSerializer.Deserialize(buffer.ToArray(), CoreJson.TypeInfo<T>()) ?? throw new PullRequestException("pr_request_invalid", "A JSON request is required.", 400);
    }
    private static async Task<IResult> Json<T>(Func<Task<T>> read) => CoreJson.Json(await read());
    private static async Task<IResult> Handle(HttpRequest request, Func<PullRequestActor, Task<IResult>> action, CancellationToken ct)
    {
        if (!request.HttpContext.Response.HasStarted) request.HttpContext.Response.Headers.CacheControl = "no-store";
        try
        {
            var services = request.HttpContext.RequestServices;
            return await CoreSessionAuthorization.RequireSessionAsync(request, services.GetRequiredService<UserDirectoryStore>(),
                services.GetRequiredService<IClock>(), user => AppAccessPolicy.IsAdmin(user)
                    ? action(new(user.Id, AppManagementAuthorization.Caller(request)?.App.Id, AppManagementAuthorization.Caller(request)?.App.InstalledAt))
                    : Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "PR access requires an administrator."), 403)),
                requireCsrf: request.Method != "GET", cancellationToken: ct);
        }
        catch (PullRequestException e) { return CoreJson.Json(new ErrorResponse(e.Code, e.Message), e.Status); }
        catch (PublicationException) { return CoreJson.Json(new ErrorResponse("pr_provider_unavailable", "GitHub could not verify this PR preview. Open it on GitHub for more information."), 502); }
        catch (UserConnectionException e) { return CoreJson.Json(new ErrorResponse(e.Code, e.Message), e.Status); }
        catch (JsonException) { return CoreJson.Json(new ErrorResponse("pr_request_invalid", "Invalid PR data."), 400); }
        catch (HttpRequestException) { return CoreJson.Json(new ErrorResponse("pr_provider_unavailable", "GitHub is temporarily unavailable."), 502); }
    }
    private static async Task<IResult> Stream(PullRequestActor actor, string id, HttpRequest request,
        PullRequestService service, IHostApplicationLifetime lifetime, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct, lifetime.ApplicationStopping);
        deadline.CancelAfter(TimeSpan.FromSeconds(120));
        using var demand = service.Admit(actor, id);
        var response = request.HttpContext.Response;
        response.ContentType = "text/event-stream";
        response.Headers["X-Accel-Buffering"] = "no";
        async Task Write(string name, string data)
        {
            using var write = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
            write.CancelAfter(TimeSpan.FromSeconds(5));
            await response.WriteAsync($"event: {name}\ndata: {data}\n\n", write.Token);
            await response.Body.FlushAsync(write.Token);
        }
        try
        {
            var observed = service.CurrentRevision(actor);
            var initial = await service.StreamStateAsync(actor, id, deadline.Token);
            await Write("stream.ready", CoreJson.Text(initial));
            var revision = initial.Revision;
            var lastPing = System.Diagnostics.Stopwatch.GetTimestamp();
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
            while (await timer.WaitForNextTickAsync(deadline.Token))
            {
                var latest = service.CurrentRevision(actor);
                if (latest == observed && System.Diagnostics.Stopwatch.GetElapsedTime(lastPing) < TimeSpan.FromSeconds(15)) continue;
                if (AppManagementAuthorization.Caller(request) is not null && await AppManagementAuthorization.RevalidateCallerAsync(request, deadline.Token) is not null) break;
                var authorized = false;
                await Handle(request, current => { authorized = current == actor; return Task.FromResult<IResult>(Results.Empty); }, deadline.Token);
                if (!authorized) { await Write("stream.revoked", "{}"); break; }
                var state = await service.StreamStateAsync(actor, id, deadline.Token);
                observed = latest;
                if (state.Revision != revision) { await Write("pull-requests.changed", CoreJson.Text(state)); revision = state.Revision; }
                else if (System.Diagnostics.Stopwatch.GetElapsedTime(lastPing) >= TimeSpan.FromSeconds(15))
                { await Write("stream.ping", "{}"); lastPing = System.Diagnostics.Stopwatch.GetTimestamp(); }
            }
        }
        catch (OperationCanceledException) { }
        catch (IOException) { }
        catch (PullRequestException) when (response.HasStarted) { }
        return Results.Empty;
    }
}
