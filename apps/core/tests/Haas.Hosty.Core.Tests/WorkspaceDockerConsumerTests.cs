using System.Text.Json;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("", "", true)]
    [InlineData("", "child-environment", false)]
    [InlineData("parent-instance", "", false)]
    [InlineData("parent-instance", "parent-instance", true)]
    [InlineData("parent-instance", "child-environment", false)]
    public async Task WorkspaceDelete_DockerConsumersBelongToTheirOwnCoreInstance(string instance, string containerInstance, bool blocks)
    {
        var (f, _) = await SourceFixtureAsync();
        var docker = new InstanceWorkspaceDockerRunner(containerInstance);
        var config = new HostyCoreRuntimeConfig(f.Paths.DataRoot, Path.Combine(f.Paths.CoreRoot, "run"),
            Path.Combine(f.Paths.CoreRoot, "run/control.json"), 7070, "http://localhost:7070", null, "localhost", null, false,
            InstanceId: instance);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, docker: docker, runtimeConfig: config);
        var tree = await service.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        await f.Apps.UpdateAppAsync(SourceTestApp, app => app with { RuntimeState = "running" });
        docker.Source = tree.Path;

        if (blocks)
        {
            var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.RequireDeleteRuntimeIdleAsync(tree, default));
            Assert.Equal("workspace_in_use", error.Code);
            Assert.Equal(1, docker.Inspections);
        }
        else
        {
            await service.RequireDeleteRuntimeIdleAsync(tree, default);
            Assert.Equal(0, docker.Inspections);
        }
        Assert.True(Directory.Exists(tree.Path));
    }

    [Theory]
    [InlineData("abc123")]
    [InlineData("bad-id!\t")]
    [InlineData("abc123\tdefault\tunexpected")]
    public async Task WorkspaceDelete_UnknownDockerOwnershipRemainsARefusal(string response)
    {
        var (f, _) = await SourceFixtureAsync();
        var docker = new InstanceWorkspaceDockerRunner("") { Response = response };
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, docker: docker);
        var tree = await service.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        await f.Apps.UpdateAppAsync(SourceTestApp, app => app with { RuntimeState = "running" });
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.RequireDeleteRuntimeIdleAsync(tree, default));
        Assert.Equal("workspace_consumer_unavailable", error.Code);
        Assert.True(Directory.Exists(tree.Path));
        Assert.Equal(0, docker.Inspections);
    }

    private sealed class InstanceWorkspaceDockerRunner(string instance) : IDockerCommandRunner
    {
        internal string? Source { get; set; }
        internal string? Response { get; init; }
        internal int Inspections { get; private set; }
        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment = null,
            CancellationToken cancellationToken = default)
        {
            if (args[0] == "ps") return Task.FromResult(new DockerCommandResult(0, Response ?? "abc123\t" + instance, ""));
            Inspections++;
            return Task.FromResult(new DockerCommandResult(0, JsonSerializer.Serialize(new[] { new { Source } }), ""));
        }
    }
}
