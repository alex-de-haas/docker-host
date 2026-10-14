using Haas.Hosty.Core;
using System.Text.Json;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreEnvironmentResourceTests
{
    [Theory]
    [InlineData("1.5GiB", 1610612736)]
    [InlineData("388kB", 388000)]
    [InlineData("15B", 15)]
    public void DockerSizes_AreParsedConservatively(string value, long expected)
        => Assert.Equal(expected, CoreEnvironmentResources.DockerSize(value));
    [Fact]
    public void DiskObservation_DoesNotChargeBorrowedSymlinksOrDescendantRoots()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        var borrowed = root + "-borrowed"; Directory.CreateDirectory(borrowed);
        try
        {
            File.WriteAllText(Path.Combine(root, "owned"), "123"); File.WriteAllText(Path.Combine(borrowed, "large"), "123456789");
            Directory.CreateSymbolicLink(Path.Combine(root, "borrowed"), borrowed);
            Directory.CreateDirectory(Path.Combine(root, "environments")); File.WriteAllText(Path.Combine(root, "environments", "child"), "123456789");
            Assert.Equal(3, CoreEnvironmentResources.OwnedSize(root));
        }
        finally { Directory.Delete(root, true); Directory.Delete(borrowed, true); }
    }
    [Fact]
    public async Task Admission_AccountsForOtherAppsAndRejectsUnknownDockerBeforeAllocation()
    {
        var root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N")); Directory.CreateDirectory(root);
        try
        {
            var config = new HostyCoreRuntimeConfig(root, root, "", 7070, "http://localhost:7070", null, "localhost", null, false);
            var store = new CoreEnvironmentStore(CoreDataPaths.FromConfig(config)); var id = Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(Path.Combine(store.Root(id), "core")); File.WriteAllText(CoreInstanceId.BuildPath(store.Root(id)), id);
            await store.WriteAsync(new(id, new("admin", null, null), new(Guid.NewGuid().ToString(), "QA"), "hash", 7071, 1, "running", DateTimeOffset.UtcNow), default);
            config = config with { DataRoot = store.Root(id), InstanceId = id };
            var runner = new Runner();
            using (var admission = await CoreEnvironmentResources.AdmitAsync(config, runner, "media", 2, default))
            { Assert.NotNull(admission); Assert.Equal("1073741824", admission.Arguments[1]); Assert.Contains("0.5", admission.Arguments); }
            runner.Memory = 3221225472;
            Assert.Equal("environment_application_capacity", (await Assert.ThrowsAsync<SandboxException>(() => CoreEnvironmentResources.AdmitAsync(config, runner, "media", 2, default))).Code);
            runner.Memory = 0;
            Assert.Equal("environment_resources_unbounded", (await Assert.ThrowsAsync<SandboxException>(() => CoreEnvironmentResources.AdmitAsync(config, runner, "media", 2, default))).Code);
            runner.App = "media"; runner.Memory = 3758096384;
            Assert.Equal("environment_application_capacity", (await Assert.ThrowsAsync<SandboxException>(() => CoreEnvironmentResources.AdmitAsync(config, runner, "media", 1, default,
                replacementServices: new HashSet<string> { "web" }, totalServices: 2))).Code);
            runner.Memory = 1073741824;
            using (var partial = await CoreEnvironmentResources.AdmitAsync(config, runner, "media", 1, default,
                replacementServices: new HashSet<string> { "web" }, totalServices: 2))
                Assert.Equal("1073741824", partial!.Arguments[1]);
            runner.Fail = true;
            Assert.Equal("environment_docker_unknown", (await Assert.ThrowsAsync<SandboxException>(() => CoreEnvironmentResources.AdmitAsync(config, runner, "media", 2, default))).Code);
            Assert.All(runner.Commands, c => Assert.Contains(c[0], new[] { "ps", "inspect" }));
        }
        finally { Directory.Delete(root, true); }
    }
    private sealed class Runner : IDockerCommandRunner
    {
        public string App = "other"; public long Memory = 2147483648; public bool Fail; public List<string[]> Commands = [];
        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment = null, CancellationToken cancellationToken = default)
        {
            Commands.Add(args.ToArray());
            return Task.FromResult(Fail ? new DockerCommandResult(1, "", "offline") : new DockerCommandResult(0, args[0] == "ps" ? "container" :
                JsonSerializer.Serialize(new[] { new { Config = new { Labels = new Dictionary<string, string> { ["hosty.app.id"] = App, ["hosty.app.service"] = "api" } }, HostConfig = new { Memory, NanoCpus = 1000000000L, PidsLimit = 256 } } }), ""));
        }
    }
}
