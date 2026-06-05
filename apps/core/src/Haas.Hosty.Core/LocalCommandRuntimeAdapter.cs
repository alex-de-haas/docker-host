using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;

namespace Haas.Hosty.Core;

internal sealed class LocalCommandRuntimeAdapter(
    HostyCoreRuntimeConfig config,
    LocalCommandProcessRegistry registry,
    AppServiceTokenService serviceTokens) : IAppRuntimeAdapter
{
    public string Type => "localCommand";

    public async Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        var endpoints = new List<AppEndpointContract>();
        var startedServices = new List<string>();
        try
        {
            foreach (var service in context.Manifest.Services)
            {
                if (string.IsNullOrWhiteSpace(service.Runtime.Command))
                {
                    throw new AppLifecycleException("local_command_missing", $"Local command service '{service.Key}' does not declare command.");
                }

                await StopServiceAsync(context.App.Id, service.Key, cancellationToken);
                var workingDirectory = ResolveWorkingDirectory(context, service);
                if (!Directory.Exists(workingDirectory))
                {
                    throw new AppLifecycleException(
                        "local_command_working_directory_not_found",
                        $"Local command working directory was not found: {workingDirectory}");
                }

                EnsureExplicitPortsAvailable(service);
                Directory.CreateDirectory(Path.Combine(context.AppRoot, "logs"));
                var logPath = Path.Combine(context.AppRoot, "logs", $"{service.Key}.log");
                var logWriter = new StreamWriter(File.Open(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                {
                    AutoFlush = true,
                };

                var startInfo = CreateShellStartInfo(service.Runtime.Command, workingDirectory);
                InjectEnvironment(startInfo, context, service, endpoints);
                var process = new System.Diagnostics.Process
                {
                    StartInfo = startInfo,
                    EnableRaisingEvents = true,
                };
                process.OutputDataReceived += (_, args) =>
                {
                    if (args.Data is not null)
                    {
                        lock (logWriter)
                        {
                            logWriter.WriteLine(args.Data);
                        }
                    }
                };
                process.ErrorDataReceived += (_, args) =>
                {
                    if (args.Data is not null)
                    {
                        lock (logWriter)
                        {
                            logWriter.WriteLine(args.Data);
                        }
                    }
                };
                process.Exited += (_, _) =>
                {
                    lock (logWriter)
                    {
                        logWriter.WriteLine($"[hosty] process exited with code {process.ExitCode}");
                        logWriter.Dispose();
                    }
                };

                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                registry.Set(context.App.Id, service.Key, new LocalCommandProcess(process, logPath, workingDirectory));
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
        var lines = new List<string>();
        foreach (var service in context.Manifest.Services)
        {
            var process = registry.Get(context.App.Id, service.Key);
            var logPath = process?.LogPath ?? Path.Combine(context.AppRoot, "logs", $"{service.Key}.log");
            if (!File.Exists(logPath))
            {
                continue;
            }

            lines.Add($"== {service.Key} ==");
            lines.AddRange(File.ReadLines(logPath).TakeLast(Math.Clamp(tail, 1, 1000)));
        }

        return Task.FromResult(new AppRuntimeLogsResult(string.Join(Environment.NewLine, lines)));
    }

    public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
    {
        var services = context.Manifest.Services
            .Select(service => BuildServiceHealth(context, service))
            .ToArray();
        var status = services.Length == 0
            ? "unknown"
            : services.All(service => string.Equals(service.Status, "running", StringComparison.Ordinal))
                ? "healthy"
                : services.All(service => string.Equals(service.Status, "stopped", StringComparison.Ordinal))
                    ? "stopped"
                    : "unhealthy";
        return Task.FromResult(new AppRuntimeHealthResult(status, services));
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
        List<AppEndpointContract> endpoints)
    {
        startInfo.Environment["HOSTY_APP_ID"] = context.App.Id;
        startInfo.Environment["HOSTY_APP_SERVICE_KEY"] = service.Key;
        startInfo.Environment["HOSTY_CORE_ORIGIN"] = config.CorePublicOrigin ?? config.ListenUrl;
        startInfo.Environment["HOSTY_APP_DATA_DIR"] = context.AppDataPath;
        Directory.CreateDirectory(context.AppDataPath);

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
            startInfo.Environment[$"HOSTY_DEPENDENCY_{NormalizeEnvironmentKey(dependency.Key)}_URL"] = dependency.Value;
        }

        var assignedHostPorts = new List<int>();
        foreach (var port in service.Runtime.Ports)
        {
            var key = port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (string.IsNullOrWhiteSpace(key))
            {
                continue;
            }

            var hostPort = port.LocalPort ?? port.HostPort ?? AllocateLoopbackPort();
            assignedHostPorts.Add(hostPort);
            startInfo.Environment[$"HOSTY_PORT_{NormalizeEnvironmentKey(key)}"] = hostPort.ToString(System.Globalization.CultureInfo.InvariantCulture);
            endpoints.Add(new AppEndpointContract(
                Key: $"{service.Key}.{key}",
                Protocol: string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol,
                Url: $"{(string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol)}://{config.RuntimePublicHost}:{hostPort}",
                Public: port.Public ?? false));
        }

        if (assignedHostPorts.Count == 1 && !HasExplicitPortEnvironment(context, service))
        {
            startInfo.Environment["PORT"] = assignedHostPorts[0].ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
    }

    private static void EnsureExplicitPortsAvailable(RuntimeSelectedService service)
    {
        foreach (var port in service.Runtime.Ports)
        {
            var hostPort = port.LocalPort ?? port.HostPort;
            if (hostPort is null)
            {
                continue;
            }

            var key = port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "port";
            if (!IsLoopbackPortAvailable(hostPort.Value))
            {
                throw new AppLifecycleException(
                    "local_command_port_unavailable",
                    $"Local command service '{service.Key}' requires local port {hostPort.Value} for port '{key}', but that port is already in use.");
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
        if (port is < IPEndPoint.MinPort or > IPEndPoint.MaxPort)
        {
            return false;
        }

        return CanBind(IPAddress.Loopback, port) &&
            (!Socket.OSSupportsIPv6 || CanBind(IPAddress.IPv6Loopback, port));
    }

    private static bool CanBind(IPAddress address, int port)
    {
        try
        {
            using var listener = new TcpListener(address, port);
            listener.Start();
            return true;
        }
        catch (SocketException)
        {
            return false;
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

    private static int AllocateLoopbackPort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static string NormalizeEnvironmentKey(string value)
        => new(value.Select(character => char.IsLetterOrDigit(character) ? char.ToUpperInvariant(character) : '_').ToArray());
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
    string WorkingDirectory);
