using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed class CoreHistoryExports(CoreHistoryExportStore store, CoreProviderMediation mediation,
    CoreHistoryAdapter history, AppRegistryStore apps, CoreProviderOperationStore operations, CoreCapabilityAuthorization authorization,
    UserDirectoryStore users, AppIdentityService identity, AppServiceTokenService services, IClock clock)
{
    internal static void RequireExport(CoreCapabilityCaller caller)
    {
        caller.Require(AccessTokenScopes.McpHistoryRead, CoreAppPermissions.HistoryProviders);
        caller.Require(AccessTokenScopes.McpHistoryRead, CoreAppPermissions.HistoryRead);
        caller.Require(AccessTokenScopes.McpHistoryExport, CoreAppPermissions.HistoryExport);
    }
    internal async Task<HostyHistoryExportGrant> CreateAsync(CoreCapabilityCaller caller, CoreHistoryExportCreate input, CancellationToken ct)
    {
        RequireExport(caller);
        if (caller.Authority is null || input.Consumer?.Kind is not ("self" or "app") || string.IsNullOrWhiteSpace(input.Purpose)
            || input.Purpose.Length > 500 || input.ExpiresAt <= clock.UtcNow) throw CoreHistoryValidation.Input("Select an exact consumer, indexing purpose and optional future expiration.");
        input = input with { RequestId = CoreProviderOperationStore.Normalize(input.RequestId), Corpus = Normalize(input.Corpus), Purpose = input.Purpose.Trim() };
        string principal;
        var creatorLabel = caller.App?.DisplayName ?? (await users.ReadAsync(ct)).Sessions.SingleOrDefault(s => AppIdentityService.HashToken(s.Id) == caller.Authority.CredentialHash)?.Label ?? "Core browser";
        var consumerLabel = creatorLabel;
        if (input.Consumer.Kind == "self")
        {
            if (input.Consumer.AppId is not null || input.Consumer.InstallationId is not null) throw CoreHistoryValidation.Input("Self selects this exact authenticated client.");
            principal = caller.PrincipalId;
        }
        else
        {
            var consumer = await ConsumerAppAsync(input.Consumer, caller.User.Id, ct);
            principal = CoreCapabilityAuthorization.AppPrincipal(consumer);
            consumerLabel = consumer.DisplayName;
        }
        var preview = new CoreHistoryExportRecord(new("preview", "1", "proposed", caller.User.Id, input.Consumer, principal, input.Corpus,
            input.Purpose, input.ExpiresAt), caller.PrincipalId, caller.Authority, "", clock.UtcNow, null, null, null, [], [], []);
        await ValidateSourcesAsync(preview, caller, ct);
        return await operations.ExecuteLocalAsync(caller, input.RequestId, "conversation-history", "exports.create", null, CoreJson.Text(input),
            async () => (await store.CreateAsync(caller, input, principal, creatorLabel, consumerLabel, ct)).Grant, ct);
    }
    private static HostyHistoryExportCorpus Normalize(HostyHistoryExportCorpus? corpus)
    {
        if (corpus?.Mode == "all-owned" && corpus.IncludeFutureConversations == true && corpus.Conversations is null && corpus.Providers is { Length: > 0 and <= 8 })
        {
            foreach (var provider in corpus.Providers) CoreProviderMediation.ValidateReference(provider);
            return corpus with { Providers = corpus.Providers.Distinct().OrderBy(CoreJson.Text, StringComparer.Ordinal).ToArray() };
        }
        if (corpus?.Mode == "conversations" && corpus.IncludeFutureConversations is null or false && corpus.Providers is null && corpus.Conversations is { Length: > 0 and <= 100 })
        {
            foreach (var conversation in corpus.Conversations) CoreHistoryValidation.Conversation(conversation);
            if (corpus.Conversations.Select(c => c.Provider).Distinct().Count() > 8) throw CoreHistoryValidation.Input("Select at most eight provider installations.");
            return corpus with { Conversations = corpus.Conversations.Distinct().OrderBy(CoreJson.Text, StringComparer.Ordinal).ToArray(), IncludeFutureConversations = null };
        }
        throw CoreHistoryValidation.Input("Select explicit owned conversations or explicitly include all owned and future conversations from 1–8 providers.");
    }
    private async Task<AppRecord> ConsumerAppAsync(HostyHistoryExportConsumer consumer, string owner, CancellationToken ct)
    {
        var app = consumer.AppId is null ? null : await apps.GetAppAsync(consumer.AppId, ct);
        if (app is null || PanelIdentity.Installation(app) != consumer.InstallationId) throw CoreHistoryExportStore.Missing();
        await identity.RequireAccessibleUserAsync(app.Id, owner, ct);
        foreach (var permission in new[] { CoreAppPermissions.HistoryProviders, CoreAppPermissions.HistoryRead, CoreAppPermissions.HistoryExport })
            if (!AppManagementAuthorization.HasPermission(app, permission)) throw new AppIdentityException("app_permission_required", "The selected export consumer lacks a reviewed history export permission.");
        return app;
    }
    internal async Task ValidateApprovalAsync(CoreHistoryExportRecord record, CoreCapabilityCaller owner, CancellationToken ct)
    {
        foreach (var provider in CoreHistoryExportStore.Providers(record))
        {
            var original = await authorization.RevalidateAsync(record.CreatorAuthority, record.Grant.OwnerUserId!, record.CreatorPrincipal,
                "conversation-history", provider.AppId, provider.Key, "history_export_create", ct);
            RequireExport(original);
        }
        await ValidateSourcesAsync(record, owner, ct);
    }
    internal async Task ValidateSourcesAsync(CoreHistoryExportRecord record, CoreCapabilityCaller owner, CancellationToken ct)
    {
        if (record.Grant.OwnerUserId != owner.User.Id || record.Grant.ExpiresAt <= clock.UtcNow) throw CoreHistoryExportStore.Missing();
        foreach (var provider in CoreHistoryExportStore.Providers(record))
        {
            var descriptor = await mediation.ResolveAsync(owner, provider, "conversation-history", ct);
            if (!descriptor.Available || descriptor.Version != 1 || !descriptor.Capabilities.Contains("history.changes"))
                throw new CoreProviderException("unsupported_capability", "The selected source must provide version-one owned-corpus changes.", 422);
            var capabilities = await history.CapabilitiesAsync(owner, provider, ct);
            if (capabilities.ChangeRetentionSeconds < 604800) throw new CoreProviderException("unsupported_capability", "Export sources must retain change identities for at least seven days.", 422);
        }
        foreach (var reference in record.Grant.Corpus!.Conversations ?? [])
        {
            var source = (await history.ConversationAsync(owner, reference, ct)).Deserialize(CoreJson.TypeInfo<HostyConversation>())!;
            if (source.OwnerUserId != owner.User.Id) throw new CoreProviderException("permission_denied", "Shared-to-you conversations cannot be exported.", 403);
        }
        if (record.Grant.Consumer!.Kind == "app") await ConsumerAppAsync(record.Grant.Consumer, owner.User.Id, ct);
    }
    internal async Task<CoreCapabilityCaller> ConsumerAsync(HttpRequest request, string appId, string grantId, CancellationToken ct)
    {
        if (!services.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? "")) throw new AppIdentityException("token_invalid", "The exact consumer's current service credential is required.");
        var record = await store.ReadAsync(grantId, ct); var app = await apps.GetAppAsync(appId, ct);
        var user = (await users.ReadAsync(ct)).Users.SingleOrDefault(u => u.Id == record.Grant.OwnerUserId);
        if (app is null || user is null || record.Grant.Consumer is not { Kind: "app" } consumer
            || consumer.AppId != appId || consumer.InstallationId != PanelIdentity.Installation(app)) throw CoreHistoryExportStore.Missing();
        return new(user, CoreCapabilityAuthorization.AppPrincipal(app), app, null)
        { Authority = new("history-export", AppId: app.Id, Installation: app.InstalledAt, PermissionRevision: app.PermissionRevision, ExportGrantId: grantId) };
    }
    internal async Task<HostyHistoryExportGrant> GetAsync(CoreCapabilityCaller caller, string grantId, CancellationToken ct)
    {
        return await store.ChangeAsync(grantId, async record =>
        {
            if (record.Grant.OwnerUserId != caller.User.Id || !CoreHistoryExportStore.IsConsumer(record, caller) && caller.Authority?.Kind == "history-export") throw CoreHistoryExportStore.Missing();
            if (!CoreHistoryExportStore.IsConsumer(record, caller)) RequireExport(caller);
            if (CoreHistoryExportStore.IsConsumer(record, caller) && caller.App is null && record.Grant.State is "active" or "proposed") RequireExport(caller);
            if (record.Grant.State is "active" or "proposed")
            {
                try
                {
                    if (caller.User.Disabled || record.Grant.ExpiresAt <= clock.UtcNow) throw new AppIdentityException("permission_denied", "The export owner or consent expired.");
                    if (CoreHistoryExportStore.IsConsumer(record, caller)) RequireExport(caller);
                    if (record.Grant.Consumer!.Kind == "app") await ConsumerAppAsync(record.Grant.Consumer, caller.User.Id, ct);
                    foreach (var provider in CoreHistoryExportStore.Providers(record))
                    {
                        var source = await apps.GetAppAsync(provider.AppId, ct);
                        if (source is null || PanelIdentity.Installation(source) != provider.InstallationId) throw CoreHistoryExportStore.Missing();
                        await identity.RequireAccessibleUserAsync(provider.AppId, caller.User.Id, ct);
                    }
                }
                catch (Exception ex) when (ex is CoreProviderException or AppIdentityException) { record = CoreHistoryExportStore.Purge(record); }
            }
            return (record, CoreHistoryExportStore.Public(record, caller));
        }, ct);
    }
    internal async Task<HostyHistoryExportGrant> RevokeAsync(CoreCapabilityCaller caller, CoreHistoryExportRevoke input, CancellationToken ct)
    {
        RequireExport(caller);
        input = input with { RequestId = CoreProviderOperationStore.Normalize(input.RequestId) };
        return await MutateAsync(caller, input.ExportGrantId, input.RequestId, input.ExpectedRevision, "revoke|" + CoreJson.Text(input), record =>
        {
            if (record.Grant.OwnerUserId != caller.User.Id || caller.Authority?.Kind == "history-export") throw CoreHistoryExportStore.Missing();
            return CoreHistoryExportStore.Purge(record);
        }, ct);
    }
    internal async Task<HostyHistoryExportGrant> AcknowledgeAsync(CoreCapabilityCaller caller, CoreHistoryExportAcknowledge input, CancellationToken ct)
    {
        input = input with { RequestId = CoreProviderOperationStore.Normalize(input.RequestId) };
        await GetAsync(caller, input.ExportGrantId, ct);
        return await MutateAsync(caller, input.ExportGrantId, input.RequestId, input.ExpectedRevision, "ack|" + CoreJson.Text(input), record =>
        {
            if (!CoreHistoryExportStore.IsConsumer(record, caller)) throw CoreHistoryExportStore.Missing();
            if (input.PurgeComplete == true && input.LastAppliedCursor is null)
            {
                if (record.Grant.State is not ("purge_required" or "purged")) throw new CoreProviderException("revision_conflict", "A purge acknowledgement cannot activate or revoke consent.", 409);
                return record with { Grant = record.Grant with { State = "purged", Revision = CoreHistoryExportStore.Next(record.Grant.Revision), LastAppliedCursor = null }, Cursors = [], Checkpoints = [] };
            }
            RequireExport(caller);
            if (record.Grant.State != "active" || input.PurgeComplete == true || input.LastAppliedCursor is null) throw new CoreProviderException("permission_denied", "An active grant and issued cursor are required.", 403);
            var issued = record.Cursors.SingleOrDefault(c => c.Id == input.LastAppliedCursor && c.Acknowledgeable)
                ?? throw new CoreProviderException("invalid_cursor", "Only a completed issued batch can be acknowledged.", 409);
            var prior = record.Checkpoints.SingleOrDefault(c => c.Provider == issued.Provider);
            if (prior is not null && System.Numerics.BigInteger.Parse(prior.Sequence) > System.Numerics.BigInteger.Parse(issued.Sequence))
                throw new CoreProviderException("revision_conflict", "Export acknowledgements cannot move backwards.", 409);
            return record with { Grant = record.Grant with { Revision = CoreHistoryExportStore.Next(record.Grant.Revision), LastAppliedCursor = issued.Id },
                Checkpoints = [.. record.Checkpoints.Where(c => c.Provider != issued.Provider), new(issued.Provider, issued.Id, issued.Sequence)],
                Cursors = record.Cursors.Where(c => c.Id == issued.Id || c.Provider != issued.Provider || System.Numerics.BigInteger.Parse(c.Sequence) > System.Numerics.BigInteger.Parse(issued.Sequence)).ToArray() };
        }, ct);
    }
    private Task<HostyHistoryExportGrant> MutateAsync(CoreCapabilityCaller caller, string id, string requestId, string expectedRevision,
        string input, Func<CoreHistoryExportRecord, CoreHistoryExportRecord> mutation, CancellationToken ct)
    {
        requestId = CoreProviderOperationStore.Normalize(requestId); CoreAgentSessionAdapter.Revision(expectedRevision);
        var fingerprint = SandboxValidation.Hash(input);
        return operations.ExecuteLocalAsync(caller, requestId, "conversation-history", input.StartsWith("ack|", StringComparison.Ordinal) ? "exports.acknowledge" : "exports.revoke", id, input, () => store.ChangeAsync(id, record =>
        {
            if (record.Grant.OwnerUserId != caller.User.Id) throw CoreHistoryExportStore.Missing();
            var prior = record.Receipts.SingleOrDefault(r => r.RequestId == requestId && r.PrincipalId == caller.PrincipalId && r.UserId == caller.User.Id);
            if (prior is not null)
            {
                if (prior.Fingerprint != fingerprint) throw new CoreProviderException("request_conflict", "This request UUID identifies different input.", 409);
                // A replay never restores content authority or hides a later revocation.
                return Task.FromResult((record, record.Grant.State is "purge_required" or "purged" ? CoreHistoryExportStore.Public(record, caller) : prior.Result));
            }
            if (record.Grant.Revision != expectedRevision) throw new CoreProviderException("revision_conflict", "Read the current export consent revision.", 409);
            record = mutation(record); var result = CoreHistoryExportStore.Public(record, caller);
            record = record with { Receipts = [.. record.Receipts, new(requestId, caller.User.Id, caller.PrincipalId, fingerprint, result)] };
            return Task.FromResult((record, result));
        }, ct), ct);
    }
    internal async Task<JsonElement> BatchAsync(CoreCapabilityCaller caller, CoreHistoryExportQuery input, bool changes, CancellationToken ct)
    {
        RequireExport(caller); CoreHistoryValidation.Page(input.Limit, input.Cursor);
        await GetAsync(caller, input.ExportGrantId, ct);
        var record = await store.ReadAsync(input.ExportGrantId, ct);
        if (!CoreHistoryExportStore.IsConsumer(record, caller)) throw CoreHistoryExportStore.Missing();
        var scope = store.Scope(record, input.Provider); var kind = changes ? "changes" : "snapshot";
        var prior = input.Cursor is null ? null : record.Cursors.SingleOrDefault(c => c.Id == input.Cursor && c.Provider == input.Provider && c.Kind == kind);
        if (input.Cursor is not null && (prior is null || prior.ExpiresAt <= clock.UtcNow)) throw new CoreProviderException("cursor_expired", "Use a current cursor issued for this export grant and source.", 410);
        if (changes && prior is null) throw new CoreProviderException("rescan_required", "Complete an approved source snapshot before reading changes.", 410);
        caller = caller with { Authority = caller.Authority! with { ExportGrantId = input.ExportGrantId } };
        var capabilities = await history.CapabilitiesAsync(caller, input.Provider, ct);
        var raw = await mediation.SendAsync(caller, input.Provider, CoreProviderPolicy.For("conversation-history", "exports." + kind),
            "POST", "/exports/" + kind, new CoreHistorySourceExport(scope, prior?.SourceCursor, input.Limit), [input.ExportGrantId], null, ct);
        void Entry(HostyHistoryEntry entry)
        {
            CoreHistoryValidation.Entry(entry, input.Provider, capabilities);
            if (scope.ConversationIds is not null && !scope.ConversationIds.Contains(entry.Ref.Conversation.Id)) throw Invalid();
        }
        if (!changes)
        {
            var page = raw.Deserialize(CoreJson.TypeInfo<HostyHistoryExportSnapshot>()) ?? throw Invalid();
            if (page.Entries is null || page.Entries.Length > input.Limit || string.IsNullOrEmpty(page.ChangeCursor) || page.ChangeCursor.Length > 16384 || page.NextCursor?.Length > 16384) throw Invalid();
            CoreHistoryValidation.Coverage(page.Coverage); CoreAgentSessionAdapter.Revision(page.HighWater);
            foreach (var entry in page.Entries) Entry(entry);
            var next = page.NextCursor is null ? null : Cursor(input.Provider, "snapshot", page.NextCursor, page.HighWater, false, clock.UtcNow.AddMinutes(15));
            var after = Cursor(input.Provider, "changes", page.ChangeCursor, page.HighWater, page.NextCursor is null, clock.UtcNow.AddDays(7));
            await RetainAsync(caller, input.ExportGrantId, [.. next is null ? Array.Empty<CoreHistoryExportCursor>() : [next], after], ct);
            return JsonSerializer.SerializeToElement(page with { NextCursor = next?.Id, ChangeCursor = after.Id }, CoreJson.TypeInfo<HostyHistoryExportSnapshot>());
        }
        else
        {
            var page = raw.Deserialize(CoreJson.TypeInfo<HostyHistoryChangePage>()) ?? throw Invalid();
            if (page.Changes is null || page.Changes.Length > input.Limit || string.IsNullOrEmpty(page.NextCursor) || page.NextCursor.Length > 16384) throw Invalid();
            CoreHistoryValidation.Coverage(page.Coverage); var sequence = System.Numerics.BigInteger.Parse(prior!.Sequence);
            foreach (var change in page.Changes)
            {
                CoreAgentSessionAdapter.Revision(change.Sequence); CoreProviderMediation.ValidateId(change.Id);
                var current = System.Numerics.BigInteger.Parse(change.Sequence); if (current <= sequence) throw Invalid(); sequence = current;
                if (change.Type == "upsert" && change.Entry is not null && change.Ref is null) Entry(change.Entry);
                else if (change.Type == "delete" && change.Entry is null && change.Ref is not null)
                {
                    CoreHistoryValidation.EntryRef(change.Ref); CoreAgentSessionAdapter.Revision(change.Revision);
                    if (change.Ref.Conversation.Provider != input.Provider || scope.ConversationIds is not null && !scope.ConversationIds.Contains(change.Ref.Conversation.Id)) throw Invalid();
                }
                else if (change.Type != "access_reset" || change.Entry is not null || change.Ref is not null || change.Reason?.Length > 500) throw Invalid();
            }
            CoreAgentSessionAdapter.Revision(page.HighWater);
            if (System.Numerics.BigInteger.Parse(page.HighWater) < sequence) throw Invalid();
            var next = Cursor(input.Provider, "changes", page.NextCursor, page.HighWater, true, clock.UtcNow.AddDays(7));
            await RetainAsync(caller, input.ExportGrantId, [next], ct);
            return JsonSerializer.SerializeToElement(page with { NextCursor = next.Id }, CoreJson.TypeInfo<HostyHistoryChangePage>());
        }
    }
    private static CoreHistoryExportCursor Cursor(HostyProviderRef provider, string kind, string source, string sequence, bool acknowledgeable, DateTimeOffset? expires)
        => new(Guid.NewGuid().ToString("N"), provider, kind, source, sequence, acknowledgeable, expires);
    private Task<bool> RetainAsync(CoreCapabilityCaller caller, string id, CoreHistoryExportCursor[] cursors, CancellationToken ct)
        => store.ChangeAsync(id, record =>
        {
            foreach (var cursor in cursors) store.Scope(record, cursor.Provider);
            if (!CoreHistoryExportStore.IsConsumer(record, caller)) throw CoreHistoryExportStore.Missing();
            var retained = record.Cursors.Where(c => c.ExpiresAt is null || c.ExpiresAt > clock.UtcNow).ToArray();
            if (retained.Length + cursors.Length > 10000) throw new CoreProviderException("budget_exceeded", "Acknowledge and retire old export cursors before continuing.", 429);
            return Task.FromResult((record with { Cursors = [.. retained, .. cursors] }, true));
        }, ct);
    private static CoreProviderException Invalid() => CoreHistoryValidation.Invalid("The source returned an invalid or out-of-corpus export batch.");
}
