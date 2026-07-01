using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class LocalCommandRuntimeAdapterTests
{
    [Fact]
    public void BuildCoreEnvironment_SplitsPublicAndRuntimeOrigins()
    {
        var config = CreateConfig(
            corePort: 7070,
            listenUrl: "http://localhost:7070",
            corePublicOrigin: "https://core.example");

        var result = LocalCommandRuntimeAdapter.BuildCoreEnvironment(config);

        Assert.Equal("7070", result["HOSTY_CORE_PORT"]);
        Assert.Equal("https://core.example", result["HOSTY_CORE_PUBLIC_ORIGIN"]);
        Assert.Equal("http://localhost:7070", result["HOSTY_CORE_ORIGIN"]);
    }

    [Fact]
    public void LocalCommandLogWriter_IgnoresLateWritesAfterDispose()
    {
        var text = new StringWriter(System.Globalization.CultureInfo.InvariantCulture);
        var writer = new LocalCommandLogWriter(text);

        writer.TryWriteLine("before");
        writer.Dispose();
        var exception = Record.Exception(() => writer.TryWriteLine("after"));

        Assert.Null(exception);
        Assert.Contains("before", text.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain("after", text.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task StartAsync_RunsSetupToCompletionBeforeCommand()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // The setup/command scripts here are POSIX shell; Core runs sh only off-Windows.
        }

        var workRoot = CreateTempDirectory();
        try
        {
            var (adapter, registry, context) = CreateSetupScenario(
                workRoot,
                // The marker proves setup ran, and ran in the working directory, before command.
                setup: "printf ran > setup-marker.txt",
                command: "sleep 30");

            var result = await adapter.StartAsync(context);

            Assert.Equal("running", result.RuntimeState);
            Assert.True(File.Exists(Path.Combine(workRoot, "setup-marker.txt")));
            Assert.NotNull(registry.Get("com.example.app", "app"));

            await adapter.StopAsync(context);
        }
        finally
        {
            TryDeleteDirectory(workRoot);
        }
    }

    [Fact]
    public async Task StartAsync_FailsWithoutStartingCommandWhenSetupExitsNonZero()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // The setup/command scripts here are POSIX shell; Core runs sh only off-Windows.
        }

        var workRoot = CreateTempDirectory();
        try
        {
            var (adapter, registry, context) = CreateSetupScenario(
                workRoot,
                setup: "echo boom-detail 1>&2; exit 7",
                command: "sleep 30");

            var error = await Assert.ThrowsAsync<AppLifecycleException>(() => adapter.StartAsync(context));

            Assert.Equal("local_command_setup_failed", error.Code);
            Assert.Contains("boom-detail", error.Message, StringComparison.Ordinal); // tail carries the cause
            Assert.Null(registry.Get("com.example.app", "app")); // command must not have started
        }
        finally
        {
            TryDeleteDirectory(workRoot);
        }
    }

    [Fact]
    public async Task StartAsync_MaterializesAndRunsPrebuiltArtifactFromContentStore()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // command is a POSIX shell script; Core runs sh only off-Windows.
        }

        var appRoot = CreateTempDirectory();
        try
        {
            // Delivery folder relative to the app/source root.
            var dist = Path.Combine(appRoot, "dist");
            Directory.CreateDirectory(dist);
            await File.WriteAllTextAsync(Path.Combine(dist, "marker.txt"), "built");

            var (adapter, registry, context) = CreatePrebuiltScenario(appRoot, deliveryPath: "dist", command: "sleep 30");

            var result = await adapter.StartAsync(context);

            Assert.Equal("running", result.RuntimeState);
            var lockRecord = Assert.Contains("web", result.ArtifactLocks!);
            Assert.Equal("prebuilt", lockRecord.Kind);
            Assert.False(string.IsNullOrWhiteSpace(lockRecord.BundleHash));

            // The process runs from the materialized artifact copy, not the source delivery folder.
            var running = registry.Get("com.example.app", "web");
            Assert.NotNull(running);
            var artifactRoot = Path.Combine(appRoot, "runtimes", "release", "artifact", lockRecord.BundleHash!);
            Assert.Equal(artifactRoot, running!.WorkingDirectory);
            Assert.True(File.Exists(Path.Combine(artifactRoot, "marker.txt")));

            await adapter.StopAsync(context);
        }
        finally
        {
            TryDeleteDirectory(appRoot);
        }
    }

    [Fact]
    public async Task StartAsync_RejectsPrebuiltWorkingDirectoryThatEscapesTheArtifactRoot()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var appRoot = CreateTempDirectory();
        try
        {
            var dist = Path.Combine(appRoot, "dist");
            Directory.CreateDirectory(dist);
            await File.WriteAllTextAsync(Path.Combine(dist, "marker.txt"), "built");

            // A workingDirectory that climbs out of the materialized artifact copy must be refused.
            var (adapter, registry, context) = CreatePrebuiltScenario(appRoot, deliveryPath: "dist", command: "sleep 30", workingDirectory: "../../escape");

            var error = await Assert.ThrowsAsync<AppLifecycleException>(() => adapter.StartAsync(context));

            Assert.Equal("local_command_working_directory_out_of_bounds", error.Code);
            Assert.Null(registry.Get("com.example.app", "web"));
        }
        finally
        {
            TryDeleteDirectory(appRoot);
        }
    }

    private static (LocalCommandRuntimeAdapter Adapter, LocalCommandProcessRegistry Registry, RuntimeLifecycleContext Context) CreatePrebuiltScenario(
        string appRoot, string deliveryPath, string command, string? workingDirectory = null)
    {
        var registry = new LocalCommandProcessRegistry();
        var adapter = new LocalCommandRuntimeAdapter(
            CreateConfig(corePort: 7070, listenUrl: "http://localhost:7070", corePublicOrigin: null),
            registry,
            new AppServiceTokenService(new ControlSecret("test-control-secret")));

        var service = new RuntimeSelectedService(
            "web",
            [],
            new RuntimeServiceProfileManifest
            {
                Type = "localCommand",
                Artifact = "prebuilt",
                Delivery = new RuntimePrebuiltDeliveryManifest { Type = "folder", Path = deliveryPath },
                WorkingDirectory = workingDirectory,
                Command = command,
            },
            null,
            "prebuilt");
        var manifest = new RuntimeAppManifest { SchemaVersion = "app.0.1", Id = "com.example.app", Name = "App", Version = "1.0.0" };
        var profile = new RuntimeProfileManifest { Key = "release", Type = "localCommand", Default = true };
        var selection = new RuntimeAppManifestSelection(manifest, "/tmp/manifest.json", "digest", profile, [service], null, "{}", null);
        var context = new RuntimeLifecycleContext(
            CreateLocalCommandAppRecord(),
            selection,
            appRoot,
            Path.Combine(appRoot, "data"),
            new Dictionary<string, string>(),
            []);
        return (adapter, registry, context);
    }

    private static (LocalCommandRuntimeAdapter Adapter, LocalCommandProcessRegistry Registry, RuntimeLifecycleContext Context) CreateSetupScenario(
        string workRoot, string? setup, string command)
    {
        var registry = new LocalCommandProcessRegistry();
        var adapter = new LocalCommandRuntimeAdapter(
            CreateConfig(corePort: 7070, listenUrl: "http://localhost:7070", corePublicOrigin: null),
            registry,
            new AppServiceTokenService(new ControlSecret("test-control-secret")));

        var service = new RuntimeSelectedService(
            "app",
            [],
            new RuntimeServiceProfileManifest { Type = "localCommand", Setup = setup, Command = command },
            null,
            "source");
        var manifest = new RuntimeAppManifest { SchemaVersion = "app.0.1", Id = "com.example.app", Name = "App", Version = "1.0.0" };
        var profile = new RuntimeProfileManifest { Key = "dev", Type = "localCommand", Default = true };
        var selection = new RuntimeAppManifestSelection(manifest, "/tmp/manifest.json", "digest", profile, [service], null, "{}", null);
        // SourceState is null and the service declares no workingDirectory, so ResolveWorkingDirectory
        // falls back to AppRoot — setup and command both run in workRoot.
        var context = new RuntimeLifecycleContext(
            CreateLocalCommandAppRecord(),
            selection,
            workRoot,
            Path.Combine(workRoot, "data"),
            new Dictionary<string, string>(),
            []);
        return (adapter, registry, context);
    }

    private static AppRecord CreateLocalCommandAppRecord()
        => new(
            Id: "com.example.app",
            DisplayName: "App",
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: false,
            Source: "manifest",
            ManifestPath: "/tmp/manifest.json",
            ManifestUrl: null,
            SelectedRuntime: "dev",
            OperationStatus: "installed",
            RuntimeState: "stopped",
            LastOperation: null,
            LastError: null,
            Capabilities: [],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);

    private static string CreateTempDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), $"hosty-localcommand-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
        }
        catch (IOException)
        {
            // A still-terminating child can hold a handle briefly; a leaked temp dir is harmless.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static HostyCoreRuntimeConfig CreateConfig(int corePort, string listenUrl, string? corePublicOrigin)
        => new(
            DataRoot: "/tmp/hosty",
            RunDirectory: "/tmp/hosty/core/run",
            ControlDiscoveryPath: "/tmp/hosty/core/run/control.json",
            CorePort: corePort,
            ShellPort: 7171,
            ListenUrl: listenUrl,
            CorePublicOrigin: corePublicOrigin,
            ShellPublicOrigin: null,
            RuntimePublicHost: "localhost",
            ShellManifestPath: null,
            ShellBootstrapRuntime: "docker",
            ShellSourceOverridePath: null,
            ShellBootstrapEnabled: false,
            ShellAutostart: false);
}
