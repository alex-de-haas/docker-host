using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static PublicationRecord ExternalDisplayRecord(DevelopmentWorkspace tree, PublicationObservation observation)
        => new() { WorkspaceId = tree.Id, Owner = tree.Owner, Repository = "owner/repo",
            HeadRepository = "owner/repo", ConnectionId = "connection", Provider = "github",
            Branch = tree.Branch, TargetBranch = tree.TargetBranch, Number = 42,
            Url = "https://github.com/owner/repo/pull/42", PublishedHead = observation.Head, Observation = observation };

    private static string ExternalDisplayPath(string root, DevelopmentWorkspace tree)
        => Path.Combine(root, "development/publications/external", tree.Id + ".json");

    private static Task WriteExternalDisplay(string root, DevelopmentWorkspace tree, PublicationObservation observation)
        => JsonStorage.WriteAsync(ExternalDisplayPath(root, tree), new ExternalPublicationSnapshot(tree.Id,
            tree.Owner, "owner/repo", "connection", [new(tree.PullRequests[0], observation.Head, observation, null)]));

    [Fact]
    public async Task ExternalPublicationDisplay_NewerCanonicalMergeReplacesStaleOpenForCompletedInventoryWithoutProviderReads()
    {
        var f = await ExternalPublicationFixture();
        var at = DateTimeOffset.UtcNow.AddMinutes(-10);
        var open = new PublicationObservation(at, "open", f.Provider.Head);
        await WriteExternalDisplay(f.F.Paths.CoreRoot, f.W, open);
        var merged = open with { At = at.AddMinutes(1), State = "merged", Complete = true,
            Reviews = [new("private-thread", "README.md", 1, false, ["Private current review body"])] };
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json"),
            ExternalDisplayRecord(f.W, merged));
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workflows",
            DevelopmentWorkspaceService.Hash(DevelopmentWorkspaceService.OwnerIdentity(f.W.Owner)) + ".json"),
            new WorkspaceWorkflow("completed", CompletedAt: at.AddMinutes(2)));

        var inspection = new WorkspaceInspectionService(f.Workspaces, f.F.Apps, f.F.Clock, f.Service);
        var row = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces);
        Assert.Equal("completed", row.Workflow!.State);
        Assert.Equal("merged", row.PullRequestSummary!.State);
        Assert.Equal(0, row.PullRequestSummary.OpenCount);
        var result = Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default));
        Assert.Equal(merged.At, result.Observation!.At);
        Assert.Equal("merged", result.Observation.State);
        Assert.False(result.Observation.Complete);
        Assert.Null(result.Observation.Reviews);
        Assert.DoesNotContain("Private current review body", CoreJson.Text(result));
        Assert.Equal(0, f.Provider.Observed);
        Assert.Equal(0, f.Provider.Created);
        Assert.Equal(0, f.Provider.Merged);
    }

    [Fact]
    public async Task ExternalPublicationDisplay_NewerSnapshotWinsAndCanonicalUrlCasingStillMatches()
    {
        var f = await ExternalPublicationFixture();
        var at = DateTimeOffset.UtcNow.AddMinutes(-10);
        var merged = new PublicationObservation(at, "merged", f.Provider.Head);
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json"),
            ExternalDisplayRecord(f.W, merged) with { Url = f.W.PullRequests[0].ToUpperInvariant() });
        var open = merged with { At = at.AddMinutes(1), State = "open", Draft = true };
        await WriteExternalDisplay(f.F.Paths.CoreRoot, f.W, open);
        var current = Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default));
        Assert.Equal(open.At, current.Observation!.At);
        Assert.Equal("open", current.Observation.State);
        Assert.True(current.Observation.Draft);

        // The canonical identity is compared independently of presentation casing.
        File.Delete(ExternalDisplayPath(f.F.Paths.CoreRoot, f.W));
        current = Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default));
        Assert.Equal("merged", current.Observation!.State);
        Assert.Equal(0, f.Provider.Observed);
    }

    [Fact]
    public async Task ExternalPublicationDisplay_MalformedSnapshotDoesNotHideValidCanonicalOrHistoricalFacts()
    {
        var f = await ExternalPublicationFixture();
        var at = DateTimeOffset.UtcNow.AddMinutes(-10);
        var merged = new PublicationObservation(at, "merged", "old-head", Complete: true,
            Reviews: [new("thread", "README.md", 1, false, ["Private historical display body"])]);
        var record = ExternalDisplayRecord(f.W, merged) with { Number = 43, Url = "https://github.com/owner/repo/pull/43",
            History = [new(42, f.W.PullRequests[0], "old-head", "merge-head", merged)] };
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json"), record);
        var path = ExternalDisplayPath(f.F.Paths.CoreRoot, f.W);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, "invalid json");

        var result = Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default));
        Assert.Equal("merged", result.Observation!.State);
        Assert.Equal("old-head", result.PublishedHead);
        Assert.False(result.Observation.Complete);
        Assert.Null(result.Observation.Reviews);
        Assert.DoesNotContain("Private historical display body", CoreJson.Text(result));
        Assert.Equal(0, f.Provider.Observed);
    }

    [Theory]
    [InlineData("workspace")]
    [InlineData("user")]
    [InlineData("principal")]
    [InlineData("session")]
    [InlineData("repository")]
    [InlineData("head-repository")]
    [InlineData("target-branch")]
    [InlineData("connection")]
    [InlineData("provider")]
    [InlineData("url")]
    [InlineData("number")]
    public async Task ExternalPublicationDisplay_MismatchedCanonicalEvidenceCannotReplaceAuthorizedSnapshot(string mismatch)
    {
        var f = await ExternalPublicationFixture();
        var at = DateTimeOffset.UtcNow.AddMinutes(-10);
        var open = new PublicationObservation(at, "open", f.Provider.Head);
        await WriteExternalDisplay(f.F.Paths.CoreRoot, f.W, open);
        var record = ExternalDisplayRecord(f.W, open with { At = at.AddMinutes(1), State = "merged" });
        record = mismatch switch {
            "workspace" => record with { WorkspaceId = new string('a', 64) },
            "user" => record with { Owner = record.Owner with { UserId = "another-admin" } },
            "principal" => record with { Owner = record.Owner with { External = record.Owner.External! with { PrincipalId = "another-principal" } } },
            "session" => record with { Owner = record.Owner with { SessionId = "another-session" } },
            "repository" => record with { Repository = "another/repo" },
            "head-repository" => record with { HeadRepository = "another/repo" },
            "target-branch" => record with { TargetBranch = "another-target" },
            "connection" => record with { ConnectionId = "another-connection" },
            "provider" => record with { Provider = "another-provider" },
            "url" => record with { Url = "https://github.com/another/repo/pull/42" },
            _ => record with { Number = 43 }
        };
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json"), record);

        var result = Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default));
        Assert.Equal("open", result.Observation!.State);
        Assert.Equal(open.At, result.Observation.At);
        Assert.Equal(0, f.Provider.Observed);
    }

    [Fact]
    public async Task ExternalPublicationDisplay_AdvancedCanonicalPrHeadRemainsDisplayOnly()
    {
        var f = await ExternalPublicationFixture();
        var observation = new PublicationObservation(DateTimeOffset.UtcNow, "open", "advanced-provider-head", Complete: true);
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json"),
            ExternalDisplayRecord(f.W, observation) with { PublishedHead = "previous-published-head" });

        var result = Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default));
        Assert.Equal("open", result.Observation!.State);
        Assert.Equal("advanced-provider-head", result.PublishedHead);
        Assert.False(result.Observation.Complete);
        Assert.Equal(0, f.Provider.Observed);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExternalPublicationDisplay_RevalidatesConnectionAndViewerForBothRetainedSources(bool revoked)
    {
        var f = await ExternalPublicationFixture();
        var open = new PublicationObservation(DateTimeOffset.UtcNow.AddMinutes(-10), "open", f.Provider.Head);
        await WriteExternalDisplay(f.F.Paths.CoreRoot, f.W, open);
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json"),
            ExternalDisplayRecord(f.W, open with { At = open.At.AddMinutes(1), State = "merged" }));
        if (revoked) await f.Users.UpdateAsync(s => s with { ProviderConnections = [] });

        var result = Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, revoked ? "admin" : "another-admin", default));
        Assert.Null(result.Observation);
        Assert.NotNull(result.Unavailable);
        Assert.Equal(0, f.Provider.Observed);
    }

    [Fact]
    public async Task ExternalPublicationDisplay_ExplicitMergedHeadEvidenceRefreshesDisplayWithoutCreatingPublication()
    {
        var f = await ExternalPublicationFixture();
        await WriteExternalDisplay(f.F.Paths.CoreRoot, f.W,
            new(DateTimeOffset.UtcNow.AddMinutes(-10), "open", f.Provider.Head));
        f.Provider.State = "merged";
        f.Provider.Complete = true;

        var heads = await f.Service.MergedWorkspaceHeadsAsync(f.W.Owner, default, "admin");
        Assert.Equal(f.Provider.Head, heads[f.W.Id]);
        var snapshot = (await JsonStorage.ReadAsync<ExternalPublicationSnapshot>(ExternalDisplayPath(f.F.Paths.CoreRoot, f.W)))!;
        var stored = Assert.Single(snapshot.PullRequests);
        Assert.Equal("merged", stored.Observation!.State);
        Assert.False(stored.Observation.Complete);
        Assert.Null(stored.Observation.Reviews);
        Assert.DoesNotContain("private review body", CoreJson.Text(snapshot));
        var read = Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default));
        Assert.Equal("merged", read.Observation!.State);
        Assert.False(read.Observation.Complete);
        Assert.Empty((await f.Service.ListAsync(null, default)).Publications);
        Assert.Equal(1, f.Provider.Observed);
        Assert.Equal(0, f.Provider.Created);
        Assert.Equal(0, f.Provider.Merged);
    }

    [Fact]
    public async Task ExternalPublicationDisplay_CompletionRefreshDoesNotPersistAfterConnectionRevocation()
    {
        var f = await ExternalPublicationFixture();
        await WriteExternalDisplay(f.F.Paths.CoreRoot, f.W,
            new(DateTimeOffset.UtcNow.AddMinutes(-10), "open", f.Provider.Head));
        f.Provider.State = "merged";
        f.Provider.Complete = true;
        f.Provider.BeforeObserve = (_, _) => f.Users.UpdateAsync(s => s with { ProviderConnections = [] });

        await f.Service.MergedWorkspaceHeadsAsync(f.W.Owner, default, "admin");

        var snapshot = (await JsonStorage.ReadAsync<ExternalPublicationSnapshot>(ExternalDisplayPath(f.F.Paths.CoreRoot, f.W)))!;
        Assert.Equal("open", Assert.Single(snapshot.PullRequests).Observation!.State);
        Assert.Null(Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default)).Observation);
        Assert.Equal(1, f.Provider.Observed);
    }

    [Fact]
    public async Task ExternalPublicationDisplay_LateOlderBackgroundResponsePreservesNewerMergedSnapshot()
    {
        var f = await ExternalPublicationFixture();
        var newer = new PublicationObservation(DateTimeOffset.UtcNow.AddMinutes(1), "merged", f.Provider.Head);
        // A concurrent completion check persists fresher evidence while this background call
        // is outstanding. Its older response must not undo that observed merge.
        f.Provider.BeforeObserve = (_, _) => WriteExternalDisplay(f.F.Paths.CoreRoot, f.W, newer);

        await f.Service.RefreshExternalReferencesAsync(default);

        var snapshot = (await JsonStorage.ReadAsync<ExternalPublicationSnapshot>(ExternalDisplayPath(f.F.Paths.CoreRoot, f.W)))!;
        var retained = Assert.Single(snapshot.PullRequests);
        Assert.Equal("merged", retained.Observation!.State);
        Assert.Equal(newer.At, retained.Observation.At);
        Assert.Equal("merged", Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default)).Observation!.State);
        Assert.Equal(1, f.Provider.Observed);
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    public async Task ExternalPublicationDisplay_NewOrEqualFailedAttemptHidesCanonicalSuccessUntilNewerSuccess(int previousMinutes)
    {
        var f = await ExternalPublicationFixture();
        f.F.Clock.UtcNow = DateTimeOffset.UtcNow;
        var previous = new PublicationObservation(f.F.Clock.UtcNow.AddMinutes(previousMinutes), "open", f.Provider.Head,
            Checks: [new("CI", "SUCCESS")]);
        var path = Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json");
        await JsonStorage.WriteAsync(path, ExternalDisplayRecord(f.W, previous));
        var inspection = new WorkspaceInspectionService(f.Workspaces, f.F.Apps, f.F.Clock, f.Service);
        Assert.Equal("passed", Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).PullRequestSummary!.Checks);
        Assert.Equal(0, f.Provider.Observed);

        f.Provider.FailedNumber = 42;
        await f.Service.RefreshExternalReferencesAsync(default);

        var snapshot = (await JsonStorage.ReadAsync<ExternalPublicationSnapshot>(ExternalDisplayPath(f.F.Paths.CoreRoot, f.W)))!;
        var failed = Assert.Single(snapshot.PullRequests);
        Assert.Null(failed.Observation);
        Assert.NotNull(failed.Unavailable);
        Assert.Equal(f.F.Clock.UtcNow, snapshot.FailedAt![f.W.PullRequests[0]]);
        var unavailable = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).PullRequestSummary!;
        Assert.Equal("unknown", unavailable.State);
        Assert.Equal("unknown", unavailable.Checks);
        Assert.True(unavailable.Partial);
        Assert.Equal(0, unavailable.OpenCount);
        Assert.Equal(1, f.Provider.Observed);

        await JsonStorage.WriteAsync(path, ExternalDisplayRecord(f.W, previous with { At = f.F.Clock.UtcNow.AddMinutes(1) }));
        var recovered = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).PullRequestSummary!;
        Assert.Equal("open", recovered.State);
        Assert.Equal("passed", recovered.Checks);
        Assert.False(recovered.Partial);
        Assert.Equal(1, recovered.OpenCount);
        Assert.Equal(1, f.Provider.Observed);
    }

    [Fact]
    public async Task ExternalPublicationDisplay_UntimestampedLegacyFailureRequiresLiveRefreshBeforeShowingSuccess()
    {
        var f = await ExternalPublicationFixture();
        f.F.Clock.UtcNow = DateTimeOffset.UtcNow.AddMinutes(-1);
        var snapshotPath = ExternalDisplayPath(f.F.Paths.CoreRoot, f.W);
        await JsonStorage.WriteAsync(snapshotPath, new ExternalPublicationSnapshot(f.W.Id, f.W.Owner,
            "owner/repo", "connection", [new(f.W.PullRequests[0], null, null, "Legacy provider failure")]));
        var observation = new PublicationObservation(f.F.Clock.UtcNow.AddSeconds(30), "open", f.Provider.Head,
            Checks: [new("CI", "SUCCESS")]);
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json"),
            ExternalDisplayRecord(f.W, observation));
        var inspection = new WorkspaceInspectionService(f.Workspaces, f.F.Apps, f.F.Clock, f.Service);

        var unknown = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).PullRequestSummary!;
        Assert.Equal("unknown", unknown.State);
        Assert.Equal("unknown", unknown.Checks);
        Assert.Equal(0, f.Provider.Observed);

        await f.Service.RefreshExternalReferencesAsync(default);

        var refreshed = (await JsonStorage.ReadAsync<ExternalPublicationSnapshot>(snapshotPath))!;
        Assert.Equal("open", Assert.Single(refreshed.PullRequests).Observation!.State);
        Assert.Null(Assert.Single(refreshed.PullRequests).Unavailable);
        Assert.Null(refreshed.FailedAt);
        var recovered = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).PullRequestSummary!;
        Assert.Equal("open", recovered.State);
        Assert.Equal("passed", recovered.Checks);
        Assert.False(recovered.Partial);
        Assert.Equal(1, f.Provider.Observed);
    }
}
