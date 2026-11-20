using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreAgentWorkspaceRecovery(string RequestId, long ExpectedRevision, HostyProviderRef Provider,
    string ProviderSessionId, string ViewerPath, string Title, IReadOnlyDictionary<string, string>? Runs = null);

internal sealed partial class CoreAgentAuthorizationStore
{
    internal async Task<CoreAgentAuthorization[]> FindPreparedRuns(WorkspaceOwner caller, HostyProviderRef provider,
        string providerSessionId, string workspaceId, CancellationToken ct)
    {
        var directory = Path.Combine(paths.CoreRoot, "agent-authorizations");
        if (!Directory.Exists(directory)) return [];
        var matches = new List<CoreAgentAuthorization>();
        foreach (var file in Directory.EnumerateFiles(directory, "*.json"))
        {
            var record = await JsonStorage.ReadAsync<CoreAgentAuthorization>(file, ct);
            if (record is { Admitted: true, Request.Operation: "runs.start" } && record.CallerAppId == caller.AppId &&
                record.CallerInstallation == caller.Installation && record.UserId == caller.UserId &&
                record.Request.Provider == provider && record.Request.SessionId == providerSessionId &&
                record.Leases?.Any(l => l.SessionId == providerSessionId && l.RequestId is not null &&
                    (l.WorkspaceId == workspaceId || l.WorkspaceId.Length == 0 && l.WorktreeId.Length == 0)) == true)
                matches.Add(record);
        }
        return [.. matches];
    }
}

internal sealed partial class CoreAgentExecution
{
    internal async Task<WorkspaceParticipation> RecoverWorkspace(WorkspaceOwner owner, string workspaceId, CoreAgentWorkspaceRecovery input, CancellationToken ct)
    {
        CoreProviderMediation.ValidateReference(input.Provider);
        var conversation = new CoreAgentConversation(owner.SessionId, input.ViewerPath, input.Title);
        conversation.Validate();
        if (!Guid.TryParse(input.ProviderSessionId, out _) || !Guid.TryParse(input.RequestId, out _) || input.ExpectedRevision < 1)
            throw Invalid("Select the exact provider session, revision and recovery request UUID.");
        if (input.Runs is { } runs && (runs.Count > 4096 || runs.Any(entry => !Guid.TryParse(entry.Key, out _) ||
                string.IsNullOrWhiteSpace(entry.Value) || entry.Value.Length > 256 || entry.Value.Any(char.IsControl))))
            throw Invalid("Supply bounded run and generation pairs from the originating conversation.");
        var consumer = await apps.GetAppAsync(owner.AppId, ct);
        var provider = await apps.GetAppAsync(input.Provider.AppId, ct);
        if (consumer is null || consumer.InstalledAt != owner.Installation || provider is null ||
            PanelIdentity.Installation(provider) != input.Provider.InstallationId ||
            !AppManagementAuthorization.HasPermission(consumer, CoreAppPermissions.AgentProviders) ||
            !AppManagementAuthorization.HasPermission(consumer, CoreAppPermissions.Sources))
            throw new AppIdentityException("permission_denied", "The original installations and current agent and source permissions are required.");
        var records = await store.FindPreparedRuns(owner, input.Provider, input.ProviderSessionId, workspaceId, ct);
        var native = new WorkspaceOwner(provider.Id, provider.InstalledAt, owner.UserId, input.ProviderSessionId);
        var trees = (await workspaces.ListAsync(null, true, ct)).Workspaces.Where(t => t.State == "active").ToArray();
        var candidates = new List<(DevelopmentWorkspace Tree, string RequestId, WorkspaceChatOrigin Origin)>();
        foreach (var record in records)
        {
            var recorded = record.Request.Conversation?.SessionId ?? Workflow(record.Request)?.SessionId;
            if (recorded is not null && recorded != owner.SessionId)
                throw Invalid("The retained run belongs to another conversation.");
            var run = record.Request.RunId!;
            var observed = input.Runs?.GetValueOrDefault(run);
            if (recorded is null && observed is null) continue;
            if (record.Generation is not null && observed is not null && observed != record.Generation)
                throw new CoreProviderException("origin_stale", "The provider and the conversation record different run generations.", 409);
            var chat = new WorkspaceChatOrigin(owner, conversation, record.Id, run, record.Generation ?? observed);
            foreach (var lease in record.Leases!.Where(l => l.RequestId is not null && l.SessionId == native.SessionId))
            {
                // Core records the request and lease before preparing source. A lost reply can leave both tree IDs empty.
                var matches = trees.Where(t => (lease.WorktreeId.Length == 0 && lease.WorkspaceId.Length == 0
                        ? t.LeaseClaims?.Any(c => c.Id == lease.LeaseId && c.Session.SameIdentity(native)) == true
                        : t.Id == lease.WorktreeId && t.WorkspaceId == lease.WorkspaceId) &&
                    t.Operations.Any(o => o.Id == lease.RequestId && o.Kind == "prepare" && o.State == "succeeded" &&
                        (o.Actor ?? t.Owner).SameIdentity(native))).Take(2).ToArray();
                if (matches.Length == 1 && matches[0].WorkspaceId == workspaceId) candidates.Add((matches[0], lease.RequestId!, chat));
            }
        }
        if (candidates.Count == 0)
            throw new CoreProviderException("origin_unresolved", "No retained preparation links this provider session to the selected workspace.", 409);
        var evidence = candidates.OrderBy(c => c.RequestId, StringComparer.Ordinal).First();
        return await workspaces.RepairPreparationAsync(evidence.Tree, native, evidence.Origin, evidence.RequestId, input.RequestId, input.ExpectedRevision, ct);
    }
}
