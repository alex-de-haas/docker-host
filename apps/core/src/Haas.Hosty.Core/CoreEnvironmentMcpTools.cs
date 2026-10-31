using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

internal static class CoreCapabilityResults
{
    internal static CallToolResult Success<T>(T value)
    {
        var json = JsonSerializer.SerializeToElement(value, CoreJson.TypeInfo<T>());
        return new() { Content = [new TextContentBlock { Text = json.GetRawText() }], StructuredContent = json };
    }
    internal static async Task<CallToolResult> Run<T>(Func<Task<T>> action)
    {
        try { return Success(await action()); }
        catch (Exception ex) when (ex is AppIdentityException or SandboxException or AppLifecycleException or AppManifestException)
        {
            var code = ex switch { AppIdentityException e => e.Code, SandboxException e => e.Code,
                AppLifecycleException e => e.Code, AppManifestException e => e.Code, _ => "operation_failed" };
            var result = Success(new ErrorResponse(code, ex.Message));
            result.IsError = true;
            return result;
        }
    }
}

internal sealed record CoreEnvironmentConsentPreview(CoreEnvironmentCreate Request, bool Authorized,
    string Authority, string Warning);

[McpServerToolType]
internal sealed class CoreEnvironmentMcpTools(IHttpContextAccessor accessor, CoreCapabilityAuthorization authorization,
    CoreEnvironmentService environments, CoreEnvironmentAccess child)
{
    private async Task<SandboxActor> Actor(CancellationToken ct, bool manage = false, bool api = false)
    {
        var http = accessor.HttpContext ?? throw new AppIdentityException("scope_required", "A current Core caller is required.");
        var scopes = new List<string> { AccessTokenScopes.McpEnvironmentsRead };
        var permissions = new List<string> { CoreAppPermissions.CoreEnvironmentsInspect };
        if (manage) { scopes.Add(AccessTokenScopes.McpEnvironmentsManage); permissions.Add(CoreAppPermissions.CoreEnvironmentsOperate); }
        if (api) { scopes.Add(AccessTokenScopes.McpEnvironmentApi); permissions.Add(CoreAppPermissions.CoreEnvironmentsApi); }
        return (await authorization.RequireAsync(http.Request, scopes, permissions, ct)).EnvironmentActor();
    }

    [McpServerTool(Name = "environment_consent", ReadOnly = true, Destructive = false)]
    [Description("Validate a child Core creation request against your standing environment authority. This is a preview, not a grant or a running child. Legacy app-specific consent remains on its legacy endpoint. Source mode additionally requires registered workspace authority.")]
    public Task<CallToolResult> Consent([Description("Creation request to validate, including its stable UUID.")] CoreEnvironmentCreate input, CancellationToken cancellationToken)
        => CoreCapabilityResults.Run(async () => new CoreEnvironmentConsentPreview(
            await environments.ValidateCreateAsync(await Actor(cancellationToken, true), input, cancellationToken), true,
            "current-caller", "Trusted child Core shares this host's Docker service. Use separate test users and data."));

    [McpServerTool(Name = "environment_list", ReadOnly = true, Destructive = false)]
    [Description("List the current user's child Core environments across creating applications. Requires explicit environment read authority; no Harness conversation is required. Other users' environments are excluded.")]
    public Task<CallToolResult> List(CancellationToken cancellationToken)
        => CoreCapabilityResults.Run(async () => await environments.ListAsync(await Actor(cancellationToken), cancellationToken));

    [McpServerTool(Name = "environment_status", ReadOnly = true, Destructive = false)]
    [Description("Read actual child Core readiness, process identity, revision and retained operation outcomes. An accepted operation is not proof of a running environment.")]
    public Task<CallToolResult> Status([Description("Core-issued environment ID.")] string environmentId, CancellationToken cancellationToken)
        => CoreCapabilityResults.Run(async () => await environments.ReadAsync(await Actor(cancellationToken), environmentId, cancellationToken));

    [McpServerTool(Name = "environment_create", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Create an independent child Core environment with separate test data. Requires environment read/manage and workspace authority for registered source inputs. Persist the request UUID and replay identical input after a lost reply. Does not require an agent session or start the child.")]
    public Task<CallToolResult> Create([Description("Label, mode, stable request UUID, optional registered source and initialization.")] CoreEnvironmentCreate input, CancellationToken cancellationToken)
        => CoreCapabilityResults.Run(async () => await environments.CreateAsync(await Actor(cancellationToken, true), input, cancellationToken));

    [McpServerTool(Name = "environment_start", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Start an authorized child Core using its current revision and a stable operation UUID. Inspect status for actual readiness; recover an uncertain result with the same request ID.")]
    public Task<CallToolResult> Start([Description("Core-issued environment ID.")] string environmentId,
        [Description("Stable request UUID and expected environment revision.")] CoreEnvironmentCommand input, CancellationToken cancellationToken)
        => Command(environmentId, "start", input, cancellationToken);

    [McpServerTool(Name = "environment_stop", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Stop an authorized child Core while retaining its test data. Active or unknown registered external consumers must stop first. Closing a chat does not stop an environment.")]
    public Task<CallToolResult> Stop([Description("Core-issued environment ID.")] string environmentId,
        [Description("Stable request UUID and expected environment revision.")] CoreEnvironmentCommand input, CancellationToken cancellationToken)
        => Command(environmentId, "stop", input, cancellationToken);

    [McpServerTool(Name = "environment_restart", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Restart an authorized child Core, preserving its identity and test data. Requires explicit environment management and stopped external consumers; preserve the operation UUID after disconnection.")]
    public Task<CallToolResult> Restart([Description("Core-issued environment ID.")] string environmentId,
        [Description("Stable request UUID and expected environment revision.")] CoreEnvironmentCommand input, CancellationToken cancellationToken)
        => Command(environmentId, "restart", input, cancellationToken);

    [McpServerTool(Name = "environment_finish", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Finish an authorized child Core and remove its owned temporary resources. Registered source worktrees and conversations remain. Confirm consumers stopped and use a stable request UUID; status reports cleanup completion or retained failures.")]
    public Task<CallToolResult> Finish([Description("Core-issued environment ID.")] string environmentId,
        [Description("Stable request UUID and expected environment revision.")] CoreEnvironmentCommand input, CancellationToken cancellationToken)
        => Command(environmentId, "finish", input, cancellationToken);

    [McpServerTool(Name = "environment_setup", ReadOnly = false, Destructive = false)]
    [Description("Set up and sign into a test child Core through normal password identity. Requires separate environment-api authority in addition to read/manage. Credentials remain with that child; never supply live provider secrets.")]
    public Task<CallToolResult> Setup([Description("Core-issued environment ID.")] string environmentId,
        [Description("Separate test account email, display name and password.")] CoreEnvironmentSetup input, CancellationToken cancellationToken)
        => CoreCapabilityResults.Run(async () => await child.SetupAsync(await Actor(cancellationToken, true, true), environmentId, input, cancellationToken));

    [McpServerTool(Name = "environment_api", ReadOnly = false, Destructive = true)]
    [Description("Call the authorized test child's JSON API through its private child login. Requires environment-api plus read/manage. Only relative /api/ routes are accepted; no arbitrary origin, parent credential or redirect is allowed.")]
    public Task<CallToolResult> Api([Description("Core-issued environment ID.")] string environmentId,
        [Description("Child-relative JSON API method, path and optional body.")] CoreEnvironmentApiRequest input, CancellationToken cancellationToken)
        => CoreCapabilityResults.Run(async () => await child.SendAsync(await Actor(cancellationToken, true, true), environmentId, input, cancellationToken));

    [McpServerTool(Name = "environment_consumer_register", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Register a consumer before it starts using an environment. Core binds your current principal. Claims survive disconnects and block Stop/Restart/Finish until confirmed release; they grant no resource access. Optional run references require current execution-provider access.")]
    public Task<CallToolResult> RegisterConsumer([Description("Core-issued environment ID.")] string environmentId,
        [Description("Stable consumer/request UUIDs, expected environment revision and optional qualified run.")] CoreEnvironmentConsumerRegister input, CancellationToken cancellationToken)
        => CoreCapabilityResults.Run(async () => await environments.RegisterConsumerAsync(await Actor(cancellationToken, true), environmentId, input, cancellationToken));

    [McpServerTool(Name = "environment_consumer_release", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Release your own consumer after its processes exit. Native consumers require an explicit native-stopped attestation; provider runs additionally require current provider-confirmed termination. A cancellation request or disconnected client is insufficient.")]
    public Task<CallToolResult> ReleaseConsumer([Description("Core-issued environment ID.")] string environmentId,
        [Description("Consumer/request UUIDs, expected consumer revision and timestamped stop evidence.")] CoreEnvironmentConsumerRelease input, CancellationToken cancellationToken)
        => CoreCapabilityResults.Run(async () => await environments.ReleaseConsumerAsync(await Actor(cancellationToken, true), environmentId, input, false, cancellationToken));

    [McpServerTool(Name = "environment_consumer_reconcile", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Explicit owner recovery for a claim whose original principal cannot release it. Supply operator-confirmed-stop evidence after verifying termination. Provider-managed consumers still require native stop confirmation. This is audited recovery, never a timeout or force-stop bypass.")]
    public Task<CallToolResult> ReconcileConsumer([Description("Core-issued environment ID.")] string environmentId,
        [Description("Consumer/request UUIDs, expected consumer revision and explicit operator stop attestation.")] CoreEnvironmentConsumerRelease input, CancellationToken cancellationToken)
        => CoreCapabilityResults.Run(async () => await environments.ReleaseConsumerAsync(await Actor(cancellationToken, true), environmentId, input, true, cancellationToken));

    private Task<CallToolResult> Command(string id, string kind, CoreEnvironmentCommand input, CancellationToken ct)
        => CoreCapabilityResults.Run(async () => await environments.CommandAsync(await Actor(ct, true), id, kind, input, ct));
}
