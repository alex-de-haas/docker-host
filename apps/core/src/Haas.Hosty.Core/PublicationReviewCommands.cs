namespace Haas.Hosty.Core;

internal sealed partial class PublicationService
{
    private string ReviewJournalPath(string id) => Path.Combine(Root, "review-operations", id + ".json");

    internal async Task<(PublicationRecord Record, UserProviderConnection Connection)> RequireReviewBindingAsync(
        DevelopmentWorkspace tree, string userId, string pullRequestUrl, CancellationToken ct, string? connectionId = null, UserProviderConnection? heldConnection = null)
    {
        // Inspection authority does not transfer another user's provider credentials, even
        // when the inspecting operator is also an administrator.
        if (tree.Owner.UserId != userId)
            throw new PublicationException("forbidden", "PR review requires the workspace owner's source account.");
        await workspaces.RequireCoreSourceAsync(tree, userId, ct, heldConnection);
        if (!(await users.ReadAsync(ct)).Users.Any(u => u.Id == userId && !u.Disabled && AppAccessPolicy.IsAdmin(u)))
            throw new PublicationException("forbidden", "PR review requires an active administrator account.");
        var saved = await Read(tree.Id, ct);
        if (saved is not null && !saved.Owner.SameIdentity(tree.Owner))
            throw new PublicationException("forbidden", "Publication belongs to another workspace owner.");
        UserProviderConnection selected;
        PublicationRecord record;
        if (tree.Owner.IsExternal)
        {
            var binding = await ExternalConnection(tree, ct, heldConnection);
            selected = binding.Connection;
            record = new() { WorkspaceId = tree.Id, Owner = tree.Owner, Provider = binding.Source.Descriptor.Id,
                Repository = binding.Repository, HeadRepository = binding.Repository, ConnectionId = selected.Id,
                Branch = tree.Branch, TargetBranch = tree.TargetBranch };
        }
        else
        {
            await RequireOwner(tree.Owner, ct);
            record = saved ?? throw new PublicationException("pr_required", "Publish or link a PR before reviewing it.");
            selected = (await users.ReadAsync(ct)).ProviderConnections?.SingleOrDefault(c => c.Id == record.ConnectionId && c.UserId == userId)
                ?? throw new PublicationException("connection_required", "Reconnect the workspace owner's source account.");
            var remote = await workspaces.PublicationRemoteAsync(tree, ct, validateGrant: heldConnection is null);
            if (remote is not null && heldConnection is not null) workspaces.ValidateHeldSourceGrant(remote.Grant, heldConnection);
            if (Publication(record.Provider).NormalizeRepository(remote?.Repository ?? tree.Repository) != record.Repository ||
                remote is not null && (remote.TargetBranch != record.TargetBranch || remote.Grant.ConnectionId != record.ConnectionId))
                throw new PublicationException("remote_changed", "The PR no longer matches the workspace's reviewed source remote.");
        }
        if (selected.Provider != record.Provider || selected.Status != "connected")
            throw new PublicationException("connection_required", "Reconnect the workspace owner's selected source account.");
        if (selected.ExpiresAt <= clock.UtcNow && selected.Method != "oauth")
            throw new PublicationException("connection_expired", "Reconnect the workspace owner's expired source account.");
        if (connectionId is not null && connectionId != selected.Id)
            throw new PublicationException("connection_conflict", "Use the source connection selected for this workspace.");
        var provider = Publication(record.Provider);
        var references = tree.PullRequests.Concat(saved?.Url is { } url ? [url] : [])
            .Concat(saved?.History.Select(h => h.Url) ?? []);
        if (!references.Any(reference => string.Equals(reference, pullRequestUrl, StringComparison.OrdinalIgnoreCase)) ||
            !Uri.TryCreate(pullRequestUrl, UriKind.Absolute, out var uri) ||
            !int.TryParse(uri.AbsolutePath.Split('/').LastOrDefault(), out var number) || number <= 0 ||
            !string.Equals(provider.PullRequestUrl(record.Repository, number), pullRequestUrl, StringComparison.OrdinalIgnoreCase))
            throw new PublicationException("pr_mismatch", "Select a PR already registered to this workspace and source repository.");
        return (record with { Number = number, Url = provider.PullRequestUrl(record.Repository, number) }, selected);
    }

    internal Task<PublicationReviewResult> CommandReviewAsync(DevelopmentWorkspace tree, string userId, string kind,
        PublicationReviewCommand input, CancellationToken ct) => Locked(async () =>
    {
        if (!Guid.TryParse(input.RequestId, out _) || kind is not ("reply" or "resolve" or "comment") ||
            (kind == "comment" ? input.ThreadId != "" : string.IsNullOrWhiteSpace(input.ThreadId)) || input.ThreadId.Length > 200 ||
            string.IsNullOrWhiteSpace(input.ExpectedHead) || input.ExpectedHead.Length > 64)
            throw new PublicationException("request_invalid", "Supply a UUID request ID, current PR head and concrete review location.");
        if (kind is "reply" or "comment" && (!input.AuthorIntent || string.IsNullOrWhiteSpace(input.Body) || input.Body.Length > 60000 ||
            input.Body.Contains("<!-- hosty-review-", StringComparison.Ordinal)))
            throw new PublicationException(kind == "reply" ? "reply_invalid" : "comment_invalid", "Explicitly submit a bounded comment using your selected source account.");
        if (kind == "comment" && (string.IsNullOrWhiteSpace(input.Path) || input.Path.Length > 4096 ||
            input.DiffSide is not ("LEFT" or "RIGHT") || input.Line is not > 0 || input.StartLine is <= 0 ||
            input.StartLine > input.Line))
            throw new PublicationException("comment_invalid", "Select an ordered range on one side of the published PR diff.");
        var current = await workspaces.Read(tree.Id, null, ct);
        var binding = await RequireReviewBindingAsync(current, userId, input.PullRequestUrl, ct, input.ConnectionId);
        var fingerprint = DevelopmentWorkspaceService.Hash(CoreJson.Text(input));
        var journal = await JsonStorage.ReadAsync<PublicationReviewJournal>(ReviewJournalPath(tree.Id), ct)
            ?? new(tree.Id, tree.Owner, []);
        if (journal.WorkspaceId != tree.Id || !journal.Owner.SameIdentity(tree.Owner))
            throw new PublicationException("forbidden", "Review operations belong to another workspace owner.");
        var previous = journal.Operations.FirstOrDefault(o => o.RequestId == input.RequestId);
        if (previous is not null && (previous.Fingerprint != fingerprint || previous.UserId != userId || previous.Kind != kind ||
            previous.ConnectionId != binding.Connection.Id || previous.Repository != binding.Record.Repository))
            throw new PublicationException("request_conflict", "The request ID belongs to different review arguments or a different source account.");
        if (previous is { State: "succeeded" })
            return new(input.RequestId, kind, "succeeded", previous.ThreadId, previous.CommentId);
        if (journal.Operations.Any(o => o.RequestId != input.RequestId && o.State == "pending"))
            throw new PublicationException("operation_pending", "Recover the pending review operation with its original request ID first.");
        var operation = previous is null
            ? new PublicationReviewOperation(input.RequestId, fingerprint, userId, binding.Connection.Id,
                binding.Record.Repository, binding.Record.Url!, kind, input.ExpectedHead, input.ThreadId, "pending")
            : previous with { State = "pending", Error = null };
        async Task SaveOperation()
        {
            journal = journal with { Operations = [.. journal.Operations.Where(o => o.RequestId != operation.RequestId), operation] };
            if (!await workspaces.WritePublicationAsync(tree.Id,
                () => JsonStorage.WriteAsync(ReviewJournalPath(tree.Id), journal, restrictToOwner: true), default))
                throw new PublicationException("workspace_closed", "The workspace is being deleted; no review operation was admitted.");
        }
        await SaveOperation();
        try
        {
            await connections.UseForSourceAsync(userId, binding.Connection.Id, async connection =>
            {
                if (connection.Provider != binding.Record.Provider)
                    throw new PublicationException("provider_mismatch", "Use the workspace's selected source provider.");
                var provider = Publication(connection.Provider);
                async Task AdmitMutation()
                {
                    ct.ThrowIfCancellationRequested();
                    var latest = await workspaces.Read(tree.Id, null, ct);
                    if (!latest.Owner.SameIdentity(tree.Owner))
                        throw new PublicationException("forbidden", "The review workspace belongs to another owner.");
                    var authorized = await RequireReviewBindingAsync(latest, userId, input.PullRequestUrl, ct,
                        binding.Connection.Id, connection);
                    if (authorized.Record.Provider != binding.Record.Provider ||
                        authorized.Record.Repository != binding.Record.Repository ||
                        authorized.Record.HeadRepository != binding.Record.HeadRepository ||
                        authorized.Record.TargetBranch != binding.Record.TargetBranch ||
                        authorized.Record.Branch != binding.Record.Branch)
                        throw new PublicationException("review_changed", "The workspace source changed before review admission. Refresh the review.");
                    ct.ThrowIfCancellationRequested();
                    // Persist immediately before the provider side effect. Recovery preserves
                    // uncertain outcomes and never blindly repeats a comment or reply POST.
                    operation = operation with { MutationStarted = true };
                    await SaveOperation();
                }
                if (kind == "comment")
                {
                    var marker = "<!-- hosty-review-comment:" + DevelopmentWorkspaceService.Hash(
                        tree.Id + "\n" + userId + "\n" + operation.ConnectionId + "\n" + operation.RequestId) + " -->";
                    var created = await provider.CreateReviewCommentAsync(connection, binding.Record, input, marker,
                        operation.MutationStarted, AdmitMutation, ct);
                    operation = operation with { ThreadId = created.ThreadId, CommentId = created.CommentId };
                }
                else if (kind == "reply")
                {
                    var marker = "<!-- hosty-review-reply:" + DevelopmentWorkspaceService.Hash(
                        tree.Id + "\n" + userId + "\n" + operation.ConnectionId + "\n" + operation.RequestId) + " -->";
                    var commentId = await provider.ReplyReviewAsync(connection, binding.Record, input.ThreadId, input.ExpectedHead,
                        input.Body!, marker, operation.MutationStarted, AdmitMutation, ct);
                    operation = operation with { CommentId = commentId };
                }
                else
                {
                    await provider.ResolveReviewAsync(connection, binding.Record, input.ThreadId, input.ExpectedHead,
                        AdmitMutation, ct);
                }
                return true;
            }, ct);
            operation = operation with { State = "succeeded", Error = null };
            await SaveOperation();
            await audit.AppendAsync(new("audit_" + Guid.NewGuid().ToString("N"), "development.review." + kind,
                "workspace", tree.Id, "succeeded", userId, clock.UtcNow,
                new Dictionary<string, string> { ["requestId"] = input.RequestId, ["threadId"] = operation.ThreadId }), ct);
            return new PublicationReviewResult(input.RequestId, kind, operation.State, operation.ThreadId, operation.CommentId);
        }
        catch (Exception ex) when (ex is PublicationException or UserConnectionException or AppLifecycleException or HttpRequestException or IOException or OperationCanceledException)
        {
            // A later admission refusal cannot disprove a previous provider side effect.
            var uncertain = previous is { State: "pending", MutationStarted: true } ||
                operation.MutationStarted && (kind is "reply" or "comment" || ex is not PublicationException pe ||
                    pe.Code is "publication_provider_unavailable");
            operation = operation with { State = uncertain ? "pending" : "failed",
                Error = uncertain ? "Outcome is uncertain. Recover with the same request ID before submitting another review operation."
                    : ex switch
                    {
                        PublicationException publication => publication.Message,
                        AppLifecycleException source => source.Message,
                        UserConnectionException account => account.Message,
                        _ => "Review operation failed. Refresh before retrying."
                    } };
            await SaveOperation();
            // Return the durable outcome for every admitted review command. A definitive
            // rejection must let the browser retain the draft without freezing its stale intent.
            return new PublicationReviewResult(input.RequestId, kind, operation.State, operation.ThreadId, operation.CommentId, operation.Error);
        }
    }, ct);
}
