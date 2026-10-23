using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NewReviewComment_PrivateSourceAdmissionReusesHeldConnectionWithoutReenteringUserGate(bool coreSource)
    {
        var f = await ExternalPublicationFixture();
        var connections = new UserConnectionService(f.Users,
            new SourceProviderRegistry([new GitHubSourceProvider(new HttpClient(), new ConfigurationBuilder().Build(),
                f.F.Clock, f.Provider)]), f.F.Clock, new AuditStore(f.F.Paths), f.F.CoreSettings);
        var access = new PrivateSourceService(connections, new HttpClient());
        var grant = await access.BindAsync("admin", "connection", f.W.Repository, false, default);
        foreach (var binding in f.W.Apps)
        {
            var app = (await f.F.Apps.GetAppAsync(binding.AppId))!;
            await f.F.Apps.UpsertAppAsync(app with { PrivateSources = new(Git: grant) });
        }
        var core = coreSource ? CoreSourceService(f.F, access) : null;
        var tree = f.W with { SourceGrant = grant };
        if (core is not null)
        {
            var source = await core.SaveAsync(new(null, "initial", new(tree.Repository, "main", ConnectionId: "connection")),
                default, "admin");
            tree = tree with { Core = new(source.Revision, source.ProjectPath) };
        }
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workspaces", tree.Id + ".json"), tree);
        var workspaces = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock,
            privateSources: access, coreDevelopment: core);
        var service = new PublicationService(f.F.Paths, workspaces, connections, f.F.Apps, f.Users, f.F.Clock,
            new AuditStore(f.F.Paths));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var result = await service.CommandReviewAsync(tree, "admin", "comment",
            NewReviewComment(tree.PullRequests[0], f.Provider.Head), timeout.Token);
        Assert.Equal("succeeded", result.State);
        Assert.Equal("new-thread", result.ThreadId);
        Assert.Equal(1, f.Provider.ReviewComments);
    }
}
