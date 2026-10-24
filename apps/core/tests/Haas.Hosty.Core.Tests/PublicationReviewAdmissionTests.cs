using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static PublicationReviewCommand ReviewAdmissionCommand(DevelopmentWorkspace tree, string head, string kind)
        => kind == "comment" ? NewReviewComment(tree.PullRequests[0], head) : new(Guid.NewGuid().ToString(),
            tree.PullRequests[0], head, "thread", ConnectionId: "connection",
            Body: kind == "reply" ? "An explicit retained reply" : null, AuthorIntent: true);

    private static void BeforeReviewAdmission(PublicationProviderFixture provider, string kind, Func<Task>? action)
    {
        if (kind == "comment") provider.BeforeCommentAdmission = action;
        else if (kind == "reply") provider.BeforeReplyAdmission = action;
        else provider.BeforeReviewResolution = action;
    }

    private static int ReviewMutationCount(PublicationProviderFixture provider, string kind)
        => kind == "comment" ? provider.ReviewComments : kind == "reply" ? provider.ReviewReplies : provider.ReviewResolutions;

    private static async Task<(PublicationService Service, DevelopmentWorkspace Tree, SourceReadGrant Grant)> PrivateReviewAdmission(
        LifecycleFixture fixture, UserDirectoryStore users, PublicationProviderFixture provider, DevelopmentWorkspace workspace)
    {
        var connections = new UserConnectionService(users,
            new SourceProviderRegistry([new GitHubSourceProvider(new HttpClient(), new ConfigurationBuilder().Build(),
                fixture.Clock, provider)]), fixture.Clock, new AuditStore(fixture.Paths), fixture.CoreSettings);
        var access = new PrivateSourceService(connections, new HttpClient());
        var grant = await access.BindAsync("admin", "connection", workspace.Repository, false, default);
        foreach (var binding in workspace.Apps)
        {
            var app = (await fixture.Apps.GetAppAsync(binding.AppId))!;
            await fixture.Apps.UpsertAppAsync(app with { PrivateSources = new(Git: grant) });
        }
        var tree = workspace with { SourceGrant = grant };
        await JsonStorage.WriteAsync(Path.Combine(fixture.Paths.CoreRoot, "development/workspaces", tree.Id + ".json"), tree);
        var workspaces = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock, privateSources: access);
        return (new PublicationService(fixture.Paths, workspaces, connections, fixture.Apps, users, fixture.Clock,
            new AuditStore(fixture.Paths)), tree, grant);
    }

    [Theory]
    [InlineData("comment")]
    [InlineData("reply")]
    [InlineData("resolve")]
    public async Task ReviewMutation_SavedRoleRevokedDuringProviderReadRefusesAdmissionAndRetainsOriginalRequest(string kind)
    {
        var f = await ExternalPublicationFixture();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        BeforeReviewAdmission(f.Provider, kind, async () => { entered.SetResult(); await resume.Task; });
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var command = ReviewAdmissionCommand(f.W, f.Provider.Head, kind);
        var pending = f.Service.CommandReviewAsync(f.W, "admin", kind, command, timeout.Token);
        try
        {
            await entered.Task.WaitAsync(timeout.Token);
            await f.Users.UpdateAsync(state => state with
            {
                Users = [.. state.Users.Select(user => user.Id == "admin" ? user with { Role = "host.user" } : user)]
            });
        }
        finally { resume.TrySetResult(); }

        var denied = await pending;
        Assert.Equal("failed", denied.State);
        Assert.Equal(0, ReviewMutationCount(f.Provider, kind));
        var journal = await JsonStorage.ReadAsync<PublicationReviewJournal>(Path.Combine(f.F.Paths.CoreRoot,
            "development/publications/review-operations", f.W.Id + ".json"));
        Assert.False(Assert.Single(journal!.Operations).MutationStarted);
        await f.Users.UpdateAsync(state => state with
        {
            Users = [.. state.Users.Select(user => user.Id == "admin" ? user with { Role = "host.admin" } : user)]
        });
        BeforeReviewAdmission(f.Provider, kind, null);
        Assert.Equal("succeeded", (await f.Service.CommandReviewAsync(f.W, "admin", kind, command, timeout.Token)).State);
        Assert.Equal(1, ReviewMutationCount(f.Provider, kind));
        Assert.Equal("succeeded", (await f.Service.CommandReviewAsync(f.W, "admin", kind, command, timeout.Token)).State);
        Assert.Equal(1, ReviewMutationCount(f.Provider, kind));
    }

    [Theory]
    [InlineData("comment", false)]
    [InlineData("reply", false)]
    [InlineData("resolve", false)]
    [InlineData("comment", true)]
    [InlineData("reply", true)]
    [InlineData("resolve", true)]
    public async Task ReviewMutation_SavedPrivateBindingChangedDuringProviderReadRefusesAndKeepsSelectedAccount(string kind, bool changeAccount)
    {
        var f = await ExternalPublicationFixture();
        var (service, tree, grant) = await PrivateReviewAdmission(f.F, f.Users, f.Provider, f.W);
        if (changeAccount)
            await f.Users.UpdateAsync(state => state with
            {
                ProviderConnections = [.. state.ProviderConnections!, state.ProviderConnections![0] with
                    { Id = "another-account", AccountId = "84", AccountName = "another-owner", Revision = "r2" }]
            });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        BeforeReviewAdmission(f.Provider, kind, async () => { entered.SetResult(); await resume.Task; });
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var command = ReviewAdmissionCommand(tree, f.Provider.Head, kind);
        var pending = service.CommandReviewAsync(tree, "admin", kind, command, timeout.Token);
        try
        {
            await entered.Task.WaitAsync(timeout.Token);
            foreach (var binding in tree.Apps)
            {
                var app = (await f.F.Apps.GetAppAsync(binding.AppId))!;
                await f.F.Apps.UpsertAppAsync(app with { PrivateSources = changeAccount
                    ? new(Git: grant with { ConnectionId = "another-account", AccountName = "another-owner" }) : null });
            }
        }
        finally { resume.TrySetResult(); }

        var denied = await pending;
        Assert.Equal("failed", denied.State);
        Assert.Equal(0, ReviewMutationCount(f.Provider, kind));
        var journal = await JsonStorage.ReadAsync<PublicationReviewJournal>(Path.Combine(f.F.Paths.CoreRoot,
            "development/publications/review-operations", tree.Id + ".json"));
        var operation = Assert.Single(journal!.Operations);
        Assert.False(operation.MutationStarted);
        Assert.Equal("connection", operation.ConnectionId);
        foreach (var binding in tree.Apps)
        {
            var app = (await f.F.Apps.GetAppAsync(binding.AppId))!;
            await f.F.Apps.UpsertAppAsync(app with { PrivateSources = new(Git: grant) });
        }
        BeforeReviewAdmission(f.Provider, kind, null);
        Assert.Equal("succeeded", (await service.CommandReviewAsync(tree, "admin", kind, command, timeout.Token)).State);
        Assert.Equal(1, ReviewMutationCount(f.Provider, kind));
    }

    [Theory]
    [InlineData("comment")]
    [InlineData("reply")]
    [InlineData("resolve")]
    public async Task ReviewMutation_CancelledDuringProviderReadNeverAdmitsAndCanRecoverOriginalRequest(string kind)
    {
        var f = await ExternalPublicationFixture();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        BeforeReviewAdmission(f.Provider, kind, async () => { entered.SetResult(); await resume.Task; });
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var cancelled = new CancellationTokenSource();
        var command = ReviewAdmissionCommand(f.W, f.Provider.Head, kind);
        var pending = f.Service.CommandReviewAsync(f.W, "admin", kind, command, cancelled.Token);
        try
        {
            await entered.Task.WaitAsync(timeout.Token);
            cancelled.Cancel();
        }
        finally { resume.TrySetResult(); }

        var denied = await pending.WaitAsync(timeout.Token);
        Assert.Equal("failed", denied.State);
        Assert.Equal(0, ReviewMutationCount(f.Provider, kind));
        var journal = await JsonStorage.ReadAsync<PublicationReviewJournal>(Path.Combine(f.F.Paths.CoreRoot,
            "development/publications/review-operations", f.W.Id + ".json"));
        Assert.False(Assert.Single(journal!.Operations).MutationStarted);
        BeforeReviewAdmission(f.Provider, kind, null);
        Assert.Equal("succeeded", (await f.Service.CommandReviewAsync(f.W, "admin", kind, command, timeout.Token)).State);
        Assert.Equal(1, ReviewMutationCount(f.Provider, kind));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReviewResolution_LateAuthorityRefusalDuringRecoveryPreservesPriorUnknownOutcome(bool revokeSource)
    {
        var f = await ExternalPublicationFixture();
        var (service, tree, grant) = await PrivateReviewAdmission(f.F, f.Users, f.Provider, f.W);
        var command = ReviewAdmissionCommand(tree, f.Provider.Head, "resolve");
        f.Provider.LoseReviewResolution = true;
        Assert.Equal("pending", (await service.CommandReviewAsync(tree, "admin", "resolve", command, default)).State);
        Assert.Equal(1, f.Provider.ReviewResolutions);
        // The original mutation reached the provider, but reconciliation has not observed it.
        f.Provider.ReviewResolved = false;
        f.Provider.LoseReviewResolution = false;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var resume = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Provider.BeforeReviewResolution = async () => { entered.SetResult(); await resume.Task; };
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var recovering = service.CommandReviewAsync(tree, "admin", "resolve", command, timeout.Token);
        try
        {
            await entered.Task.WaitAsync(timeout.Token);
            if (revokeSource)
            {
                foreach (var binding in tree.Apps)
                {
                    var app = (await f.F.Apps.GetAppAsync(binding.AppId))!;
                    await f.F.Apps.UpsertAppAsync(app with { PrivateSources = null });
                }
            }
            else await f.Users.UpdateAsync(state => state with
            {
                Users = [.. state.Users.Select(user => user.Id == "admin" ? user with { Role = "host.user" } : user)]
            });
        }
        finally { resume.TrySetResult(); }

        Assert.Equal("pending", (await recovering).State);
        Assert.Equal(1, f.Provider.ReviewResolutions);
        var journal = await JsonStorage.ReadAsync<PublicationReviewJournal>(Path.Combine(f.F.Paths.CoreRoot,
            "development/publications/review-operations", tree.Id + ".json"));
        var operation = Assert.Single(journal!.Operations);
        Assert.Equal("pending", operation.State);
        Assert.True(operation.MutationStarted);
        foreach (var binding in tree.Apps)
        {
            var app = (await f.F.Apps.GetAppAsync(binding.AppId))!;
            await f.F.Apps.UpsertAppAsync(app with { PrivateSources = new(Git: grant) });
        }
        await f.Users.UpdateAsync(state => state with
        {
            Users = [.. state.Users.Select(user => user.Id == "admin" ? user with { Role = "host.admin" } : user)]
        });
        Assert.Equal("publication_operation_pending", (await Assert.ThrowsAsync<PublicationException>(() =>
            service.CommandReviewAsync(tree, "admin", "resolve", command with { RequestId = Guid.NewGuid().ToString() }, timeout.Token))).Code);
        f.Provider.BeforeReviewResolution = null;
        f.Provider.ReviewResolved = true;
        Assert.Equal("succeeded", (await service.CommandReviewAsync(tree, "admin", "resolve", command, timeout.Token)).State);
        Assert.Equal(1, f.Provider.ReviewResolutions);
    }
}
