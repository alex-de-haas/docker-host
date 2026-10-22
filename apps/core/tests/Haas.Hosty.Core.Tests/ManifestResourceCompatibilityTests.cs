using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class DockerRuntimeAdapterTests
{
    [Theory]
    [InlineData("{\"cpus\":1,\"memory\":\"1g\"}")]
    [InlineData("{\"memoryBytes\":32212254720,\"cpus\":32,\"pids\":512}")]
    [InlineData("{\"memoryBytes\":0,\"cpus\":0,\"pids\":0}")]
    [InlineData("{\"memoryBytes\":\"unknown\",\"cpus\":{},\"pids\":[]}")]
    [InlineData("null")]
    [InlineData("\"unused extension\"")]
    public async Task ManifestResources_AreIgnoredDuringAdmissionAndDockerLaunch(string resources)
    {
        var root = Directory.CreateTempSubdirectory("hosty-resource-manifest-").FullName;
        try
        {
            var path = await WriteResourceManifestAsync(root, resources);
            var original = await File.ReadAllTextAsync(path);
            var manifests = new AppManifestService();
            var selection = await manifests.LoadAsync(path, "docker", validateAllProfiles: true);
            var local = await manifests.LoadAsync(path, "dev", validateAllProfiles: true);
            Assert.Equal("app.0.1", selection.Manifest.SchemaVersion);
            Assert.Equal("localCommand", Assert.Single(local.Services).Runtime.Type);
            var installedRoot = Path.Combine(root, "installed");
            await manifests.SaveManifestCopyAsync(selection, installedRoot);
            Assert.Equal(original, await File.ReadAllTextAsync(Path.Combine(installedRoot, "manifest.json")));
            selection = await manifests.LoadAsync(installedRoot, validateAllProfiles: true);

            var runner = new FakeDockerCommandRunner();
            var context = CreateDockerContext(CreateDockerAppRecord(null, null)) with { Manifest = selection };
            await CreateAdapter(runner).StartAsync(context);

            var run = Assert.Single(runner.Commands, command => command[0] == "run");
            Assert.DoesNotContain("--memory", run);
            Assert.DoesNotContain("--memory-swap", run);
            Assert.DoesNotContain("--cpus", run);
            Assert.DoesNotContain("--pids-limit", run);
            Assert.Equal(original, await File.ReadAllTextAsync(path));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task ManifestResources_DoNotOverrideManagedEnvironmentAdmission()
    {
        var root = Directory.CreateTempSubdirectory("hosty-resource-environment-").FullName;
        try
        {
            var path = await WriteResourceManifestAsync(root, "{\"memoryBytes\":32212254720,\"cpus\":32,\"pids\":4096}");
            var selection = await new AppManifestService().LoadAsync(path, validateAllProfiles: true);
            var config = new HostyCoreRuntimeConfig(root, root, "", 7070, "http://localhost:7070", null, "localhost", null, false);
            var store = new CoreEnvironmentStore(CoreDataPaths.FromConfig(config));
            var id = Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(Path.Combine(store.Root(id), "core"));
            await File.WriteAllTextAsync(CoreInstanceId.BuildPath(store.Root(id)), id);
            await store.WriteAsync(new(id, new("admin", null, null), new(Guid.NewGuid().ToString(), "QA"),
                "hash", 7071, 1, "running", DateTimeOffset.UtcNow), default);
            config = config with { DataRoot = store.Root(id), InstanceId = id };
            var runner = new FakeDockerCommandRunner(args => args is ["inspect", _]
                ? new DockerCommandResult(1, "", "No such container")
                : new DockerCommandResult(0, args[0] == "pull" ? "Digest: sha256:" + new string('a', 64) : "", ""));
            var adapter = new DockerRuntimeAdapter(config, CreateTokenService(), NullLogger<DockerRuntimeAdapter>.Instance, runner);
            var context = CreateDockerContext(CreateDockerAppRecord(null, null)) with { Manifest = selection };

            await adapter.StartAsync(context);

            var run = Assert.Single(runner.Commands, command => command[0] == "run");
            var limits = new CoreEnvironmentLimits();
            var args = run.ToList();
            Assert.Equal(limits.ApplicationMemoryBytes.ToString(), args[args.IndexOf("--memory") + 1]);
            Assert.Equal(limits.ApplicationMemoryBytes.ToString(), args[args.IndexOf("--memory-swap") + 1]);
            Assert.Equal("1", args[args.IndexOf("--cpus") + 1]);
            Assert.Equal(limits.ApplicationPids.ToString(), args[args.IndexOf("--pids-limit") + 1]);
        }
        finally { Directory.Delete(root, true); }
    }

    [Theory]
    [InlineData("{\"cpus\":1,\"memory\":\"1g\"}")]
    [InlineData("{\"memoryBytes\":32212254720,\"cpus\":32,\"pids\":512}")]
    public async Task ManifestResources_DoNotPreventAdoptionOfMatchingService(string resources)
    {
        var root = Directory.CreateTempSubdirectory("hosty-resource-adoption-").FullName;
        try
        {
            var path = await WriteResourceManifestAsync(root, resources);
            var selection = await new AppManifestService().LoadAsync(path);
            var digest = "sha256:" + new string('a', 64);
            var context = CreateDockerContext(CreateDockerAppRecord("pinned", LockMap(digest))) with { Manifest = selection };
            var first = new FakeDockerCommandRunner();
            await CreateAdapter(first).StartAsync(context);
            var fingerprint = first.Find("run")!.Single(value => value.StartsWith("hosty.service.configuration=", StringComparison.Ordinal)).Split('=')[1];
            var inspection = JsonSerializer.Serialize(new[] { new
            {
                Config = new { Labels = new Dictionary<string, string> { ["hosty.app.service"] = "app", ["hosty.service.configuration"] = fingerprint }, Env = Array.Empty<string>() },
                Mounts = Array.Empty<object>(),
                HostConfig = new { Memory = 0, MemorySwap = 0, NanoCpus = 0, PidsLimit = 0 },
            } });
            var adopted = new FakeDockerCommandRunner(args => args is ["inspect", "--format", var fmt, ..] && fmt.Contains("State.Running", StringComparison.Ordinal)
                ? new DockerCommandResult(0, $"true::com.example.app::::ghcr.io/example/app@{digest}::PATH=/usr/bin", "")
                : args is ["inspect", var name] && name.StartsWith("hosty-", StringComparison.Ordinal)
                    ? new DockerCommandResult(0, inspection, "") : new DockerCommandResult(0, "", ""));

            await CreateAdapter(adopted).StartAsync(context);

            Assert.False(adopted.Ran("run"));
            Assert.False(adopted.Ran("rm"));
            Assert.False(adopted.Ran("stop"));
        }
        finally { Directory.Delete(root, true); }
    }

    private static async Task<string> WriteResourceManifestAsync(string root, string resources)
    {
        var path = Path.Combine(root, "manifest.json");
        await File.WriteAllTextAsync(path, $$"""
            {
              "schemaVersion": "app.0.1", "id": "com.example.app", "name": "App", "version": "1.0.0",
              "runtimeProfiles": [
                { "key": "docker", "type": "docker", "default": true },
                { "key": "dev", "type": "localCommand", "development": true }
              ],
              "services": [{
                "key": "app",
                "injection": { "appServiceToken": false, "appIdentityToken": false, "settings": [] },
                "runtimes": {
                  "docker": { "image": "ghcr.io/example/app:latest", "resources": {{resources}} },
                  "dev": { "command": "echo ready", "resources": {{resources}} }
                }
              }]
            }
            """);
        return path;
    }
}

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ManifestResources_ExistingAppCanStartPlanAndApplyUpdate(bool targetHasResources)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        // Project Manager used this extension before Core began interpreting resource limits.
        var installed = await fixture.WriteManifestAsync("1.0.0",
            networkJson: "\"resources\": {\"cpus\":1,\"memory\":\"1g\"},");
        await fixture.Service.InstallAsync(new AppInstallRequest(installed));
        await fixture.Service.StartAsync("com.example.notes");
        var dataPath = Path.Combine(fixture.Paths.AppsRoot, "com.example.notes", "data", "keep.txt");
        await File.WriteAllTextAsync(dataPath, "existing app data");
        var target = await fixture.WriteManifestAsync("2.0.0", networkJson: targetHasResources
            ? "\"resources\": {\"memoryBytes\":0,\"cpus\":0,\"pids\":0}," : null);

        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(target));
        var result = await fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest));

        Assert.Equal("updated", result.Status);
        Assert.Equal("2.0.0", result.App!.Version);
        Assert.Equal("running", result.App.RuntimeState);
        Assert.Equal("existing app data", await File.ReadAllTextAsync(dataPath));
    }
}
