namespace Haas.Hosty.Core;

internal static class CoreProviderApi
{
    internal static Task<CoreCapabilityCaller> Caller(HttpRequest request, CoreCapabilityAuthorization authorization, string kind, string operation, CancellationToken ct)
    {
        var policy = CoreProviderPolicy.For(kind, operation);
        return authorization.RequireAsync(request, policy.Scopes, policy.Permissions, ct, policy.Administrator);
    }
    internal static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (CoreProviderException ex) { return CoreJson.Json(new CoreProviderFailure(ex.Error), ex.Status); }
        catch (AppIdentityException ex) { return CoreJson.Json(new CoreProviderFailure(new(ex.Code, ex.Message, false)), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (SandboxException ex) { return CoreJson.Json(new CoreProviderFailure(new(ex.Code, ex.Message, false)), ex.Status); }
        catch (System.Text.Json.JsonException) { return CoreJson.Json(new CoreProviderFailure(new("provider_response_invalid", "The provider returned an invalid response.", false)), 502); }
    }
    internal static void Map(WebApplication app)
    {
        const string tasks = "/api/tasks/v1";
        app.MapGet(tasks + "/providers", async (HttpRequest request, CoreCapabilityAuthorization auth, CoreTaskAdapter service, CancellationToken ct) =>
            await Handle(async () => await service.ProvidersAsync(await Caller(request, auth, "tasks", "list", ct), ct)));
        app.MapPost(tasks + "/options", async (CoreTaskOptions input, HttpRequest request, CoreCapabilityAuthorization auth, CoreTaskAdapter service, CancellationToken ct) =>
            await Handle(async () => await service.OptionsAsync(await Caller(request, auth, "tasks", "options", ct), input, ct)));
        app.MapPost(tasks + "/list", async (CoreTaskQuery input, HttpRequest request, CoreCapabilityAuthorization auth, CoreTaskAdapter service, CancellationToken ct) =>
            await Handle(async () => await service.ListAsync(await Caller(request, auth, "tasks", "list", ct), input, ct)));
        app.MapPost(tasks + "/get", async (CoreTaskGet input, HttpRequest request, CoreCapabilityAuthorization auth, CoreTaskAdapter service, CancellationToken ct) =>
            await Handle(async () => await service.GetAsync(await Caller(request, auth, "tasks", "get", ct), input, ct)));
        app.MapPost(tasks + "/create", async (CoreTaskCreate input, HttpRequest request, CoreCapabilityAuthorization auth, CoreTaskAdapter service, CancellationToken ct) =>
            await Handle(async () => await service.CreateAsync(await Caller(request, auth, "tasks", "create", ct), input, ct)));
        app.MapPost(tasks + "/edit", async (CoreTaskEdit input, HttpRequest request, CoreCapabilityAuthorization auth, CoreTaskAdapter service, CancellationToken ct) =>
            await Handle(async () => await service.EditAsync(await Caller(request, auth, "tasks", "edit", ct), input, ct)));
        app.MapPost(tasks + "/action", async (CoreTaskAction input, HttpRequest request, CoreCapabilityAuthorization auth, CoreTaskAdapter service, CancellationToken ct) =>
            await Handle(async () => await service.ActionAsync(await Caller(request, auth, "tasks", "action", ct), input, ct)));
        const string sessions = "/api/agent-sessions/v1";
        app.MapGet(sessions + "/providers", async (HttpRequest request, CoreCapabilityAuthorization auth, CoreAgentSessionAdapter service, CancellationToken ct) =>
            await Handle(async () => await service.ProvidersAsync(await Caller(request, auth, "agent-sessions", "sessions.get", ct), ct)));
        app.MapPost(sessions + "/sessions/query", async (CoreAgentSessionQuery input, HttpRequest request, CoreCapabilityAuthorization auth, CoreAgentSessionAdapter service, CancellationToken ct) =>
            await Handle(async () => await service.ListAsync(await Caller(request, auth, "agent-sessions", "sessions.query", ct), input, ct)));
        app.MapPost(sessions + "/sessions/get", async (CoreAgentSessionGet input, HttpRequest request, CoreCapabilityAuthorization auth, CoreAgentSessionAdapter service, CancellationToken ct) =>
            await Handle(async () => await service.GetAsync(await Caller(request, auth, "agent-sessions", "sessions.get", ct), input, ct)));
        app.MapPost(sessions + "/runs/get", async (CoreAgentRunGet input, HttpRequest request, CoreCapabilityAuthorization auth, CoreAgentSessionAdapter service, CancellationToken ct) =>
            await Handle(async () => await service.ReadRunAsync(await Caller(request, auth, "agent-sessions", "runs.get", ct), input.Run, ct)));
        app.MapPost(sessions + "/runs/cancel", async (CoreAgentRunCancel input, HttpRequest request, CoreCapabilityAuthorization auth, CoreAgentSessionAdapter service, CancellationToken ct) =>
            await Handle(async () => await service.CancelAsync(await Caller(request, auth, "agent-sessions", "runs.cancel", ct), input, ct)));
    }
}
