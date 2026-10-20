using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static DevelopmentWorkspace ViewerWorkspace(WorkspaceOwner owner) => new()
    {
        Id = new string('a', 64), Owner = owner, Repository = "/fixture/repository", RepositoryId = "fixture",
        Path = "/fixture/worktree", Branch = "work", TargetBranch = "main", OriginalBase = "base",
        IntegrationBase = "base", SessionPath = "/chat?session=existing", State = "active",
    };

    [Theory]
    [InlineData("hosty.harness", "/development", "session&unexpected=1")]
    [InlineData("example.assistant", "/chat", "existing")]
    public async Task WorkspaceViewer_ResolvesCurrentOwningAssistantWithoutTheRetiredApp(string appId, string expectedPath, string sessionId)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(fixture, sessionId) with { AppId = appId };
        await fixture.Apps.UpsertAppAsync(CreateDependencyApp() with
        {
            Id = appId, InstalledAt = owner.Installation,
            Endpoints = [new("http", "http", "http://assistant.test:3100", Public: true)],
        });
        var inspection = new WorkspaceInspectionService(new(fixture.Paths, fixture.Apps, fixture.Clock), fixture.Apps, fixture.Clock);

        var destination = await inspection.DestinationAsync(ViewerWorkspace(owner), default);

        Assert.Null(destination.Unavailable);
        var url = new Uri(destination.Url!);
        Assert.Equal(expectedPath, url.AbsolutePath);
        Assert.Equal("?session=" + Uri.EscapeDataString(sessionId), url.Query);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceViewer_MissingOrReplacedAssistantDoesNotInventADestination(bool replaced)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceTestOwner(fixture);
        if (replaced)
            await fixture.Apps.UpsertAppAsync(CreateDependencyApp() with
            {
                Id = owner.AppId, InstalledAt = owner.Installation.AddSeconds(1),
                Endpoints = [new("http", "http", "http://replacement.test:3100", Public: true)],
            });
        var inspection = new WorkspaceInspectionService(new(fixture.Paths, fixture.Apps, fixture.Clock), fixture.Apps, fixture.Clock);

        var destination = await inspection.DestinationAsync(ViewerWorkspace(owner), default);

        Assert.Null(destination.Url);
        Assert.Contains("removed or replaced", destination.Unavailable);
    }

    [Fact]
    public async Task WorkspaceViewer_ExternalOwnerRetainsInspectionWithoutInventingAConversation()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var owner = WorkspaceOwner.ForExternal("admin", "external-principal", "external-task", "External agent");
        var inspection = new WorkspaceInspectionService(new(fixture.Paths, fixture.Apps, fixture.Clock), fixture.Apps, fixture.Clock);

        var destination = await inspection.DestinationAsync(ViewerWorkspace(owner), default);

        Assert.Null(destination.Url);
        Assert.Contains("External workspaces", destination.Unavailable);
        Assert.Contains("Core workspace API", destination.Unavailable);
    }
}
