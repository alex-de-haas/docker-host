namespace Haas.Hosty.Core;

internal static class CoreAgentEndpoints
{
    internal static void Map(WebApplication app)
    {
        const string root = "/api/internal/apps/{appId}/agent";
        app.MapPost(root + "/authorize", (string appId, CoreAgentAuthorizeRequest input, HttpRequest request,
            ProviderAccessService access, CoreAgentExecution service, CancellationToken ct) => Handle(async () =>
                await service.Authorize(await Authenticate(appId, request, access, ct), request.Headers["X-Hosty-User-Token"].ToString(), input, ct)));
        app.MapPost(root + "/introspect", (string appId, CoreAgentIntrospection input, HttpRequest request,
            ProviderAccessService access, CoreAgentExecution service, CancellationToken ct) => Handle(async () =>
                await service.Introspect(await Authenticate(appId, request, access, ct), input, ct)));
        app.MapPost(root + "/admit", (string appId, CoreAgentReference input, HttpRequest request,
            ProviderAccessService access, CoreAgentExecution service, CancellationToken ct) => Handle(async () =>
                await service.Admit(await Authenticate(appId, request, access, ct), input.AdmissionRef, ct)));
        app.MapPost(root + "/renew", (string appId, CoreAgentReference input, HttpRequest request,
            ProviderAccessService access, CoreAgentExecution service, CancellationToken ct) => Handle(async () =>
                await service.Renew(await Authenticate(appId, request, access, ct), input.AdmissionRef, ct)));
        app.MapPost(root + "/mcp/token", (string appId, CoreAgentMcpRequest input, HttpRequest request,
            ProviderAccessService access, CoreAgentExecution service, CancellationToken ct) => Handle(async () =>
                await service.McpToken(await Authenticate(appId, request, access, ct), input, ct)));
        app.MapPost(root + "/skills/snapshots", (string appId, CoreAgentSkillRequest input, HttpRequest request,
            ProviderAccessService access, CoreAgentExecution service, CancellationToken ct) => Handle(async () =>
                await service.Skills(await Authenticate(appId, request, access, ct), input, ct)));
        app.MapPost(root + "/workflow", (string appId, CoreAgentWorkflowRequest input, HttpRequest request,
            ProviderAccessService access, CoreProviderMediation service, CancellationToken ct) => Handle(async () =>
                await service.AgentWorkflowAsync(await Authenticate(appId, request, access, ct), input, ct)));
        app.MapPost(root + "/workspace", (string appId, CoreAgentWorkspaceRequest input, HttpRequest request,
            ProviderAccessService access, CoreAgentExecution service, CancellationToken ct) => Handle(async () =>
                await service.Workspace(await Authenticate(appId, request, access, ct), input, ct)));
    }
    private static Task<IResult> Handle<T>(Func<Task<T>> action) => CoreProviderApi.Handle(async () =>
    {
        try { return await action(); }
        catch (AppLifecycleException ex) { throw new CoreProviderException(ex.Code, ex.Message, 409); }
    });
    private static Task<AppRecord> Authenticate(string id, HttpRequest request, ProviderAccessService access, CancellationToken ct)
    {
        if (request.Cookies.ContainsKey(CoreSessionAuthorization.SessionCookieName)) throw new AppIdentityException("app_credential_mixed", "Do not combine provider service identity and Core cookies.");
        return access.AuthenticateAsync(id, request, ct);
    }
}
