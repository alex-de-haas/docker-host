using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static DevelopmentWorkspaceService RepositoryIdentityService(LifecycleFixture fixture)
    {
        var http = new HttpClient();
        var provider = new GitHubSourceProvider(http, new ConfigurationBuilder().Build(), fixture.Clock);
        var connections = new UserConnectionService(new UserDirectoryStore(fixture.Paths),
            new SourceProviderRegistry([provider]), fixture.Clock, new AuditStore(fixture.Paths), fixture.CoreSettings);
        return new(fixture.Paths, fixture.Apps, fixture.Clock,
            privateSources: new PrivateSourceService(connections, http));
    }

    private static DevelopmentWorkspace RepositoryIdentityRecord(DevelopmentWorkspace template, string repository)
    {
        var repositoryId = DevelopmentWorkspaceService.Hash(repository);
        var id = DevelopmentWorkspaceService.Hash(DevelopmentWorkspaceService.OwnerIdentity(template.Owner) + "\n" + repositoryId);
        return template with { Id = id, Repository = repository, RepositoryId = repositoryId,
            Path = Path.Combine(Path.GetDirectoryName(template.Path)!, id), Branch = "hosty/session/" + id };
    }

    [Theory]
    [InlineData("https://github.com/Owner/Repository")]
    [InlineData("https://github.com/owner/repository.git")]
    [InlineData("https://github.com/OWNER/REPOSITORY.GIT/")]
    public async Task RepositoryIdentity_ProviderAliasesUseOneFreshStore(string repository)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var service = RepositoryIdentityService(fixture);
        Assert.Equal("https://github.com/owner/repository.git",
            await service.CanonicalRepositoryAsync(repository, null, default));
    }

    [Fact]
    public async Task RepositoryIdentity_NormalizationKeepsAnUnreleasedLegacyStore()
    {
        var (fixture, _, original, _) = await DocumentFixtureAsync();
        var workspace = await original.PrepareAsync(WorkspaceTestOwner(fixture), WorkspaceRequest(), default);
        const string legacy = "https://github.com/Owner/Repository";
        File.Delete(Path.Combine(fixture.Paths.CoreRoot, "development/workspaces", workspace.Id + ".json"));
        workspace = RepositoryIdentityRecord(workspace, legacy);
        await JsonStorage.WriteAsync(Path.Combine(fixture.Paths.CoreRoot, "development/workspaces", workspace.Id + ".json"), workspace);
        var service = RepositoryIdentityService(fixture);
        Assert.Equal(legacy, await service.CanonicalRepositoryAsync("https://github.com/owner/repository.git", null, default));
        Assert.Equal("https://github.com/owner/repository.git", service.LogicalRepositoryIdentity(legacy));
        await JsonStorage.WriteAsync(Path.Combine(fixture.Paths.CoreRoot, "development/workspaces", workspace.Id + ".json"), workspace with { State = "released" });
        Assert.Equal("https://github.com/owner/repository.git",
            await service.CanonicalRepositoryAsync("https://github.com/Owner/Repository", null, default));
    }

    [Fact]
    public async Task RepositoryIdentity_DoesNotChooseBetweenDistinctLegacyAllocations()
    {
        var (fixture, _, original, _) = await DocumentFixtureAsync();
        var workspace = await original.PrepareAsync(WorkspaceTestOwner(fixture), WorkspaceRequest(), default);
        var records = Path.Combine(fixture.Paths.CoreRoot, "development/workspaces");
        const string first = "https://github.com/Owner/Repository";
        const string second = "https://github.com/owner/repository.git";
        File.Delete(Path.Combine(records, workspace.Id + ".json"));
        foreach (var repository in new[] { first, second })
        {
            var legacy = RepositoryIdentityRecord(workspace, repository);
            await JsonStorage.WriteAsync(Path.Combine(records, legacy.Id + ".json"), legacy);
        }
        var service = RepositoryIdentityService(fixture);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.CanonicalRepositoryAsync("https://github.com/owner/repository", null, default));
        Assert.Equal("workspace_repository_alias_conflict", error.Code);
    }

    [Fact]
    public async Task RepositoryIdentity_UnknownProviderPathCaseRemainsSignificant()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var service = RepositoryIdentityService(fixture);
        Assert.Equal("https://example.test/Owner/Repository",
            await service.CanonicalRepositoryAsync("https://example.test/Owner/Repository/", null, default));
        Assert.Equal("https://example.test/owner/repository.git",
            await service.CanonicalRepositoryAsync("https://example.test/owner/repository.git", null, default));
    }
}
