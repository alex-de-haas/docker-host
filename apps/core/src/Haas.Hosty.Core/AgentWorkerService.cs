using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core.Features;

namespace Haas.Hosty.Core;

internal sealed record AgentWorkerManifest(string Service, string Image);
internal sealed record AgentWorkerMount(string Source, bool Readonly = false);
internal sealed record AgentWorkerRequest(string? Generation = null, string? ImageId = null,
    AgentWorkerMount[]? Mounts = null, string[]? Paths = null);
internal sealed record AgentWorkerOutput(string Output);
internal sealed record AgentWorkerExec(string Generation, string Provider, string[] Arguments,
    string Cwd, Dictionary<string, string> Environment);
internal sealed record AgentWorkerFrame(string Kind, string? Data = null, int? Code = null);

// The coordinator never receives Docker control. All host paths, image references, ownership,
// resource limits and network placement are resolved here from the installed application.
internal sealed class AgentWorkerService(CoreDataPaths paths, HostyCoreRuntimeConfig config,
    AppRegistryStore apps, AppManifestService manifests, AppServiceTokenService tokens,
    IDockerCommandRunner? commandRunner = null)
{
    private readonly IDockerCommandRunner docker = commandRunner ?? new ProcessDockerCommandRunner();
    private readonly ConcurrentDictionary<string, SemaphoreSlim> locks = new(StringComparer.Ordinal);
    private const string Label = "hosty.agent-worker";
    private static AppLifecycleException Error(string message) => new("agent_worker_unavailable", message);
    private string AppRoot(string appId) => CoreDataPaths.ResolveContainedPath(Path.Combine(MountPathPolicy.ResolveRealPath(paths.DataRoot), "apps"), appId);
    private string Instance => DevelopmentWorkspaceService.Hash(MountPathPolicy.ResolveRealPath(paths.DataRoot));
    private static string Installation(AppRecord app) => DevelopmentWorkspaceService.Hash(app.Id + "\n" + app.InstalledAt.ToString("O"));
    private string Name(AppRecord app, string generation) => $"hosty-agent-{Instance[..12]}-{Installation(app)[..12]}-{Generation(generation)}";
    private static string Generation(string? value) => Guid.TryParseExact(value, "D", out var id)
        ? id.ToString("D") : throw Error("A worker generation UUID is required.");

    internal async Task<AppRecord> AuthenticateAsync(string appId, HttpRequest request, CancellationToken ct)
    {
        if (!tokens.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? ""))
            throw new AppIdentityException("token_invalid", "An app service token is required.");
        var app = await apps.GetAppAsync(appId, ct) ?? throw Error("The assistant is not installed.");
        if (app.GrantedCorePermissions?.Contains(CoreAppPermissions.Sources, StringComparer.Ordinal) != true
            || app.ConfirmedRoles?.Contains("assistant", StringComparer.Ordinal) != true)
            throw new AppIdentityException("app_permission_required", "A reviewed assistant with source authority is required.");
        return app;
    }

    private async Task<AgentWorkerManifest> Declaration(AppRecord app, CancellationToken ct)
    {
        var selection = await manifests.LoadAsync(app.ManifestPath!, app.SelectedRuntime, ct);
        var worker = selection.Manifest.AgentWorker ?? throw Error("This application does not declare an agent worker.");
        if (!selection.Services.Any(s => s.Key == worker.Service && s.Runtime.Type == "docker"))
            throw Error("The selected runtime does not use a Docker coordinator.");
        return worker;
    }

    private async Task<string> Run(IReadOnlyList<string> args, CancellationToken ct)
    {
        var result = await docker.RunBoundedAsync(args, 2_000_000, ct);
        if (result.ExitCode != 0)
        {
            // This runner handles only control/accounting commands. Provider execution and its
            // secret-bearing streams use the separate transport below.
            var detail = result.StandardError.Trim();
            if (detail.Length > 2048) detail = detail[..2048];
            throw Error($"Docker {args[0]} failed (exit {result.ExitCode}). {detail}");
        }
        return result.StandardOutput.Trim();
    }

    private async Task RequireLocalEngine(CancellationToken ct)
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux())
            throw Error("Shared workers require a macOS or Linux host.");
        var endpoint = await Run(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], ct);
        var overridden = Environment.GetEnvironmentVariable("DOCKER_HOST");
        if (!endpoint.StartsWith("unix://", StringComparison.Ordinal)
            || overridden is not null && !overridden.StartsWith("unix://", StringComparison.Ordinal)
            || await Run(["info", "--format", "{{.OSType}}"], ct) != "linux")
            throw Error("Shared workers require a local Linux Docker engine.");
    }

    private async Task RequireLease(AppRecord app, string generation, CancellationToken ct)
    {
        var file = Path.Combine(paths.CoreRoot, "development", "worker-leases", Generation(generation) + ".json");
        var lease = await JsonStorage.ReadAsync<DevelopmentWorkerLease>(file, ct);
        if (lease is not { Active: true } || lease.Owner.IsExternal || lease.Owner.AppId != app.Id
            || lease.Owner.Installation != app.InstalledAt)
            throw Error("The worker needs an active lease belonging to this assistant installation.");
    }

    internal static string Canonical(string value)
    {
        if (!Path.IsPathFullyQualified(value) || Path.GetFullPath(value) != value
            || value == "/" || value.IndexOfAny([',', '\r', '\n', '\0']) >= 0
            || !Directory.Exists(value) || MountPathPolicy.ResolveRealPath(value) != value)
            throw Error("Worker mounts must be existing canonical directories without symbolic redirects.");
        return value;
    }

    internal static bool Beneath(string value, string root) => value.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal);

    private string[] SourceRoots() => [
        Canonical(Path.Combine(MountPathPolicy.ResolveRealPath(paths.DataRoot), "core", "development", "trees")),
        Canonical(Path.Combine(MountPathPolicy.ResolveRealPath(paths.DataRoot), "core", "development", "repositories"))];

    private string AllowedPrivatePath(AppRecord app, string value)
    {
        var root = AppRoot(app.Id);
        Canonical(value);
        if (!Beneath(value, Path.Combine(root, "cache", "sessions"))
            && !Beneath(value, Path.Combine(root, "cache", "agent-docker-providers"))
            && !Beneath(value, Path.Combine(root, "data", "provider-sessions")))
            throw Error("The worker path is outside this assistant's session and provider directories.");
        return value;
    }

    private async Task<string?> Inspect(AppRecord app, string generation, CancellationToken ct)
    {
        var name = Name(app, generation);
        var ids = (await Run(["ps", "-a", "--filter", $"name=^/{name}$", "--format", "{{.ID}}"], ct))
            .Split('\n', StringSplitOptions.RemoveEmptyEntries);
        if (ids.Length == 0) return null;
        if (ids.Length != 1) throw Error("Worker inventory is ambiguous.");
        var json = await Run(["inspect", ids[0]], ct);
        using var document = JsonDocument.Parse(json);
        var item = document.RootElement[0];
        var labels = item.GetProperty("Config").GetProperty("Labels");
        if (item.GetProperty("Name").GetString() != "/" + name
            || Read(labels, Label) != "1" || Read(labels, Label + ".instance") != Instance
            || Read(labels, Label + ".installation") != Installation(app)
            || Read(labels, Label + ".generation") != generation)
            throw Error("The worker name belongs to another container. It was preserved.");
        return json;
    }
    private static string? Read(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) ? value.GetString() : null;

    internal async Task<string> ExecuteAsync(AppRecord app, string operation, AgentWorkerRequest input, CancellationToken ct)
    {
        var gate = locks.GetOrAdd(app.Id, _ => new(1));
        await gate.WaitAsync(ct);
        try
        {
            var declaration = await Declaration(app, ct);
            await RequireLocalEngine(ct);
            if (operation == "info") return await Run(["info", "--format", "{{json .}}"], ct);
            if (operation == "context") return "unix://core-managed";
            if (operation == "image") return await Run(["image", "inspect", declaration.Image], ct);
            if (operation == "pull") return await Run(["pull", declaration.Image], ct);
            var generation = Generation(input.Generation);
            var name = Name(app, generation);
            if (operation == "create")
            {
                await RequireLease(app, generation, ct);
                if (await Inspect(app, generation, ct) is not null) throw Error("This worker generation already exists; reconcile it before retrying.");
                var owned = await Run(["ps", "-a", "--filter", $"label={Label}.instance={Instance}",
                    "--filter", $"label={Label}.installation={Installation(app)}", "--format", "{{.ID}}"], ct);
                if (owned.Length != 0) throw Error("Another worker generation requires recovery.");
                using var image = JsonDocument.Parse(await Run(["image", "inspect", declaration.Image], ct));
                var imageId = image.RootElement[0].GetProperty("Id").GetString()!;
                if (imageId != input.ImageId) throw Error("The prepared worker image changed. Retry preparation.");
                var coordinator = DockerRuntimeAdapter.BuildContainerName(config.InstanceId, app.Id, declaration.Service);
                using var container = JsonDocument.Parse(await Run(["inspect", coordinator], ct));
                var coordinatorLabels = container.RootElement[0].GetProperty("Config").GetProperty("Labels");
                if (Read(coordinatorLabels, "hosty.instance") != config.InstanceId
                    || Read(coordinatorLabels, "hosty.app.id") != app.Id
                    || !container.RootElement[0].GetProperty("State").GetProperty("Running").GetBoolean())
                    throw Error("The owning coordinator is not running.");
                // The worker is an additional owned container, including inside a child Core.
                // Reserve its share without excluding the coordinator from the same app's usage.
                using var admission = await CoreEnvironmentResources.AdmitAsync(config, docker, app.Id, 1, ct,
                    replacementServices: new HashSet<string>(StringComparer.Ordinal) { "agent-worker" });
                var sources = SourceRoots();
                var home = Canonical(Path.Combine(AppRoot(app.Id), "cache", "agent-worker", generation, "home"));
                var cache = Canonical(Path.Combine(AppRoot(app.Id), "cache", "agent-worker", "cache"));
                var args = new List<string> {
                    "create", "--name", name, "--init", "--restart", "no", "--read-only",
                    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                    "--tmpfs", "/tmp:rw,nosuid,nodev,size=536870912,mode=1777",
                    "--network", "container:" + coordinator, "--user", await HostUser(ct),
                    "--label", Label + "=1", "--label", Label + ".instance=" + Instance,
                    "--label", Label + ".installation=" + Installation(app), "--label", Label + ".generation=" + generation,
                    "--label", "hosty.resource-role=agent", "--label", "hosty.instance=" + config.InstanceId,
                    "--label", "hosty.app.id=" + app.Id, "--label", "hosty.app.service=agent-worker",
                    "--mount", $"type=bind,src={home},dst=/worker/home",
                    "--mount", $"type=bind,src={cache},dst=/worker/cache",
                    "--mount", $"type=bind,src={sources[0]},dst={sources[0]}",
                    "--mount", $"type=bind,src={sources[1]},dst={sources[1]},readonly"
                };
                args.AddRange(admission?.Arguments ?? [
                    "--cpus", "2", "--memory", "4294967296", "--memory-swap", "4294967296", "--pids-limit", "512",
                    "--log-driver", "json-file", "--log-opt", "max-size=5m", "--log-opt", "max-file=2"]);
                if (input.Mounts is null || input.Mounts.Length > 16) throw Error("Invalid worker storage bindings.");
                foreach (var mount in input.Mounts)
                {
                    if (sources.Contains(mount.Source, StringComparer.Ordinal)) continue;
                    var source = AllowedPrivatePath(app, mount.Source);
                    args.AddRange(["--mount", $"type=bind,src={source},dst={source}" + (mount.Readonly ? ",readonly" : "")]);
                }
                args.Add(imageId);
                return await Run(args, ct);
            }
            var inspection = await Inspect(app, generation, ct);
            if (operation == "inventory")
            {
                if (inspection is null) return "";
                using var item = JsonDocument.Parse(inspection);
                return item.RootElement[0].GetProperty("Id").GetString()!;
            }
            if (operation == "inspect") return inspection ?? throw Error("The worker no longer exists.");
            if (inspection is null && operation is "stop" or "remove") return "";
            if (inspection is null) throw Error("The worker no longer exists.");
            switch (operation)
            {
                case "start":
                    await RequireLease(app, generation, ct);
                    return await Run(["start", name], ct);
                case "stop": return await Run(["stop", "--time", "10", name], ct);
                case "remove": return await Run(["rm", name], ct);
                case "usage": return await Run(["exec", name, "cat", "/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/pids.current"], ct);
                case "disk":
                    if (input.Paths is null || input.Paths.Length > 32) throw Error("Invalid accounting paths.");
                    var roots = SourceRoots();
                    foreach (var path in input.Paths)
                        if (path is not "/worker/home" and not "/worker/cache" && !roots.Contains(path, StringComparer.Ordinal))
                            AllowedPrivatePath(app, path);
                    return await Run(["exec", name, "du", "-sk", "--", ..input.Paths], ct);
                default: throw Error("Unknown worker operation.");
            }
        }
        finally { gate.Release(); }
    }

    internal static async Task<string> HostUser(CancellationToken ct)
    {
        async Task<string> Id(string flag)
        {
            var start = new ProcessStartInfo("id"); start.ArgumentList.Add(flag);
            var result = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(5), ct);
            var value = result.StandardOutput.Trim();
            if (result.ExitCode != 0 || !uint.TryParse(value, out _)) throw Error("Cannot determine the host execution identity.");
            return value;
        }
        return await Id("-u") + ":" + await Id("-g");
    }

    internal async Task PrepareImageAsync(AgentWorkerManifest declaration, CancellationToken ct)
    {
        await RequireLocalEngine(ct);
        var available = await docker.RunAsync(["image", "inspect", declaration.Image], cancellationToken: ct);
        if (available.ExitCode != 0) await Run(["pull", declaration.Image], ct);
    }

    internal async Task StopInstallationAsync(AppRecord app, CancellationToken ct)
    {
        var gate = locks.GetOrAdd(app.Id, _ => new(1));
        await gate.WaitAsync(ct);
        try
        {
            var names = (await Run(["ps", "-a", "--filter", $"label={Label}.instance={Instance}",
                "--filter", $"label={Label}.installation={Installation(app)}", "--format", "{{.Names}}"], ct))
                .Split('\n', StringSplitOptions.RemoveEmptyEntries);
            foreach (var name in names)
            {
                if (name.Length < 36) throw Error("Worker inventory contains an invalid ownership record.");
                var generation = Generation(name[^36..]);
                if (Name(app, generation) != name) throw Error("Worker inventory contains an ownership conflict.");
                if (await Inspect(app, generation, ct) is null) continue;
                await Run(["stop", "--time", "10", name], ct);
                await Run(["rm", name], ct);
                if (await Inspect(app, generation, ct) is not null) throw Error("Worker removal is not confirmed.");
            }
            // Coordinator recovery releases the user-owned leases only after reconciling its
            // persisted state. Core lifecycle never guesses that an absent container means no lease.
        }
        finally { gate.Release(); }
    }

    internal async Task<ProcessStartInfo> ExecAsync(AppRecord app, AgentWorkerExec input, CancellationToken ct)
    {
        await Declaration(app, ct);
        await RequireLease(app, input.Generation, ct);
        if (await Inspect(app, input.Generation, ct) is null) throw Error("The worker no longer exists.");
        if (input.Provider is not "codex" and not "claude" || input.Arguments.Length > 256
            || input.Environment.Count > 64) throw Error("Invalid agent execution request.");
        var cwd = Canonical(input.Cwd);
        if (!Beneath(cwd, SourceRoots()[0])) AllowedPrivatePath(app, cwd);
        var start = new ProcessStartInfo("docker") { RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var value in new[] { "exec", "-i", "--workdir", cwd }) start.ArgumentList.Add(value);
        foreach (var (key, value) in input.Environment)
        {
            if (!AllowedEnvironment(key) || value.Length > 65536) throw Error("Invalid agent environment.");
            start.ArgumentList.Add("--env"); start.ArgumentList.Add(key); start.Environment[key] = value;
        }
        start.ArgumentList.Add(Name(app, input.Generation));
        start.ArgumentList.Add("/opt/hosty-worker/" + input.Provider);
        foreach (var argument in input.Arguments) start.ArgumentList.Add(argument);
        return start;
    }

    internal static bool AllowedEnvironment(string key) => key is "HOME" or "XDG_CACHE_HOME" or "TMPDIR"
        or "GIT_OPTIONAL_LOCKS" or "GIT_CONFIG_NOSYSTEM" or "GIT_CONFIG_GLOBAL"
        or "NPM_CONFIG_CACHE" or "NUGET_PACKAGES" or "DOTNET_CLI_HOME" or "DOTNET_CLI_TELEMETRY_OPTOUT"
        or "DOTNET_SKIP_FIRST_TIME_EXPERIENCE" or "CODEX_HOME" or "CLAUDE_CONFIG_DIR"
        or "ANTHROPIC_API_KEY" or "CLAUDE_CODE_OAUTH_TOKEN" or "CLAUDE_CODE_ENTRYPOINT"
        or "CLAUDE_AGENT_SDK_VERSION" or "CLAUDE_CODE_SDK_READS_SESSION_STATE"
        || key.StartsWith("HOSTY_MCP_", StringComparison.Ordinal)
            && key.All(c => char.IsAsciiLetterUpper(c) || char.IsAsciiDigit(c) || c == '_');
}

internal static class AgentWorkerEndpoints
{
    internal static void Map(WebApplication app)
    {
        const string root = "/api/internal/apps/{appId}/agent-worker";
        app.MapPost(root + "/{operation}", async (string appId, string operation, AgentWorkerRequest input,
            HttpRequest request, AgentWorkerService service, CancellationToken ct) =>
        {
            try
            {
                var caller = await service.AuthenticateAsync(appId, request, ct);
                return CoreJson.Json(new AgentWorkerOutput(await service.ExecuteAsync(caller, operation, input, ct)));
            }
            catch (AppIdentityException ex) { return Results.StatusCode(ex.Code == "token_invalid" ? 401 : 403); }
            catch (AppLifecycleException ex) { return CoreJson.Json(new AgentWorkerOutput(ex.Message), 409); }
            catch (SandboxException ex) { return CoreJson.Json(new AgentWorkerOutput(ex.Message), ex.Status); }
        });
        app.MapPost(root + "/exec", Stream);
    }

    private static async Task Stream(string appId, HttpContext context, AgentWorkerService service)
    {
        var ct = context.RequestAborted;
        // Provider stdin may remain idle for an entire model turn, and a conversation can stream
        // indefinitely. Bound each frame below instead of applying ordinary upload limits.
        if (context.Features.Get<IHttpMinRequestBodyDataRateFeature>() is { } rate) rate.MinDataRate = null;
        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } size) size.MaxRequestBodySize = null;
        using var reader = new StreamReader(context.Request.Body, Encoding.UTF8);
        try
        {
            var app = await service.AuthenticateAsync(appId, context.Request, ct);
            var first = await ReadLine(reader, ct);
            var input = JsonSerializer.Deserialize(first, CoreJson.TypeInfo<AgentWorkerExec>()) ?? throw new InvalidDataException();
            using var process = Process.Start(await service.ExecAsync(app, input, ct)) ?? throw new IOException("Cannot start agent transport.");
            using var cancelled = ct.Register(() => { try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } });
            context.Response.ContentType = "application/x-ndjson";
            context.Response.Headers.CacheControl = "no-store";
            await context.Response.StartAsync(ct);
            var frames = Channel.CreateBounded<AgentWorkerFrame>(32);
            async Task Drain(Stream stream, string kind)
            {
                var buffer = new byte[16384];
                int count;
                while ((count = await stream.ReadAsync(buffer, ct)) > 0)
                    await frames.Writer.WriteAsync(new(kind, Convert.ToBase64String(buffer, 0, count)), ct);
            }
            async Task Feed()
            {
                while (true)
                {
                    var line = await ReadLine(reader, ct);
                    var frame = JsonSerializer.Deserialize(line, CoreJson.TypeInfo<AgentWorkerFrame>()) ?? throw new InvalidDataException();
                    if (frame.Kind == "eof") { process.StandardInput.Close(); return; }
                    if (frame.Kind != "stdin" || frame.Data is null) throw new InvalidDataException();
                    await process.StandardInput.BaseStream.WriteAsync(Convert.FromBase64String(frame.Data), ct);
                    await process.StandardInput.BaseStream.FlushAsync(ct);
                }
            }
            var feed = Feed();
            _ = feed.ContinueWith(task => {
                _ = task.Exception;
                try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                context.Abort();
            }, TaskContinuationOptions.OnlyOnFaulted);
            async Task Collect()
            {
                try
                {
                    await Task.WhenAll(Drain(process.StandardOutput.BaseStream, "stdout"), Drain(process.StandardError.BaseStream, "stderr"), process.WaitForExitAsync(ct));
                    await frames.Writer.WriteAsync(new("exit", Code: process.ExitCode), ct);
                }
                finally { frames.Writer.TryComplete(); }
            }
            var collect = Collect();
            try
            {
                await foreach (var frame in frames.Reader.ReadAllAsync(ct))
                {
                    await context.Response.WriteAsync(CoreJson.Text(frame) + "\n", ct);
                    await context.Response.Body.FlushAsync(ct);
                }
                await collect;
            }
            finally
            {
                try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                // Observe a disconnected input producer without blocking output completion.
                _ = feed.ContinueWith(task => _ = task.Exception, TaskContinuationOptions.OnlyOnFaulted);
            }
        }
        catch (Exception ex) when (ex is AppIdentityException or AppLifecycleException or IOException or JsonException or InvalidDataException or OperationCanceledException)
        {
            if (!context.Response.HasStarted) context.Response.StatusCode = ex is AppIdentityException identity ? identity.Code == "token_invalid" ? 401 : 403 : 409;
            else context.Abort();
        }
    }

    private static async Task<string> ReadLine(StreamReader reader, CancellationToken ct)
    {
        var result = new StringBuilder();
        var character = new char[1];
        while (await reader.ReadAsync(character, ct) != 0)
        {
            if (character[0] == '\n') return result.ToString();
            if (result.Length >= 262144) throw new InvalidDataException("Worker frame limit exceeded.");
            result.Append(character[0]);
        }
        throw new EndOfStreamException();
    }
}
