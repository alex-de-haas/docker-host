using System.Text.Json;

namespace Haas.Hosty.Core;

// Read-only observations are separate from publication commands and completion/cleanup policy.
internal sealed record ExternalPublicationSnapshot(string WorkspaceId, WorkspaceOwner Owner,
    string Repository, string ConnectionId, InspectionPullRequest[] PullRequests)
{
    // Internal attempt metadata: unavailable references keep their public Observation=null shape.
    public Dictionary<string, DateTimeOffset>? FailedAt { get; init; }
    public string? TargetBranch { get; init; }
}

internal sealed partial class PublicationService
{
    private readonly SemaphoreSlim externalObservationGate = new(1, 1);
    private string ExternalPath(string id) => Path.Combine(Root, "external", id + ".json");

    private async Task<(ISourceProvider Source, string Repository, UserProviderConnection Connection, string TargetBranch)> ExternalConnection(
        DevelopmentWorkspace tree, CancellationToken ct, UserProviderConnection? heldConnection = null, bool localOnly = false)
    {
        if (!tree.Owner.IsExternal) throw new PublicationException("forbidden", "External workspace required.");
        await workspaces.RequireExternalSourceAsync(tree, ct, heldConnection, localOnly);
        var state = await users.ReadAsync(ct);
        if (!state.Users.Any(u => u.Id == tree.Owner.UserId && !u.Disabled && AppAccessPolicy.IsAdmin(u)))
            throw new PublicationException("forbidden", "PR tracking requires the workspace owner's active administrator account.");
        var remote = await workspaces.PublicationRemoteAsync(tree, ct, validateGrant: heldConnection is null, localOnly: localOnly);
        if (remote is not null && heldConnection is not null) workspaces.ValidateHeldSourceGrant(remote.Grant, heldConnection);
        var source = connections.Providers.ForUrl(remote?.Repository ?? tree.Repository);
        var provider = source.Publication ?? throw new PublicationException("unsupported", "This source provider does not support PR tracking.");
        var repository = provider.NormalizeRepository(remote?.Repository ?? tree.Repository);
        var grant = remote?.Grant ?? await workspaces.WorkspaceGrantAsync(tree, ct, heldConnection, localOnly);
        if (grant is null)
        {
            foreach (var binding in tree.Apps)
            {
                var app = await apps.GetAppAsync(binding.AppId, ct);
                if (app?.InstalledAt == binding.Installation && app.PrivateSources?.Git is { } current)
                { grant = current; break; }
            }
        }
        var candidates = (state.ProviderConnections ?? []).Where(c => c.UserId == tree.Owner.UserId &&
            c.Provider == source.Descriptor.Id && c.Status == "connected" &&
            (grant is null || c.Id == grant.ConnectionId)).ToArray();
        if (candidates.Length == 0)
            throw new PublicationException("connection_required", "PR tracking is not connected. Connect the workspace owner's source account in Shell Settings → Source connections.");
        if (candidates.Length != 1)
            throw new PublicationException("connection_ambiguous", "Several source accounts match. Select a Git source connection for the workspace's application to enable PR tracking.");
        var connection = candidates[0];
        if (connection.ExpiresAt <= clock.UtcNow && connection.Method != "oauth")
            throw new PublicationException("connection_expired", "PR tracking connection expired. Reconnect it in Shell Settings → Source connections.");
        return (source, repository, connection, remote?.TargetBranch ?? tree.TargetBranch);
    }

    internal async Task<InspectionPullRequest[]> ReadExternalReferencesAsync(DevelopmentWorkspace tree, string userId, CancellationToken ct)
    {
        var urls = tree.PullRequests.Where(SafeReference).Distinct(StringComparer.Ordinal).ToArray();
        InspectionPullRequest[] Unavailable(string message) => urls.Select(url => new InspectionPullRequest(url, null, null, message)).ToArray();
        if (tree.Owner.UserId != userId) return Unavailable("PR tracking is available to the workspace owner.");
        try
        {
            var binding = await ExternalConnection(tree, ct, localOnly: true);
            ExternalPublicationSnapshot? snapshot = null;
            try { snapshot = await inspectionRecords.ReadAsync<ExternalPublicationSnapshot>(ExternalPath(tree.Id), ct); }
            catch (Exception ex) when (ex is IOException or JsonException) { /* A verified publication may still have a newer retained observation. */ }
            if (!MatchesExternalSnapshot(snapshot, tree, binding.Repository, binding.Connection.Id, binding.TargetBranch)) snapshot = null;
            var record = await ReadInspectionRecordAsync(tree.Id, ct);
            if (record is null || record.WorkspaceId != tree.Id || !record.Owner.SameIdentity(tree.Owner) ||
                record.ConnectionId != binding.Connection.Id || record.Provider != binding.Source.Descriptor.Id ||
                record.Repository != binding.Repository || record.HeadRepository != binding.Repository || record.TargetBranch != binding.TargetBranch)
                record = null;
            return urls.Select(url =>
            {
                var candidates = new List<InspectionPullRequest>();
                candidates.AddRange(snapshot?.PullRequests.Where(p => string.Equals(p.Url, url, StringComparison.OrdinalIgnoreCase)) ?? []);
                void AddPublication(string? candidateUrl, int? number, PublicationObservation? observation, bool historical = false)
                {
                    if (number is not > 0 || candidateUrl is null || observation is null ||
                        !string.Equals(candidateUrl, url, StringComparison.OrdinalIgnoreCase) ||
                        !string.Equals(binding.Source.Publication!.PullRequestUrl(binding.Repository, number.Value), url, StringComparison.OrdinalIgnoreCase)) return;
                    candidates.Add(new(url, observation.Head, observation, null, Historical: historical));
                }
                if (record is not null)
                {
                    AddPublication(record.Url, record.Number, record.Observation);
                    foreach (var previous in record.History) AddPublication(previous.Url, previous.Number, previous.Observation, historical: true);
                }
                return LatestExternalReference(url, candidates, FailedAt(snapshot, url), failClosed: true);
            }).ToArray();
        }
        catch (Exception ex) when (ex is PublicationException or UserConnectionException or AppLifecycleException)
        { return Unavailable(ex.Message); }
        catch (Exception ex) when (ex is IOException or JsonException)
        { return Unavailable("PR observation is unavailable; the next refresh will retry."); }
    }

    private static bool MatchesExternalSnapshot(ExternalPublicationSnapshot? snapshot, DevelopmentWorkspace tree, string repository, string connectionId, string targetBranch)
        => snapshot is not null && snapshot.WorkspaceId == tree.Id && snapshot.Owner.SameIdentity(tree.Owner) &&
            snapshot.Repository == repository && snapshot.ConnectionId == connectionId &&
            (snapshot.TargetBranch ?? tree.TargetBranch) == targetBranch;

    private static DateTimeOffset? FailedAt(ExternalPublicationSnapshot? snapshot, string url)
        => snapshot?.FailedAt?.Where(pair => string.Equals(pair.Key, url, StringComparison.OrdinalIgnoreCase))
            .Select(pair => (DateTimeOffset?)pair.Value).Max();

    private static InspectionPullRequest LatestExternalReference(string url, IEnumerable<InspectionPullRequest> candidates,
        DateTimeOffset? failedAt = null, bool failClosed = false)
    {
        var items = candidates.ToArray();
        var observed = items.Where(p => p.Observation is not null).ToArray();
        var newest = observed.Length == 0 ? (DateTimeOffset?)null : observed.Max(p => p.Observation!.At);
        var latest = observed.Where(p => p.Observation!.At == newest).ToArray();
        var failed = items.FirstOrDefault(p => p.Observation is null && p.Unavailable is not null);
        var reference = failClosed && failed is not null && (failedAt is null || newest is null || failedAt >= newest) ? failed
            : latest.FirstOrDefault(p => p.Unavailable is not null || p.Observation!.Error is not null)
            ?? latest.FirstOrDefault() ?? items.FirstOrDefault()
            ?? new(url, null, null, "PR tracking is connected; waiting for the next provider observation.");
        if (reference.Observation is not null && latest.Select(p => (p.Observation!.State, p.Observation.Head, p.Observation.Draft)).Distinct().Skip(1).Any())
            reference = reference with { Observation = reference.Observation! with { State = "unavailable", Error = "Retained PR observations disagree; refresh provider status." } };
        // Legacy caches and exact publication records may contain private reviews/completion proof.
        return reference with { Url = url, Observation = reference.Observation is { } observation
            ? observation with { Complete = false, Reviews = null } : null };
    }

    // Explicit completion checks run outside the workspace mutation gate. Retain their display
    // facts before completion stops background observation, without retaining completion authority.
    private async Task RetainExternalReferenceAsync(DevelopmentWorkspace tree, string repository, string connectionId,
        string providerId, string targetBranch, string url, int number, InspectionPullRequest reference, CancellationToken ct, bool background = false,
        DateTimeOffset? attemptedAt = null)
    {
        // Capture the failed attempt before waiting for the final-write gate.
        var failureTime = attemptedAt ?? clock.UtcNow;
        if (!await workspaces.WritePublicationAsync(tree.Id, async () =>
        {
            if (background && !await workspaces.CanObserveInBackgroundAsync(tree.Id, ct)) return;
            var current = await workspaces.Read(tree.Id, tree.Owner, ct);
            var binding = await ExternalConnection(current, ct, localOnly: true);
            if (!current.Owner.SameIdentity(tree.Owner) || binding.Connection.Id != connectionId || binding.Source.Descriptor.Id != providerId ||
                binding.Repository != repository || binding.TargetBranch != targetBranch ||
                !current.PullRequests.Contains(url, StringComparer.OrdinalIgnoreCase) ||
                !string.Equals(binding.Source.Publication!.PullRequestUrl(binding.Repository, number), url, StringComparison.OrdinalIgnoreCase))
                throw new PublicationException("pr_mismatch", "The workspace PR binding changed during observation.");
            ExternalPublicationSnapshot? previous = null;
            try { previous = await JsonStorage.ReadAsync<ExternalPublicationSnapshot>(ExternalPath(tree.Id), ct); }
            catch (Exception ex) when (ex is IOException or JsonException) { /* Replace an unreadable display snapshot with fresh verified facts. */ }
            var retained = MatchesExternalSnapshot(previous, current, repository, connectionId, targetBranch) ? previous!.PullRequests : [];
            if (retained.Length == 0) previous = null;
            var failureTimes = new Dictionary<string, DateTimeOffset>(StringComparer.OrdinalIgnoreCase);
            var items = current.PullRequests.Where(SafeReference).Distinct(StringComparer.Ordinal).Select(referenceUrl =>
            {
                var prior = retained.FirstOrDefault(p => string.Equals(p.Url, referenceUrl, StringComparison.OrdinalIgnoreCase));
                var updating = string.Equals(reference.Url, referenceUrl, StringComparison.OrdinalIgnoreCase);
                var failedAt = FailedAt(previous, referenceUrl);
                var failedNow = updating && reference.Observation is null && reference.Unavailable is not null;
                if (failedNow && (failedAt is null || failureTime > failedAt)) failedAt = failureTime;
                IEnumerable<InspectionPullRequest> candidates = updating
                    ? new[] { reference, prior }.OfType<InspectionPullRequest>()
                    : new[] { prior }.OfType<InspectionPullRequest>();
                // A new live success can recover an untimestamped legacy failure; cached reads cannot.
                var result = LatestExternalReference(referenceUrl, candidates, failedAt, failClosed: !updating || failedNow || failedAt is not null);
                if (result.Observation is null && result.Unavailable is not null && failedAt is { } failed)
                    failureTimes[referenceUrl] = failed;
                return result;
            }).ToArray();
            await JsonStorage.WriteAsync(ExternalPath(tree.Id), new ExternalPublicationSnapshot(tree.Id, current.Owner,
                repository, connectionId, items) { FailedAt = failureTimes.Count == 0 ? null : failureTimes, TargetBranch = targetBranch }, restrictToOwner: true);
        }, ct))
            throw new PublicationException("pr_mismatch", "The workspace stopped accepting PR observations.");
    }

    // Fetch fresh provider evidence before acquiring the workspace mutation lock. Publication
    // commands take publication -> workspace locks; reversing that order would deadlock.
    internal async Task<Dictionary<string, string>> MergedWorkspaceHeadsAsync(WorkspaceOwner owner, CancellationToken ct, string? actorId = null)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        // Provider evidence uses the connection belonging to its recorded owner. Collection-wide
        // source authority does not let another operator borrow that connection for completion.
        if (actorId is not null && actorId != owner.UserId) return result;
        foreach (var tree in (await workspaces.ListAsync(null, true, ct)).Workspaces.Where(t => t.Owner.SameIdentity(owner)))
        {
            if (!owner.IsExternal)
            {
                var record = await Read(tree.Id, ct);
                if (record is null) continue;
                record = await ObserveAsync(tree.Id, null, ct);
                if (record.Observation is { State: "merged", Complete: true, Head: { } head } && head == record.PublishedHead)
                    result[tree.Id] = head;
                continue;
            }
            if (tree.PullRequests.Length == 0) continue;
            try
            {
                var binding = await ExternalConnection(tree, ct);
                var provider = binding.Source.Publication!;
                // Background observation stops while paused. Refresh local evidence explicitly
                // before selecting a matching PR; the mutation rechecks it under the owner gate.
                var current = await workspaces.ObserveAsync(tree.Id, owner, ct);
                foreach (var url in tree.PullRequests.Where(SafeReference))
                {
                    if (!int.TryParse(new Uri(url).AbsolutePath.Split('/').LastOrDefault(), out var number) ||
                        number <= 0 || !string.Equals(provider.PullRequestUrl(binding.Repository, number), url, StringComparison.OrdinalIgnoreCase)) continue;
                    var record = new PublicationRecord { WorkspaceId = tree.Id, Owner = owner,
                        Repository = binding.Repository, HeadRepository = binding.Repository,
                        ConnectionId = binding.Connection.Id, Provider = binding.Source.Descriptor.Id,
                        Branch = tree.Branch, TargetBranch = binding.TargetBranch, Number = number, Url = url };
                    var observation = await connections.UseForSourceAsync(owner.UserId, binding.Connection.Id,
                        c => provider.ObserveAsync(c, record, ct), ct);
                    if (observation.Error is null && observation.State is "open" or "closed" or "merged")
                        await RetainExternalReferenceAsync(tree, binding.Repository, binding.Connection.Id, binding.Source.Descriptor.Id,
                            binding.TargetBranch, url, number, new(url, observation.Head, observation, null), ct);
                    if (observation is { State: "merged", Complete: true, Head: { } head } && head == current.Observation?.Head)
                        result[tree.Id] = head;
                }
            }
            catch (Exception ex) when (ex is PublicationException or UserConnectionException or HttpRequestException)
            { /* No provider exemption; the fresh target ancestry check still applies. */ }
        }
        return result;
    }

    private int externalObservationCursor;
    internal async Task RefreshExternalReferencesAsync(CancellationToken ct, TimeSpan? maximumDuration = null)
    {
        if (!await externalObservationGate.WaitAsync(0, ct)) return;
        using var cycle = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cycle.CancelAfter(maximumDuration ?? TimeSpan.FromSeconds(10));
        try
        {
            var eligible = new List<DevelopmentWorkspace>();
            foreach (var tree in (await workspaces.ListAsync(null, true, cycle.Token)).Workspaces.Where(w => w.Owner.IsExternal))
                if (await workspaces.CanObserveInBackgroundAsync(tree.Id, cycle.Token)) eligible.Add(tree);
            var jobs = eligible.OrderBy(w => w.Id, StringComparer.Ordinal)
                .SelectMany(tree => tree.PullRequests.Where(SafeReference).Distinct(StringComparer.Ordinal)
                    .OrderBy(url => url, StringComparer.Ordinal).Select(url => (Tree: tree, Url: url))).ToArray();
            // One global request budget, with rotation so a slow or large workspace cannot starve
            // references later in the list. Ordinary publications run before this bounded batch.
            for (var attempt = 0; attempt < Math.Min(10, jobs.Length) && !cycle.IsCancellationRequested; attempt++)
            {
                var (tree, url) = jobs[externalObservationCursor % jobs.Length];
                externalObservationCursor = (externalObservationCursor + 1) % jobs.Length;
                try
                {
                    // A previous provider request may have overlapped Delete. Recheck each
                    // queued item so the rest of the batch does not keep polling that workspace.
                    if (!await workspaces.CanObserveInBackgroundAsync(tree.Id, cycle.Token)) continue;
                    var binding = await ExternalConnection(tree, cycle.Token);
                    var provider = binding.Source.Publication!;
                    InspectionPullRequest result;
                    try
                    {
                        var uri = new Uri(url);
                        if (!int.TryParse(uri.AbsolutePath.Split('/').Last(), out var number) || number <= 0 ||
                            !string.Equals(provider.PullRequestUrl(binding.Repository, number), url, StringComparison.OrdinalIgnoreCase))
                            throw new PublicationException("pr_mismatch", "The PR URL does not match this workspace's source repository.");
                        var record = new PublicationRecord { WorkspaceId = tree.Id, Owner = tree.Owner,
                            Repository = binding.Repository, HeadRepository = binding.Repository,
                            ConnectionId = binding.Connection.Id, Provider = binding.Source.Descriptor.Id,
                            Branch = tree.Branch, TargetBranch = binding.TargetBranch, Number = number, Url = url };
                        var observation = await connections.UseForSourceAsync(tree.Owner.UserId, binding.Connection.Id,
                            c => provider.ObserveReferenceAsync(c, record, cycle.Token), cycle.Token);
                        // A linked PR may use another branch; its display facts never authorize
                        // exact-source review, completion or source cleanup.
                        result = new(url, observation.Head, observation with { Complete = false, Reviews = null }, null);
                    }
                    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                    { result = new(url, null, null, "Provider observation timed out; the next refresh will retry."); }
                    catch (Exception ex) when (ex is PublicationException or UserConnectionException or HttpRequestException or JsonException)
                    { result = new(url, null, null, ex is PublicationException ? ex.Message : "Provider state is unavailable. Check the source connection; the next refresh will retry."); }
                    // Persist after the network budget, rechecking access without another request.
                    var observedNumber = int.TryParse(new Uri(url).AbsolutePath.Split('/').Last(), out var parsed) ? parsed : 0;
                    await RetainExternalReferenceAsync(tree, binding.Repository, binding.Connection.Id, binding.Source.Descriptor.Id,
                        binding.TargetBranch, url, observedNumber, result, ct, background: true);
                }
                catch (Exception ex) when (ex is PublicationException or UserConnectionException or AppLifecycleException or IOException or JsonException)
                { /* Unavailable ownership/source/credentials are explained by the read projection. */ }
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { /* Yield the observer when this batch's deadline expires. */ }
        finally { externalObservationGate.Release(); }
    }

    private static bool SafeReference(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) &&
        uri.Scheme == "https" && uri.UserInfo.Length == 0;
}
