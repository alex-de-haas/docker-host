using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed record PreviewCheckRecipe(string Id, string[] Command, string Cwd = ".", int TimeoutSeconds = 300);
internal sealed record PreviewCheckRun(string Id, string Digest, string RequestId);
internal sealed record PreviewCheckResult(string RequestId, string Digest, string State, DateTimeOffset At,
    int? ExitCode = null, string? Output = null, string? ContainerId = null);
internal sealed record PreviewCheck(string Id, string Service, PreviewCheckRecipe Recipe, string? Digest,
    string State, string? Message, PreviewCheckResult? Result = null);
internal sealed record PreviewChecksView(PreviewCheck[] Checks, string State, string? Message = null,
    AppRuntimeHealthResponse? Readiness = null, string? ReadinessError = null, DateTimeOffset? ObservedAt = null);

// Execution uses the already quota-limited application container, never a host shell. A timeout
// stops that exact container: killing a Docker CLI alone would leave its exec descendants alive.
internal sealed class PreviewChecks(IDockerCommandRunner docker)
{
    internal const int OutputLimit = 16384;
    internal static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    internal static void Validate(PreviewCheckRecipe recipe)
    {
        if (recipe is null || recipe.Id is null || !System.Text.RegularExpressions.Regex.IsMatch(recipe.Id, "^[a-zA-Z0-9_-]{1,64}$") ||
            recipe.Command is not { Length: > 0 and <= 32 } || recipe.Command.Any(s => string.IsNullOrEmpty(s) || s.Length > 2048 || s.Contains('\0')) ||
            recipe.TimeoutSeconds is < 1 or > 300 || recipe.Cwd is null || !DockerSourceRuntime.SafeRelative(recipe.Cwd))
            throw new AppLifecycleException("preview_recipe_invalid", "Check recipes require an id, argv, contained cwd and a timeout from 1 to 300 seconds.");
    }

    internal static async Task<string> SourceDigest(string root, RuntimeSourceMountManifest mount, CancellationToken ct)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        long bytes = 0; int count = 0;
        async Task Visit(string directory)
        {
            foreach (var path in Directory.EnumerateFileSystemEntries(directory).Order(StringComparer.Ordinal))
            {
                ct.ThrowIfCancellationRequested();
                var relative = Path.GetRelativePath(root, path).Replace('\\', '/');
                if (relative == ".git" || mount.Caches.Any(c => relative == c) || mount.GeneratedFiles.Contains(relative)) continue;
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                    throw new AppLifecycleException("preview_source_unknown", "Check source contains a symbolic link; its revision cannot be verified.");
                if (++count > 20000) throw new AppLifecycleException("preview_source_unknown", "Check source exceeds 20,000 entries.");
                if (Directory.Exists(path)) { await Visit(path); continue; }
                var size = new FileInfo(path).Length;
                if ((bytes += size) > 128 * 1024 * 1024)
                    throw new AppLifecycleException("preview_source_unknown", "Check source exceeds the bounded revision scan (20,000 files / 128 MiB).");
                hash.AppendData(Encoding.UTF8.GetBytes(relative + "\0" + size + "\0"));
                await using var stream = File.OpenRead(path);
                hash.AppendData(await SHA256.HashDataAsync(stream, ct));
            }
        }
        await Visit(root);
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    internal async Task<(string Id, string Image)> Container(string instance, string app, string service, CancellationToken ct)
    {
        var result = await docker.RunBoundedAsync(["inspect", "--format", "{{json .}}", DockerRuntimeAdapter.BuildContainerName(instance, app, service)], 32768, ct);
        if (result.ExitCode != 0) throw new AppLifecycleException("preview_runtime_unknown", "The service container is unavailable. Fix the source and start it, then check again.");
        using var json = JsonDocument.Parse(result.StandardOutput);
        var node = json.RootElement; var labels = node.GetProperty("Config").GetProperty("Labels");
        string Label(string key) => labels.TryGetProperty(key, out var value) ? value.GetString() ?? "" : "";
        var id = node.GetProperty("Id").GetString() ?? "";
        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-f0-9]{64}$") || Label("hosty.app.id") != app ||
            Label("hosty.instance") != instance || Label("hosty.app.service") != service || !node.GetProperty("State").GetProperty("Running").GetBoolean())
            throw new AppLifecycleException("preview_runtime_unknown", "The selected service is stopped or its ownership cannot be verified. Restart after repairing the source.");
        return (id, node.GetProperty("Image").GetString()!);
    }

    internal async Task<PreviewCheckResult> Run(string container, string cwd, PreviewCheckRecipe recipe, PreviewCheckRun request, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(recipe.TimeoutSeconds));
        try
        {
            var result = await docker.RunBoundedAsync(["exec", "--workdir", cwd, container, .. recipe.Command], OutputLimit, deadline.Token);
            return new(request.RequestId, request.Digest, result.ExitCode == 0 ? "passed" : "failed", DateTimeOffset.UtcNow,
                result.ExitCode, (result.StandardOutput + "\n" + result.StandardError).Trim()[..Math.Min((result.StandardOutput + "\n" + result.StandardError).Trim().Length, OutputLimit)]);
        }
        catch (Exception ex) when (ex is OperationCanceledException or DockerUnavailableException)
        {
            using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            try
            {
                await docker.RunBoundedAsync(["kill", container], 4096, cleanup.Token);
                var observed = await docker.RunBoundedAsync(["inspect", "--format", "{{.State.Running}}", container], 4096, cleanup.Token);
                if (observed.ExitCode != 0 || observed.StandardOutput.Trim() != "false")
                    return new(request.RequestId, request.Digest, "unknown", DateTimeOffset.UtcNow, Output: "Command termination is unconfirmed. Restore Docker and stop this service before retrying.");
                return new(request.RequestId, request.Digest, ct.IsCancellationRequested || ex is DockerUnavailableException ? "interrupted" : "timed_out", DateTimeOffset.UtcNow,
                    Output: "The selected service was stopped to terminate the check and its child processes. Repair the source if needed, then Restart explicitly.");
            }
            catch (Exception cleanupError) when (cleanupError is OperationCanceledException or DockerUnavailableException)
            { return new(request.RequestId, request.Digest, "unknown", DateTimeOffset.UtcNow, Output: "Docker is unavailable; check termination is unconfirmed. Restore Docker and stop this service before retrying."); }
        }
    }
}

internal sealed partial class CoreLifecycleService
{
    public Task<PreviewChecksView> ReadPreviewChecksAsync(string appId, CancellationToken ct)
        => WithAppLockAsync(appId, () => PreviewChecksCore(appId, null, ct), ct);
    public Task<PreviewChecksView> RunPreviewCheckAsync(string appId, PreviewCheckRun input, CancellationToken ct)
        => WithAppLockAsync(appId, () => PreviewChecksCore(appId, input, ct), ct);

    private async Task<PreviewChecksView> PreviewChecksCore(string appId, PreviewCheckRun? input, CancellationToken ct)
    {
        var app = await RequireAppAsync(appId, ct);
        var selection = (await LoadSelectionWithStatusAsync(app, ct)).Selection;
        var context = await CreateRuntimeContextAsync(app, selection, ct);
        var engine = new PreviewChecks(new ProcessDockerCommandRunner());
        var checks = new List<PreviewCheck>();
        foreach (var service in selection.Services)
        {
            if (service.Runtime.Type != "docker" || service.Runtime.SourceMount is not { Mode: "ro" } mount) continue;
            var root = DockerSourceRuntime.ResolveSourcePath(context, mount);
            var recipePath = Path.Combine(root, ".hosty", "preview-checks.json");
            if (!File.Exists(recipePath)) continue;
            if (CoreDataPaths.ContainsSymbolicLink(root, recipePath) || new FileInfo(recipePath).Length > 32768)
                throw new AppLifecycleException("preview_recipe_invalid", "Check recipe must be a contained regular file no larger than 32 KiB.");
            PreviewCheckRecipe[] recipes;
            try { recipes = JsonSerializer.Deserialize(await File.ReadAllTextAsync(recipePath, ct), CoreJsonSerializerContext.Default.PreviewCheckRecipeArray)
                ?? throw new AppLifecycleException("preview_recipe_invalid", "Check recipes must be an array."); }
            catch (JsonException) { throw new AppLifecycleException("preview_recipe_invalid", "Cannot read .hosty/preview-checks.json. Use an array of check recipes with id, command, cwd and timeoutSeconds."); }
            foreach (var recipe in recipes) PreviewChecks.Validate(recipe);
            if (recipes.Length > 8 || recipes.Select(r => r.Id).Distinct().Count() != recipes.Length)
                throw new AppLifecycleException("preview_recipe_invalid", "Use at most eight uniquely named checks per service.");
            foreach (var recipe in recipes)
            {
                PreviewChecks.Validate(recipe);
                var id = service.Key + "/" + recipe.Id;
                var receiptPath = Path.Combine(GetAppRoot(appId), "preview-checks", PreviewChecks.Hash(id) + ".json");
                var previous = await JsonStorage.ReadAsync<PreviewCheckResult>(receiptPath, ct);
                string? digest = null, message = null; (string Id, string Image) container = default;
                try
                {
                    container = await engine.Container(instanceId, appId, service.Key, ct);
                    digest = PreviewChecks.Hash(await PreviewChecks.SourceDigest(root, mount, ct) + selection.ManifestDigest +
                        container.Id + container.Image + CoreJson.Text(recipe));
                }
                catch (Exception ex) when (ex is AppLifecycleException or DockerUnavailableException or IOException or JsonException)
                { message = ex.Message; }
                var state = digest is null ? "unknown" : previous is null ? "not_checked"
                    : previous.Digest != digest ? "stale" : previous.State == "running" ? "unknown" : previous.State;
                if (input?.Id == id)
                {
                    if (!Guid.TryParseExact(input.RequestId, "D", out _)) throw new AppLifecycleException("preview_request_invalid", "Use a UUID requestId.");
                    var requestPath = Path.Combine(GetAppRoot(appId), "preview-checks", "requests", input.RequestId + ".json");
                    var replay = await JsonStorage.ReadAsync<PreviewCheckResult>(requestPath, ct);
                    if (replay is not null)
                    {
                        if (replay.Digest != input.Digest) throw new AppLifecycleException("preview_request_conflict", "This request id belongs to another revision.");
                        checks.Add(new(id, service.Key, recipe, digest, digest != replay.Digest ? "stale" : replay.State == "running" ? "unknown" : replay.State, message, replay)); continue;
                    }
                    if (digest is null || input.Digest != digest) throw new AppLifecycleException("preview_check_stale", "The source, recipe or container changed. Review Check preview again before running it.");
                    var receiptsDirectory = Path.Combine(GetAppRoot(appId), "preview-checks", "requests");
                    if (Directory.Exists(receiptsDirectory)) foreach (var path in Directory.EnumerateFiles(receiptsDirectory, "*.json"))
                    {
                        var unresolved = await JsonStorage.ReadAsync<PreviewCheckResult>(path, ct);
                        if (unresolved is { State: "running" or "unknown" } && unresolved.ContainerId == container.Id)
                            throw new AppLifecycleException("preview_check_unconfirmed", "A previous check may still be running. Restart the service to confirm termination before another check.");
                    }
                    var cwd = recipe.Cwd == "." ? root : CoreDataPaths.ResolveContainedPath(root, recipe.Cwd);
                    if (!Directory.Exists(cwd) || CoreDataPaths.ContainsSymbolicLink(root, cwd))
                        throw new AppLifecycleException("preview_recipe_invalid", "The check working directory must exist inside the service source.");
                    // Persist before execution: a Core crash is unknown, never an automatic rerun.
                    var running = new PreviewCheckResult(input.RequestId, digest, "running", clock.UtcNow, ContainerId: container.Id);
                    await JsonStorage.WriteAsync(receiptPath, running, true, ct);
                    await JsonStorage.WriteAsync(requestPath, running, true, ct);
                    previous = (await engine.Run(container.Id!, mount.Target.TrimEnd('/') + (recipe.Cwd == "." ? "" : "/" + recipe.Cwd), recipe, input, ct)) with { ContainerId = container.Id };
                    await JsonStorage.WriteAsync(requestPath, previous, true, CancellationToken.None);
                    await JsonStorage.WriteAsync(receiptPath, previous, true, CancellationToken.None);
                    state = previous.State;
                    if (PreviewChecks.Hash(await PreviewChecks.SourceDigest(root, mount, ct) + selection.ManifestDigest + container.Id + container.Image + CoreJson.Text(recipe)) != digest)
                        state = "stale";
                }
                checks.Add(new(id, service.Key, recipe, digest, state, message, previous));
            }
        }
        if (input is not null && !checks.Any(c => c.Id == input.Id)) throw new AppLifecycleException("preview_recipe_missing", "The requested check is no longer configured.");
        AppRuntimeHealthResponse? readiness = null; string? readinessError = null;
        using var healthDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        healthDeadline.CancelAfter(TimeSpan.FromSeconds(10));
        try { readiness = await GetHealthAsync(appId, healthDeadline.Token); }
        catch (Exception ex) when (ex is AppLifecycleException or DockerUnavailableException or IOException or OperationCanceledException)
        { readinessError = "Current readiness could not be verified. Inspect service health and logs, then retry."; }
        return new(checks.ToArray(), checks.Count == 0 ? "not_checked" : "observed",
            checks.Count == 0 ? "No check recipe is configured for a read-only Docker source service. Build and tests have not been checked. Restart remains available." : null,
            readiness, readinessError, clock.UtcNow);
    }
}
