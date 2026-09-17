using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static string ReviewManifest(string version = "1.0.0", string revision = "1") => $$$$"""
        {"schemaVersion":"app.0.1","id":"com.example.review","name":"Review","version":"{{{{version}}}}",
         "runtimeProfiles":[{"key":"dev","type":"docker","development":true}],
         "services":[{"key":"app","runtimes":{"dev":{"type":"docker","artifact":"source",
           "build":{"revision":"{{{{revision}}}}"},"sourceMount":{},"command":"watch",
           "ports":[{"key":"http","containerPort":8080}]}}}]}
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReviewedUpdate_PreservesDevImageUntilBuildRecipeChanges(bool changeRevision)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = Path.Combine(fixture.Root, "source.json");
        await File.WriteAllTextAsync(manifest, ReviewManifest());
        var installed = await fixture.Service.InstallAsync(new(manifest, "dev"));
        Assert.True(installed.App!.SupportsSource);
        var locked = new ArtifactLock("development-image", "sha256:" + new string('a', 64), "test:1",
            DockerSourceRuntime.BuildFingerprint(new()), null, DateTimeOffset.UtcNow);
        await fixture.Apps.UpdateAppAsync("com.example.review", app => app with
        { ManifestUrl = "https://example.test/manifest.json", SourceState = null,
          ArtifactLocks = new Dictionary<string, ArtifactLock> { ["app"] = locked } });
        await File.WriteAllTextAsync(manifest, ReviewManifest("1.1.0", changeRevision ? "2" : "1"));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.review", new(manifest));
        await fixture.Service.ApplyUpdateAsync("com.example.review", new(plan.PlanDigest));
        var updated = (await fixture.Apps.GetAppAsync("com.example.review"))!;
        if (changeRevision) Assert.Null(updated.ArtifactLocks);
        else Assert.Equal(locked, updated.ArtifactLocks!["app"]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SwitchOrUpdate_ReservesNewPortsBeforeMixedStart(bool update)
    {
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        var manifest = Path.Combine(fixture.Root, "switch.json");
        var document = JsonNode.Parse(ReviewManifest())!;
        document["runtimeProfiles"]![0]!["type"] = "mixed";
        var runtime = document["services"]![0]!["runtimes"]!["dev"]!;
        runtime["type"] = "localCommand";
        runtime.AsObject().Remove("build");
        runtime.AsObject().Remove("sourceMount");
        document["runtimeProfiles"]!.AsArray().Add(JsonNode.Parse("""{"key":"docker","type":"docker"}"""));
        document["services"]![0]!["runtimes"]!["docker"] = JsonNode.Parse("""{"type":"docker","image":"example/app:1","ports":[{"key":"old","containerPort":8080}]}""");
        await File.WriteAllTextAsync(manifest, document.ToJsonString());
        var installed = await fixture.Service.InstallAsync(new(manifest, "docker"));
        Assert.True(installed.App!.SupportsSource);
        var app = (await fixture.Apps.GetAppAsync("com.example.review"))!;
        Assert.DoesNotContain(app.PortAssignments!, port => port.PortKey == "http");
        if (update)
        {
            document["version"] = "1.1.0";
            document["services"]![0]!["runtimes"]!["docker"]!["ports"]!.AsArray().Add(JsonNode.Parse("""{"key":"http","containerPort":9090}"""));
            await File.WriteAllTextAsync(manifest, document.ToJsonString());
            var plan = await fixture.Service.CreateUpdatePlanAsync(app.Id, new(manifest));
            await fixture.Service.ApplyUpdateAsync(app.Id, new(plan.PlanDigest));
        }
        else
        {
            var plan = await fixture.Service.CreateRuntimeSwitchPlanAsync(app.Id, new("dev"));
            await fixture.Service.ApplyRuntimeSwitchAsync(app.Id, new("dev", plan.PlanDigest));
        }
        app = (await fixture.Apps.GetAppAsync(app.Id))!;
        var assignment = Assert.Single(app.PortAssignments!, port => port.PortKey == "http");
        Assert.True(assignment.HostPort > 0);
        var selection = await fixture.Manifests.LoadAsync(app.ManifestPath!, app.SelectedRuntime);
        var service = Assert.Single(selection.Services);
        var context = MixedRuntimeTests.Context(selection) with { App = app };
        Assert.Equal($"http://127.0.0.1:{assignment.HostPort}", RuntimeServiceDiscovery.BuildPeerUrl(context,
            service with { Runtime = service.Runtime with { Type = "localCommand" } }, service, service.Runtime.Ports.Single(port => port.Key == "http")));
    }

    [Fact]
    public async Task LegacyManifest_ReadsSelectedProfileButInstallRejectsInvalidAlternative()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var path = await fixture.WriteManifestAsync("1.0.0");
        var installed = await fixture.Service.InstallAsync(new(path));
        var app = (await fixture.Apps.GetAppAsync(installed.App!.Id))!;
        var json = JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!;
        json["runtimeProfiles"]!.AsArray().Add(JsonNode.Parse("""{"key":"legacy-broken","type":"docker"}"""));
        await File.WriteAllTextAsync(app.ManifestPath!, json.ToJsonString());
        var service = new AppManifestService();
        await service.LoadAsync(app.ManifestPath!, "docker");
        // Exercise the cached-load path as well as the original parse.
        await service.LoadAsync(app.ManifestPath!, "docker");
        await Assert.ThrowsAsync<AppManifestException>(() => service.LoadAsync(app.ManifestPath!, "docker", validateAllProfiles: true));
        await fixture.Service.GetHealthAsync(app.Id);
        await fixture.Service.StopAsync(app.Id);
        await Assert.ThrowsAsync<AppManifestException>(() => fixture.Service.CreateInstallPlanAsync(new(app.ManifestPath!, "docker")));
    }

    [Fact]
    public async Task Worktree_ExactFileScopeSupportsPreviewAndDiscard()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        await File.WriteAllTextAsync(Path.Combine(repository, "README.md"), "edited");
        await File.WriteAllTextAsync(Path.Combine(repository, "README.md-extra"), "keep");
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with
        { SourceState = app.SourceState! with { InspectionPaths = ["README.md"] } });
        Assert.Equal("README.md", Assert.Single((await fixture.Sources.GetWorktreeStatusAsync(SourceTestApp)).Files).Path);
        Assert.Contains("+edited", (await fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("README.md"))).Combined);
        var plan = await fixture.Sources.PlanDiscardAsync(SourceTestApp, new(["README.md"]));
        await fixture.Service.ApplySourceDiscardAsync(SourceTestApp, new(plan.ReviewId));
        Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(repository, "README.md")));
        Assert.Equal("keep", await File.ReadAllTextAsync(Path.Combine(repository, "README.md-extra")));
    }
}
