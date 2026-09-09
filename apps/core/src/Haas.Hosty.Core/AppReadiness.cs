namespace Haas.Hosty.Core;

// Readiness probing, shared by the start verb's wait and the supervisor's observation
// (docs/features/app-readiness/).
//
// A service that declares an http/tcp healthcheck is probed by it. A service that declares none is
// probed by a tcp connect on every endpoint the app publishes from it — the UI entry, a dependency
// endpoint, an MCP interface — because those are exactly the addresses a client is about to use.
// The implicit probe differs by runtime, and the difference was measured (2026-09-09, Docker Desktop
// on macOS): a tcp connect to a published docker port succeeds the instant the port exists — six
// seconds before the container listens — because the userland proxy accepts on the container's
// behalf. So a localCommand service is probed by tcp connect (nothing sits between Core and the
// process), and a docker service by an http request that the container itself has to answer, on
// its http endpoints only, passing on *any* response — a 401 or a 404 is a server that is up, not one
// that is ill, and a service wanting a stricter answer declares a healthcheck. A docker endpoint that
// is not http (redis, raw tcp) gets no implicit probe: tcp would lie, and http does not apply, so its
// image HEALTHCHECK is the only signal. A service with nothing to probe reads as ready the moment its
// process is alive — the same rule Aspire applies to a resource with no health check.
//
// Precedence: a signal the adapter already produced — a container HEALTHCHECK, or the localCommand
// adapter's own declared-probe result — is never overridden. These probes fill in only where the
// adapter left `Health` null.
internal static class AppReadinessProbes
{
    // One connect attempt's ceiling. Short on purpose: the wait polls about once a second, and a
    // probe that hangs for longer than that would make the budget's resolution the probe's timeout.
    internal static readonly TimeSpan ImplicitProbeTimeout = TimeSpan.FromSeconds(2);

    /// <summary>Probe targets per service, resolved against the endpoint URLs the runtime published.</summary>
    internal static IReadOnlyDictionary<string, IReadOnlyList<HealthProbeTarget>> BuildTargets(
        RuntimeAppManifestSelection selection,
        IReadOnlyList<AppEndpointContract> endpoints,
        TimeSpan timeout)
    {
        var targets = new Dictionary<string, IReadOnlyList<HealthProbeTarget>>(StringComparer.Ordinal);
        foreach (var service in selection.Services)
        {
            var list = new List<HealthProbeTarget>();
            var healthcheck = service.Runtime.Healthcheck;
            if (healthcheck is { Type: "http" or "tcp" })
            {
                // Declared: the same target resolution the localCommand adapter applies, so a docker
                // service declaring http/tcp is probed the way a localCommand one is.
                var port = healthcheck.Port is int declared
                    ? service.Runtime.Ports.FirstOrDefault(candidate => candidate.ContainerPort == declared)
                    : service.Runtime.Ports.FirstOrDefault(candidate => candidate.ContainerPort is not null);
                if (port is not null && ResolveHostPort(endpoints, service.Key, RuntimeServiceDiscovery.PortKey(port)) is int hostPort)
                {
                    var path = string.IsNullOrWhiteSpace(healthcheck.Path)
                        ? "/"
                        : healthcheck.Path!.StartsWith('/') ? healthcheck.Path! : "/" + healthcheck.Path;
                    var declaredTimeout = healthcheck.TimeoutSeconds is int seconds && seconds > 0 ? TimeSpan.FromSeconds(seconds) : timeout;
                    list.Add(new HealthProbeTarget(healthcheck.Type, "127.0.0.1", hostPort, path, declaredTimeout < timeout ? declaredTimeout : timeout));
                }
            }
            else if (healthcheck is null || string.Equals(healthcheck.Type, "none", StringComparison.Ordinal))
            {
                // Implicit: every endpoint the app publishes from this service. An `exec` healthcheck
                // is the container's own and shows up as the adapter's signal, so it takes neither branch.
                var docker = string.Equals(selection.RuntimeProfile.Type, "docker", StringComparison.Ordinal);
                foreach (var published in selection.Manifest.Endpoints)
                {
                    if (!string.Equals(published.Service, service.Key, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    var protocol = string.IsNullOrWhiteSpace(published.Protocol) ? "http" : published.Protocol.ToLowerInvariant();
                    if (docker && protocol is not ("http" or "https"))
                    {
                        continue;
                    }

                    var portKey = published.Port;
                    if (string.IsNullOrWhiteSpace(portKey))
                    {
                        var first = service.Runtime.Ports.FirstOrDefault(candidate => candidate.ContainerPort is not null);
                        portKey = first is null ? null : RuntimeServiceDiscovery.PortKey(first);
                    }

                    if (ResolveHostPort(endpoints, service.Key, portKey) is int hostPort &&
                        !list.Any(existing => existing.Port == hostPort))
                    {
                        list.Add(docker
                            ? new HealthProbeTarget("http", "127.0.0.1", hostPort, "/", timeout, AnyResponse: true)
                            : new HealthProbeTarget("tcp", "127.0.0.1", hostPort, "/", timeout));
                    }
                }
            }

            if (list.Count > 0)
            {
                targets[service.Key] = list;
            }
        }

        return targets;
    }

    // The host port behind a service's port key, read off the URL the runtime published for it. Always
    // probed on loopback rather than on the URL's host: RuntimePublicHost may be a LAN name, and a
    // host->app call must be a literal IPv4 anyway (.NET has no Happy-Eyeballs).
    internal static int? ResolveHostPort(IReadOnlyList<AppEndpointContract> endpoints, string service, string? portKey)
    {
        var endpoint = endpoints.FirstOrDefault(candidate =>
            string.Equals(candidate.Service, service, StringComparison.Ordinal) &&
            (portKey is null || string.Equals(candidate.Port, portKey, StringComparison.Ordinal)) &&
            !string.IsNullOrWhiteSpace(candidate.Url));
        return endpoint?.Url is { } url && Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Port > 0
            ? uri.Port
            : null;
    }

    /// <summary>
    /// Fills <c>Health</c> for every running service the adapter left unprobed and this class has a
    /// target for. Services the adapter already answered for, services that are not running, and
    /// services with nothing to probe pass through unchanged.
    /// </summary>
    internal static async Task<IReadOnlyList<AppRuntimeServiceHealth>> ApplyAsync(
        IReadOnlyList<AppRuntimeServiceHealth> services,
        IReadOnlyDictionary<string, IReadOnlyList<HealthProbeTarget>> targets,
        IHealthProbe probe,
        CancellationToken cancellationToken)
    {
        var result = new List<AppRuntimeServiceHealth>(services.Count);
        foreach (var service in services)
        {
            if (service.Health is not null ||
                !string.Equals(service.Status, "running", StringComparison.Ordinal) ||
                !targets.TryGetValue(service.Service, out var serviceTargets))
            {
                result.Add(service);
                continue;
            }

            var healthy = true;
            foreach (var target in serviceTargets)
            {
                if (!await probe.ProbeAsync(target, cancellationToken))
                {
                    healthy = false;
                    break;
                }
            }

            result.Add(service with { Health = healthy ? "healthy" : "unhealthy" });
        }

        return result;
    }

    /// <summary>The per-app fold, and the snapshot the record persists.</summary>
    internal static AppHealthSummary Summarize(IReadOnlyList<AppRuntimeServiceHealth> services, DateTimeOffset observedAt)
        => new(
            Fold(services),
            services.Select(service => new AppServiceHealthSummary(service.Service, service.Status, service.Health)).ToArray(),
            observedAt);

    // The docker adapter's fold, with the localCommand adapter's one difference kept: a set of services
    // that all *exited* is a failure ("unhealthy"), not the "unknown" a set of never-seen containers is.
    internal static string Fold(IReadOnlyList<AppRuntimeServiceHealth> services)
    {
        var status = DockerRuntimeAdapter.SummarizeHealthStatus(services);
        return status == "unknown" && services.Count > 0 && services.Any(service => string.Equals(service.Status, "exited", StringComparison.Ordinal))
            ? "unhealthy"
            : status;
    }

    /// <summary>Whether two snapshots say the same thing, ignoring when they were taken.</summary>
    internal static bool SameReading(AppHealthSummary? left, AppHealthSummary? right)
    {
        if (left is null || right is null)
        {
            return left is null && right is null;
        }

        return string.Equals(left.Status, right.Status, StringComparison.Ordinal) &&
            left.Services.Count == right.Services.Count &&
            left.Services.Zip(right.Services).All(pair =>
                string.Equals(pair.First.Service, pair.Second.Service, StringComparison.Ordinal) &&
                string.Equals(pair.First.Status, pair.Second.Status, StringComparison.Ordinal) &&
                string.Equals(pair.First.Health, pair.Second.Health, StringComparison.Ordinal));
    }
}
