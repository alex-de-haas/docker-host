using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimePreparationTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("hosty-preparation-").FullName;
    public void Dispose() => Directory.Delete(root, recursive: true);

    private RuntimeLifecycleContext Context(RuntimeAppDataTarget? data, RuntimeAppDataTarget? cache, bool cachePath = true)
    {
        var source = Path.Combine(root, "source");
        Directory.CreateDirectory(source);
        RuntimeAppDataTarget Target(RuntimeAppDataTarget target) => new()
        {
            Runtime = "dev", Service = target.Service, ContainerPath = target.ContainerPath, Environment = target.Environment,
        };
        data = data is null ? null : Target(data); cache = cache is null ? null : Target(cache);
        var baseline = MixedRuntimeTests.Context();
        var service = new RuntimeSelectedService("engine", [], new RuntimeServiceProfileManifest
        {
            Type = "docker", Artifact = "source", SourceMount = new(), Command = "run-engine", Setup = "prepare-engine",
            Environment = new Dictionary<string, string> { ["CUSTOM_DATA"] = "/manifest-value", ["STATIC_VALUE"] = "static" },
        }, new("example/prepare", "1"), "source");
        var app = baseline.App with { Settings = new Dictionary<string, AppSettingValue>
        {
            ["PROVIDER_CREDENTIAL"] = new("PROVIDER_CREDENTIAL", "string", "do-not-inject-credential", true),
        } };
        return baseline with
        {
            App = app, AppRoot = Path.Combine(root, "ordinary-app"), AppDataPath = Path.Combine(root, "scratch", "data"),
            AppCachePath = cachePath ? Path.Combine(root, "scratch", "cache") : null, SourceRoot = source, PreparationOnly = true,
            WorkspaceActivationId = Guid.NewGuid().ToString(),
            Manifest = baseline.Manifest with
            {
                RuntimeProfile = new() { Key = "dev", Type = "docker", Development = true }, Services = [service],
                DataTarget = data, CacheTarget = cache,
                Manifest = new RuntimeAppManifest
                {
                    Data = data is null ? null : new() { Enabled = true, Targets = [data] },
                    Cache = cache is null ? null : new() { Enabled = true, Targets = [cache] },
                },
            },
            DependencyUrls = new Dictionary<string, string> { ["database"] = "http://ordinary-database:5432" },
            Mounts = [new("library", "media", Path.Combine(root, "external-data"), "/mnt/library/media", true, "engine")],
            TelemetryEndpoint = "http://ordinary-telemetry:4318",
        };
    }

    private DockerRuntimeAdapter Adapter(RecordingRunner runner) => new(
        new(root, Path.Combine(root, "core", "run"), Path.Combine(root, "core", "run", "control.json"),
            7070, "http://localhost:7070", null, "localhost", null, false),
        new(new AppServiceSigningKey("unused-preparation-key"u8.ToArray())), NullLogger<DockerRuntimeAdapter>.Instance, runner);

    private static string[] Values(IReadOnlyList<string> command, string option)
        => command.Select((value, index) => (value, index)).Where(pair => pair.value == option)
            .Select(pair => command[pair.index + 1]).ToArray();

    [Theory]
    [InlineData(null)]
    [InlineData("engine")]
    public async Task DockerPreparation_SetupUsesScratchTargetsAndDeclaredEnvironmentWithoutOrdinaryAuthority(string? service)
    {
        var context = Context(new() { Service = service, ContainerPath = "/var/prepare-data", Environment = "CUSTOM_DATA" },
            new() { Service = service, ContainerPath = "/var/prepare-cache", Environment = "CUSTOM_CACHE" });
        var runner = new RecordingRunner();
        var prepared = await Adapter(runner).PrepareAsync(context, default);
        var command = Assert.Single(runner.Commands, args => args[0] == "run");
        Assert.Equal(new[] { MountPathPolicy.ResolveRealPath(context.AppDataPath) + ":/var/prepare-data:rw", MountPathPolicy.ResolveRealPath(context.AppCachePath!) + ":/var/prepare-cache:rw" }, Values(command, "-v"));
        Assert.Equal(new[] { "CUSTOM_DATA=/manifest-value", "STATIC_VALUE=static", "CUSTOM_DATA=/var/prepare-data", "CUSTOM_CACHE=/var/prepare-cache" },
            Values(command, "--env"));
        Assert.Contains($"type=bind,source={MountPathPolicy.ResolveRealPath(context.SourceRoot!)},target=/workspace,readonly", command);
        Assert.Equal(new[] { "/bin/sh", "-lc", "prepare-engine" }, command.TakeLast(3));
        Assert.Equal(new[] { "engine" }, prepared.SetupServices);
        Assert.True(Directory.Exists(context.AppDataPath));
        Assert.True(Directory.Exists(context.AppCachePath));
        Assert.DoesNotContain(command, value => value.Contains("ordinary-app", StringComparison.Ordinal) ||
            value.Contains("external-data", StringComparison.Ordinal) || value.Contains("PROVIDER_CREDENTIAL", StringComparison.Ordinal) ||
            value.Contains("do-not-inject-credential", StringComparison.Ordinal) || value.Contains("ordinary-database", StringComparison.Ordinal) ||
            value.Contains("ordinary-telemetry", StringComparison.Ordinal) || value.Contains("HOSTY_APP_SERVICE_TOKEN", StringComparison.Ordinal) ||
            value.Contains("HOSTY_APP_IDENTITY_TOKEN", StringComparison.Ordinal));
        Assert.DoesNotContain("-p", command);
        Assert.DoesNotContain("--network", command);
        Assert.All(runner.Environments, environment => Assert.Null(environment));
    }

    [Fact]
    public async Task DockerPreparation_PreservesExistingBindRootPermissionsForContainerUsers()
    {
        var context = Context(new(), new());
        Directory.CreateDirectory(context.AppDataPath);
        Directory.CreateDirectory(context.AppCachePath!);
        var mode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
            UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(context.AppDataPath, mode);
            File.SetUnixFileMode(context.AppCachePath!, mode);
        }
        await Adapter(new RecordingRunner()).PrepareAsync(context, default);
        if (!OperatingSystem.IsWindows())
        {
            Assert.Equal(mode, File.GetUnixFileMode(context.AppDataPath));
            Assert.Equal(mode, File.GetUnixFileMode(context.AppCachePath!));
        }
    }

    [Fact]
    public async Task DockerPreparation_BlankTargetsUseTheSameContainerDefaultsAsStartup()
    {
        var context = Context(new() { ContainerPath = " ", Environment = " " }, new());
        var runner = new RecordingRunner();
        await Adapter(runner).PrepareAsync(context, default);
        var command = Assert.Single(runner.Commands, args => args[0] == "run");
        Assert.Equal(new[] { MountPathPolicy.ResolveRealPath(context.AppDataPath) + ":/app/data:rw", MountPathPolicy.ResolveRealPath(context.AppCachePath!) + ":/app/cache:rw" }, Values(command, "-v"));
        Assert.Contains("HOSTY_APP_DATA_DIR=/app/data", Values(command, "--env"));
        Assert.Contains("HOSTY_APP_CACHE_DIR=/app/cache", Values(command, "--env"));
    }

    [Fact]
    public async Task DockerPreparation_TargetsForAnotherServiceRemainUnmountedAndNeedNoCachePath()
    {
        var context = Context(new() { Service = "another" }, new() { Service = "another" }, cachePath: false);
        var runner = new RecordingRunner();
        await Adapter(runner).PrepareAsync(context, default);
        var command = Assert.Single(runner.Commands, args => args[0] == "run");
        Assert.Empty(Values(command, "-v"));
        Assert.DoesNotContain(Values(command, "--env"), value => value.StartsWith("HOSTY_APP_DATA_DIR=", StringComparison.Ordinal) ||
            value.StartsWith("HOSTY_APP_CACHE_DIR=", StringComparison.Ordinal));
        Assert.False(Directory.Exists(context.AppDataPath));
        Assert.False(Directory.Exists(Path.Combine(context.AppRoot, "cache")));
    }

    [Fact]
    public async Task DockerPreparation_MissingRequiredScratchCacheRefusesBeforeSetupWithoutOrdinaryFallback()
    {
        var context = Context(new(), new(), cachePath: false);
        var runner = new RecordingRunner();
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => Adapter(runner).PrepareAsync(context, default));
        Assert.Equal("activation_cache_path_missing", error.Code);
        Assert.DoesNotContain(runner.Commands, args => args[0] == "run");
        Assert.False(Directory.Exists(Path.Combine(context.AppRoot, "cache")));
        Assert.False(Directory.Exists(context.AppDataPath));
    }

    [Fact]
    public async Task DockerPreparation_NoDeclaredCacheAllowsNullScratchCachePath()
    {
        var context = Context(new(), null, cachePath: false);
        var runner = new RecordingRunner();
        await Adapter(runner).PrepareAsync(context, default);
        var command = Assert.Single(runner.Commands, args => args[0] == "run");
        Assert.Equal(new[] { MountPathPolicy.ResolveRealPath(context.AppDataPath) + ":/app/data:rw" }, Values(command, "-v"));
        Assert.DoesNotContain(Values(command, "--env"), value => value.StartsWith("HOSTY_APP_CACHE_DIR=", StringComparison.Ordinal));
        Assert.False(Directory.Exists(Path.Combine(context.AppRoot, "cache")));
    }

    private sealed class RecordingRunner : IDockerCommandRunner
    {
        internal List<IReadOnlyList<string>> Commands { get; } = [];
        internal List<IReadOnlyDictionary<string, string>?> Environments { get; } = [];
        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment, CancellationToken cancellationToken)
        {
            Commands.Add(args.ToArray());
            Environments.Add(environment);
            return Task.FromResult(new DockerCommandResult(0, args[0] == "context" ? "unix:///var/run/docker.sock"
                : args[0] == "pull" ? "Digest: sha256:" + new string('a', 64) : "", ""));
        }
    }
}
