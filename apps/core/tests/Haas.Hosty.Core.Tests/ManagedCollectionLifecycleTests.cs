using Haas.Hosty.Core;
using System.Text.Json;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task ManagedCollection_AllowsUnleasedTreeCleanupButPreservesExternalOwnerFilesAndLease()
    {
        var (f, _) = await SourceFixtureAsync();
        var docker = new CollectionDockerRunner();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, docker: docker);
        var owner = ExternalOwner();
        var request = ExternalPrepare();
        var external = await service.PrepareAsync(owner, request, default);
        var unused = await service.PrepareAsync(WorkspaceTestOwner(f, "unused"), WorkspaceRequest("unused"), default);
        await File.WriteAllTextAsync(Path.Combine(external.Path, "uncommitted.txt"), "external work must survive");
        var pointer = await File.ReadAllTextAsync(Path.Combine(external.Path, ".git"));
        var recordPath = Path.Combine(f.Paths.CoreRoot, "development/workspaces", external.Id + ".json");
        var record = await File.ReadAllTextAsync(recordPath);
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        var document = System.Text.Json.Nodes.JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!;
        document["externalMounts"] = System.Text.Json.Nodes.JsonNode.Parse("""
            { "development": { "kind": "managed-workspaces", "scope": "instance", "service": "app", "mode": "rw", "required": true } }
            """);
        await File.WriteAllTextAsync(app.ManifestPath!, document.ToJsonString());
        var manifest = (await JsonStorage.ReadAsync<RuntimeAppManifest>(app.ManifestPath!, default))!;
        await f.Apps.UpdateAppAsync(app.Id, value => value with { RuntimeState = "running", GrantedCorePermissions = [CoreAppPermissions.Sources] });
        app = (await f.Apps.GetAppAsync(app.Id))!;
        var mounts = ManagedWorkspaceMounts.Resolve(f.Paths, app, manifest);
        docker.Inspection = JsonSerializer.Serialize(new
        {
            Config = new { Labels = new Dictionary<string, string> { ["hosty.app.service"] = "app" } },
            Mounts = mounts.Select(m => new { Source = MountPathPolicy.ResolveRealPath(m.HostPath), Destination = m.ContainerPath, RW = !m.ReadOnly }),
        });
        Assert.Equal("released", (await service.CommandAsync(unused.Id, null, "cleanup", new(Guid.NewGuid().ToString(), unused.OriginalBase), default)).State);
        Assert.Equal("running", (await f.Apps.GetAppAsync(app.Id))!.RuntimeState);
        Assert.Equal(record, await File.ReadAllTextAsync(recordPath));
        Assert.Equal(pointer, await File.ReadAllTextAsync(Path.Combine(external.Path, ".git")));
        Assert.Equal("external work must survive", await File.ReadAllTextAsync(Path.Combine(external.Path, "uncommitted.txt")));
        var restarted = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, docker: docker);
        var observed = await restarted.Read(external.Id, owner, default);
        Assert.Equal(external.Path, observed.Path); Assert.Equal(external.Owner, observed.Owner);
        Assert.Equal(external.Leases, observed.Leases); Assert.Equal(external.Branch, observed.Branch);
        Assert.Equal(external.Id, (await restarted.PrepareAsync(owner, request, default)).Id);
        Assert.Equal("workspace_in_use", (await Assert.ThrowsAsync<AppLifecycleException>(() => restarted.CommandAsync(external.Id, owner, "cleanup", new(Guid.NewGuid().ToString(), external.OriginalBase), default))).Code);
    }

    private sealed class CollectionDockerRunner : IDockerCommandRunner
    {
        public string Inspection { get; set; } = "{}";
        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment = null, CancellationToken cancellationToken = default)
            => Task.FromResult(new DockerCommandResult(0, args[0] == "ps" ? "abc123" : Inspection, ""));
    }
}
