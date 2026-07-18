using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

internal sealed class LocalCommandRuntimeAdapter(
    HostyCoreRuntimeConfig config,
    LocalCommandProcessRegistry registry,
    AppServiceTokenService serviceTokens,
    IHealthProbe? probe = null,
    LocalCommandShimOptions? shim = null,
    ILogger<LocalCommandRuntimeAdapter>? logger = null) : IAppRuntimeAdapter
{
    public string Type => "localCommand";

    public async Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        var endpoints = new List<AppEndpointContract>();
        var startedServices = new List<string>();
        // Content-hash locks for prebuilt services, keyed by service (mirrors the docker image-digest
        // locks). Returned to the lifecycle service to persist onto AppRecord.ArtifactLocks.
        var resolvedLocks = new Dictionary<string, ArtifactLock>(StringComparer.Ordinal);
        foreach (var service in context.Manifest.Services)
        {
            await StopServiceAsync(context.App.Id, service.Key, context.AppRoot, cancellationToken);
        }

        EnsureExplicitPortsAvailable(context);

        // Resolve every service's host ports up front so the assignment is deterministic and
        // shared: a service reads its own HOSTY_PORT_* from the same map a dependent reads to
        // build HOSTY_SERVICE_{KEY}_URL, regardless of declaration/start order.
        var servicePorts = ResolveServicePorts(context);
        try
        {
            foreach (var service in context.Manifest.Services)
            {
                if (string.IsNullOrWhiteSpace(service.Runtime.Command))
                {
                    throw new AppLifecycleException("local_command_missing", $"Local command service '{service.Key}' does not declare command.");
                }

                var workingDirectory = ResolveWorkingDirectory(context, service);

                // A prebuilt service runs from a materialized, content-addressed copy of its delivery
                // (not the source tree). Materialize/resolve it and record the resulting hash lock; the
                // run directory becomes the artifact copy plus any declared workingDirectory.
                if (string.Equals(service.Artifact, "prebuilt", StringComparison.Ordinal) &&
                    service.Runtime.Delivery is { } delivery)
                {
                    var policy = DockerRuntimeAdapter.ResolveUpdatePolicy(context.App.UpdatePolicy);
                    var (artifactRoot, resolvedLock) = PrebuiltArtifactStore.Resolve(
                        context.AppRoot,
                        context.Manifest.RuntimeProfile.Key,
                        ResolveSourceRoot(context),
                        delivery,
                        context.App.ArtifactLocks?.GetValueOrDefault(service.Key),
                        policy);
                    workingDirectory = CombineWorkingDirectory(artifactRoot, service.Runtime.WorkingDirectory);
                    resolvedLocks[service.Key] = resolvedLock;
                }

                if (!Directory.Exists(workingDirectory))
                {
                    throw new AppLifecycleException(
                        "local_command_working_directory_not_found",
                        $"Local command working directory was not found: {workingDirectory}");
                }

                // Owner-only: service output routinely contains settings and tokens the command was
                // handed. The logs directory is Core-owned and never bind-mounted, so unlike the app
                // data root it can be locked down outright.
                SecureFileSystem.EnsurePrivateDirectory(Path.Combine(context.AppRoot, "logs"));
                var logPath = Path.Combine(context.AppRoot, "logs", $"{service.Key}.log");
                // FileOptions.None: LocalCommandLogWriter writes synchronously with AutoFlush, so an
                // async handle would add a thread-pool hop per log line.
                var logWriter = new LocalCommandLogWriter(new StreamWriter(SecureFileSystem.CreatePrivateFile(logPath, FileMode.Append, FileShare.ReadWrite, FileOptions.None))
                {
                    AutoFlush = true,
                });

                // Prepare the source before the long-running command (e.g. `npm install`). It runs to
                // completion; a failure fails the start. The log writer is disposed here on failure
                // because this service was not yet registered/started (the outer catch only unwinds
                // services already in `startedServices`).
                try
                {
                    await RunSetupAsync(context, service, servicePorts, workingDirectory, logWriter, cancellationToken);
                }
                catch
                {
                    logWriter.Dispose();
                    throw;
                }

                var (startInfo, processGroup) = CreateShellStartInfo(service.Runtime.Command, workingDirectory);
                InjectEnvironment(startInfo, context, service, endpoints, servicePorts);
                var process = new System.Diagnostics.Process
                {
                    StartInfo = startInfo,
                    EnableRaisingEvents = true,
                };
                process.OutputDataReceived += (_, args) =>
                {
                    logWriter.TryWriteLine(args.Data);
                };
                process.ErrorDataReceived += (_, args) =>
                {
                    logWriter.TryWriteLine(args.Data);
                };
                process.Exited += (_, _) =>
                {
                    logWriter.TryWriteLine($"[hosty] process exited with code {process.ExitCode}");
                    logWriter.Dispose();
                };

                try
                {
                    process.Start();
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                }
                catch
                {
                    logWriter.Dispose();
                    process.Dispose();
                    throw;
                }

                registry.Set(context.App.Id, service.Key, new LocalCommandProcess(process, logPath, workingDirectory, servicePorts[service.Key], processGroup));
                await WritePidFileAsync(context, service.Key, process, processGroup, cancellationToken);
                startedServices.Add(service.Key);
                await Task.Delay(250, cancellationToken);
                if (process.HasExited)
                {
                    throw new AppLifecycleException("local_command_start_failed", $"Local command service '{service.Key}' exited with code {process.ExitCode}.");
                }
            }
        }
        catch
        {
            foreach (var serviceKey in startedServices.AsEnumerable().Reverse())
            {
                await StopServiceAsync(context.App.Id, serviceKey, context.AppRoot, CancellationToken.None);
            }

            throw;
        }

        return new AppRuntimeStartResult("running", endpoints, resolvedLocks.Count > 0 ? resolvedLocks : null);
    }

    // Runs the service's one-shot `setup` command to completion before the long-running `command`, in
    // the same working directory and with the same injected environment. Output streams to the service
    // log; a non-zero exit (or a launch failure) throws so the start aborts with the cause visible. A
    // no-op when the service declares no setup.
    private async Task RunSetupAsync(
        RuntimeLifecycleContext context,
        RuntimeSelectedService service,
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, int>> servicePorts,
        string workingDirectory,
        LocalCommandLogWriter logWriter,
        CancellationToken cancellationToken)
    {
        var setup = service.Runtime.Setup;
        if (string.IsNullOrWhiteSpace(setup))
        {
            return;
        }

        logWriter.TryWriteLine($"[hosty] setup: {setup}");
        // Setup is short-lived and killed with entireProcessTree on cancel, so it does not need the
        // group-leader pidfile the long-running command gets; the group flag is discarded here.
        var (startInfo, _) = CreateShellStartInfo(setup, workingDirectory);
        // Setup sees the same environment as `command`; the endpoints list is throwaway here so the
        // real start remains the single source of truth for recorded endpoints.
        InjectEnvironment(startInfo, context, service, [], servicePorts);

        using var process = new System.Diagnostics.Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };

        // Keep the last lines so a failure message carries the actual cause (e.g. npm's error) without
        // making the operator open the log file. OutputDataReceived and ErrorDataReceived are raised
        // concurrently on separate threads, so `tail` (not thread-safe) is guarded by a lock.
        var tail = new Queue<string>();
        var tailLock = new object();
        void Capture(string? line)
        {
            if (line is null)
            {
                return;
            }

            logWriter.TryWriteLine(line);
            lock (tailLock)
            {
                tail.Enqueue(line);
                while (tail.Count > 15)
                {
                    tail.Dequeue();
                }
            }
        }

        process.OutputDataReceived += (_, args) => Capture(args.Data);
        process.ErrorDataReceived += (_, args) => Capture(args.Data);

        try
        {
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }
        catch (Exception ex)
        {
            throw new AppLifecycleException("local_command_setup_failed", $"Local command setup for service '{service.Key}' failed to start: {ex.Message}");
        }

        try
        {
            await process.WaitForExitAsync(cancellationToken);
        }
        catch
        {
            // Never leave the setup process orphaned on cancellation. Kill can race the process's own
            // exit (InvalidOperationException) or be denied (Win32Exception); swallow so the original
            // cancellation/failure exception is the one that propagates.
            if (!process.HasExited)
            {
                try
                {
                    process.Kill(entireProcessTree: true);
                }
                catch
                {
                    // Best effort — preserve the original exception below.
                }
            }

            throw;
        }

        // Parameterless WaitForExit flushes any still-pending async output before we read the tail.
        process.WaitForExit();

        if (process.ExitCode != 0)
        {
            logWriter.TryWriteLine($"[hosty] setup exited with code {process.ExitCode}");
            string detail;
            lock (tailLock)
            {
                detail = tail.Count > 0 ? " " + string.Join(" | ", tail) : string.Empty;
            }
            throw new AppLifecycleException(
                "local_command_setup_failed",
                $"Local command setup for service '{service.Key}' exited with code {process.ExitCode}.{detail}");
        }

        logWriter.TryWriteLine("[hosty] setup completed");
    }

    public async Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        foreach (var service in context.Manifest.Services)
        {
            await StopServiceAsync(context.App.Id, service.Key, context.AppRoot, cancellationToken);
        }

        return new AppRuntimeOperationResult("stopped");
    }

    public async Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        _ = await StopAsync(context, cancellationToken);
        return new AppRuntimeOperationResult("removed");
    }

    public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default)
    {
        var services = new List<AppRuntimeServiceLogs>();
        var lines = new List<string>();
        foreach (var service in context.Manifest.Services)
        {
            var process = registry.Get(context.App.Id, service.Key);
            var logPath = process?.LogPath ?? Path.Combine(context.AppRoot, "logs", $"{service.Key}.log");
            var fileExists = File.Exists(logPath);
            List<string> serviceLines = [];
            if (fileExists)
            {
                // A failing read for one service must not break log retrieval for the rest.
                try
                {
                    // Share ReadWrite so the read succeeds while the running service still holds the
                    // log open for append (the writer at StartAsync uses FileShare.ReadWrite). Without
                    // this, Windows raises a sharing violation ("used by another process"); other
                    // platforms don't enforce share modes so the plain File.ReadLines masked it.
                    serviceLines = ReadSharedLines(logPath).TakeLast(Math.Clamp(tail, 1, 1000)).ToList();
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    serviceLines = [$"[error reading log file: {ex.Message}]"];
                }
            }

            services.Add(new AppRuntimeServiceLogs(service.Key, string.Join(Environment.NewLine, serviceLines)));
            // Match the prior combined-text behavior: a header is emitted whenever the
            // log file exists, even if it is empty, so CLI/control output stays stable.
            if (fileExists)
            {
                lines.Add($"== {service.Key} ==");
                lines.AddRange(serviceLines);
            }
        }

        return Task.FromResult(new AppRuntimeLogsResult(string.Join(Environment.NewLine, lines), services));
    }

    // Lazily enumerate a log file that may be concurrently appended to by a running service.
    // FileShare.ReadWrite lets the read coexist with the writer's open handle (required on Windows);
    // enumeration keeps TakeLast's bounded-memory behavior over large logs.
    private static IEnumerable<string> ReadSharedLines(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var reader = new StreamReader(stream);
        while (reader.ReadLine() is { } line)
        {
            yield return line;
        }
    }

    public async Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        var services = new List<AppRuntimeServiceHealth>(context.Manifest.Services.Count);
        foreach (var service in context.Manifest.Services)
        {
            var health = BuildServiceHealth(context, service);
            services.Add(await ApplyActiveProbeAsync(context, service, health, cancellationToken));
        }

        // Liveness decides first, then the Core-side probe result (Health) refines the all-running
        // case — exactly as the docker aggregate does, but keeping localCommand's "exited" status in
        // the failure branch ("unhealthy") rather than treating it as a clean stop.
        var status = services.Count == 0
            ? "unknown"
            : services.All(service => string.Equals(service.Status, "running", StringComparison.Ordinal))
                ? services.Any(service => string.Equals(service.Health, "unhealthy", StringComparison.Ordinal))
                    ? "degraded"
                    : services.Any(service => string.Equals(service.Health, "starting", StringComparison.Ordinal))
                        ? "starting"
                        : "healthy"
                : services.All(service => string.Equals(service.Status, "stopped", StringComparison.Ordinal))
                    ? "stopped"
                    : "unhealthy";
        return new AppRuntimeHealthResult(status, services);
    }

    // Folds a Core-side http/tcp probe into a running service's health. Only a running service with a
    // declared http/tcp healthcheck and a resolvable host port is probed; otherwise the base health
    // (no probe signal) is returned unchanged.
    private async Task<AppRuntimeServiceHealth> ApplyActiveProbeAsync(
        RuntimeLifecycleContext context, RuntimeSelectedService service, AppRuntimeServiceHealth health, CancellationToken cancellationToken)
    {
        if (probe is null ||
            service.Runtime.Healthcheck is not { } healthcheck ||
            !string.Equals(health.Status, "running", StringComparison.Ordinal))
        {
            return health;
        }

        var handle = registry.Get(context.App.Id, service.Key);
        if (handle is null)
        {
            return health;
        }

        var target = ResolveProbeTarget(healthcheck, service.Runtime.Ports, handle.Ports);
        if (target is null)
        {
            return health;
        }

        var healthy = await probe.ProbeAsync(target, cancellationToken);
        return health with { Health = healthy ? "healthy" : "unhealthy" };
    }

    // Resolves a loopback probe target from a service's http/tcp healthcheck and the host ports it was
    // assigned at start. The healthcheck names a declared container port (or defaults to the first);
    // that port's key maps to the actual host port. Returns null when the check is not http/tcp or no
    // port resolves, so the caller simply skips probing.
    internal static HealthProbeTarget? ResolveProbeTarget(
        RuntimeServiceHealthcheckManifest? healthcheck,
        IReadOnlyList<RuntimePortManifest> ports,
        IReadOnlyDictionary<string, int> assignedPorts)
    {
        if (healthcheck is null || healthcheck.Type is not ("http" or "tcp"))
        {
            return null;
        }

        var port = healthcheck.Port is int declared
            ? ports.FirstOrDefault(candidate => candidate.ContainerPort == declared)
            : ports.FirstOrDefault(candidate => candidate.ContainerPort is not null);
        if (port is null || !assignedPorts.TryGetValue(RuntimeServiceDiscovery.PortKey(port), out var hostPort))
        {
            return null;
        }

        var path = string.IsNullOrWhiteSpace(healthcheck.Path)
            ? "/"
            : healthcheck.Path!.StartsWith('/') ? healthcheck.Path! : "/" + healthcheck.Path;
        var timeout = TimeSpan.FromSeconds(healthcheck.TimeoutSeconds is int seconds && seconds > 0 ? seconds : 5);
        return new HealthProbeTarget(healthcheck.Type, "127.0.0.1", hostPort, path, timeout);
    }

    // Builds the start info for a shell command and reports whether the process is a reclaimable group
    // leader. When the setsid shim is available (non-Windows + a resolved shim path), Core re-execs
    // itself as the group leader instead of spawning /bin/sh directly; the shim then launches the shell
    // inheriting these same stdio pipes, so log capture is unchanged. A null shim path (dll-hosted run,
    // Windows, or tests) falls back to the direct spawn with no group tracking.
    private (System.Diagnostics.ProcessStartInfo StartInfo, bool ProcessGroup) CreateShellStartInfo(string command, string workingDirectory)
    {
        var startInfo = new System.Diagnostics.ProcessStartInfo
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        if (OperatingSystem.IsWindows())
        {
            startInfo.FileName = "cmd.exe";
            startInfo.ArgumentList.Add("/c");
            startInfo.ArgumentList.Add(command);
            return (startInfo, false);
        }

        if (shim?.ShimPath is { } shimPath)
        {
            startInfo.FileName = shimPath;
            startInfo.ArgumentList.Add(LocalCommandShim.Verb);
            startInfo.ArgumentList.Add(command);
            return (startInfo, true);
        }

        startInfo.FileName = "/bin/sh";
        startInfo.ArgumentList.Add("-c");
        startInfo.ArgumentList.Add(command);
        return (startInfo, false);
    }

    private void InjectEnvironment(
        System.Diagnostics.ProcessStartInfo startInfo,
        RuntimeLifecycleContext context,
        RuntimeSelectedService service,
        List<AppEndpointContract> endpoints,
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, int>> servicePorts)
    {
        startInfo.Environment["HOSTY_APP_ID"] = context.App.Id;
        startInfo.Environment["HOSTY_APP_SERVICE_KEY"] = service.Key;
        foreach (var environment in BuildCoreEnvironment(config))
        {
            startInfo.Environment[environment.Key] = environment.Value;
        }

        startInfo.Environment["HOSTY_APP_DATA_DIR"] = context.AppDataPath;
        Directory.CreateDirectory(context.AppDataPath);

        // External mounts: localCommand has no container, so the app reads the operator host
        // paths directly (vs the container paths the docker runtime injects).
        var serviceMounts = RuntimeMountPlanner.ForService(context.Mounts, service.Key);
        foreach (var mountEnvironment in RuntimeMountPlanner.BuildMountEnvironment(serviceMounts, useContainerPath: false))
        {
            startInfo.Environment[mountEnvironment.Key] = mountEnvironment.Value;
        }

        foreach (var environment in service.Runtime.Environment)
        {
            startInfo.Environment[environment.Key] = environment.Value;
        }

        foreach (var setting in context.App.Settings.Values)
        {
            if (!string.IsNullOrWhiteSpace(setting.Value))
            {
                startInfo.Environment[setting.Key] = setting.Value;
            }
        }

        startInfo.Environment["HOSTY_APP_SERVICE_TOKEN"] = serviceTokens.CreateToken(context.App.Id);

        foreach (var dependency in context.DependencyUrls)
        {
            startInfo.Environment[$"HOSTY_DEPENDENCY_{RuntimePortHelper.NormalizeEnvironmentKey(dependency.Key)}_URL"] = dependency.Value;
        }

        // Intra-app discovery: a sibling is reached on the loopback host at the port it was
        // assigned in `servicePorts` (the same map drives every service's own HOSTY_PORT_*). A
        // missing entry yields null, which BuildEnvironment skips rather than emitting `:0`.
        foreach (var serviceUrl in RuntimeServiceDiscovery.BuildEnvironment(
            context.Manifest.Services,
            service,
            (target, port) => servicePorts.TryGetValue(target.Key, out var targetPorts) &&
                    targetPorts.TryGetValue(RuntimeServiceDiscovery.PortKey(port), out var hostPort)
                ? $"{RuntimeServiceDiscovery.Scheme(port)}://{config.RuntimePublicHost}:{hostPort}"
                : null))
        {
            startInfo.Environment[serviceUrl.Key] = serviceUrl.Value;
        }

        // OTLP telemetry: the localCommand process runs on the host, so it reaches the collector's
        // host-published OTLP port via the loopback endpoint unchanged (no host.docker.internal rewrite
        // the docker adapter applies). Gated on the manifest opting in and a resolved collector
        // endpoint — emits nothing otherwise. See docs/features/observability.md.
        foreach (var telemetry in RuntimeTelemetrySettings
            .FromManifest(context.Manifest.Manifest.Telemetry)
            .BuildEnvironment(context.TelemetryEndpoint, context.App.Id, service.Key))
        {
            startInfo.Environment[telemetry.Key] = telemetry.Value;
        }

        var ports = servicePorts[service.Key];
        var assignedHostPorts = new List<int>();
        foreach (var port in service.Runtime.Ports)
        {
            var key = port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (string.IsNullOrWhiteSpace(key) || !ports.TryGetValue(key, out var hostPort))
            {
                continue;
            }

            assignedHostPorts.Add(hostPort);
            startInfo.Environment[$"HOSTY_PORT_{RuntimePortHelper.NormalizeEnvironmentKey(key)}"] = hostPort.ToString(System.Globalization.CultureInfo.InvariantCulture);
            endpoints.Add(new AppEndpointContract(
                Key: $"{service.Key}.{key}",
                Protocol: string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol,
                Url: $"{(string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol)}://{config.RuntimePublicHost}:{hostPort}",
                Public: port.Public ?? false,
                Service: service.Key,
                Port: key));
        }

        if (assignedHostPorts.Count == 1 && !HasExplicitPortEnvironment(context, service))
        {
            startInfo.Environment["PORT"] = assignedHostPorts[0].ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
    }

    // Resolves every service's host ports once so the assignment is stable and shared across
    // services within a single start (a dependent must see the exact port its sibling binds).
    private static IReadOnlyDictionary<string, IReadOnlyDictionary<string, int>> ResolveServicePorts(RuntimeLifecycleContext context)
    {
        // Track every port handed out across services so a dynamic allocation never lands on a
        // port already assigned to a sibling (pinned or dynamic) — the assignments here happen
        // before any process binds, so the OS alone cannot keep them distinct.
        var assigned = new HashSet<int>();
        var map = new Dictionary<string, IReadOnlyDictionary<string, int>>(StringComparer.Ordinal);
        foreach (var service in context.Manifest.Services)
        {
            var ports = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var port in service.Runtime.Ports)
            {
                var key = port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture);
                if (string.IsNullOrWhiteSpace(key) || ports.ContainsKey(key))
                {
                    continue;
                }

                var hostPort = RuntimePortHelper.ResolveHostPort(context.App, service.Key, port, key, assigned);
                ports[key] = hostPort;
                assigned.Add(hostPort);
            }

            map[service.Key] = ports;
        }

        return map;
    }

    internal static IReadOnlyDictionary<string, string> BuildCoreEnvironment(HostyCoreRuntimeConfig config)
        => new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["HOSTY_CORE_PORT"] = config.CorePort.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["HOSTY_CORE_PUBLIC_ORIGIN"] = config.EffectiveCorePublicOrigin,
            ["HOSTY_CORE_ORIGIN"] = config.ListenUrl,
        };

    private static void EnsureExplicitPortsAvailable(RuntimeLifecycleContext context)
    {
        var usedPorts = new Dictionary<int, string>();
        foreach (var service in context.Manifest.Services)
        {
            foreach (var port in service.Runtime.Ports)
            {
                var key = port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "port";
                if (!RuntimePortHelper.TryResolvePinnedHostPort(context.App, service.Key, port, key, out var hostPort))
                {
                    continue;
                }

                if (!RuntimePortHelper.IsLoopbackTcpPortAvailable(hostPort))
                {
                    throw new AppLifecycleException(
                        "local_command_port_unavailable",
                        $"Local command service '{service.Key}' requires local port {hostPort} for port '{key}', but that port is already in use or invalid.");
                }

                if (usedPorts.TryGetValue(hostPort, out var existingService))
                {
                    throw new AppLifecycleException(
                        "local_command_port_unavailable",
                        $"Local command service '{service.Key}' requires local port {hostPort} for port '{key}', but that port is already used by service '{existingService}' in this app.");
                }

                usedPorts.Add(hostPort, service.Key);
            }
        }
    }

    private static bool HasExplicitPortEnvironment(RuntimeLifecycleContext context, RuntimeSelectedService service)
        => service.Runtime.Environment.Keys.Any(key => string.Equals(key, "PORT", StringComparison.OrdinalIgnoreCase)) ||
            context.App.Settings.Values.Any(setting =>
                string.Equals(setting.Key, "PORT", StringComparison.OrdinalIgnoreCase) &&
                !string.IsNullOrWhiteSpace(setting.Value));

    // The effective source root: the lifecycle-resolved root (honors Development Mode — e.g. a locked
    // runtime's pinned checkout) when set, else an override folder, else the managed checkout, else the
    // app root. Drives source runtimes' working directory and resolves a prebuilt service's relative
    // delivery.
    private static string ResolveSourceRoot(RuntimeLifecycleContext context)
        => context.SourceRoot ??
            context.App.SourceState?.LocalOverridePath ??
            context.App.SourceState?.ManagedCheckoutPath ??
            context.AppRoot;

    private static string CombineWorkingDirectory(string root, string? workingDirectory)
    {
        if (string.IsNullOrWhiteSpace(workingDirectory))
        {
            return root;
        }

        // Keep the working directory inside `root`: a `workingDirectory` that is absolute or climbs out
        // with `..` would otherwise run from — or, for a prebuilt, escape the materialized copy into —
        // an arbitrary host path. OS-aware containment (case-insensitive on Windows, separator-safe).
        var canonicalRoot = Path.GetFullPath(root);
        var combined = Path.GetFullPath(Path.Combine(canonicalRoot, workingDirectory));
        var rootPrefix = canonicalRoot.EndsWith(Path.DirectorySeparatorChar)
            ? canonicalRoot
            : canonicalRoot + Path.DirectorySeparatorChar;
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (!string.Equals(combined, canonicalRoot, comparison) && !combined.StartsWith(rootPrefix, comparison))
        {
            throw new AppLifecycleException(
                "local_command_working_directory_out_of_bounds",
                $"Working directory '{workingDirectory}' escapes the runtime root '{canonicalRoot}'.");
        }

        return combined;
    }

    // Source-based working directory (also used by health/logs for display). A prebuilt service's run
    // directory is the materialized artifact copy instead, resolved in StartAsync.
    private static string ResolveWorkingDirectory(RuntimeLifecycleContext context, RuntimeSelectedService service)
        => CombineWorkingDirectory(ResolveSourceRoot(context), service.Runtime.WorkingDirectory);

    // Records the just-started root so a future Core can reclaim its process tree if this Core exits
    // non-gracefully and loses the in-memory registry handle. Reading StartTime of a process that
    // exited between Start() and here can throw; on failure the write is skipped — the 250ms HasExited
    // check in the caller fails the start regardless, so no orphan is left unrecorded.
    private static async Task WritePidFileAsync(
        RuntimeLifecycleContext context, string serviceKey, System.Diagnostics.Process process, bool processGroup, CancellationToken cancellationToken)
    {
        DateTimeOffset startedAtUtc;
        try
        {
            startedAtUtc = process.StartTime.ToUniversalTime();
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return;
        }

        await LocalCommandProcessReclaim.WriteAsync(
            context.AppRoot,
            new LocalCommandPidFile(process.Id, startedAtUtc, context.App.Id, serviceKey, processGroup),
            cancellationToken);
    }

    private async Task StopServiceAsync(string appId, string serviceKey, string appRoot, CancellationToken cancellationToken)
    {
        var running = registry.Remove(appId, serviceKey);
        if (running is not null && !running.Process.HasExited)
        {
            try
            {
                if (running.ProcessGroup && !OperatingSystem.IsWindows())
                {
                    UnixProcessControl.TryKillProcessGroup(running.Process.Id);
                }
                else
                {
                    running.Process.Kill(entireProcessTree: true);
                }

                await running.Process.WaitForExitAsync(cancellationToken);
            }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                // The process exited between the HasExited check and the kill — the outcome we wanted.
            }
        }

        running?.Process.Dispose();

        // Always run the pidfile fallback (best-effort): it reaps a tree an earlier (crashed) Core left
        // behind that this instance never had a registry handle for, and deletes the pidfile on a clean
        // stop. A reclaim failure (e.g. an unreadable run/*.json) must never fail the stop/start flow.
        try
        {
            await LocalCommandProcessReclaim.ReclaimAsync(appRoot, serviceKey, logger, cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            logger?.LogWarning(ex, "Failed to reclaim orphaned localCommand process for {AppId}/{Service}.", appId, serviceKey);
        }
    }

    private AppRuntimeServiceHealth BuildServiceHealth(RuntimeLifecycleContext context, RuntimeSelectedService service)
    {
        var process = registry.Get(context.App.Id, service.Key);
        if (process is null)
        {
            return new AppRuntimeServiceHealth(
                Service: service.Key,
                Status: "stopped",
                ProcessId: null,
                ExitCode: null,
                LogPath: Path.Combine(context.AppRoot, "logs", $"{service.Key}.log"),
                WorkingDirectory: ResolveWorkingDirectory(context, service),
                Message: "No local command process is registered.");
        }

        var hasExited = process.Process.HasExited;
        return new AppRuntimeServiceHealth(
            Service: service.Key,
            Status: hasExited ? "exited" : "running",
            ProcessId: hasExited ? null : process.Process.Id,
            ExitCode: hasExited ? process.Process.ExitCode : null,
            LogPath: process.LogPath,
            WorkingDirectory: process.WorkingDirectory,
            Message: hasExited ? "Local command process exited." : null);
    }

}

internal sealed class LocalCommandProcessRegistry
{
    private readonly ConcurrentDictionary<string, LocalCommandProcess> processes = new(StringComparer.Ordinal);

    public void Set(string appId, string serviceKey, LocalCommandProcess process)
        => processes[$"{appId}/{serviceKey}"] = process;

    public LocalCommandProcess? Get(string appId, string serviceKey)
        => processes.TryGetValue($"{appId}/{serviceKey}", out var process) ? process : null;

    public LocalCommandProcess? Remove(string appId, string serviceKey)
        => processes.TryRemove($"{appId}/{serviceKey}", out var process) ? process : null;
}

internal sealed record LocalCommandProcess(
    System.Diagnostics.Process Process,
    string LogPath,
    string WorkingDirectory,
    IReadOnlyDictionary<string, int> Ports,
    bool ProcessGroup);

// The resolved path Core re-execs to spawn a localCommand root as a setsid group leader, or null when
// the shim is unavailable (Windows / dll-hosted run) so the adapter falls back to a direct spawn. A
// singleton built once at startup from LocalCommandShim.ResolveShimPath(); optional so tests (and any
// unregistered path) get the direct-spawn default.
internal sealed record LocalCommandShimOptions(string? ShimPath);

internal sealed class LocalCommandLogWriter(TextWriter writer) : IDisposable
{
    private readonly object syncRoot = new();
    private TextWriter? currentWriter = writer;

    public void TryWriteLine(string? value)
    {
        if (value is null)
        {
            return;
        }

        lock (syncRoot)
        {
            if (currentWriter is null)
            {
                return;
            }

            try
            {
                currentWriter.WriteLine(value);
            }
            catch (ObjectDisposedException)
            {
                currentWriter = null;
            }
        }
    }

    public void Dispose()
    {
        TextWriter? writerToDispose;
        lock (syncRoot)
        {
            writerToDispose = currentWriter;
            currentWriter = null;
        }

        writerToDispose?.Dispose();
    }
}
