using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed partial class DevelopmentWorkspaceService
{
    // Named sources are an editing contract. The existing app runtime continues to use its
    // primary binding and the ordinary one-worktree allocation remains the unit of Git work.
    internal Task<WorkspacePreparationResult> PrepareApplicationAsync(WorkspaceOwner owner, WorkspacePrepare input,
        CancellationToken ct, WorkspaceChatOrigin? origin = null, bool nativeExecution = false,
        Func<string, string, Task>? recordLeaseIntent = null)
        => WithPreparationAppLockAsync(input, async () =>
        {
            await RequireWorkspaceUserAsync(owner.UserId, ct);
            RequestId(input.RequestId);
            if (owner.SessionId != input.SessionId)
                throw Error("session_invalid", "Preparation must use the authenticated session.");
            if (input.LeaseId is not null && !Guid.TryParse(input.LeaseId, out _))
                throw Error("lease_invalid", "Use a stable activity lease UUID.");
            if (owner.IsExternal && input.LeaseId is null)
                throw Error("lease_invalid", "External preparation requires an explicit activity lease UUID.");
            if (input.Name is not null) ValidateWorkspaceName(input.Name);
            var app = await apps.GetAppAsync(input.AppId ?? "", ct)
                ?? throw Error("app_missing", "An installed source app is required.");
            var manifestText = app.ManifestPath is { } path && File.Exists(path) ? await File.ReadAllTextAsync(path, ct) : null;
            var manifest = manifestText is null ? null : JsonSerializer.Deserialize(manifestText, CoreJson.TypeInfo<RuntimeAppManifest>());
            var receiptPath = PreparationReceiptPath(owner, input.RequestId);
            var receipt = await JsonStorage.ReadAsync<WorkspacePreparationReceipt>(receiptPath, ct);
            if (manifest?.Sources is not { Count: > 0 })
            {
                if (receipt is not null) throw Error("source_changed", "The installed source declaration changed. Prepare the current sources with a new request ID.");
                if (input.SourceConnections is { Count: > 0 })
                    throw Error("source_connection_invalid", "Named source connections require named sources in the installed manifest.");
                if (recordLeaseIntent is not null && input.LeaseId is { } legacyLease) await recordLeaseIntent(input.RequestId, legacyLease);
                var tree = await PrepareApplicationWorktreeAsync(owner, input, ct, origin, nativeExecution);
                await MarkPreviousSourcesAsync(tree.WorkspaceId, app, [], tree.AllocationGeneration, ct, legacyPrimaryTreeId: tree.Id);
                if (tree.ServiceSources is not null) tree = await Read(tree.Id, owner, ct);
                return new WorkspacePreparationResult(tree, [tree], [], input.LeaseId is { } lease ? [new(tree.Id, input.RequestId, lease)] : [],
                    WorkspaceId: tree.WorkspaceId);
            }

            var workspaceOwner = owner.IsExternal ? owner : await Locked("workspace-participation", async () =>
            {
                var participation = origin is null ? await SessionParticipationAsync(owner, ct)
                    : await PreparationParticipationAsync(owner, origin.Owner, ct);
                return participation?.AllocationOwner ?? owner;
            }, ct);
            var workspaceId = WorkspaceIdFor(workspaceOwner);
            await RequireOpenWorkflow(workspaceOwner, ct);
            var allocationGeneration = await JsonStorage.ReadAsync<string>(AllocationGenerationPath(workspaceOwner), ct);
            var connections = input.SourceConnections is null ? null : input.SourceConnections
                .OrderBy(entry => entry.Key, StringComparer.Ordinal).ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal);
            var fingerprint = Hash(CoreJson.Text(input with { SourceConnections = connections }));
            var revision = PreparationSourceRevision(app, manifest);
            if (receipt is not null)
            {
                if (receipt.Fingerprint != fingerprint || receipt.WorkspaceId != workspaceId)
                    throw Error("request_conflict", "Reuse the original workspace preparation arguments and context.");
                if (receipt.AllocationGeneration != allocationGeneration)
                    throw Error("released", "This preparation belongs to a removed workspace allocation. Start a new preparation request.");
                if (receipt.Installation != app.InstalledAt || receipt.ManifestRevision != revision)
                    throw Error("source_changed", "The installed source declaration changed. Prepare the current sources with a new request ID.");
                if (receipt.Repositories.Any(repository => repository.AdmissionFailure is not null))
                {
                    var prior = receipt.Repositories.Where(repository => repository.AdmissionFailure is null)
                        .ToDictionary(repository => repository.Repository, StringComparer.Ordinal);
                    var retainedRepositories = prior.Values.SelectMany(repository => repository.Binding.SourceIds
                        .Select(sourceId => (SourceId: sourceId, repository.Repository)))
                        .ToDictionary(entry => entry.SourceId, entry => entry.Repository, StringComparer.Ordinal);
                    var retry = await PlanPreparationAsync(app, manifest, input, recordLeaseIntent is not null || owner.IsExternal, ct,
                        retainedRepositories);
                    // An inaccessible local alias can now resolve to an admitted repo. Retain that
                    // repo's request and activity IDs when the declaration resolves.
                    var repositories = retry.Select(repository => prior.TryGetValue(repository.Repository, out var prepared)
                        ? repository with { RequestId = prepared.RequestId, LeaseId = prepared.LeaseId } : repository).ToArray();
                    receipt = receipt with { Repositories = RetainPrimaryReceiptIdentity(repositories, input, manifest.PrimarySource is not null) };
                    await JsonStorage.WriteAsync(receiptPath, receipt, true, ct);
                }
            }
            else
            {
                var repositories = await PlanPreparationAsync(app, manifest, input,
                    distinctLeases: recordLeaseIntent is not null || owner.IsExternal, ct);
                receipt = new(fingerprint, revision, app.InstalledAt, workspaceId,
                    RetainPrimaryReceiptIdentity(repositories, input, manifest.PrimarySource is not null), AllocationGeneration: allocationGeneration);
                // Freeze the repository set and child UUIDs before any worktree or lease is created.
                await JsonStorage.WriteAsync(receiptPath, receipt, true, ct);
            }
            await MarkPreviousSourcesAsync(workspaceId, app, receipt.Repositories, allocationGeneration, ct);

            var trees = new List<DevelopmentWorkspace>();
            var failures = new List<WorkspacePreparationFailure>();
            var leases = new List<WorkspacePreparationLease>();
            DevelopmentWorkspace? primary = null;
            foreach (var planned in receipt.Repositories)
            {
                if (planned.AdmissionFailure is { } blocked)
                {
                    failures.Add(blocked);
                    continue;
                }
                try
                {
                    if (recordLeaseIntent is not null && planned.LeaseId is { } lease) await recordLeaseIntent(planned.RequestId, lease);
                    var childInput = input with { RequestId = planned.RequestId, LeaseId = planned.LeaseId,
                        TargetBranch = planned.Binding.TargetBranch, ExpectedLocalHead = planned.Binding.Primary ? input.ExpectedLocalHead : null,
                        SourceConnections = null };
                    var child = await PrepareApplicationWorktreeAsync(owner, childInput, ct, origin, nativeExecution,
                        planned with { AllocationGeneration = allocationGeneration });
                    if (child.WorkspaceId != workspaceId)
                        throw Error("request_conflict", "The session's workspace changed during preparation. Reopen the original workspace.");
                    trees.Add(child);
                    if (planned.LeaseId is { } leaseId) leases.Add(new(child.Id, planned.RequestId, leaseId));
                    if (planned.Binding.Primary) primary = child;
                }
                catch (AppLifecycleException error)
                {
                    failures.Add(new(planned.Repository, planned.Binding.SourceIds, error.Code, error.Message));
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or HttpRequestException or UserConnectionException)
                {
                    failures.Add(new(planned.Repository, planned.Binding.SourceIds, "workspace_unavailable", "The registered repository, its source connection, or worktree is unavailable."));
                    logger?.LogWarning(error, "Could not prepare a source repository in workspace {WorkspaceId}", workspaceId);
                }
            }

            var result = new WorkspacePreparationResult(primary, trees.ToArray(), failures.ToArray(), leases.ToArray(),
                UsesNamedSources: true, WorkspaceId: workspaceId);
            await JsonStorage.WriteAsync(receiptPath, receipt with { Failures = result.Failures }, true, ct);
            return result;
        }, ct);

    private string PreparationReceiptPath(WorkspaceOwner owner, string requestId)
    {
        var key = Hash(OwnerIdentity(owner) + "\n" + Guid.Parse(requestId).ToString("D"));
        var path = Path.Combine(Root, "source-preparations", key + ".json");
        RequireDiscardStorage(path);
        return path;
    }

    private async Task<WorkspacePreparationRepository[]> PlanPreparationAsync(AppRecord app, RuntimeAppManifest manifest,
        WorkspacePrepare input, bool distinctLeases, CancellationToken ct,
        IReadOnlyDictionary<string, string>? retainedRepositories = null)
    {
        var references = manifest.Services.Where(service => service.SourceRef is not null)
            .GroupBy(service => service.SourceRef!, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Select(service => service.Key).Order(StringComparer.Ordinal).ToArray(), StringComparer.Ordinal);
        if (manifest.PrimarySource is { } primary && !references.ContainsKey(primary)) references.Add(primary, []);
        if (references.Count == 0) throw Error("source_missing", "No primary source or service source is declared for this application.");
        if (input.TargetBranch is not null && manifest.PrimarySource is null)
            throw Error("branch_required", "The preparation target branch applies only to a declared primary source.");
        if (input.ExpectedLocalHead is not null && manifest.PrimarySource is null)
            throw Error("local_source_required", "An accepted HEAD check requires a primary local Git source.");
        foreach (var (sourceId, connection) in input.SourceConnections ?? new Dictionary<string, string>())
        {
            if (!references.ContainsKey(sourceId) || string.IsNullOrWhiteSpace(connection) || connection.Length > 200 || connection.Any(char.IsControl))
                throw Error("source_connection_invalid", "Select a source connection for a referenced source using its exact name.");
        }

        var sources = new List<WorkspacePreparationRepository>();
        foreach (var (sourceId, services) in references.OrderBy(entry => entry.Key, StringComparer.Ordinal))
        {
            if (!manifest.Sources!.TryGetValue(sourceId, out var source) || string.IsNullOrWhiteSpace(source.Repository))
                throw Error("source_missing", $"Source '{sourceId}' has no repository.");
            var isPrimary = sourceId == manifest.PrimarySource;
            var binding = new WorkspaceSourceBinding(app.Id, app.InstalledAt, [sourceId], services, source.Branch, isPrimary);
            var requestedConnection = input.SourceConnections?.GetValueOrDefault(sourceId);
            var repository = isPrimary ? app.SourceState?.Repository ?? source.Repository : source.Repository;
            if (retainedRepositories?.TryGetValue(sourceId, out var retainedRepository) == true)
            {
                sources.Add(new(retainedRepository, "", null, binding, requestedConnection));
                continue;
            }
            try
            {
                var localRoot = isPrimary ? app.SourceState?.LocalOverridePath : null;
                if (!isPrimary && (Path.IsPathFullyQualified(repository) || !Uri.TryCreate(repository, UriKind.Absolute, out var uri) || uri.IsFile))
                {
                    if (app.ManifestUrl is not null || app.InstallManifestPath is not { } installManifest || !Path.IsPathFullyQualified(installManifest))
                        throw Error("source_local_unavailable", "A local service repository requires an installation from a trusted local manifest.");
                    if (!Path.IsPathFullyQualified(repository) && !Uri.TryCreate(repository, UriKind.Absolute, out _))
                        localRoot = Path.GetFullPath(repository, Path.GetDirectoryName(installManifest)!);
                }
                repository = await CanonicalRepository(repository, localRoot, ct);
                sources.Add(new(repository, "", null, binding, requestedConnection));
            }
            catch (AppLifecycleException error)
            {
                sources.Add(new(repository, "", null, binding, requestedConnection,
                    new(repository, binding.SourceIds, error.Code, error.Message)));
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException)
            {
                sources.Add(new(repository, "", null, binding, requestedConnection,
                    new(repository, binding.SourceIds, "workspace_source_local_unavailable", "The local Git repository is unavailable.")));
            }
        }

        return sources.GroupBy(source => (source.Repository, Failed: source.AdmissionFailure is not null))
            .Select(group =>
            {
                var members = group.ToArray();
                var isPrimary = members.Any(source => source.Binding.Primary);
                var branches = members.Select(source => source.Binding.TargetBranch).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
                if (branches.Length > 1)
                    throw Error("base_conflict", $"Sources sharing repository '{group.Key.Repository}' declare different target branches.");
                var connectionIds = members.Select(source => source.ConnectionId).OfType<string>().Distinct(StringComparer.Ordinal).ToArray();
                if (connectionIds.Length > 1 || isPrimary && connectionIds.Length == 1 && connectionIds[0] != app.PrivateSources?.Git?.ConnectionId)
                    throw Error("source_connection_invalid", "Use one connection for each repository. Change the primary connection through app source review.");
                var sourceIds = members.SelectMany(source => source.Binding.SourceIds).Order(StringComparer.Ordinal).ToArray();
                var serviceKeys = members.SelectMany(source => source.Binding.ServiceKeys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
                return new WorkspacePreparationRepository(group.Key.Repository,
                    isPrimary ? input.RequestId : DerivedPreparationId(input.RequestId, group.Key.Repository),
                    input.LeaseId is null || isPrimary || !distinctLeases ? input.LeaseId : DerivedPreparationId(input.LeaseId, group.Key.Repository),
                    new(app.Id, app.InstalledAt, sourceIds, serviceKeys,
                        (isPrimary ? input.TargetBranch : null) ?? branches.SingleOrDefault(), isPrimary), connectionIds.SingleOrDefault(),
                    members[0].AdmissionFailure is { } failure ? failure with { SourceIds = sourceIds } : null);
            })
            .OrderByDescending(source => source.Binding.Primary).ThenBy(source => source.Repository, StringComparer.Ordinal).ToArray();
    }

    private static WorkspacePreparationRepository[] RetainPrimaryReceiptIdentity(WorkspacePreparationRepository[] repositories,
        WorkspacePrepare input, bool hasPrimarySource)
    {
        if (hasPrimarySource || repositories.Any(repository => repository.RequestId == input.RequestId))
            return repositories;
        var representative = Array.FindIndex(repositories, repository => repository.AdmissionFailure is null);
        if (representative >= 0)
            repositories[representative] = repositories[representative] with { RequestId = input.RequestId, LeaseId = input.LeaseId };
        return repositories;
    }

    private static string PreparationSourceRevision(AppRecord app, RuntimeAppManifest manifest)
    {
        var descriptors = manifest.Sources!.OrderBy(entry => entry.Key, StringComparer.Ordinal)
            .Select(entry => entry.Key + "\n" + CoreJson.Text(entry.Value.WithoutReleasePin()));
        var references = manifest.Services.Where(service => service.SourceRef is not null)
            .OrderBy(service => service.Key, StringComparer.Ordinal).Select(service => service.Key + "\n" + service.SourceRef);
        return Hash(string.Join("\n", new[] { manifest.PrimarySource, app.SourceState?.Repository,
            app.SourceState?.Repository is { } repository && !Path.IsPathFullyQualified(repository) &&
                !Uri.TryCreate(repository, UriKind.Absolute, out _) ? app.SourceState.LocalOverridePath : null }
            .Concat(descriptors).Concat(references)));
    }

    private static string DerivedPreparationId(string id, string repository)
        => Guid.ParseExact(Hash(Guid.Parse(id).ToString("D") + "\n" + repository)[..32], "N").ToString("D");

    private static string PreparationFingerprint(WorkspacePrepare input, WorkspacePreparationRepository? source, string? coreRevision = null)
        => Hash(CoreJson.Text(input) + (coreRevision is null ? "" : "\ncore:" + coreRevision) +
            (source is null ? "" : "\nsource:" + source.Repository + "\n" + source.ConnectionId));

    private async Task<SourceReadGrant?> BindPreparationGrantAsync(WorkspacePreparationRepository source, string userId, CancellationToken ct)
        => source.ConnectionId is null ? null
            : await RemoteGit.BindAsync(userId, source.ConnectionId, source.Repository, false, ct);

    private async Task<bool> HasCurrentAdditionalSourceAsync(DevelopmentWorkspace tree, CancellationToken ct)
    {
        foreach (var binding in tree.ServiceSources ?? [])
        {
            if (binding.Primary || binding.Previous) continue;
            var app = await apps.GetAppAsync(binding.AppId, ct);
            if (app is null || app.InstalledAt != binding.Installation || app.ManifestPath is not { } path)
                continue;
            var manifest = await JsonStorage.ReadAsync<RuntimeAppManifest>(path, ct);
            if (manifest?.Sources is null) continue;
            foreach (var sourceId in binding.SourceIds)
            {
                if (!manifest.Services.Any(service => service.SourceRef == sourceId) ||
                    !manifest.Sources.TryGetValue(sourceId, out var source) || source.Repository is null)
                    continue;
                // Managed private Git uses a provider HTTPS repository identity, never a local path.
                if (LogicalRepositoryIdentity(source.Repository) == LogicalRepositoryIdentity(tree.Repository))
                    return true;
            }
        }
        return false;
    }

    private static DevelopmentWorkspace BindApplicationSource(DevelopmentWorkspace tree, AppRecord app, WorkspacePreparationRepository? planned)
    {
        if (planned is null) return Attach(tree, app, null);
        if (planned.Binding.Primary) tree = Attach(tree, app, null);
        return tree with { ServiceSources = [.. (tree.ServiceSources ?? []).Where(binding => !SameSourceBinding(binding, planned.Binding)), planned.Binding] };
    }

    private static bool SameSourceBinding(WorkspaceSourceBinding left, WorkspaceSourceBinding right)
        => left.AppId == right.AppId && left.Installation == right.Installation &&
            left.Primary == right.Primary &&
            left.SourceIds.SequenceEqual(right.SourceIds) && left.ServiceKeys.SequenceEqual(right.ServiceKeys);

    private async Task MarkPreviousSourcesAsync(string workspaceId, AppRecord app, WorkspacePreparationRepository[] sources,
        string? allocationGeneration, CancellationToken ct, string? legacyPrimaryTreeId = null)
    {
        var byRepository = sources.Where(source => source.AdmissionFailure is null).ToDictionary(source => source.Repository, StringComparer.Ordinal);
        var unresolved = sources.Where(source => source.AdmissionFailure is not null)
            .SelectMany(source => source.Binding.SourceIds).ToHashSet(StringComparer.Ordinal);
        var canClassifyLegacy = sources.Length > 0 && !sources.Any(source => source.Binding.Primary && source.AdmissionFailure is not null);
        foreach (var matched in (await ListAsync(null, false, ct)).Workspaces.Where(tree => tree.WorkspaceId == workspaceId &&
            (tree.ServiceSources?.Any(binding => binding.AppId == app.Id && !binding.Previous) == true ||
                canClassifyLegacy && tree.Apps.Any(binding => binding.AppId == app.Id && binding.Installation == app.InstalledAt))))
        {
            await Locked(Hash(OwnerIdentity(matched.Owner)), async () =>
            {
                var tree = await Read(matched.Id, null, ct);
                if (tree.AllocationGeneration != allocationGeneration) return true;
                if (legacyPrimaryTreeId is null) await RequireOpenWorkflow(tree.Owner, ct);
                var active = byRepository.GetValueOrDefault(tree.Repository)?.Binding;
                var recorded = tree.ServiceSources ?? [];
                var namedPrimary = recorded.Any(binding => binding.AppId == app.Id && binding.Installation == app.InstalledAt &&
                    binding.Primary && !binding.Previous);
                var legacyPrimaryReplaced = canClassifyLegacy && !namedPrimary && active?.Primary != true &&
                    tree.Apps.Any(binding => binding.AppId == app.Id && binding.Installation == app.InstalledAt);
                var sourceBindings = recorded.Select(binding => binding.AppId == app.Id && !binding.Previous &&
                    !binding.SourceIds.Any(unresolved.Contains) && (active is null || !SameSourceBinding(binding, active))
                        ? binding with { Previous = true } : binding)
                    .ToArray();
                if (legacyPrimaryReplaced)
                    sourceBindings = [.. sourceBindings, new(app.Id, app.InstalledAt, [], [], tree.TargetBranch, Primary: true, Previous: true)];
                if (!sourceBindings.SequenceEqual(recorded))
                {
                    var primaryRemoved = tree.Id != legacyPrimaryTreeId && active?.Primary != true &&
                        (legacyPrimaryReplaced || namedPrimary && !sourceBindings.Any(binding =>
                            binding.AppId == app.Id && binding.Installation == app.InstalledAt && binding.Primary && !binding.Previous));
                    await Save(tree with { ServiceSources = sourceBindings,
                        Apps = primaryRemoved ? tree.Apps.Where(binding => binding.AppId != app.Id).ToArray() : tree.Apps });
                }
                return true;
            }, ct);
        }
    }
}
