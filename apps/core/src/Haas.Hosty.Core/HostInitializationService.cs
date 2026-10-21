using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Initialization;

namespace Haas.Hosty.Core;

internal sealed record InitializationInstall(SystemAppBootstrapDescriptor Descriptor, string State = "pending",
    string? ManifestDigest = null, string? Version = null, string? Runtime = null,
    string? FeedDigest = null, string? ArtifactDigest = null, string? Error = null);
internal sealed record InitializationDocument(string SchemaVersion, string Phase, InitializationRequest Request,
    string Fingerprint, IReadOnlyList<InitializationInstall> Installs, string? Error = null, IReadOnlyList<InitializationRequest>? PreviousRequests = null);

// One durable operation per data root. HTTP disconnects do not cancel installation; the hosted
// worker owns it and resumes an interrupted operation after Core restarts. Completed initialization
// is never used as an app reconciliation policy (uninstall remains durable).
internal sealed class HostInitializationService(
    CoreDataPaths paths, DistributionAppsProvider distribution, HostyCoreRuntimeConfig config,
    CoreLifecycleService lifecycle, AppRegistryStore apps, DistributionSeedStore seed, AppManifestService manifests, IDockerCommandRunner docker,
    UserDirectoryStore users, CorePublicOriginResolver origins, ShellPublicOriginResolver shellOrigins,
    AuthBootstrapService auth, ILogger<HostInitializationService> logger) : BackgroundService
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly SemaphoreSlim wake = new(0, 1);
    private string StatePath => InitializationFiles.StatePath(paths.DataRoot);

    internal static InitializationRequest Normalize(InitializationRequest input)
    {
        if (input.SchemaVersion != InitializationFiles.Schema || !Guid.TryParse(input.RequestId, out var id)
            || input.Apps is null || input.Apps.Length > 64 || input.Apps.Any(string.IsNullOrWhiteSpace)
            || input.Apps.Distinct(StringComparer.Ordinal).Count() != input.Apps.Length)
            throw new AppLifecycleException("initialization_invalid", "Use a supported initialization contract, request UUID and distinct catalog app IDs.");
        var ports = input.Ports ?? [];
        if (ports.Length > 64 || ports.Any(p => p is null || !input.Apps.Contains(p.AppId, StringComparer.Ordinal)
                || string.IsNullOrWhiteSpace(p.Service) || string.IsNullOrWhiteSpace(p.PortKey) || p.Port is < 1024 or > 65535)
            || ports.Select(p => (p.AppId, p.Service, p.PortKey)).Distinct().Count() != ports.Length
            || ports.Select(p => p.Port).Distinct().Count() != ports.Length)
            throw new AppLifecycleException("initialization_ports_invalid", "Choose distinct ports from 1024 to 65535 for services of selected apps.");
        return input with { RequestId = id.ToString("N"), Apps = input.Apps.Order(StringComparer.Ordinal).ToArray(),
            Ports = ports.OrderBy(p => p.AppId, StringComparer.Ordinal).ThenBy(p => p.Service, StringComparer.Ordinal).ThenBy(p => p.PortKey, StringComparer.Ordinal).ToArray() };
    }
    internal static string Fingerprint(InitializationRequest request)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(CoreJson.Text(request with { RequestId = "" }))));

    private async Task<InitializationDocument?> ReadAsync(CancellationToken ct)
    {
        if (!File.Exists(StatePath)) return null;
        try
        {
            var state = await JsonStorage.ReadAsync<InitializationDocument>(StatePath, ct);
            if (state is null || state.SchemaVersion != InitializationFiles.Schema || state.Request is null || state.Installs is null
                || state.Phase is not ("pending" or "preparing" or "failed" or "ready"))
                throw new JsonException("Invalid initialization document.");
            if (Fingerprint(Normalize(state.Request)) != state.Fingerprint) throw new JsonException("Initialization input fingerprint does not match.");
            return state;
        }
        catch (Exception ex) when (ex is JsonException or IOException or AppLifecycleException)
        { throw new AppLifecycleException("initialization_state_invalid", "Initialization state could not be read. Preserve this root and repair the state before retrying. " + ex.Message); }
    }
    private Task SaveAsync(InitializationDocument state, CancellationToken ct)
        => JsonStorage.WriteAsync(StatePath, state, restrictToOwner: true, ct);

    public async Task<InitializationStatus> GetAsync(CancellationToken ct)
    {
        var state = await ReadAsync(ct);
        var directory = await users.ReadAsync(ct);
        var admin = directory.Users.Any(u => u.Role == "host.admin" && !u.Disabled);
        var existing = state is null && !InitializationFiles.Requested(paths.DataRoot) && InitializationFiles.HasHistory(paths.DataRoot);
        return new(InitializationFiles.Schema, state?.Phase ?? (existing ? "existing" : "selection"), state?.Request.RequestId,
            state?.Request.Apps ?? [], state?.Installs.Select(i => new InitializationAppStatus(i.Descriptor.AppId,
                i.Descriptor.DisplayName, i.State, i.Version, i.Error)).ToArray() ?? [], admin,
            !admin && directory.Users.Count > 0, origins.Effective, await shellOrigins.ResolveAsync(ct), state?.Error, state?.Request);
    }

    public async Task<InitializationStatus> SubmitAsync(InitializationRequest input, CancellationToken ct)
    {
        input = Normalize(input);
        var fingerprint = Fingerprint(input);
        if (!await gate.WaitAsync(0, ct))
        {
            var running = await ReadAsync(ct);
            ValidateReplay(running, input, fingerprint);
            if (running?.Phase is "failed" or "ready")
            {
                // Terminal state is visible just before the worker releases the gate. Queue the
                // submission so an immediate retry is not mistaken for observation and dropped.
                await gate.WaitAsync(ct);
            }
            else
            {
                if (running?.Fingerprint != fingerprint || running.Request.RequestId != input.RequestId)
                    throw new AppLifecycleException("initialization_busy", "Initialization is running. Observe or retry its original request ID and selection.");
                return await GetAsync(ct);
            }
        }
        try
        {
            var prior = await ReadAsync(ct);
            ValidateReplay(prior, input, fingerprint);
            var review = prior?.Phase == "failed" && prior.Request.RequestId != input.RequestId;
            if (prior is not null && !review)
            {
                if (prior.Phase == "ready") return await GetAsync(ct);
                if (prior.Fingerprint != fingerprint)
                    throw new AppLifecycleException("initialization_selection_conflict", "Resume the accepted selection first; use hosty setup afterwards to change installed apps.");
                // Preserve the accepted request and resolved versions even when another client resumes.
                await SaveAsync(prior with { Phase = "pending", Error = null }, ct);
            }
            else
            {
                if (!InitializationFiles.Requested(paths.DataRoot) && InitializationFiles.HasHistory(paths.DataRoot))
                    return await GetAsync(ct);
                if ((prior?.PreviousRequests?.Count ?? 0) >= 64)
                    throw new AppLifecycleException("initialization_review_limit", "Too many reviewed selections; inspect this installation before further changes.");
                var catalog = await distribution.LoadAsync(ct);
                if (catalog.Problems.Count > 0) throw new AppLifecycleException("initialization_catalog_invalid", string.Join("; ", catalog.Problems));
                var entries = input.Apps.Select(id => catalog.Apps.FirstOrDefault(a => a.Id == id)
                    ?? throw new AppLifecycleException("initialization_app_unknown", $"'{id}' is not in this Core's distribution catalog.")).ToArray();
                var descriptors = SystemAppBootstraps.FromDistribution(entries, config).Descriptors;
                InitializationFiles.Request(paths.DataRoot);
                await SaveAsync(new(InitializationFiles.Schema, "pending", input, fingerprint,
                    descriptors.Select(d => new InitializationInstall(d with { Enabled = true })).ToArray(),
                    PreviousRequests: prior is null ? [] : [.. prior.PreviousRequests ?? [], prior.Request]), ct);
            }
            if (wake.CurrentCount == 0) wake.Release();
        }
        finally { gate.Release(); }
        return await GetAsync(ct);
    }

    private static void ValidateReplay(InitializationDocument? state, InitializationRequest input, string fingerprint)
    {
        if (state?.PreviousRequests?.FirstOrDefault(r => r.RequestId == input.RequestId) is { } retired)
            throw new AppLifecycleException(Fingerprint(retired) == fingerprint ? "initialization_request_superseded" : "initialization_request_conflict",
                "This request belongs to an earlier reviewed selection. Observe and resume the current initialization request.");
        if (state?.Request.RequestId == input.RequestId && state.Fingerprint != fingerprint)
            throw new AppLifecycleException("initialization_request_conflict", "This request ID already belongs to another app selection.");
    }

    public async Task<AuthBootstrapTokenResponse> SetupLinkAsync(CancellationToken ct)
    {
        var status = await GetAsync(ct);
        if (status.Phase is not ("ready" or "existing"))
            throw new AppLifecycleException("initialization_not_ready", "Wait for all selected apps to become ready before administrator registration.");
        if (status.RecoveryRequired)
            throw new AppLifecycleException("initialization_recovery_required", "Existing users require hosty auth recovery-token; initialization cannot reset accounts.");
        return await auth.CreateSetupTokenAsync(ct);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();
        try
        {
            await gate.WaitAsync(stoppingToken);
            try
            {
                var initial = await ReadAsync(stoppingToken);
                if (initial?.Phase is "pending" or "preparing" && wake.CurrentCount == 0) wake.Release();
            }
            finally { gate.Release(); }
            while (!stoppingToken.IsCancellationRequested)
            {
                await wake.WaitAsync(stoppingToken);
                await gate.WaitAsync(stoppingToken);
                try { await RunAsync(stoppingToken); }
                finally { gate.Release(); }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        catch (Exception ex) { logger.LogError(ex, "Initialization worker stopped; the persisted state is retained for diagnosis."); }
    }

    private async Task RunAsync(CancellationToken ct)
    {
        var state = await ReadAsync(ct);
        if (state is null || state.Phase == "ready") return;
        state = state with { Phase = "preparing", Error = null };
        await SaveAsync(state, ct);
        var installs = state.Installs.ToArray();
        var index = 0;
        var dockerChecked = false;
        try
        {
            // Resolve the entire selection before changing installed apps. Each accepted version and
            // digest is durable, so a mutable feed cannot silently change a retry's reviewed inputs.
            for (index = 0; index < installs.Length; index++)
            {
                if (installs[index].ManifestDigest is not null && await apps.GetAppAsync(installs[index].Descriptor.AppId, ct) is not null) continue;
                var (plan, feed) = await PlanAsync(installs[index], ct);
                var item = installs[index];
                var artifacts = CoreJson.Text(plan.ArtifactDigests ?? []);
                if (item.ManifestDigest is not null && (item.ManifestDigest != plan.TargetManifestDigest
                        || item.Version != plan.TargetVersion || item.Runtime != plan.TargetRuntime
                        || item.FeedDigest != feed?.PlanDigest || item.ArtifactDigest != artifacts))
                    throw new AppLifecycleException("initialization_input_changed", $"Accepted install inputs for '{item.Descriptor.AppId}' changed. The previous selection is preserved. Inspect the distribution, then explicitly accept new inputs with hosty init --review.");
                if (plan.RuntimeChoices.FirstOrDefault(c => c.Key == plan.TargetRuntime) is { Available: false } unavailable)
                    throw new AppLifecycleException("initialization_prerequisite", unavailable.Error ?? $"Runtime '{plan.TargetRuntime}' is unavailable.");
                var selection = await manifests.LoadAsync(plan.ManifestPath, plan.TargetRuntime, ct);
                if (selection.Services.Any(service => service.Runtime.Type == "docker") && !dockerChecked)
                {
                    var available = await docker.RunAsync(["info", "--format", "{{.ServerVersion}}"], cancellationToken: ct);
                    if (available.ExitCode != 0) throw new AppLifecycleException("initialization_docker_unavailable", "Start Docker and run hosty init again. Completed work is retained.");
                    dockerChecked = true;
                }
                foreach (var port in state.Request.Ports!.Where(p => p.AppId == item.Descriptor.AppId))
                {
                    var service = selection.Services.FirstOrDefault(s => s.Key == port.Service);
                    var declaration = service?.Runtime.Ports.FirstOrDefault(p => p.Key == port.PortKey);
                    if (declaration is null || declaration.LocalPort is not null || declaration.Expose == "host" || service!.Runtime.IsHostNetwork
                        || declaration.Transport?.Contains("udp") == true)
                        throw new AppLifecycleException("initialization_port_unknown", $"Select an assignable loopback TCP service/port for '{port.AppId}'.");
                    if (port.Port == config.CorePort || !RuntimePortHelper.IsLoopbackTcpPortAvailable(port.Port))
                        throw new AppLifecycleException("initialization_port_occupied", $"Port {port.Port} is occupied; choose a free port before accepting this selection.");
                }
                installs[index] = item with { ManifestDigest = plan.TargetManifestDigest, Version = plan.TargetVersion,
                    Runtime = plan.TargetRuntime, FeedDigest = feed?.PlanDigest, ArtifactDigest = artifacts, State = "planned", Error = null };
                await SaveAsync(state with { Installs = installs }, ct);
            }
            for (index = 0; index < installs.Length; index++)
            {
                var item = installs[index];
                installs[index] = item with { State = "installing", Error = null };
                await SaveAsync(state with { Installs = installs }, ct);
                await InstallAsync(item, ct);
                var app = await apps.GetAppAsync(item.Descriptor.AppId, ct)
                    ?? throw new AppLifecycleException("initialization_install_failed", $"'{item.Descriptor.AppId}' was not installed.");
                foreach (var port in state.Request.Ports!.Where(p => p.AppId == app.Id))
                {
                    var assignment = app.PortAssignments?.FirstOrDefault(p => p.Service == port.Service && p.PortKey == port.PortKey)
                        ?? throw new AppLifecycleException("initialization_port_unknown", $"'{app.Id}' has no assignable {port.Service}/{port.PortKey} port.");
                    if (assignment.HostPort == port.Port && assignment.Source == AppPortSources.Operator) continue;
                    var plan = await lifecycle.ReassignPortPlanAsync(app.Id, port.Service, port.PortKey, ct);
                    await lifecycle.ReassignPortAsync(app.Id, new(port.Service, port.PortKey, plan.Digest, "manual", port.Port), ct);
                }
                installs[index] = item with { State = "starting" };
                await SaveAsync(state with { Installs = installs }, ct);
                if (!AppRuntimeStates.IsUp(app.RuntimeState)) await lifecycle.StartAsync(app.Id, ct);
                using var readiness = CancellationTokenSource.CreateLinkedTokenSource(ct);
                readiness.CancelAfter(TimeSpan.FromMinutes(3));
                try
                {
                    while ((await lifecycle.GetHealthAsync(app.Id, readiness.Token)).Status != "healthy")
                        await Task.Delay(TimeSpan.FromSeconds(1), readiness.Token);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                { throw new AppLifecycleException("initialization_readiness_timeout", $"'{app.Id}' did not become healthy. Inspect its logs and retry hosty init."); }
                installs[index] = item with { State = "ready", Error = null };
                await SaveAsync(state with { Installs = installs }, ct);
            }
            await seed.SaveAsync(state.Request.Apps, [], cancellationToken: ct);
            await SaveAsync(state with { Phase = "ready", Installs = installs }, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            if (index < installs.Length) installs[index] = installs[index] with { State = "failed", Error = ex.Message };
            await SaveAsync(state with { Phase = "failed", Installs = installs, Error = ex.Message }, ct);
            logger.LogWarning("Initialization did not complete: {Error}", ex.Message);
        }
    }
    private async Task<(AppInstallPlan Plan, AppFeedInstallPlan? Feed)> PlanAsync(InitializationInstall item, CancellationToken ct)
    {
        var d = item.Descriptor;
        if (d.FeedsUrl is not null)
        {
            var feed = await lifecycle.CreateFeedInstallPlanAsync(new(d.FeedsUrl, null, d.Runtime, d.Autostart), ct);
            return (feed.Install, feed);
        }
        return (await lifecycle.CreateInstallPlanAsync(new(d.ManifestPath!, d.Runtime, Autostart: d.Autostart), ct), null);
    }
    private async Task InstallAsync(InitializationInstall item, CancellationToken ct)
    {
        var d = item.Descriptor;
        if (await apps.GetAppAsync(d.AppId, ct) is { } installed)
        {
            if (installed.Version != item.Version || installed.SelectedRuntime != item.Runtime)
                throw new AppLifecycleException("initialization_app_changed", $"'{d.AppId}' changed during initialization; inspect it before resuming.");
            return;
        }
        var (plan, feed) = await PlanAsync(item, ct);
        if (plan.TargetManifestDigest != item.ManifestDigest || plan.TargetVersion != item.Version || plan.TargetRuntime != item.Runtime
            || feed?.PlanDigest != item.FeedDigest || CoreJson.Text(plan.ArtifactDigests ?? []) != item.ArtifactDigest)
            throw new AppLifecycleException("initialization_input_changed", $"Install inputs for '{d.AppId}' changed after acceptance.");
        if (feed is not null)
            await lifecycle.ApplyFeedInstallAsync(new(d.FeedsUrl!, feed.FeedId, plan.TargetRuntime, d.Settings, d.Autostart, feed.PlanDigest, false), ct);
        else
            await lifecycle.InstallAsync(new(d.ManifestPath!, plan.TargetRuntime, Settings: d.Settings, Autostart: d.Autostart, PlanId: plan.PlanId, StartOnInstall: false), ct);
        await apps.UpdateAppAsync(d.AppId, record => record with { InstallOrigin = AppInstallOrigins.Distribution }, ct);
    }
}
