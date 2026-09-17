using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class DockerSourceRuntimeTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-dev-source-" + Guid.NewGuid().ToString("N"));
    public DockerSourceRuntimeTests() => Directory.CreateDirectory(root);
    public void Dispose() => Directory.Delete(root, recursive: true);

    private RuntimeLifecycleContext Context => MixedRuntimeTests.Context() with { SourceRoot = root };
    private static RuntimeSelectedService SourceService(RuntimeSourceMountManifest? mount = null)
        => new("engine", [], new RuntimeServiceProfileManifest
        {
            Type = "docker", Artifact = "source", SourceMount = mount ?? new(),
            Command = "dotnet watch run", Setup = "dotnet restore",
        }, new("mcr.microsoft.com/dotnet/sdk", "10.0"), "source");

    [Theory]
    [InlineData("../outside")]
    [InlineData("/etc")]
    [InlineData("a/../../outside")]
    [InlineData("a\\b")]
    public void SourceMount_RejectsEscapingPaths(string path)
    {
        var errors = new List<AppManifestValidationError>();
        DockerSourceRuntime.Validate("engine", new() { Type = "docker", Development = true }, SourceService(new() { Path = path }).Runtime, errors);
        Assert.NotEmpty(errors);
        Assert.Throws<AppLifecycleException>(() => DockerSourceRuntime.ResolveSourcePath(Context, new() { Path = path }));
    }

    [Fact]
    public void SourceMount_RejectsSymlinkEscapes()
    {
        Directory.CreateSymbolicLink(Path.Combine(root, "escape"), Path.GetTempPath());
        Assert.Throws<AppLifecycleException>(() => DockerSourceRuntime.ResolveSourcePath(Context, new() { Path = "escape" }));
        Directory.Delete(Path.Combine(root, "escape"));
    }

    [Fact]
    public async Task SourceCommand_PreservesEntrypointAndSeparatesCaches()
    {
        var launch = await DockerSourceRuntime.PrepareAsync(Context, SourceService(new() { Caches = ["bin", "obj"] }), new Runner(), default);
        Assert.NotNull(launch);
        Assert.DoesNotContain("--entrypoint", launch.Arguments);
        Assert.Contains($"type=bind,source={MountPathPolicy.ResolveRealPath(root)},target=/workspace,readonly", launch.Arguments);
        Assert.Contains(launch.Arguments, arg => arg.Contains("target=/workspace/obj,volume-nocopy"));
        Assert.Equal(new[] { "/bin/sh", "-lc", "(dotnet restore) && dotnet watch run" }, launch.Command);
    }

    [Fact]
    public async Task CacheMountpoints_PrepareFreshCheckoutAndPreserveExistingContents()
    {
        var service = SourceService(new() { Caches = ["src/Engine/bin", "src/Engine/obj"] });
        Assert.False(Directory.Exists(Path.Combine(root, "src")));
        var first = await DockerSourceRuntime.PrepareAsync(Context, service, new Runner(), default);
        Assert.Empty(Directory.EnumerateFileSystemEntries(Path.Combine(root, "src/Engine/bin")));
        Assert.Empty(Directory.EnumerateFileSystemEntries(Path.Combine(root, "src/Engine/obj")));
        var hostOutput = Path.Combine(root, "src/Engine/bin/host-output");
        await File.WriteAllTextAsync(hostOutput, "retain host output");
        var second = await DockerSourceRuntime.PrepareAsync(Context, service, new Runner(), default);
        Assert.Equal(first!.Arguments, second!.Arguments);
        Assert.Equal("retain host output", await File.ReadAllTextAsync(hostOutput));
    }

    [Theory]
    [InlineData("cache")]
    [InlineData("cache/bin")]
    public async Task CacheMountpoints_RejectFileCollisionsBeforeCreatingDirectories(string cache)
    {
        await File.WriteAllTextAsync(Path.Combine(root, "cache"), "source content");
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => DockerSourceRuntime.PrepareAsync(
            Context, SourceService(new() { Caches = ["should-not-be-created", cache] }), new Runner(), default));
        Assert.Equal("docker_source_cache_invalid", error.Code);
        Assert.False(Directory.Exists(Path.Combine(root, "should-not-be-created")));
        Assert.Equal("source content", await File.ReadAllTextAsync(Path.Combine(root, "cache")));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CacheMountpoints_RejectExistingAndDanglingSymlinks(bool dangling)
    {
        var outside = Path.Combine(Path.GetTempPath(), "hosty-cache-outside-" + Guid.NewGuid().ToString("N"));
        if (!dangling) Directory.CreateDirectory(outside);
        var link = Path.Combine(root, "cache");
        Directory.CreateSymbolicLink(link, outside);
        try
        {
            var error = await Assert.ThrowsAsync<AppLifecycleException>(() => DockerSourceRuntime.PrepareAsync(
                Context, SourceService(new() { Caches = ["cache/bin"] }), new Runner(), default));
            Assert.Equal("docker_source_cache_invalid", error.Code);
            Assert.False(Directory.Exists(Path.Combine(outside, "bin")));
            Assert.Equal(!dangling, Directory.Exists(outside));
        }
        finally
        {
            if (dangling && !OperatingSystem.IsWindows()) File.Delete(link);
            else Directory.Delete(link);
            if (Directory.Exists(outside)) Directory.Delete(outside);
        }
    }

    [Fact]
    public async Task RemoteDocker_RefusesHostSourceMount()
    {
        // Context inspection must be authoritative when DOCKER_HOST is not explicitly configured.
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DOCKER_HOST"))) return;
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => DockerSourceRuntime.PrepareAsync(Context, SourceService(new() { Caches = ["bin"] }), new Runner(remote: true), default));
        Assert.Equal("docker_source_remote_unsupported", error.Code);
        Assert.False(Directory.Exists(Path.Combine(root, "bin")));
    }

    [Fact]
    public async Task Build_ReusesImmutableImageDespiteSourceEditsAndRejectsUnreviewedRevision()
    {
        File.WriteAllText(Path.Combine(root, "Dockerfile.dev"), "FROM example/environment:1");
        var service = SourceService() with { Runtime = SourceService().Runtime with { Build = new() } };
        var runner = new Runner();
        var first = await DockerSourceRuntime.ResolveBuildAsync(Context, service, runner, null, default);
        File.WriteAllText(Path.Combine(root, "Dockerfile.dev"), "FROM example/environment:2");
        var second = await DockerSourceRuntime.ResolveBuildAsync(Context, service, runner, first.Lock, default);
        Assert.Equal(first, second);
        Assert.Equal(1, runner.Builds);
        var changed = service with { Runtime = service.Runtime with { Build = new() { Revision = "2" } } };
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => DockerSourceRuntime.ResolveBuildAsync(Context, changed, runner, first.Lock, default));
        Assert.Equal("docker_dev_build_requires_review", error.Code);
    }

    private sealed class Runner(bool remote = false) : IDockerCommandRunner
    {
        public int Builds { get; private set; }
        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment, CancellationToken cancellationToken)
        {
            if (args[0] == "build") Builds++;
            return Task.FromResult(new DockerCommandResult(0,
                args[0] == "context" ? remote ? "ssh://remote" : "unix:///var/run/docker.sock" : "sha256:" + new string('a', 64), ""));
        }
    }
}
