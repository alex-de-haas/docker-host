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
    public async Task RemoteDocker_RefusesHostSourceMount()
    {
        // Context inspection must be authoritative when DOCKER_HOST is not explicitly configured.
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DOCKER_HOST"))) return;
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => DockerSourceRuntime.PrepareAsync(Context, SourceService(), new Runner(remote: true), default));
        Assert.Equal("docker_source_remote_unsupported", error.Code);
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
