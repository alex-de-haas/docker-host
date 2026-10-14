using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Haas.Hosty.Core;

// Additional execution targets have their own resource graph. This adapter never sends a
// synthetic AppRecord through installed-app lifecycle or reads its settings/data/credentials.
internal sealed partial class SandboxDockerRuntime(IDockerCommandRunner docker, SandboxStore store,
    HostyCoreRuntimeConfig config, SandboxServiceCredentials credentials) : ISandboxRuntime
{
    private readonly SemaphoreSlim admission = new(1, 1);
    private const long GiB = 1073741824;
    private static readonly HttpClient probes = new(new SocketsHttpHandler { AllowAutoRedirect = false, UseProxy = false, UseCookies = false })
        { Timeout = TimeSpan.FromSeconds(3) };

    public async Task<SandboxServiceLog[]> LogsAsync(SandboxInstance instance, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(10));
        var result = new List<SandboxServiceLog>();
        foreach (var resource in instance.Resources.Where(r => r.Kind == "container"
            && instance.Input.Manifest.Services.Any(service => service.Key == r.Service)))
        {
            var state = await RequireOwned(instance, resource, deadline.Token);
            if (state is null) { result.Add(new(resource.Service!, "missing", "")); continue; }
            var output = await docker.RunBoundedAsync(["logs", "--tail", "100", resource.EngineId!], 32768, deadline.Token);
            result.Add(new(resource.Service!, state.Value.GetProperty("State").GetProperty("Running").GetBoolean() ? "running" : "stopped",
                output.ExitCode == 0 ? SandboxLogText.Sanitize(output.StandardOutput + "\n" + output.StandardError) : "Log output unavailable."));
        }
        return result.ToArray();
    }

    public async Task<SandboxRuntimeStart> StartAsync(SandboxInstance instance, Func<SandboxResource, Task> recordResource, CancellationToken ct)
    {
        await admission.WaitAsync(ct);
        try
        {
            var policy = await JsonStorage.ReadAsync<SandboxRuntimePolicy>(Path.Combine(store.Root, "runtime.json"), ct)
                ?? throw Error("sandbox_runtime_not_prepared", "Prepare the trusted sandbox relay image and runtime policy first.");
            if (!OperatingSystem.IsMacOS() || policy.MaxRunningInstances is < 1 or > 2 || policy.ReservedAgentBytes is < 0 or > 4294967296)
                throw Error("sandbox_host_unsupported", "This reviewed profile supports local macOS Docker Desktop only.");
            if (!ValidImage(policy.RelayImage)) throw Error("sandbox_runtime_not_prepared", "The relay must be pinned by immutable local image ID.");
            await Admit(instance, policy, recordResource, ct);
            var image = await Run(["image", "inspect", "--format", "{{.Id}}", policy.RelayImage], ct);
            if (image.StandardOutput.Trim() != policy.RelayImage) throw Error("sandbox_relay_unavailable", "The pinned relay is unavailable.");
            var port = instance.PreviewPort;
            if (port is < 1024 or > 65535) throw Error("sandbox_preview_port_invalid", "The instance has no reserved preview port.");
            using (var reservation = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp))
            {
                try { reservation.Bind(new IPEndPoint(IPAddress.Loopback, port)); }
                catch (SocketException) { throw Error("sandbox_preview_port_conflict", "The reserved preview port is occupied; no substitute origin was allocated."); }
            }
            var domain = $"s-{instance.Id}.d-{instance.DataRevision}.{LocalBrowserOrigins.Site(config.InstanceId)}";
            var endpoints = instance.Input.Manifest.Manifest.Endpoints.Where(e => e.Public).Select(e =>
            {
                var service = instance.Input.Manifest.Services.Single(s => s.Key == e.Service);
                var target = service.Runtime.Ports.Single(p => e.Port is not null && RuntimeServiceDiscovery.PortMatches(p, e.Port));
                if (target.ContainerPort is null || target.Protocol is not (null or "http"))
                    throw Error("sandbox_endpoint_unsupported", "The local preview recipe requires declared HTTP ports.");
                return new SandboxRelayEndpoint($"{e.Key}.{domain}:{port}", service.Key, target.ContainerPort.Value);
            }).ToArray();
            var publicEndpoints = instance.Input.Manifest.Manifest.Endpoints.Where(e => e.Public).Zip(endpoints,
                (e, route) => new SandboxPreviewEndpoint(e.Key, "http://" + route.Host)).ToArray();
            var entrypointNode = instance.Input.Manifest.Manifest.Ui?.Entrypoint;
            var entrypoint = entrypointNode is { ValueKind: JsonValueKind.Object } node && node.TryGetProperty("endpoint", out var entry)
                ? entry.GetString() : null;
            var preview = publicEndpoints.FirstOrDefault(e => e.Key == entrypoint) ?? publicEndpoints.FirstOrDefault()
                ?? throw Error("sandbox_preview_missing", "Declare a public HTTP preview endpoint.");
            var authHost = $"auth.{domain}:{port}";
            var relayConfig = new SandboxRelayConfig(instance.Id, instance.Generation, instance.DataRevision,
                $"http://host.docker.internal:{config.CorePort}", authHost, endpoints);
            var relayFile = Path.Combine(store.InstanceRoot(instance.Id), "relay.json");
            var inner = Resource(instance, "network", "inner");
            var outer = Resource(instance, "network", "outer");
            var browserNetwork = Resource(instance, "network", "browser-network");
            await Create(inner, ["network", "create", "--driver", "bridge", "--internal", "--ipv6=false", "--opt",
                "com.docker.network.bridge.gateway_mode_ipv4=isolated"], instance, recordResource, ct);
            await Create(outer, ["network", "create", "--driver", "bridge", "--ipv6=false"], instance, recordResource, ct);
            await VerifyNetwork(inner, instance, ct);
            await Create(browserNetwork, ["network", "create", "--driver", "bridge", "--internal", "--ipv6=false", "--opt",
                "com.docker.network.bridge.gateway_mode_ipv4=isolated"], instance, recordResource, ct);
            await VerifyNetwork(browserNetwork, instance, ct);
            // Finalize routing before Docker binds the file. Atomic replacement after a bind
            // leaves Docker Desktop's mount on the removed inode and the relay cannot read it.
            var browserNetworkState = (await RequireOwned(instance, browserNetwork, ct))!.Value;
            var subnet = browserNetworkState.GetProperty("IPAM").GetProperty("Config")[0].GetProperty("Subnet").GetString();
            var browserAddress = BrowserRelayAddress(subnet);
            await JsonStorage.WriteAsync(relayFile, relayConfig with { BrowserAddress = browserAddress }, true, ct);
            // Routing metadata only; the private directory and realm remain outside the mount.
            File.SetUnixFileMode(relayFile, UnixFileMode.UserRead | UnixFileMode.GroupRead | UnixFileMode.OtherRead);
            var ordered = DockerRuntimeAdapter.OrderServices(instance.Input.Manifest.Services);
            var limits = instance.Request.Limits ?? new();
            var user = $"{GetUserId()}:{GetGroupId()}";
            if (GetUserId() == 0) throw Error("sandbox_root_unsupported", "Run the local demo Core as an ordinary user.");
            var token = credentials.Create(instance);
            foreach (var service in ordered)
            {
                store.RequireNotRevoked(instance.Id);
                var resource = Resource(instance, "container", service.Key);
                var args = new List<string> { "create", "--name", resource.Id };
                args.AddRange(Labels(instance, resource.Generation));
                args.AddRange(Limits(limits.MemoryBytes / ordered.Count, limits.Cpus / ordered.Count,
                    limits.Pids / ordered.Count, Math.Min(268435456 / ordered.Count, limits.MemoryBytes / ordered.Count / 4), user));
                args.AddRange(["--network", inner.Id, "--network-alias", service.Key, "--dns", "127.0.0.1"]);
                args.AddRange(DockerRuntimeAdapter.BuildHealthcheckArguments(service.Runtime));
                var environment = new Dictionary<string, string>(service.Runtime.Environment, StringComparer.Ordinal);
                if (environment.Keys.Any(k => k.StartsWith("HOSTY_", StringComparison.Ordinal) || k.Contains('=') || k.Any(char.IsControl)))
                    throw Error("sandbox_environment_unsupported", "The recipe cannot override Core-injected environment.");
                environment["HOSTY_APP_ID"] = instance.Input.AppId;
                environment["HOSTY_APP_SERVICE_KEY"] = service.Key;
                environment["HOSTY_APP_SERVICE_TOKEN"] = token;
                environment["HOSTY_CORE_ORIGIN"] = "http://sandbox-core:8090";
                environment["HOSTY_CORE_PUBLIC_ORIGIN"] = "http://" + authHost;
                environment["HOSTY_SANDBOX_PROTOCOL"] = "hosty-sandbox-v1";
                environment["HOSTY_SANDBOX_INSTANCE_ID"] = instance.Id;
                environment["HOSTY_SANDBOX_GENERATION"] = instance.Generation;
                environment["HOSTY_SANDBOX_DATA_REVISION"] = instance.DataRevision;
                environment["HOME"] = "/tmp";
                foreach (var endpoint in publicEndpoints) environment["HOSTY_PUBLIC_ORIGIN_" + RuntimePortHelper.NormalizeEnvironmentKey(endpoint.Key)] = endpoint.Url;
                foreach (var pair in RuntimeServiceDiscovery.BuildEnvironment(ordered, service, (peer, peerPort) =>
                    $"http://{peer.Key}:{peerPort.ContainerPort}")) environment[pair.Key] = pair.Value;
                foreach (var declaredPort in service.Runtime.Ports.Where(p => p.ContainerPort is not null))
                    environment["HOSTY_PORT_" + RuntimePortHelper.NormalizeEnvironmentKey(RuntimeServiceDiscovery.PortKey(declaredPort))] = declaredPort.ContainerPort!.Value.ToString(CultureInfo.InvariantCulture);
                if (service.Runtime.Ports.FirstOrDefault(p => p.Protocol is null or "http")?.ContainerPort is { } httpPort)
                    environment["PORT"] = httpPort.ToString(CultureInfo.InvariantCulture);
                AddData(instance, service, instance.Input.Manifest.DataTarget, "data", args, environment);
                AddData(instance, service, instance.Input.Manifest.CacheTarget, "cache", args, environment);
                if (service.Runtime.SourceMount is { } sourceMount)
                {
                    var sourceRoot = instance.Input.SourceRoot ?? throw Error("sandbox_source_invalid", "Source input is missing.");
                    var source = sourceMount.Path == "." ? sourceRoot : Contained(sourceRoot, sourceMount.Path);
                    DockerSourceRuntime.PrepareCacheMountpoints(source, sourceMount.Caches);
                    args.AddRange(["--mount", Bind(source, sourceMount.Target, true), "--workdir",
                        sourceMount.Target.TrimEnd('/') + (service.Runtime.WorkingDirectory is { Length: > 0 } cwd ? "/" + cwd : "")]);
                    foreach (var generated in instance.Input.Manifest.Manifest.Sandbox?.GeneratedSourceFiles?.GetValueOrDefault(instance.Request.Profile) ?? [])
                    {
                        var sourceFile = Contained(source, generated);
                        if (!File.Exists(sourceFile)) throw Error("sandbox_source_invalid", "The generated source mountpoint is missing.");
                        var overlay = Path.Combine(store.DataPath(instance.Id, "cache"), SandboxValidation.Hash(instance.Input.Digest + "|" + service.Key + "|" + generated));
                        if (!File.Exists(overlay)) File.Copy(sourceFile, overlay, false);
                        args.AddRange(["--mount", Bind(overlay, sourceMount.Target.TrimEnd('/') + "/" + generated)]);
                    }
                    foreach (var relative in sourceMount.Caches)
                    {
                        var cache = Path.Combine(store.DataPath(instance.Id, "cache"), SandboxValidation.Hash(instance.Input.Digest + "|" + relative));
                        Directory.CreateDirectory(cache);
                        args.AddRange(["--mount", Bind(cache, sourceMount.Target.TrimEnd('/') + "/" + relative)]);
                    }
                }
                foreach (var key in environment.Keys) args.AddRange(["-e", key]);
                args.Add(instance.Input.Images[service.Key]);
                if (service.Runtime.Command is { Length: > 0 } command)
                    args.AddRange(["/bin/sh", "-lc", service.Runtime.Setup is { Length: > 0 } setup ? $"({setup}) && touch /tmp/hosty-setup-complete && {command}" : command]);
                await recordResource(resource);
                var created = await Run(args, ct, environment);
                resource = resource with { EngineId = EngineIdentity(created.StandardOutput) };
                await recordResource(resource);
                resource = await CaptureConfiguration(instance, resource, ct);
                await recordResource(resource);
                await Run(["start", resource.Id], ct);
            }
            store.RequireNotRevoked(instance.Id);
            var relay = Resource(instance, "container", "relay");
            var relayArgs = new List<string> { "create", "--name", relay.Id };
            relayArgs.AddRange(Labels(instance, relay.Generation));
            relayArgs.AddRange(Limits(268435456, .25, 64, 33554432, "1000:1000"));
            relayArgs.AddRange(["--network", outer.Id, "--sysctl", "net.ipv4.ip_forward=0", "-p", $"127.0.0.1:{port}:8091",
                "--mount", Bind(relayFile, "/run/hosty/relay.json", true), "-e", "HOSTY_SANDBOX_SERVICE_TOKEN", policy.RelayImage]);
            await recordResource(relay);
            var createdRelay = await Run(relayArgs, ct, new Dictionary<string, string> { ["HOSTY_SANDBOX_SERVICE_TOKEN"] = token });
            relay = relay with { EngineId = EngineIdentity(createdRelay.StandardOutput) };
            await recordResource(relay);
            await RequireOwned(instance, relay, ct);
            await Run(["network", "connect", "--alias", "sandbox-core", inner.Id, relay.Id], ct);
            await Run(["network", "connect", "--ip", browserAddress, browserNetwork.Id, relay.Id], ct);
            relay = await CaptureConfiguration(instance, relay, ct);
            await recordResource(relay);
            await Run(["start", relay.Id], ct);
            var relayState = (await RequireOwned(instance, relay, ct))!.Value;
            if (relayState.GetProperty("NetworkSettings").GetProperty("Networks").GetProperty(browserNetwork.Id).GetProperty("IPAddress").GetString() != browserAddress)
                throw Error("sandbox_browser_network_unknown", "Docker did not apply the reserved private browser address.");
            // A setup timeout is distinct from the subsequent HTTP readiness budget. The marker
            // lives only in bounded container tmpfs; it grants no authority or host access.
            using (var setupDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                setupDeadline.CancelAfter(TimeSpan.FromMinutes(10));
                try
                {
                    foreach (var service in ordered.Where(s => !string.IsNullOrEmpty(s.Runtime.Setup)))
                    {
                        var resource = Resource(instance, "container", service.Key);
                        while (true)
                        {
                            store.RequireNotRevoked(instance.Id);
                            var state = await RequireOwned(instance, resource, setupDeadline.Token);
                            if (state is null || !state.Value.GetProperty("State").GetProperty("Running").GetBoolean())
                                throw Error("sandbox_setup_failed", "A service stopped before its offline setup completed.");
                            var result = await docker.RunAsync(["exec", resource.Id, "test", "-f", "/tmp/hosty-setup-complete"], null, setupDeadline.Token);
                            if (result.ExitCode == 0) break;
                            await Task.Delay(500, setupDeadline.Token);
                        }
                    }
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                { throw Error("sandbox_setup_timeout", "Offline setup did not complete within ten minutes."); }
            }
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(limits.StartupSeconds));
            try
            {
                while (true)
                {
                    store.RequireNotRevoked(instance.Id);
                    var ready = await ObserveServices(instance, ordered.Select(s => Resource(instance, "container", s.Key)).Append(relay), deadline.Token) == "ready";
                    foreach (var endpoint in endpoints)
                    {
                        try
                        {
                            using var request = new HttpRequestMessage(HttpMethod.Get, $"http://127.0.0.1:{port}/_hosty/healthz");
                            request.Headers.Host = endpoint.Host;
                            using var response = await probes.SendAsync(request, deadline.Token);
                            ready &= response.IsSuccessStatusCode;
                        }
                        catch (HttpRequestException) { ready = false; }
                        catch (OperationCanceledException) when (!deadline.IsCancellationRequested) { ready = false; }
                    }
                    if (ready) break;
                    await Task.Delay(250, deadline.Token);
                }
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            { throw Error("sandbox_readiness_timeout", "The declared services and preview did not become ready within the startup budget."); }
            return new(preview.Url, "http://" + authHost, publicEndpoints, "http://" + browserAddress + ":8092");
        }
        finally { admission.Release(); }
    }

    internal async Task<SandboxResource> CreateBrowserAsync(SandboxInstance instance, string jobId,
        Func<SandboxResource, Task> record, CancellationToken ct)
    {
        await admission.WaitAsync(ct);
        try
        {
            var policy = await JsonStorage.ReadAsync<SandboxRuntimePolicy>(Path.Combine(store.Root, "runtime.json"), ct)
                ?? throw Error("sandbox_runtime_not_prepared", "Prepare the trusted browser runtime first.");
            if (!ValidImage(policy.BrowserImage) || instance.BrowserProxy is null)
                throw Error("sandbox_browser_not_prepared", "The pinned browser image or private proxy is unavailable.");
            await Admit(instance, policy, record, ct, browser: true);
            var network = instance.Resources.SingleOrDefault(r => r.Kind == "network" && r.Service == "browser-network")
                ?? throw Error("sandbox_browser_network_unknown", "The dedicated browser network is missing.");
            await VerifyNetwork(network, instance, ct);
            var profile = Path.Combine(store.Root, "browser-seccomp.json");
            await using (var resource = typeof(SandboxDockerRuntime).Assembly.GetManifestResourceStream("Hosty.SandboxBrowser.seccomp.json")!)
            await using (var file = File.Create(profile)) await resource.CopyToAsync(file, ct);
            var worker = Resource(instance, "container", "browser-" + jobId);
            var args = new List<string> { "create", "--name", worker.Id, "--interactive", "--init" };
            args.AddRange(Labels(instance, worker.Generation));
            args.AddRange(Limits(1610612736, 1, 256, 268435456, "1000:1000"));
            args.AddRange(["--ipc", "private", "--shm-size", "268435456", "--security-opt", "seccomp=" + profile,
                "--network", network.Id, "--dns", "127.0.0.1", policy.BrowserImage!]);
            await record(worker);
            var created = await Run(args, ct);
            worker = worker with { EngineId = EngineIdentity(created.StandardOutput) };
            await record(worker); await RequireOwned(instance, worker, ct);
            return worker;
        }
        finally { admission.Release(); }
    }
    internal async Task RemoveBrowserAsync(SandboxInstance instance, SandboxResource worker, CancellationToken ct)
    {
        var scoped = instance with { Resources = [worker] };
        await StopAsync(scoped, ct); await RemoveAsync(scoped, ct);
    }

    public async Task StopAsync(SandboxInstance instance, CancellationToken ct)
    {
        foreach (var resource in instance.Resources.Reverse().Where(r => r.Kind == "container"))
        {
            if (await RequireOwned(instance, resource, ct) is null) continue;
            await Run(["stop", "--time", "10", resource.Id], ct);
            var stopped = await RequireOwned(instance, resource, ct);
            if (stopped is { } value && value.GetProperty("State").GetProperty("Running").GetBoolean())
                throw Error("sandbox_stop_unverified", "A sandbox consumer is still running; cleanup is blocked.");
        }
    }

    public async Task RemoveAsync(SandboxInstance instance, CancellationToken ct)
    {
        foreach (var resource in instance.Resources.Reverse().OrderBy(r => r.Kind == "network" ? 1 : 0))
        {
            var state = await RequireOwned(instance, resource, ct);
            if (state is null) continue;
            if (resource.Kind == "container" && state.Value.GetProperty("State").GetProperty("Running").GetBoolean())
                throw Error("sandbox_cleanup_blocked", "Verify stopped consumers before removing resources.");
            await Run([resource.Kind, "rm", resource.Id], ct);
            if (await RequireOwned(instance, resource, ct) is not null)
                throw Error("sandbox_cleanup_unverified", "A sandbox resource remains after removal.");
        }
    }

    public async Task<string> ObserveAsync(SandboxInstance instance, CancellationToken ct)
    {
        foreach (var network in instance.Resources.Where(r => r.Kind == "network"))
        {
            var state = await RequireOwned(instance, network, ct);
            if (state is null) return "unknown";
            RequireConfiguration(network, state.Value);
        }
        return await ObserveServices(instance, instance.Resources.Where(r => r.Kind == "container" && r.Service is not null
            && !r.Service.StartsWith("browser-", StringComparison.Ordinal) && !r.Service.StartsWith("probe-", StringComparison.Ordinal)), ct);
    }

    public async Task<long?> VmFreeBytesAsync(SandboxInstance instance, CancellationToken ct)
    {
        var relay = instance.Resources.SingleOrDefault(r => r.Kind == "container" && r.Service == "relay");
        if (relay is null) return null;
        var state = await RequireOwned(instance, relay, ct);
        if (state is null || !state.Value.GetProperty("State").GetProperty("Running").GetBoolean()) return null;
        var result = await Run(["exec", relay.Id, "/usr/local/bin/node", "-e",
            "const s=require('node:fs').statfsSync('/');process.stdout.write(String(s.bavail*s.bsize))"], ct);
        return long.TryParse(result.StandardOutput.Trim(), out var free) ? free
            : throw Error("sandbox_storage_observation_unknown", "Docker VM free storage could not be measured.");
    }

    public async Task<SandboxMetrics?> MetricsAsync(SandboxInstance instance, CancellationToken ct)
    {
        var live = new List<SandboxResource>();
        foreach (var resource in instance.Resources.Where(r => r.Kind == "container"))
        {
            var state = await RequireOwned(instance, resource, ct);
            if (state is { } current && current.GetProperty("State").GetProperty("Running").GetBoolean()) live.Add(resource);
        }
        if (live.Count == 0) return new(DateTimeOffset.UtcNow, [], 0, instance.Metrics?.SampledPeakMemoryBytes);
        var args = new List<string> { "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}" };
        args.AddRange(live.Select(r => r.EngineId ?? r.Id));
        var stats = DockerStatsParser.Parse((await Run(args, ct)).StandardOutput);
        var services = live.Select(r => { var stat = stats.SingleOrDefault(s => s.ContainerName == r.Id);
            return new SandboxServiceMetrics(r.Service ?? "service", stat?.MemoryBytes, stat?.CpuPercent); }).ToArray();
        double? total = services.All(s => s.MemoryBytes is not null) ? services.Sum(s => s.MemoryBytes!.Value) : null;
        return new(DateTimeOffset.UtcNow, services, total, total is { } bytes ? Math.Max(bytes, instance.Metrics?.SampledPeakMemoryBytes ?? 0) : instance.Metrics?.SampledPeakMemoryBytes);
    }

    private async Task<string> ObserveServices(SandboxInstance instance, IEnumerable<SandboxResource> resources, CancellationToken ct)
    {
        var all = resources.ToArray(); if (all.Length == 0) return "stopped";
        foreach (var resource in all)
        {
            var value = await RequireOwned(instance, resource, ct);
            if (value is null) return "unknown";
            var recorded = resource.ConfigurationDigest is not null ? resource
                : (await store.ReadAsync(instance.Id, ct))?.Resources.SingleOrDefault(r => r.Kind == resource.Kind && r.Id == resource.Id) ?? resource;
            RequireConfiguration(recorded, value.Value);
            var state = value.Value.GetProperty("State");
            if (state.TryGetProperty("OOMKilled", out var oom) && oom.GetBoolean()) return "unhealthy";
            if (!state.GetProperty("Running").GetBoolean()) return "stopped";
            if (state.TryGetProperty("Health", out var health) && health.GetProperty("Status").GetString() != "healthy") return "starting";
        }
        return "ready";
    }

    private async Task Admit(SandboxInstance instance, SandboxRuntimePolicy policy, Func<SandboxResource, Task> record, CancellationToken ct, bool browser = false)
    {
        var daemon = await Run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], ct);
        if (!daemon.StandardOutput.Trim().StartsWith("unix://", StringComparison.Ordinal)
            || Environment.GetEnvironmentVariable("DOCKER_HOST") is { Length: > 0 } host && !host.StartsWith("unix://", StringComparison.Ordinal))
            throw Error("sandbox_daemon_unsupported", "Sandbox source execution requires the local Docker Desktop engine.");
        var info = await Run(["info", "--format", "{{json .}}"], ct);
        using var document = JsonDocument.Parse(info.StandardOutput);
        if (!document.RootElement.GetProperty("OperatingSystem").GetString()!.Contains("Docker Desktop", StringComparison.Ordinal))
            throw Error("sandbox_daemon_unsupported", "The selected engine has no verified local sandbox profile.");
        var running = (await store.ListAsync(ct)).Where(i => (browser || i.Id != instance.Id) && i.State is "ready" or "starting" or "unhealthy" or "stopping" or "unknown").ToArray();
        if (!browser && running.Length >= policy.MaxRunningInstances) throw Error("sandbox_concurrency_exceeded", "Stop a running sandbox before starting another; this profile has no queue.");
        var reserved = running.Sum(i => (i.Request.Limits ?? new()).MemoryBytes + 268435456)
            + (browser ? 1610612736 : (instance.Request.Limits ?? new()).MemoryBytes + 268435456) + policy.ReservedAgentBytes + 2 * GiB;
        var live = await Run(["ps", "--quiet", "--no-trunc"], ct);
        foreach (var id in live.StandardOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var inspected = await Run(["container", "inspect", id], ct);
            using var parsed = JsonDocument.Parse(inspected.StandardOutput);
            var item = parsed.RootElement[0];
            // App/relay ceilings are already reserved above. Browser/probe containers are
            // additional consumers, even when they belong to that same sandbox. Labels alone
            // cannot exclude an unrelated running workload from the host budget.
            if (CoveredByAppReservation(running, item.GetProperty("Id").GetString()!)) continue;
            var memory = item.GetProperty("HostConfig").GetProperty("Memory").GetInt64();
            if (memory <= 0) throw Error("resource_budget_unknown", "A running Docker workload has no memory ceiling; its reservation must be coordinated before sandbox admission.");
            reserved += memory;
        }
        if (reserved > document.RootElement.GetProperty("MemTotal").GetInt64())
            throw Error("resource_budget_exceeded", $"The local sandbox profile requires {reserved} bytes including existing workloads and 2 GiB headroom.");
        var disk = new DriveInfo(Path.GetPathRoot(store.TemporaryRoot)!);
        if (disk.AvailableFreeSpace < 20 * GiB) throw Error("storage_budget_exceeded", "Sandbox admission requires 20 GiB free on the host data filesystem.");
        // Even read-only capacity probes are instance-owned, journaled resources. A crash
        // between create/start/remove retains enough identity for ordinary disposal.
        var probe = Resource(instance, "container", "probe-disk");
        var args = new List<string> { "create", "--name", probe.Id };
        args.AddRange(Labels(instance, probe.Generation));
        args.AddRange(Limits(67108864, .1, 16, 1048576, "1000:1000"));
        args.AddRange(["--network", "none", "--entrypoint", "node", policy.RelayImage, "-e",
            "const s=require('node:fs').statfsSync('/');process.stdout.write(String(s.bavail*s.bsize))"]);
        await record(probe);
        var created = await Run(args, ct);
        probe = probe with { EngineId = EngineIdentity(created.StandardOutput) };
        await record(probe); await RequireOwned(instance, probe, ct);
        try
        {
            var free = await Run(["start", "--attach", probe.Id], ct);
            if (!long.TryParse(free.StandardOutput.Trim(), out var available) || available < 20 * GiB)
                throw Error("storage_budget_exceeded", "Sandbox admission requires an observed 20 GiB free on the Docker VM disk.");
        }
        finally
        {
            using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var scoped = instance with { Resources = [probe] };
            await StopAsync(scoped, cleanup.Token); await RemoveAsync(scoped, cleanup.Token);
        }
    }

    internal static bool CoveredByAppReservation(IEnumerable<SandboxInstance> instances, string engineId)
        => instances.Any(instance => instance.Resources.Any(resource => resource.Kind == "container" && resource.EngineId == engineId
            && resource.Service is not null && !resource.Service.StartsWith("browser-", StringComparison.Ordinal)
            && !resource.Service.StartsWith("probe-", StringComparison.Ordinal)));

    private async Task Create(SandboxResource resource, List<string> args, SandboxInstance instance, Func<SandboxResource, Task> record, CancellationToken ct)
    {
        args.AddRange(Labels(instance, resource.Generation)); args.Add(resource.Id);
        await record(resource); var created = await Run(args, ct);
        resource = resource with { EngineId = EngineIdentity(created.StandardOutput) };
        await record(resource);
        resource = await CaptureConfiguration(instance, resource, ct);
        await record(resource);
    }
    private async Task<SandboxResource> CaptureConfiguration(SandboxInstance instance, SandboxResource resource, CancellationToken ct)
    {
        var inspected = await RequireOwned(instance, resource, ct)
            ?? throw Error("sandbox_creation_unverified", "A newly created resource disappeared before its configuration was recorded.");
        return resource with { ConfigurationDigest = ConfigurationDigest(resource.Kind, inspected) };
    }
    internal static void RequireConfiguration(SandboxResource resource, JsonElement inspected)
    {
        if (resource.ConfigurationDigest is null || resource.ConfigurationDigest != ConfigurationDigest(resource.Kind, inspected))
            throw Error("sandbox_configuration_changed", "The recorded isolation configuration cannot be verified; stop or recreate this instance.");
    }
    internal static string ConfigurationDigest(string kind, JsonElement inspected)
    {
        // Persist only the digest. Config contains service credentials; it is never an API field.
        // Exclude process state, counters, dynamically assigned addresses and network members.
        var fields = kind == "container"
            ? new[] { "Image", "Config", "HostConfig", "Mounts" }
            : new[] { "Driver", "Internal", "EnableIPv6", "Options", "IPAM", "Labels" };
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (var field in fields) { writer.WritePropertyName(field); WriteCanonical(writer, inspected.GetProperty(field), normalizeOomDefault: field == "HostConfig"); }
            if (kind == "container")
            {
                // Docker fills NetworkID only on start. Network resource IDs are verified
                // independently; this digest protects the container's attachment names.
                writer.WriteStartArray("Networks");
                foreach (var network in inspected.GetProperty("NetworkSettings").GetProperty("Networks").EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
                    writer.WriteStringValue(network.Name);
                writer.WriteEndArray();
            }
            writer.WriteEndObject();
        }
        return SandboxValidation.Hash(System.Text.Encoding.UTF8.GetString(stream.ToArray()));
    }
    private static void WriteCanonical(Utf8JsonWriter writer, JsonElement value, bool normalizeOomDefault = false)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            writer.WriteStartObject();
            foreach (var property in value.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal))
            {
                writer.WritePropertyName(property.Name);
                // The tested engine normalizes its create-time null to false at start.
                if (normalizeOomDefault && property.Name == "OomKillDisable" && property.Value.ValueKind == JsonValueKind.Null)
                    writer.WriteBooleanValue(false);
                else WriteCanonical(writer, property.Value);
            }
            writer.WriteEndObject();
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            writer.WriteStartArray(); foreach (var item in value.EnumerateArray()) WriteCanonical(writer, item); writer.WriteEndArray();
        }
        else value.WriteTo(writer);
    }

    private async Task VerifyNetwork(SandboxResource resource, SandboxInstance instance, CancellationToken ct)
    {
        var value = (await RequireOwned(instance, resource, ct))!.Value;
        if (!value.GetProperty("Internal").GetBoolean() || value.GetProperty("EnableIPv6").GetBoolean()
            || value.GetProperty("Options").GetProperty("com.docker.network.bridge.gateway_mode_ipv4").GetString() != "isolated")
            throw Error("sandbox_network_unsupported", "Docker did not create the required isolated network.");
    }
    private async Task<JsonElement?> RequireOwned(SandboxInstance instance, SandboxResource resource, CancellationToken ct)
    {
        if (resource.Kind is not ("container" or "network")) throw Error("sandbox_resource_invalid", "Unknown sandbox resource kind.");
        var result = await docker.RunAsync([resource.Kind, "inspect", resource.Id], null, ct);
        if (result.ExitCode != 0)
        {
            if (IsMissingResource(result.StandardError, resource)) return null;
            throw Error("sandbox_observation_unknown", "Docker resource ownership could not be observed.");
        }
        using var document = JsonDocument.Parse(result.StandardOutput);
        var value = document.RootElement[0];
        var bound = resource.EngineId ?? instance.Resources.FirstOrDefault(r => r.Id == resource.Id && r.Kind == resource.Kind)?.EngineId;
        // The callback durably records creation before callers observe an older local snapshot.
        // A name/label-only intent after a crash is not proof that this is the resource we created.
        bound ??= (await store.ReadAsync(instance.Id, ct))?.Resources.FirstOrDefault(r => r.Id == resource.Id && r.Kind == resource.Kind)?.EngineId;
        if (bound is null)
            throw Error("sandbox_creation_unverified", "Creation has no recorded engine identity; preserve the resource for explicit reconciliation.");
        if (value.GetProperty("Id").GetString() != bound)
            throw Error("sandbox_ownership_mismatch", "The named resource was replaced; preserve it for explicit reconciliation.");
        var labels = resource.Kind == "container" ? value.GetProperty("Config").GetProperty("Labels") : value.GetProperty("Labels");
        foreach (var pair in Ownership(instance, resource.Generation))
            if (!labels.TryGetProperty(pair.Key, out var actual) || actual.GetString() != pair.Value)
                throw Error("sandbox_ownership_mismatch", "Resource ownership differs from the journal; automatic cleanup is blocked.");
        return value.Clone();
    }
    private IEnumerable<KeyValuePair<string, string>> Ownership(SandboxInstance instance, string generation)
        => new Dictionary<string, string> { ["hosty.instance"] = config.InstanceId, ["hosty.sandbox"] = instance.Id,
            ["hosty.sandbox.generation"] = generation, ["hosty.app"] = instance.Input.AppId, ["hosty.sandbox.owner"] = instance.Owner.Key };
    private IEnumerable<string> Labels(SandboxInstance instance, string generation)
        => Ownership(instance, generation).SelectMany(pair => new[] { "--label", pair.Key + "=" + pair.Value });
    private static SandboxResource Resource(SandboxInstance instance, string kind, string service)
        => new(kind, "hosty-sb-" + instance.Id + "-" + instance.Generation + "-" + service, instance.Generation, service);
    internal static string BrowserRelayAddress(string? subnet)
    {
        var parts = subnet?.Split('/');
        if (parts is not { Length: 2 } || !IPAddress.TryParse(parts[0], out var network)
            || network.AddressFamily != AddressFamily.InterNetwork || !int.TryParse(parts[1], out var bits) || bits is < 8 or > 30)
            throw Error("sandbox_browser_network_unknown", "The browser network has an unsupported address range.");
        var bytes = network.GetAddressBytes();
        var value = System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(bytes);
        var mask = uint.MaxValue << (32 - bits);
        if ((value & mask) != value) throw Error("sandbox_browser_network_unknown", "The network address is not canonical.");
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes, value + 2);
        return new IPAddress(bytes).ToString();
    }

    internal static string[] Limits(long memory, double cpus, int pids, long scratch, string user)
        => ["--user", user, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", memory.ToString(CultureInfo.InvariantCulture),
            "--memory-swap", memory.ToString(CultureInfo.InvariantCulture), "--cpus", cpus.ToString(CultureInfo.InvariantCulture), "--pids-limit", pids.ToString(CultureInfo.InvariantCulture),
            "--tmpfs", $"/tmp:rw,nosuid,nodev,size={scratch},mode=1777", "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
            "--log-driver", "local", "--log-opt", "max-size=10m", "--log-opt", "max-file=3"];
    private void AddData(SandboxInstance instance, RuntimeSelectedService service, RuntimeAppDataTarget? target, string area,
        List<string> args, Dictionary<string, string> environment)
    {
        if (target is null || target.Service is { Length: > 0 } selected && selected != service.Key) return;
        var path = target.ContainerPath ?? "/app/" + area;
        args.AddRange(["--mount", Bind(store.DataPath(instance.Id, area), path)]);
        environment[target.Environment ?? (area == "data" ? "HOSTY_APP_DATA_DIR" : "HOSTY_APP_CACHE_DIR")] = path;
    }
    private static string Contained(string root, string path)
        => CoreDataPaths.TryResolveContainedRelativePath(root, path, out var full) && !CoreDataPaths.ContainsSymbolicLink(root, full)
            ? full : throw Error("sandbox_path_invalid", "A sandbox source/cache path escaped its authorized root.");
    private static string Bind(string source, string target, bool readOnly = false)
    {
        if (source.Contains(',') || target.Contains(',') || source.Any(char.IsControl) || target.Any(char.IsControl))
            throw Error("sandbox_path_invalid", "The selected mount cannot be represented safely.");
        return $"type=bind,source={source},target={target}" + (readOnly ? ",readonly" : "");
    }
    private static int ReservePort()
    { using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp); socket.Bind(new IPEndPoint(IPAddress.Loopback, 0)); return ((IPEndPoint)socket.LocalEndPoint!).Port; }
    private async Task<DockerCommandResult> Run(IReadOnlyList<string> args, CancellationToken ct, IReadOnlyDictionary<string, string>? environment = null)
    {
        var result = await docker.RunAsync(args, environment, ct);
        if (result.ExitCode != 0) throw Error("sandbox_docker_failed", "Docker rejected a sandbox resource operation; recorded resources are retained for reconciliation.");
        return result;
    }
    private static string EngineIdentity(string output)
    {
        var id = output.Trim();
        if (id.Length != 64 || !id.All(char.IsAsciiHexDigit)) throw Error("sandbox_creation_unknown", "Docker did not return an immutable resource identity.");
        return id;
    }
    internal static bool ValidImage(string? image) => image is { Length: 71 } && image.StartsWith("sha256:", StringComparison.Ordinal)
        && image[7..].All(char.IsAsciiHexDigit);
    internal static bool IsMissingResource(string error, SandboxResource resource)
        => error.Trim().Equals($"Error response from daemon: No such {resource.Kind}: {resource.Id}", StringComparison.OrdinalIgnoreCase)
            || (resource.Kind == "network" && error.Trim().Equals($"Error response from daemon: network {resource.Id} not found", StringComparison.OrdinalIgnoreCase));
    private static SandboxException Error(string code, string message) => new(code, message);
    [DllImport("libc", EntryPoint = "geteuid")] private static extern uint GetUserId();
    [DllImport("libc", EntryPoint = "getegid")] private static extern uint GetGroupId();
}
