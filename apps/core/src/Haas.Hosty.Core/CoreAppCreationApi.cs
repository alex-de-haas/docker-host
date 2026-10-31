using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

internal static class CoreAppCreationApi
{
    internal static void Map(WebApplication app)
    {
        const string root = "/api/app-creations/v1";
        app.MapGet(root + "/capabilities", async (HttpRequest request, CoreAppCreationAdapter service, CancellationToken ct) => await AppCreationEndpoints.Handle(() => service.Capabilities(request, ct)));
        app.MapGet(root + "/guide", async (string? topic, HttpRequest request, CoreAppCreationAdapter service, CancellationToken ct) => await AppCreationEndpoints.Handle(() => service.Guide(request, topic, ct)));
        app.MapPost(root + "/get", async (CanonicalAppCreationStatus input, HttpRequest request, CoreAppCreationAdapter service, CancellationToken ct) => await AppCreationEndpoints.Handle(() => service.Status(request, input, ct)));
        app.MapPost(root + "/create", async (CanonicalAppCreation input, HttpRequest request, CoreAppCreationAdapter service, CancellationToken ct) => await AppCreationEndpoints.Handle(() => service.Create(request, input, ct)));
        app.MapPost(root + "/local/get", async (CanonicalLocalApp input, HttpRequest request, CoreAppCreationAdapter service, CancellationToken ct) => await AppCreationEndpoints.Handle(() => service.LocalStatus(request, input, ct)));
        app.MapPost(root + "/local/{kind}", async (string kind, CanonicalLocalHandoff input, HttpRequest request, CoreAppCreationAdapter service, CancellationToken ct) => await AppCreationEndpoints.Handle(() => service.Handoff(request, kind, input, ct)));
    }
}

[McpServerToolType]
internal sealed class CoreAppCreationMcpTools(IHttpContextAccessor accessor, CoreAppCreationAdapter service)
{
    private HttpRequest Request => accessor.HttpContext?.Request ?? throw new AppIdentityException("scope_required", "A current Core caller is required.");
    [McpServerTool(Name = "app_creation_capabilities", ReadOnly = true, Destructive = false)]
    [Description("Read the current user's configured Git author and local creation capabilities. Requires workspace authority; does not install or publish an app.")]
    public Task<CallToolResult> Capabilities(CancellationToken cancellationToken) => CoreCapabilityResults.Run(() => service.Capabilities(Request, cancellationToken));
    [McpServerTool(Name = "app_creation_guide", ReadOnly = true, Destructive = false)]
    [Description("Read a bounded topic from Core's packaged application development guide. Requires workspace authority. Use overview to find topic IDs.")]
    public Task<CallToolResult> Guide(CancellationToken cancellationToken, string? topic = null) => CoreCapabilityResults.Run(() => service.Guide(Request, topic, cancellationToken));
    [McpServerTool(Name = "app_creation_status", ReadOnly = true, Destructive = false)]
    [Description("Recover an app creation by its original request UUID and opaque task context. Returns its durable stage; never repeats completed creation steps.")]
    public Task<CallToolResult> Status(CanonicalAppCreationStatus input, CancellationToken cancellationToken) => CoreCapabilityResults.Run(() => service.Status(Request, input, cancellationToken));
    [McpServerTool(Name = "app_create", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Create a local application and registered worktree with an explicit bootstrap commit, task context and activity lease. Requires workspace plus app-create or reviewed apps.install authority. Preserve requestId and exact input after uncertainty. Remote repository publication and runtime start remain separate operations.")]
    public Task<CallToolResult> Create(CanonicalAppCreation input, CancellationToken cancellationToken) => CoreCapabilityResults.Run(() => service.Create(Request, input, cancellationToken));
    [McpServerTool(Name = "app_local_status", ReadOnly = true, Destructive = false)]
    [Description("Inspect the local application's source, registered worktree and ordinary runtime handoff state. Requires workspace authority; does not start or replace the runtime.")]
    public Task<CallToolResult> LocalStatus(CanonicalLocalApp input, CancellationToken cancellationToken) => CoreCapabilityResults.Run(() => service.LocalStatus(Request, input, cancellationToken));
}
