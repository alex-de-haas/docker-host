using System.Diagnostics;
using Haas.Hosty.Core;
using Haas.Hosty.Launch;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreEnvironmentRetentionTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-child-retention-" + Guid.NewGuid().ToString("N"));
    private CoreEnvironmentRuntime Runtime => new(new(root, root, "", 7070, "http://localhost:7070", null, "localhost", null, false),
        new EmptyDocker(), new Clients(), NullLogger<CoreEnvironmentRuntime>.Instance);
    private static CoreEnvironmentRecord Record(string mode = "release", string? project = null) => new(Guid.NewGuid().ToString("N"), new("admin", null, null),
        new(Guid.NewGuid().ToString(), "Build", mode, project), "hash", 7070, 1, "stopped", DateTimeOffset.UtcNow);

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    public void UnownedGeneration_IsNeverALiveProcess(int pid)
        => Assert.False(CoreBuildRetention.IsAlive(pid, DateTimeOffset.MinValue));

    [Fact]
    public async Task FailedPreparation_RetainsOnlyLatestDiagnosticGenerationWithoutParentLifetimePinning()
    {
        Directory.CreateDirectory(root);
        var project = Path.Combine(root, "invalid.csproj"); await File.WriteAllTextAsync(project, "<Project><invalid>");
        for (var i = 0; i < 3; i++)
            await Assert.ThrowsAsync<SandboxException>(() => Runtime.PrepareAsync(Record("source", project), root, default));
        var generation = Assert.Single(Directory.GetDirectories(Path.Combine(root, "core", "builds")));
        Assert.True(File.Exists(Path.Combine(generation, "build.log")));
        var marker = CoreLaunchFiles.Read(Path.Combine(generation, CoreBuildRetention.Marker), CoreLaunchJson.Default.CoreBuildGeneration)!;
        Assert.Equal("failed", marker.State); Assert.Equal(-1, marker.OwnerPid);
    }

    [Fact]
    public async Task Cleanup_PreservesLiveAndRunnerReferencedGenerations_AndBoundsReplacementsAndUnusedPreparations()
    {
        var binary = OperatingSystem.IsWindows() ? "hosty-core.exe" : "hosty-core";
        var source = Path.Combine(root, "core", "bin", binary); Directory.CreateDirectory(Path.GetDirectoryName(source)!);
        await File.WriteAllTextAsync(source, "fixture native output");
        var runtime = Runtime; var record = Record();
        var outputs = new List<string>();
        for (var i = 0; i < 5; i++)
        {
            var output = await runtime.PrepareAsync(record, root, default); outputs.Add(output);
            var path = Path.Combine(CoreEnvironmentRuntime.Generation(root, output)!, CoreBuildRetention.Marker);
            var marker = CoreLaunchFiles.Read(path, CoreLaunchJson.Default.CoreBuildGeneration)!;
            CoreLaunchFiles.Write(path, marker with { State = "ready", OwnerPid = -1 }, CoreLaunchJson.Default.CoreBuildGeneration);
        }
        using var process = Process.GetCurrentProcess();
        var activeGeneration = CoreEnvironmentRuntime.Generation(root, outputs[0])!;
        CoreBuildRetention.Mark(activeGeneration, "ready", null);
        var runnerGeneration = CoreEnvironmentRuntime.Generation(root, outputs[1])!;
        var run = Path.Combine(root, "apps", "fixture", "run"); Directory.CreateDirectory(run);
        await File.WriteAllTextAsync(Path.Combine(run, "web.json"), System.Text.Json.JsonSerializer.Serialize(new {
            pid = process.Id, startedAtUtc = process.StartTime.ToUniversalTime(), runnerGeneration }));
        var unused = await runtime.PrepareAsync(record, root, default);
        await runtime.CleanupAsync(record with { Executable = unused }, root, default);
        Assert.True(File.Exists(outputs[0])); Assert.True(File.Exists(outputs[1]));
        Assert.False(File.Exists(outputs[2])); Assert.True(File.Exists(outputs[3])); Assert.True(File.Exists(outputs[4]));
        for (var i = 0; i < 3; i++)
        {
            var replacement = await runtime.PrepareAsync(record, root, default);
            await runtime.CleanupAsync(record with { Executable = replacement }, root, default);
        }
        Assert.False(File.Exists(unused));
        Assert.Equal(5, Directory.GetDirectories(Path.Combine(root, "core", "builds")).Length);
        var unknown = Path.Combine(root, "core", "builds", "operator-output"); Directory.CreateDirectory(unknown);
        await runtime.CleanupAsync(record, root, default); Assert.True(Directory.Exists(unknown));
    }

    [Fact]
    public async Task Stop_TraversesRecordedDescendantsAndOnlyTheirDockerOwnership()
    {
        var config = new HostyCoreRuntimeConfig(root, root, "", 7070, "http://localhost:7070", null, "localhost", null, false);
        var child = Record(); Directory.CreateDirectory(Path.Combine(root, "core"));
        await File.WriteAllTextAsync(CoreInstanceId.BuildPath(root), child.Id);
        var store = new CoreEnvironmentStore(CoreDataPaths.FromConfig(config)); var descendant = Record();
        await store.WriteAsync(descendant, default);
        var nestedRoot = store.Root(descendant.Id); Directory.CreateDirectory(Path.Combine(nestedRoot, "core"));
        await File.WriteAllTextAsync(CoreInstanceId.BuildPath(nestedRoot), descendant.Id);
        var docker = new EmptyDocker();
        var runtime = new CoreEnvironmentRuntime(config, docker, new Clients(), NullLogger<CoreEnvironmentRuntime>.Instance);
        await runtime.StopAsync(child, root, true, default);
        Assert.Contains("label=hosty.instance=" + child.Id, docker.Arguments);
        Assert.Contains("label=hosty.instance=" + descendant.Id, docker.Arguments);
    }
    private sealed class Clients : IHttpClientFactory { public HttpClient CreateClient(string name) => new(); }
    private sealed class EmptyDocker : IDockerCommandRunner
    {
        public List<string> Arguments { get; } = [];
        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment, CancellationToken ct)
        { Arguments.AddRange(args); return Task.FromResult(new DockerCommandResult(0, "", "")); }
    }
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
}
