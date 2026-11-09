using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;
using System.Text.Json;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static InspectionPullRequest NavigationPr(string url, string state, string[]? checks = null, bool draft = false)
        => new(url, "head", new(DateTimeOffset.Parse("2026-11-04T10:00:00Z"), state, "head", Draft: draft,
            Checks: checks?.Select(c => new PublicationCheck("CI", c)).ToArray()), null);

    [Fact]
    public void WorkspaceNavigationSummary_AllMergedRequiresEveryDistinctReference()
    {
        var merged = NavigationPr("https://example.test/1", "merged");
        Assert.Null(WorkspacePullRequestSummary.From([]));
        var summary = WorkspacePullRequestSummary.From([merged, merged])!;
        Assert.Equal(1, summary.Count); Assert.Equal("merged", summary.State); Assert.False(summary.Partial);
        Assert.Equal(0, summary.OpenCount); Assert.Equal(0, summary.DraftCount);
        Assert.Equal("closed", WorkspacePullRequestSummary.From([merged, NavigationPr("https://example.test/2", "closed")])!.State);
        Assert.Equal("unknown", WorkspacePullRequestSummary.From([merged, new("https://example.test/2", null, null, "Unavailable")])!.State);
        Assert.Equal("unknown", WorkspacePullRequestSummary.From([merged, merged with { Unavailable = "Revoked" }])!.State);
    }

    [Fact]
    public void WorkspaceNavigationSummary_CountsOpenAndDraftReferencesIndependentlyOfHistory()
    {
        var open = NavigationPr("https://example.test/1", "open", ["SUCCESS"]);
        var draft = NavigationPr("https://example.test/2", "open", draft: true);
        var result = WorkspacePullRequestSummary.From([open, draft, NavigationPr("https://example.test/3", "merged"),
            NavigationPr("https://example.test/4", "closed"), open with { Url = open.Url.ToUpperInvariant() }])!;

        Assert.Equal(4, result.Count);
        Assert.Equal(2, result.OpenCount);
        Assert.Equal(1, result.DraftCount);
        Assert.Equal("open", result.State);
        Assert.False(result.Partial);
        var draftsOnly = WorkspacePullRequestSummary.From([draft])!;
        Assert.Equal(1, draftsOnly.OpenCount);
        Assert.Equal(1, draftsOnly.DraftCount);
    }

    [Fact]
    public void WorkspaceNavigationSummary_UnavailableReferencesKeepOpenCountsConservative()
    {
        var open = NavigationPr("https://example.test/1", "open", ["SUCCESS"]);
        var draft = NavigationPr("https://example.test/2", "open", draft: true);
        var unknown = new InspectionPullRequest("https://example.test/3", null, null, "Unavailable");
        var partial = WorkspacePullRequestSummary.From([open, draft, unknown])!;
        Assert.Equal(3, partial.Count);
        Assert.Equal(2, partial.OpenCount);
        Assert.Equal(1, partial.DraftCount);
        Assert.True(partial.Partial);

        var duplicateUnavailable = WorkspacePullRequestSummary.From([open, draft, unknown,
            open with { Url = open.Url.ToUpperInvariant(), Unavailable = "Revoked" }])!;
        Assert.Equal(3, duplicateUnavailable.Count);
        Assert.Equal(1, duplicateUnavailable.OpenCount);
        Assert.Equal(1, duplicateUnavailable.DraftCount);
        Assert.Equal("draft", duplicateUnavailable.State);
        Assert.True(duplicateUnavailable.Partial);
    }

    [Theory]
    [InlineData("SUCCESS", "IN_PROGRESS", "running")]
    [InlineData("FAILURE", "IN_PROGRESS", "failed")]
    [InlineData("CANCELLED", "SUCCESS", "failed")]
    [InlineData("SUCCESS", "UNRECOGNIZED", "unknown")]
    [InlineData("SUCCESS", "NEUTRAL", "passed")]
    [InlineData("SKIPPED", "NEUTRAL", "none")]
    public void WorkspaceNavigationSummary_AggregatesOpenCiAcrossRepositories(string first, string second, string expected)
    {
        var current = NavigationPr("https://example.test/1", "open", [first, second]);
        var history = NavigationPr("https://example.test/2", "merged", ["FAILURE"]);
        history = history with { Observation = history.Observation! with { At = DateTimeOffset.Parse("2025-01-01T00:00:00Z") } };
        var result = WorkspacePullRequestSummary.From([current, history])!;
        Assert.Equal("open", result.State); Assert.Equal(expected, result.Checks);
        Assert.Equal(current.Observation!.At, result.ObservedAt);
        Assert.NotEqual("passed", WorkspacePullRequestSummary.From([current, NavigationPr("https://example.test/3", "open")])!.Checks);
    }

    [Fact]
    public void WorkspaceNavigationSummary_DraftAndMissingChecksDoNotImplyReadiness()
    {
        var draft = NavigationPr("https://example.test/1", "open", draft: true);
        var result = WorkspacePullRequestSummary.From([draft])!;
        Assert.Equal("draft", result.State); Assert.Equal("unknown", result.Checks);
        Assert.Equal("open", WorkspacePullRequestSummary.From([draft, NavigationPr("https://example.test/2", "open", ["SUCCESS"])])!.State);
    }

    [Fact]
    public async Task WorkspaceNavigationSummary_InventoryUsesRetainedExternalFactsAndRechecksAccessWithoutProviderReads()
    {
        var f = await ExternalPublicationFixture();
        await f.Service.RefreshExternalReferencesAsync(default);
        var observed = f.Provider.Observed;
        var inspection = new WorkspaceInspectionService(f.Workspaces, f.F.Apps, f.F.Clock, f.Service);
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "README.md"), "Not yet observed locally");
        var before = (await f.Workspaces.Read(f.W.Id, null, default)).Observation;
        var row = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces);
        Assert.Equal("open", row.PullRequestSummary!.State); Assert.Equal("passed", row.PullRequestSummary.Checks);
        Assert.Equal(1, row.PullRequestSummary.OpenCount); Assert.Equal(0, row.PullRequestSummary.DraftCount);
        using (var json = JsonDocument.Parse(CoreJson.Text(row)))
        {
            var summary = json.RootElement.GetProperty("pullRequestSummary");
            Assert.Equal(1, summary.GetProperty("openCount").GetInt32());
            Assert.Equal(0, summary.GetProperty("draftCount").GetInt32());
            Assert.False(summary.GetProperty("partial").GetBoolean());
        }
        Assert.Equal(CoreJson.Text(before), CoreJson.Text(row.Worktrees[0].Observation));
        Assert.Equal(observed, f.Provider.Observed);
        Assert.DoesNotContain("fixture-secret", CoreJson.Text(row));
        Assert.DoesNotContain("private review body", CoreJson.Text(row));
        f.Provider.State = "merged";
        await f.Service.RefreshExternalReferencesAsync(default);
        observed = f.Provider.Observed;
        var merged = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).PullRequestSummary!;
        Assert.Equal("merged", merged.State); Assert.Equal(0, merged.OpenCount); Assert.Equal(0, merged.DraftCount);
        await f.Users.UpdateAsync(s => s with { ProviderConnections = [] });
        var unavailable = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces);
        Assert.Equal("unknown", unavailable.PullRequestSummary!.State);
        Assert.True(unavailable.PullRequestSummary.Partial);
        using (var json = JsonDocument.Parse(CoreJson.Text(unavailable)))
        {
            var summary = json.RootElement.GetProperty("pullRequestSummary");
            Assert.Equal(0, summary.GetProperty("openCount").GetInt32());
            Assert.Equal(0, summary.GetProperty("draftCount").GetInt32());
            Assert.True(summary.GetProperty("partial").GetBoolean());
        }
        Assert.Equal(observed, f.Provider.Observed);
        Assert.Equal(0, f.Provider.Created); Assert.Equal(0, f.Provider.Merged);
    }

    [Fact]
    public async Task WorkspaceNavigationSummary_InternalCacheInvalidatesAndDoesNotShareOwnerProviderFacts()
    {
        var f = await PublicationFixture();
        f.Provider.RepositoryOverride = "owner/repo";
        var connections = new UserConnectionService(f.Users, new SourceProviderRegistry([new GitHubSourceProvider(new HttpClient(),
            new ConfigurationBuilder().Build(), f.F.Clock, f.Provider)]), f.F.Clock, new AuditStore(f.F.Paths), f.F.CoreSettings);
        var inspection = new WorkspaceInspectionService(f.Workspaces, f.F.Apps, f.F.Clock, f.Service, f.Users, connections);
        var record = Assert.Single((await f.Service.ListAsync(null, default)).Publications) with {
            Url = "https://github.com/owner/repo/pull/2", PublishedHead = f.W.Observation!.Head,
            Observation = new(f.F.Clock.UtcNow, "open", f.W.Observation.Head, Checks: [new("CI", "SUCCESS")]) };
        var path = Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json");
        await JsonStorage.WriteAsync(path, record);
        var observed = f.Provider.Observed;
        Assert.Equal("passed", Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).PullRequestSummary!.Checks);
        Assert.Null(Assert.Single((await inspection.ListAsync("another-admin", default)).Workspaces).PullRequestSummary);
        await JsonStorage.WriteAsync(path, record with { Observation = record.Observation! with { Checks = [new("CI", "FAILURE")] } });
        Assert.Equal("failed", Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).PullRequestSummary!.Checks);
        await JsonStorage.WriteAsync(path, record with { PublishedHead = "different-head" });
        Assert.Equal("unknown", Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).PullRequestSummary!.State);
        await JsonStorage.WriteAsync(path, record);
        await f.Users.UpdateAsync(s => s with { ProviderConnections = [] });
        Assert.Equal("unknown", Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).PullRequestSummary!.State);
        Assert.Equal(observed, f.Provider.Observed);
        await File.WriteAllTextAsync(path, "invalid json");
        Assert.Null(Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).PullRequestSummary);
    }
    private sealed class NavigationLocalSourceAccess : ISourceGitAccess
    {
        public int LocalReads;
        public string NormalizeRepository(string value) => value;
        public Task ValidateLocalAsync(PrivateSourceAccess? access, CancellationToken ct) { LocalReads++; return Task.CompletedTask; }
        public Task ValidateAsync(PrivateSourceAccess? access, CancellationToken ct) => throw new InvalidOperationException("Inventory must not refresh credentials");
        public Task<T> WithConnectionAsync<T>(SourceReadGrant grant, Func<UserProviderConnection, Task<T>> action, CancellationToken ct) => throw new NotSupportedException();
        public Task<SourceReadGrant> BindAsync(string owner, string id, string url, bool manifest, CancellationToken ct) => throw new NotSupportedException();
        public Task<string> GitAsync(SourceReadGrant grant, string repository, string? directory, IReadOnlyList<string> args, CancellationToken ct) => throw new NotSupportedException();
        public Task<string> GitWithConnectionAsync(SourceReadGrant grant, string repository, string? directory, IReadOnlyList<string> args, UserProviderConnection connection, CancellationToken ct) => throw new NotSupportedException();
    }

    [Fact]
    public async Task WorkspaceNavigationSummary_PrivateSourceInventoryUsesOnlyLocalGrantChecks()
    {
        var f = await ExternalPublicationFixture();
        await f.Service.RefreshExternalReferencesAsync(default);
        var grant = new SourceReadGrant("admin", "connection", "github", "owner", "GitHub", f.W.Repository);
        foreach (var app in f.W.Apps) await f.F.Apps.UpdateAppAsync(app.AppId, a => a with { PrivateSources = new(Git: grant) });
        var access = new NavigationLocalSourceAccess();
        var workspaces = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock, privateSources: access);
        var connections = new UserConnectionService(f.Users, new SourceProviderRegistry([new GitHubSourceProvider(new HttpClient(),
            new ConfigurationBuilder().Build(), f.F.Clock, f.Provider)]), f.F.Clock, new AuditStore(f.F.Paths), f.F.CoreSettings);
        var publications = new PublicationService(f.F.Paths, workspaces, connections, f.F.Apps, f.Users, f.F.Clock, new(f.F.Paths));
        var inspection = new WorkspaceInspectionService(workspaces, f.F.Apps, f.F.Clock, publications);
        var observed = f.Provider.Observed;
        var row = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces);
        Assert.Equal("open", row.PullRequestSummary!.State);
        Assert.True(access.LocalReads > 0);
        Assert.Equal(observed, f.Provider.Observed);
    }

}
