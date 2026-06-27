using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;

namespace Haas.Hosty.Core;

internal sealed class LocalCommandRuntimeAdapter(
    HostyCoreRuntimeConfig config,
    LocalCommandProcessRegistry registry,
    AppServiceTokenService serviceTokens,
    IHealthProbe? probe = null) : IAppRuntimeAdapter
{
    public string Type => "localCommand";

    public async Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        var endpoints = new List<AppEndpointContract>();
        var startedServices = new List<string>();
        foreach (var service in context.Manifest.Services)
        {
            await StopServiceAsync(context.App.Id, service.Key, cancellationToken);
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
                if (!Directory.Exists(workingDirectory))
                {
                    throw new AppLifecycleException(
                        "local_command_working_directory_not_found",
                        $"Local command working directory was not found: {workingDirectory}");
                }

                Directory.CreateDirectory(Path.Combine(context.AppRoot, "logs"));
                var logPath = Path.Combine(context.AppRoot, "logs", $"{service.Key}.log");
                var logWriter = new LocalCommandLogWriter(new StreamWriter(File.Open(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                {
                    AutoFlush = true,
                });

                var startInfo = CreateShellStartInfo(service.Runtime.Command, workingDirectory);
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

                registry.Set(context.App.Id, service.Key, new LocalCommandProcess(process, logPath, workingDirectory, servicePorts[service.Key]));
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
                await StopServiceAsync(context.App.Id, serviceKey, CancellationToken.None);
            }

            throw;
        }

        return new AppRuntimeStartResult("running", endpoints);
    }

    public async Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        foreach (var service in context.Manifest.Services)
        {
            await StopServiceAsync(context.App.Id, service.Key, cancellationToken);
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
                    serviceLines = File.ReadLines(logPath).TakeLast(Math.Clamp(tail, 1, 1000)).ToList();
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

    private static System.Diagnostics.ProcessStartInfo CreateShellStartInfo(string command, string workingDirectory)
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
        }
        else
        {
            startInfo.FileName = "/bin/sh";
            startInfo.ArgumentList.Add("-c");
            startInfo.ArgumentList.Add(command);
        }

        return startInfo;
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

                var hostPort = RuntimePortHelper.ResolveHostPort(context, service.Key, port, key, assigned);
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
                if (!RuntimePortHelper.TryResolvePinnedHostPort(context, service.Key, port, key, out var hostPort))
                {
                    continue;
                }

                if (!IsLoopbackPortAvailable(hostPort))
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

    private static bool IsLoopbackPortAvailable(int port)
    {
        if (port is <= 0 or > IPEndPoint.MaxPort)
        {
            return false;
        }

        if (ProbeBind(IPAddress.Loopback, port) is not PortBindProbeResult.Available)
        {
            return false;
        }

        return !Socket.OSSupportsIPv6 ||
            ProbeBind(IPAddress.IPv6Loopback, port) is not PortBindProbeResult.InUse;
    }

    private static PortBindProbeResult ProbeBind(IPAddress address, int port)
    {
        try
        {
            using var listener = new TcpListener(address, port);
            listener.Start();
            return PortBindProbeResult.Available;
        }
        catch (SocketException ex) when (ex.SocketErrorCode == SocketError.AddressAlreadyInUse)
        {
            return PortBindProbeResult.InUse;
        }
        catch (SocketException)
        {
            return PortBindProbeResult.Unavailable;
        }
    }

    private static string ResolveWorkingDirectory(RuntimeLifecycleContext context, RuntimeSelectedService service)
    {
        var sourceRoot = context.App.SourceState?.LocalOverridePath ??
            context.App.SourceState?.ManagedCheckoutPath ??
            context.AppRoot;
        return string.IsNullOrWhiteSpace(service.Runtime.WorkingDirectory)
            ? sourceRoot
            : Path.GetFullPath(Path.Combine(sourceRoot, service.Runtime.WorkingDirectory));
    }

    private async Task StopServiceAsync(string appId, string serviceKey, CancellationToken cancellationToken)
    {
        var running = registry.Remove(appId, serviceKey);
        if (running is null)
        {
            return;
        }

        if (!running.Process.HasExited)
        {
            running.Process.Kill(entireProcessTree: true);
            await running.Process.WaitForExitAsync(cancellationToken);
        }

        running.Process.Dispose();
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

    private enum PortBindProbeResult
    {
        Available,
        InUse,
        Unavailable,
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
    IReadOnlyDictionary<string, int> Ports);

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
