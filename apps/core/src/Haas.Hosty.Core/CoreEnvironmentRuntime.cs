using System.Diagnostics;
using System.Net;
using System.Text.Json;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed class CoreEnvironmentRuntime(HostyCoreRuntimeConfig config, IDockerCommandRunner docker,
    IHttpClientFactory clients, ILogger<CoreEnvironmentRuntime> logger) : ICoreEnvironmentRuntime
{
    public async Task<CoreEnvironmentUsage?> InspectResourcesAsync(CoreEnvironmentRecord record, string root, CancellationToken ct)
        => await CoreEnvironmentResources.InspectAsync(record, root, docker, ct);
    private static string BinaryName => OperatingSystem.IsWindows() ? "hosty-core.exe" : "hosty-core";
    public async Task<string> PrepareAsync(CoreEnvironmentRecord record, string root, CancellationToken ct)
    {
        var generation = Path.Combine(root, "core", "builds", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(generation);
        CoreBuildRetention.Mark(generation, "building", record.Request.ProjectPath);
        try
        {
            if (record.Request.Mode == "source")
            {
                var start = new ProcessStartInfo("dotnet") { WorkingDirectory = Path.GetDirectoryName(record.Request.ProjectPath)! };
                foreach (var arg in new[] { "build", record.Request.ProjectPath!, "--configuration", "Debug", "--artifacts-path", generation, "--nologo" }) start.ArgumentList.Add(arg);
                var result = await ProcessRunner.RunAsync(start, TimeSpan.FromMinutes(5), ct, 65536);
                await File.WriteAllTextAsync(Path.Combine(generation, "build.log"), result.StandardOutput + result.StandardError, ct);
                if (result.ExitCode != 0 || result.TimedOut)
                    throw new SandboxException("environment_build_failed", "Core source build failed; the running child is preserved. See " + Path.Combine(generation, "build.log"), 409);
                var binary = Path.Combine(generation, "bin", Path.GetFileNameWithoutExtension(record.Request.ProjectPath)!, "debug", BinaryName);
                if (!File.Exists(binary)) throw new SandboxException("environment_build_missing", "The selected project did not produce hosty-core.", 409);
                CoreBuildRetention.Mark(generation, "prepared", record.Request.ProjectPath);
                return binary;
            }
            var source = record.Request.Mode == "release" ? Path.Combine(config.DataRoot, "core", "bin", BinaryName)
                : Path.Combine(AppContext.BaseDirectory, BinaryName);
            if (!File.Exists(source)) throw new SandboxException("environment_binary_missing", "The selected prepared or installed Core executable is unavailable.", 409);
            // Copy the prepared generation: parent build retention must not remove a live child's binary.
            // A release is a single native file; a debug build includes its adjacent managed dependencies.
            if (record.Request.Mode == "release") File.Copy(source, Path.Combine(generation, BinaryName));
            else CopyDirectory(Path.GetDirectoryName(source)!, generation);
            CoreBuildRetention.Mark(generation, "prepared", record.Request.ProjectPath);
            return Path.Combine(generation, BinaryName);
        }
        catch
        {
            ReleasePreparation(generation);
            CoreBuildRetention.Cleanup(root);
            throw;
        }
    }
    private static void ReleasePreparation(string generation)
    {
        var path = Path.Combine(generation, CoreBuildRetention.Marker);
        var marker = CoreLaunchFiles.Read(path, CoreLaunchJson.Default.CoreBuildGeneration);
        // A failed attempt is no longer owned by this long-running parent. Retention keeps the
        // newest failure's diagnostics, but does not pin every failed build until parent exit.
        if (marker?.OwnerPid == Environment.ProcessId)
            CoreLaunchFiles.Write(path, marker with { State = "failed", OwnerPid = -1, OwnerStartedAt = DateTimeOffset.MinValue }, CoreLaunchJson.Default.CoreBuildGeneration);
    }
    internal static string? Generation(string root, string? executable)
    {
        if (executable is null) return null;
        var builds = Path.Combine(root, "core", "builds");
        if (CoreDataPaths.ContainsSymbolicLink(builds, executable)) return null;
        var path = Path.GetDirectoryName(executable);
        while (path is not null && Path.GetDirectoryName(path) != builds) path = Path.GetDirectoryName(path);
        return path is not null && File.Exists(Path.Combine(path, CoreBuildRetention.Marker)) ? path : null;
    }
    public Task CleanupAsync(CoreEnvironmentRecord record, string root, CancellationToken ct)
    {
        try
        {
            if (Generation(root, record.Executable) is { } generation) ReleasePreparation(generation);
            CoreBuildRetention.Cleanup(root);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        { logger.LogWarning("Child Core build retention deferred for {Environment}: {Reason}", record.Id, ex.GetType().Name); }
        return Task.CompletedTask;
    }
    // Preparation and consent must describe the same file closure. Directory links are excluded;
    // the retention marker is regenerated for the child rather than copied from its parent.
    internal static IEnumerable<FileSystemInfo> PreparedEntries(string source)
    {
        foreach (var entry in new DirectoryInfo(source).EnumerateFileSystemInfos())
        {
            if (entry is DirectoryInfo directory)
            {
                if (directory.LinkTarget is not null) continue;
                yield return entry;
                foreach (var nested in PreparedEntries(directory.FullName)) yield return nested;
            }
            else if (entry.Name != CoreBuildRetention.Marker) yield return entry;
        }
    }
    internal static void CopyDirectory(string source, string destination)
    {
        foreach (var entry in PreparedEntries(source))
        {
            var target = Path.Combine(destination, Path.GetRelativePath(source, entry.FullName));
            if (entry is DirectoryInfo) Directory.CreateDirectory(target);
            else File.Copy(entry.FullName, target);
        }
    }
    internal static bool Alive(CoreEnvironmentProcess? identity)
    {
        if (identity is null || identity.Pid <= 1) return false;
        try
        {
            using var process = Process.GetProcessById(identity.Pid);
            return !process.HasExited && (process.StartTime.ToUniversalTime() - identity.StartedAt.UtcDateTime).Duration() < TimeSpan.FromSeconds(1);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { return false; }
    }
    private static async Task<ControlDiscoveryDocument?> DiscoveryAsync(CoreEnvironmentRecord record, string root, CancellationToken ct)
    {
        ControlDiscoveryDocument? discovery;
        try { discovery = await JsonStorage.ReadAsync<ControlDiscoveryDocument>(Path.Combine(root, "core", "run", "control.json"), ct); }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException) { return null; }
        if (discovery is null || !Uri.TryCreate(discovery.ControlBaseUrl, UriKind.Absolute, out var uri)
            || !uri.IsLoopback || uri.Scheme != "http" || discovery.ProcessId <= 1) return null;
        if (!File.Exists(CoreInstanceId.BuildPath(root)) || File.ReadAllText(CoreInstanceId.BuildPath(root)).Trim() != record.Id) return null;
        try
        {
            using var process = Process.GetProcessById(discovery.ProcessId);
            if (process.HasExited || process.StartTime.ToUniversalTime() > discovery.StartedAt.UtcDateTime.AddSeconds(1)) return null;
            if (record.Process is { } saved && Alive(saved) && saved.Pid != process.Id) return null;
            return discovery;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { return null; }
    }
    public async Task<CoreEnvironmentProcess?> ObserveAsync(CoreEnvironmentRecord record, string root, CancellationToken ct)
    {
        var discovery = await DiscoveryAsync(record, root, ct);
        if (discovery is null) return null;
        try
        {
            using var client = clients.CreateClient(); client.Timeout = TimeSpan.FromSeconds(2);
            using var request = new HttpRequestMessage(HttpMethod.Get, discovery.ControlBaseUrl.TrimEnd('/') + "/core/status");
            foreach (var header in discovery.RequiredHeaders) request.Headers.TryAddWithoutValidation(header.Key, header.Value);
            using var response = await client.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode) return null;
            using var status = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
            var versionText = status.RootElement.TryGetProperty("version", out var version) ? version.GetString()?.Split('-')[0] : null;
            if (!Version.TryParse(versionText, out var parsed) || parsed < new Version(0, 133, 0))
                throw new SandboxException("environment_core_version", "Child Core 0.133.0 or newer is required for resource limits and resumable cleanup. Finish or upgrade this environment.", 409);
            using var process = Process.GetProcessById(discovery.ProcessId);
            return new(process.Id, process.StartTime.ToUniversalTime());
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or ArgumentException or InvalidOperationException) { return null; }
    }
    public async Task StartAsync(CoreEnvironmentRecord record, string root, Func<CoreEnvironmentProcess, Task> saveProcess, CancellationToken ct)
    {
        try
        {
            if (await ObserveAsync(record, root, ct) is { } existing) { await saveProcess(existing); return; }
        }
        catch (SandboxException ex) when (ex.Code == "environment_core_version")
        {
            // Do not adopt a pre-quota child as if its app containers were bounded.
            await StopAsync(record, root, false, ct);
        }
        if (Alive(record.Process)) throw new SandboxException("environment_process_unready", "The recorded process is alive but not ready. Stop it before starting another.", 409);
        Directory.CreateDirectory(Path.Combine(root, "core", "logs"));
        var log = Path.Combine(root, "core", "logs", "environment-" + Guid.NewGuid().ToString("N") + ".log");
        var start = new ProcessStartInfo { UseShellExecute = false, WorkingDirectory = root, CreateNoWindow = true };
        // Core code is trusted, but ambient app/provider secrets and Git credentials are not copied.
        var inherited = start.Environment.ToDictionary(p => p.Key, p => p.Value);
        start.Environment.Clear();
        foreach (var key in new[] { "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "DOTNET_ROOT", "DOTNET_ROOT_ARM64", "LANG" })
            if (inherited.TryGetValue(key, out var value)) start.Environment[key] = value;
        var home = Path.Combine(root, "home"); Directory.CreateDirectory(home);
        start.Environment["HOME"] = home; start.Environment["USERPROFILE"] = home;
        start.Environment["GIT_CONFIG_NOSYSTEM"] = "1";
        start.Environment["GIT_CONFIG_GLOBAL"] = OperatingSystem.IsWindows() ? "NUL" : "/dev/null";
        start.Environment["GIT_TERMINAL_PROMPT"] = "0";
        var endpoint = Environment.GetEnvironmentVariable("DOCKER_HOST");
        if (string.IsNullOrWhiteSpace(endpoint) || !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DOCKER_CONTEXT")))
        {
            var resolved = await docker.RunAsync(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], null, ct);
            if (resolved.ExitCode != 0) throw new SandboxException("environment_docker_unknown", "Cannot resolve the shared local Docker endpoint.", 409);
            endpoint = resolved.StandardOutput.Trim();
        }
        if (endpoint is null || !(endpoint.StartsWith("unix://", StringComparison.Ordinal) || endpoint.StartsWith("npipe://", StringComparison.Ordinal)))
            throw new SandboxException("environment_docker_remote", "Child environments require the shared local Docker engine.", 409);
        start.Environment["DOCKER_HOST"] = endpoint;
        start.Environment["HOSTY_DATA_ROOT"] = root;
        start.Environment["HOSTY_CORE_PORT"] = record.Port.ToString(System.Globalization.CultureInfo.InvariantCulture);
        start.Environment["HOSTY_CORE_URL"] = $"http://localhost:{record.Port}";
        start.Environment["HOSTY_DISTRIBUTION_APPS_PATH"] = Path.Combine(root, "core", "distribution-apps.json");
        start.Environment["HOSTY_CORE_LAUNCH_MODE"] = record.Request.Mode == "source" ? "dev" : record.Request.Mode;
        start.Environment["HOSTY_CORE_PROJECT"] = record.Request.ProjectPath ?? "";
        var generation = Generation(root, record.Executable);
        start.Environment["HOSTY_CORE_GENERATION"] = generation ?? "";
        start.Environment["HOSTY_CLI_PATH"] = CoreCliLauncher.ResolveCliPath();
        if (OperatingSystem.IsWindows())
        {
            start.FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe";
            start.ArgumentList.Add("/d"); start.ArgumentList.Add("/s"); start.ArgumentList.Add("/c");
            start.ArgumentList.Add($"\"\"{record.Executable}\" > \"{log}\" 2>&1\"");
        }
        else
        {
            start.FileName = "/bin/sh"; start.ArgumentList.Add("-c");
            start.ArgumentList.Add("exec nohup \"$1\" > \"$2\" 2>&1"); start.ArgumentList.Add("hosty-child");
            start.ArgumentList.Add(record.Executable!); start.ArgumentList.Add(log);
        }
        using var launched = Process.Start(start) ?? throw new SandboxException("environment_launch_failed", "Unable to start the child Core.", 409);
        var spawned = new CoreEnvironmentProcess(launched.Id, launched.StartTime.ToUniversalTime());
        if (generation is not null) CoreBuildRetention.Mark(generation, "starting", record.Request.ProjectPath, spawned.Pid, spawned.StartedAt);
        await saveProcess(spawned);
        // On Windows cmd is the launcher. Discovery supplies the actual Core process after readiness.
        var probe = record with { Process = OperatingSystem.IsWindows() ? null : spawned };
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(45));
        while (!deadline.IsCancellationRequested)
        {
            CoreEnvironmentProcess? process;
            try { process = await ObserveAsync(probe, root, deadline.Token); }
            catch (SandboxException ex) when (ex.Code == "environment_core_version")
            {
                await StopAsync(probe with { Process = spawned }, root, false, ct);
                throw;
            }
            if (process is not null)
            {
                if (generation is not null) CoreBuildRetention.Mark(generation, "ready", record.Request.ProjectPath, process.Pid, process.StartedAt);
                await saveProcess(process); return;
            }
            if (launched.HasExited) throw new SandboxException("environment_launch_failed", "Child Core exited before readiness. See " + log, 409);
            await Task.Delay(100, deadline.Token);
        }
        throw new SandboxException("environment_start_timeout", "Child Core readiness timed out. See " + log, 409);
    }
    public async Task StopAsync(CoreEnvironmentRecord record, string root, bool remove, CancellationToken ct)
    {
        if (record.RootDeletionStarted)
        {
            foreach (var owner in record.CleanupOwners ?? [record.Id]) await DockerCleanupAsync(owner, true, ct);
            return;
        }
        var discovery = await DiscoveryAsync(record, root, ct);
        var identity = record.Process;
        if (discovery is not null)
        {
            using var process = Process.GetProcessById(discovery.ProcessId);
            identity = new(process.Id, process.StartTime.ToUniversalTime());
            try
            {
                using var client = clients.CreateClient(); client.Timeout = TimeSpan.FromSeconds(3);
                using var request = new HttpRequestMessage(HttpMethod.Post, discovery.ControlBaseUrl.TrimEnd('/') + "/core/stop");
                foreach (var header in discovery.RequiredHeaders) request.Headers.TryAddWithoutValidation(header.Key, header.Value);
                using var response = await client.SendAsync(request, ct);
                var timer = Stopwatch.StartNew();
                while (Alive(identity) && timer.Elapsed < TimeSpan.FromSeconds(18)) await Task.Delay(100, ct);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            { logger.LogWarning("Graceful child Core stop unavailable for {Environment}: {Reason}", record.Id, ex.GetType().Name); }
        }
        if (Alive(identity))
        {
            using var process = Process.GetProcessById(identity!.Pid);
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync(ct);
            if (Alive(identity)) throw new SandboxException("environment_process_alive", "The child process has not stopped.", 409);
        }
        using var rootLock = Directory.Exists(root) ? CoreRootLock.Acquire(config with
        {
            DataRoot = root, RunDirectory = Path.Combine(root, "core", "run"),
            ControlDiscoveryPath = Path.Combine(root, "core", "run", "control.json"),
        }, cleanup: true) : null;
        // A broken child may have its own environments. Reconcile only roots recorded under it.
        var childStore = new CoreEnvironmentStore(CoreDataPaths.FromConfig(config with { DataRoot = root }));
        foreach (var child in await childStore.ListAsync(ct))
        {
            if (child.State == "finished") continue;
            childStore.VerifyRoot(child);
            await StopAsync(child, childStore.Root(child.Id), remove, ct);
        }
        var apps = Path.Combine(root, "apps");
        if (Directory.Exists(apps))
            foreach (var app in Directory.EnumerateDirectories(apps))
            {
                var run = Path.Combine(app, "run");
                if (!Directory.Exists(run) || CoreDataPaths.ContainsSymbolicLink(root, run)) continue;
                foreach (var path in Directory.EnumerateFiles(run, "*.json"))
                {
                    var saved = await JsonStorage.ReadAsync<LocalCommandPidFile>(path, ct);
                    if (saved?.InstanceId == record.Id)
                    {
                        await LocalCommandProcessReclaim.ReclaimAsync(app, Path.GetFileNameWithoutExtension(path), logger, ct);
                        if (Alive(new(saved.Pid, saved.StartedAtUtc))) throw new SandboxException("environment_runner_alive", "A local app runner is still alive.", 409);
                    }
                }
            }
        await DockerCleanupAsync(record.Id, remove, ct);
    }
    private async Task DockerCleanupAsync(string id, bool remove, CancellationToken ct)
    {
        async Task<string> Run(string[] args)
        {
            var result = await docker.RunAsync(args, null, ct);
            if (result.ExitCode != 0) throw new SandboxException("environment_docker_cleanup", "Docker cleanup failed: " + result.StandardError, 409);
            return result.StandardOutput.Trim();
        }
        var containers = (await Run(["ps", "-aq", "--filter", "label=hosty.instance=" + id])).Split('\n', StringSplitOptions.RemoveEmptyEntries);
        foreach (var container in containers)
        {
            var owner = await Run(["inspect", "--format", "{{ index .Config.Labels \"hosty.instance\" }}", container]);
            if (owner != id) throw new SandboxException("environment_docker_owner", "Docker resource ownership changed.", 409);
            await Run(remove ? ["rm", "-f", container] : ["stop", "-t", "5", container]);
        }
        if (!remove) return;
        foreach (var resource in new[] { "network", "volume" })
            foreach (var name in (await Run([resource, "ls", "-q", "--filter", "label=hosty.instance=" + id])).Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                var owner = await Run([resource, "inspect", "--format", "{{ index .Labels \"hosty.instance\" }}", name]);
                if (owner != id) throw new SandboxException("environment_docker_owner", "Docker resource ownership changed.", 409);
                await Run([resource, "rm", name]);
            }
        // Success means a fresh inventory is empty, not merely that delete commands were accepted.
        if ((await Run(["ps", "-aq", "--filter", "label=hosty.instance=" + id])).Length != 0)
            throw new SandboxException("environment_docker_cleanup", "Owned containers remain after cleanup.", 409);
        foreach (var resource in new[] { "network", "volume" })
            if ((await Run([resource, "ls", "-q", "--filter", "label=hosty.instance=" + id])).Length != 0)
                throw new SandboxException("environment_docker_cleanup", "Owned Docker resources remain after cleanup.", 409);
        // Older app runtimes created unlabelled networks. Do not claim complete cleanup or
        // delete an ambiguous resource by name alone; retain the root for explicit repair.
        if ((await Run(["network", "ls", "-q", "--filter", "name=^hosty-" + id[..12] + "-"])).Length != 0)
            throw new SandboxException("environment_docker_unverified", "A legacy or unverified instance network remains; verify its ownership before removal, then retry Finish.", 409);
    }
}
