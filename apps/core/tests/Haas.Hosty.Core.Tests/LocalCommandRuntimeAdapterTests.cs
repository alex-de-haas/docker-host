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
    public async Task StartAsync_InjectsCacheDirOnlyWhenDeclared()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // The setup/command scripts here are POSIX shell; Core runs sh only off-Windows.
        }

        // Setup shares the command's environment and runs to completion inside StartAsync,
        // so probing the variable there needs no synchronization with the command process.
        var declaredRoot = CreateTempDirectory();
        var undeclaredRoot = CreateTempDirectory();
        try
        {
            var (adapter, _, context) = CreateSetupScenario(
                declaredRoot,
                setup: "printf \"${HOSTY_APP_CACHE_DIR-unset}\" > cache-env.txt",
                command: "sleep 30",
                cacheEnabled: true);
            var result = await adapter.StartAsync(context);
            Assert.Equal("running", result.RuntimeState);
            await adapter.StopAsync(context);

            var cachePath = Path.Combine(declaredRoot, "cache");
            Assert.Equal(cachePath, await File.ReadAllTextAsync(Path.Combine(declaredRoot, "cache-env.txt")));
            Assert.True(Directory.Exists(cachePath));

            var (undeclaredAdapter, _, undeclaredContext) = CreateSetupScenario(
                undeclaredRoot,
                setup: "printf \"${HOSTY_APP_CACHE_DIR-unset}\" > cache-env.txt",
                command: "sleep 30");
            _ = await undeclaredAdapter.StartAsync(undeclaredContext);
            await undeclaredAdapter.StopAsync(undeclaredContext);

            Assert.Equal("unset", await File.ReadAllTextAsync(Path.Combine(undeclaredRoot, "cache-env.txt")));
            Assert.False(Directory.Exists(Path.Combine(undeclaredRoot, "cache")));
        }
        finally
        {
            TryDeleteDirectory(declaredRoot);
            TryDeleteDirectory(undeclaredRoot);
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

    [Fact]
    public async Task StartAsync_WritesPidFileMatchingRegistryProcess()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // The command here is a POSIX shell script; Core runs sh only off-Windows.
        }

        var workRoot = CreateTempDirectory();
        try
        {
            var (adapter, registry, context) = CreateSetupScenario(workRoot, setup: null, command: "sleep 30");

            await adapter.StartAsync(context);

            var running = registry.Get("com.example.app", "app");
            Assert.NotNull(running);

            var pidFilePath = LocalCommandProcessReclaim.PidFilePath(workRoot, "app");
            Assert.True(File.Exists(pidFilePath));
            var pidFile = await JsonStorage.ReadAsync<LocalCommandPidFile>(pidFilePath);
            Assert.NotNull(pidFile);
            Assert.Equal(running!.Process.Id, pidFile!.Pid);
            Assert.Equal("com.example.app", pidFile.AppId);
            Assert.Equal("app", pidFile.ServiceKey);
            // Tests build the adapter without shim options, so the direct-spawn (non-group) path is used.
            Assert.False(pidFile.ProcessGroup);

            await adapter.StopAsync(context);
        }
        finally
        {
            TryDeleteDirectory(workRoot);
        }
    }

    [Fact]
    public async Task StopAsync_KillsOrphanViaPidFileWhenRegistryHandleWasLost()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // The command here is a POSIX shell script; Core runs sh only off-Windows.
        }

        var workRoot = CreateTempDirectory();
        try
        {
            var (adapter, registry, context) = CreateSetupScenario(workRoot, setup: null, command: "sleep 30");

            await adapter.StartAsync(context);
            var running = registry.Get("com.example.app", "app");
            Assert.NotNull(running);
            var pid = running!.Process.Id;

            // Simulate a Core restart that lost the in-memory handle: the process keeps running and its
            // pidfile survives, but the registry no longer knows about it.
            registry.Remove("com.example.app", "app");
            Assert.True(File.Exists(LocalCommandProcessReclaim.PidFilePath(workRoot, "app")));

            await adapter.StopAsync(context);

            Assert.False(IsProcessAlive(pid));
            Assert.False(File.Exists(LocalCommandProcessReclaim.PidFilePath(workRoot, "app")));
        }
        finally
        {
            TryDeleteDirectory(workRoot);
        }
    }

    [Fact]
    public async Task StopAsync_OnWindowsKillsJobDescendantAfterRootExited()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var workRoot = CreateTempDirectory();
        System.Diagnostics.Process? child = null;
        LocalCommandRuntimeAdapter? adapter = null;
        RuntimeLifecycleContext? context = null;
        try
        {
            var childPidPath = Path.Combine(workRoot, "child.pid");
            var escapedPidPath = childPidPath.Replace("'", "''", StringComparison.Ordinal);
            var scriptPath = Path.Combine(workRoot, "spawn-child.cmd");
            await File.WriteAllTextAsync(
                scriptPath,
                $"""
                @echo off
                start "" /b powershell.exe -NoProfile -NonInteractive -Command "Set-Content -LiteralPath '{escapedPidPath}' -Value $PID; Start-Sleep -Seconds 30" >nul 2>&1
                powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 2"
                """);

            var coreExecutable = Path.Combine(Path.GetDirectoryName(typeof(LocalCommandShim).Assembly.Location)!, "hosty-core.exe");
            Assert.True(File.Exists(coreExecutable), $"Core apphost was not copied to the test output: {coreExecutable}");

            LocalCommandProcessRegistry registry;
            (adapter, registry, context) = CreateSetupScenario(
                workRoot,
                setup: null,
                // The bare file name, resolved against the working directory (workRoot). A quoted absolute
                // path does not survive the trip: .NET escapes the inner quotes as \" when it pastes the
                // command line, and cmd.exe reads those literally, so the launch fails with ERRORLEVEL 1
                // before the script ever runs.
                command: Path.GetFileName(scriptPath),
                shim: new LocalCommandShimOptions(coreExecutable));

            AppRuntimeStartResult started;
            try
            {
                started = await adapter.StartAsync(context);
            }
            catch (AppLifecycleException ex)
            {
                // This lane only runs on Windows CI, so a bare exception message would leave the failure
                // undiagnosable — the service log holds what the command actually printed.
                Assert.Fail($"{ex.Message}{Environment.NewLine}Service log:{Environment.NewLine}{ReadServiceLog(workRoot)}");
                throw;
            }

            Assert.Equal("running", started.RuntimeState);

            int childPid;
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15)))
            {
                // File.Exists turns true the moment Set-Content creates the file, before the pid is
                // written and while PowerShell may still hold it open, so poll for a value that parses.
                while (!TryReadChildPid(childPidPath, out childPid))
                {
                    await Task.Delay(50, timeout.Token);
                }
            }

            child = System.Diagnostics.Process.GetProcessById(childPid);

            var running = registry.Get("com.example.app", "app");
            Assert.NotNull(running);
            // Poll HasExited instead of awaiting WaitForExitAsync: that also waits for the redirected
            // output to reach EOF, and the descendant spawned above holds Core's inherited pipe handles
            // until the job kills it. What this step is about is the recorded root being gone.
            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20)))
            {
                while (!running!.Process.HasExited)
                {
                    await Task.Delay(50, timeout.Token);
                }
            }

            Assert.False(child.HasExited);

            await adapter.StopAsync(context);

            using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10)))
            {
                await child.WaitForExitAsync(timeout.Token);
            }
            Assert.True(child.HasExited);
        }
        finally
        {
            if (adapter is not null && context is not null)
            {
                try
                {
                    await adapter.StopAsync(context);
                }
                catch
                {
                }
            }
            if (child is not null && !child.HasExited)
            {
                child.Kill();
            }

            child?.Dispose();
            TryDeleteDirectory(workRoot);
        }
    }

    [Fact]
    public async Task GetLogsAsync_ReadsTailWhileServiceHoldsLogOpenForAppend()
    {
        // Not Windows-gated on purpose: the sharing violation only reproduces on Windows (CI is
        // Linux, which doesn't enforce share modes), so here this is a smoke test of the read/tail
        // path. It is the read side's FileShare.ReadWrite that makes the Windows case pass.
        var workRoot = CreateTempDirectory();
        try
        {
            var (adapter, _, context) = CreateSetupScenario(workRoot, setup: null, command: "unused");

            var logPath = Path.Combine(workRoot, "logs", "app.log");
            Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);

            // Mirror the running-service writer: an open append handle that shares ReadWrite.
            using var writer = new StreamWriter(File.Open(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
            {
                AutoFlush = true,
            };
            writer.WriteLine("first");
            writer.WriteLine("second");

            var result = await adapter.GetLogsAsync(context, tail: 10);

            Assert.NotNull(result.Services);
            var appLogs = Assert.Single(result.Services!);
            Assert.DoesNotContain("error reading log file", appLogs.Text, StringComparison.Ordinal);
            Assert.Contains("first", appLogs.Text, StringComparison.Ordinal);
            Assert.Contains("second", appLogs.Text, StringComparison.Ordinal);
        }
        finally
        {
            TryDeleteDirectory(workRoot);
        }
    }

    private static bool IsProcessAlive(int pid)
    {
        try
        {
            return !System.Diagnostics.Process.GetProcessById(pid).HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private static (LocalCommandRuntimeAdapter Adapter, LocalCommandProcessRegistry Registry, RuntimeLifecycleContext Context) CreatePrebuiltScenario(
        string appRoot, string deliveryPath, string command, string? workingDirectory = null)
    {
        var registry = new LocalCommandProcessRegistry();
        var adapter = new LocalCommandRuntimeAdapter(
            CreateConfig(corePort: 7070, listenUrl: "http://localhost:7070", corePublicOrigin: null),
            registry,
            new AppServiceTokenService(new AppServiceSigningKey("test-control-secret"u8.ToArray())));

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

    // Reads a service log while the writing process may still hold it open (FileShare.ReadWrite), so a
    // start failure can be reported with the command's own output.
    private static string ReadServiceLog(string workRoot)
    {
        var logPath = Path.Combine(workRoot, "logs", "app.log");
        try
        {
            using var stream = new FileStream(logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            return reader.ReadToEnd();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return $"(unreadable: {logPath})";
        }
    }

    private static bool TryReadChildPid(string path, out int pid)
    {
        pid = 0;
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream);
            return int.TryParse(reader.ReadToEnd().Trim(), System.Globalization.CultureInfo.InvariantCulture, out pid);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static (LocalCommandRuntimeAdapter Adapter, LocalCommandProcessRegistry Registry, RuntimeLifecycleContext Context) CreateSetupScenario(
        string workRoot,
        string? setup,
        string command,
        bool cacheEnabled = false,
        LocalCommandShimOptions? shim = null)
    {
        var registry = new LocalCommandProcessRegistry();
        var adapter = new LocalCommandRuntimeAdapter(
            CreateConfig(corePort: 7070, listenUrl: "http://localhost:7070", corePublicOrigin: null),
            registry,
            new AppServiceTokenService(new AppServiceSigningKey("test-control-secret"u8.ToArray())),
            shim: shim);

        var service = new RuntimeSelectedService(
            "app",
            [],
            new RuntimeServiceProfileManifest { Type = "localCommand", Setup = setup, Command = command },
            null,
            "source");
        var manifest = new RuntimeAppManifest
        {
            SchemaVersion = "app.0.1",
            Id = "com.example.app",
            Name = "App",
            Version = "1.0.0",
            Cache = cacheEnabled ? new RuntimeAppDataManifest { Enabled = true } : null,
        };
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

    [Fact]
    public void EnsureDynamicRangePortsStillAvailable_DynamicRangePortTakenDuringSetup_Throws()
    {
        // The gateway's failure: the port is free at the adapter's first preflight, then `npm install`
        // runs — dozens of outbound connections drawing local ports from this very range — and by the
        // time the command spawns the port is gone. Naming it beats an EADDRINUSE from inside the app.
        using var holder = HoldHighDynamicRangePort(out var taken);

        var error = Assert.Throws<AppLifecycleException>(() =>
            LocalCommandRuntimeAdapter.EnsureDynamicRangePortsStillAvailable("api", new Dictionary<string, int> { ["http"] = taken }));

        Assert.Equal("local_command_port_unavailable", error.Code);
        Assert.Contains(taken.ToString(System.Globalization.CultureInfo.InvariantCulture), error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void EnsureDynamicRangePortsStillAvailable_HeldBandPort_IsNotProbed()
    {
        // Deliberate scoping, not an oversight. A band port cannot be taken by the OS on its own, so
        // re-probing it buys nothing — and would cost a real regression: on Windows a Node listener binds
        // with SO_EXCLUSIVEADDRUSE, so the app's own TIME_WAIT sockets from the run we just stopped can
        // still hold its port, and a strict probe here would fail ordinary restarts.
        var band = RuntimePortHelper.AllocateLoopbackPort();
        using var holder = new System.Net.Sockets.Socket(System.Net.Sockets.AddressFamily.InterNetwork, System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Tcp);
        holder.Bind(new System.Net.IPEndPoint(System.Net.IPAddress.Loopback, band));
        holder.Listen(1);

        LocalCommandRuntimeAdapter.EnsureDynamicRangePortsStillAvailable("api", new Dictionary<string, int> { ["http"] = band });
    }

    [Fact]
    public void EnsureDynamicRangePortsStillAvailable_FreePorts_Pass()
    {
        var free = RuntimePortHelper.AllocateLoopbackPort();

        LocalCommandRuntimeAdapter.EnsureDynamicRangePortsStillAvailable(
            "api",
            new Dictionary<string, int> { ["http"] = free, ["metrics"] = RuntimePortHelper.AllocateLoopbackPort() });
    }

    // Listens on a dynamic-range port scanned down from the top of the range, rather than taking whatever
    // a port-0 bind hands back. The suite already shares an ephemeral-port race — every
    // `TcpListener(IPAddress.Loopback, 0)` helper competes for the same OS cursor, see LoopbackHttpServer
    // — and a long-lived listener on an OS-assigned port is one more competitor. 65535 downward is where
    // that cursor is least likely to be: it is above Linux's range entirely and at the far end of the
    // Windows and macOS one.
    private static System.Net.Sockets.Socket HoldHighDynamicRangePort(out int port)
    {
        for (var candidate = 65535; candidate >= RuntimePortHelper.OsDynamicPortFloor; candidate--)
        {
            var socket = new System.Net.Sockets.Socket(System.Net.Sockets.AddressFamily.InterNetwork, System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Tcp);
            try
            {
                socket.Bind(new System.Net.IPEndPoint(System.Net.IPAddress.Loopback, candidate));
                socket.Listen(1);
                port = candidate;
                return socket;
            }
            catch (System.Net.Sockets.SocketException)
            {
                socket.Dispose();
            }
        }

        throw new InvalidOperationException("No bindable port in the OS dynamic range.");
    }

    private static HostyCoreRuntimeConfig CreateConfig(int corePort, string listenUrl, string? corePublicOrigin)
        => new(
            DataRoot: "/tmp/hosty",
            RunDirectory: "/tmp/hosty/core/run",
            ControlDiscoveryPath: "/tmp/hosty/core/run/control.json",
            CorePort: corePort,
            ListenUrl: listenUrl,
            CorePublicOrigin: corePublicOrigin,
            RuntimePublicHost: "localhost",
            ShellSourceOverridePath: null,
            ShellAutostart: false);
}
