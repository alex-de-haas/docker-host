using Haas.Hosty.Core;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core.Tests;

public sealed class DockerRuntimeAdapterTests
{
    [Fact]
    public void BuildDockerCoreEnvironment_SplitsContainerAndBrowserOrigins()
    {
        var config = CreateConfig(corePort: 7070, listenUrl: "http://localhost:7070", corePublicOrigin: null);

        var result = DockerRuntimeAdapter.BuildDockerCoreEnvironment(config, "http://localhost:7070");

        Assert.Contains("HOSTY_CORE_PORT=7070", result);
        Assert.Contains("HOSTY_CORE_PUBLIC_ORIGIN=http://localhost:7070", result);
        Assert.Contains("HOSTY_CORE_ORIGIN=http://host.docker.internal:7070", result);
        Assert.DoesNotContain("HOSTY_CORE_PUBLIC_ORIGIN=http://host.docker.internal:7070", result);
    }

    // The decoupling: the container's route to Core is derived from the listen URL, so a public origin
    // never sends app-to-Core traffic out through the tunnel and back. The browser-facing value still
    // carries it, which is the whole point of keeping the two variables apart.
    [Fact]
    public void BuildDockerCoreEnvironment_DoesNotRouteContainerTrafficThroughThePublicOrigin()
    {
        var config = CreateConfig(corePort: 7070, listenUrl: "http://localhost:7070", corePublicOrigin: "https://core.example.test");

        var result = DockerRuntimeAdapter.BuildDockerCoreEnvironment(config, "https://core.example.test");

        Assert.Contains("HOSTY_CORE_PUBLIC_ORIGIN=https://core.example.test", result);
        Assert.Contains("HOSTY_CORE_ORIGIN=http://host.docker.internal:7070", result);
        Assert.DoesNotContain("HOSTY_CORE_ORIGIN=https://core.example.test", result);
    }

    // A listen URL that is already non-loopback (a host binding to a LAN address) is passed through
    // unchanged, exactly as a non-loopback value always was — the change is where the value comes from,
    // not how it is rewritten.
    [Fact]
    public void BuildDockerCoreEnvironment_DerivesTheContainerOriginFromTheListenUrl()
    {
        var config = CreateConfig(corePort: 7171, listenUrl: "http://192.168.1.10:7171", corePublicOrigin: "https://core.example.test");

        var result = DockerRuntimeAdapter.BuildDockerCoreEnvironment(config, "https://core.example.test");

        Assert.Contains("HOSTY_CORE_ORIGIN=http://192.168.1.10:7171", result);
    }

    [Theory]
    [InlineData("http://localhost:7070", "http://host.docker.internal:7070")]
    [InlineData("http://127.0.0.1:7070", "http://host.docker.internal:7070")]
    [InlineData("http://[::1]:7070", "http://host.docker.internal:7070")]
    [InlineData("https://localhost:7443", "https://host.docker.internal:7443")]
    public void BuildDockerCoreOrigin_RewritesLoopbackOriginsForContainerAccess(
        string coreOrigin,
        string expected)
    {
        var result = DockerRuntimeAdapter.BuildDockerCoreOrigin(coreOrigin);

        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("https://core.example")]
    [InlineData("http://192.168.1.20:7070")]
    [InlineData("not-a-url")]
    public void BuildDockerCoreOrigin_KeepsNonLoopbackOrigins(string coreOrigin)
    {
        var result = DockerRuntimeAdapter.BuildDockerCoreOrigin(coreOrigin);

        Assert.Equal(coreOrigin, result);
    }

    [Fact]
    public void BuildPortArguments_DefaultPort_PublishesLoopbackTcpOnlyAndInjectsHostPortOnce()
    {
        var port = new RuntimePortManifest { Key = "http", ContainerPort = 8080 };

        var args = DockerRuntimeAdapter.BuildPortArguments(port, hostPort: 49152, containerPort: 8080);

        // Byte-for-byte unchanged from the legacy publish: loopback bind, no protocol suffix.
        Assert.Equal(["-p", "127.0.0.1:49152:8080", "-e", "HOSTY_PORT_HTTP=49152"], args);
        Assert.DoesNotContain(args, arg => arg.Contains("/udp"));
        Assert.Single(args, arg => arg.StartsWith("HOSTY_PORT_", StringComparison.Ordinal));
    }

    [Fact]
    public void BuildPortArguments_HostExposedTcpAndUdp_PublishesBothProtocolsOnAllInterfaces()
    {
        var port = new RuntimePortManifest
        {
            Key = "torrent",
            ContainerPort = 6881,
            HostPort = 6881,
            Expose = "host",
            Transport = ["tcp", "udp"],
        };

        var args = DockerRuntimeAdapter.BuildPortArguments(port, hostPort: 6881, containerPort: 6881);

        Assert.Contains("0.0.0.0:6881:6881/tcp", args);
        Assert.Contains("0.0.0.0:6881:6881/udp", args);
        Assert.Equal(2, args.Count(arg => arg == "-p"));
        Assert.DoesNotContain("127.0.0.1:6881:6881", args);
        // HOSTY_PORT_* is injected exactly once even though two protocols are published.
        Assert.Single(args, arg => arg.StartsWith("HOSTY_PORT_", StringComparison.Ordinal));
        Assert.Contains("HOSTY_PORT_TORRENT=6881", args);
    }

    [Theory]
    [InlineData("host", "0.0.0.0")]
    [InlineData("HOST", "0.0.0.0")]
    [InlineData("loopback", "127.0.0.1")]
    public void BuildPortArguments_ExposeControlsBindAddress(string expose, string expectedBind)
    {
        var port = new RuntimePortManifest { ContainerPort = 6881, HostPort = 6881, Expose = expose };

        var args = DockerRuntimeAdapter.BuildPortArguments(port, hostPort: 6881, containerPort: 6881);

        Assert.Contains($"{expectedBind}:6881:6881/tcp", args);
    }

    [Fact]
    public void BuildPortArguments_HostNetwork_OmitsPublishButKeepsHostPortEnv()
    {
        // Under `--network host` docker discards `-p`, so Core emits none; HOSTY_PORT_* still carries
        // the container port the listener already binds directly on the host.
        var port = new RuntimePortManifest { Key = "torrent", ContainerPort = 6881, Expose = "host", Transport = ["tcp", "udp"] };

        var args = DockerRuntimeAdapter.BuildPortArguments(port, hostPort: 6881, containerPort: 6881, hostNetwork: true);

        Assert.DoesNotContain("-p", args);
        Assert.Equal(["-e", "HOSTY_PORT_TORRENT=6881"], args);
    }

    [Fact]
    public void BuildDockerServiceUrl_HostNetworkedTarget_UsesHostDockerInternal()
    {
        // A host-networked sibling is not on the per-app user network, so a dependent reaches it via
        // host.docker.internal at its container port rather than the service-name alias.
        var service = new RuntimeSelectedService(
            "api",
            [],
            new RuntimeServiceProfileManifest
            {
                Type = "docker",
                Network = "host",
                Ports = [new RuntimePortManifest { Key = "internal", ContainerPort = 8080 }],
            },
            null,
            "image");
        var port = new RuntimePortManifest { Key = "internal", ContainerPort = 8080 };

        var url = DockerRuntimeAdapter.BuildDockerServiceUrl(service, port);

        Assert.Equal("http://host.docker.internal:8080", url);
    }

    [Fact]
    public void BuildDockerServiceUrl_TargetsSiblingAliasAtContainerPort()
    {
        var service = new RuntimeSelectedService(
            "api",
            [],
            new RuntimeServiceProfileManifest { Type = "docker", Ports = [new RuntimePortManifest { Key = "internal", ContainerPort = 3000 }] },
            null,
            "image");
        var port = new RuntimePortManifest { Key = "internal", ContainerPort = 3000 };

        var url = DockerRuntimeAdapter.BuildDockerServiceUrl(service, port);

        Assert.Equal("http://api:3000", url);
    }

    [Fact]
    public void BuildPrivilegedArguments_EmitsCapAddAndDevice_NormalizingCapabilityNames()
    {
        var runtime = new RuntimeServiceProfileManifest
        {
            Type = "docker",
            Capabilities = ["NET_ADMIN", "cap_mknod"],
            Devices = ["/dev/net/tun"],
        };

        var args = DockerRuntimeAdapter.BuildPrivilegedArguments(runtime);

        Assert.Equal(["--cap-add", "NET_ADMIN", "--cap-add", "MKNOD", "--device", "/dev/net/tun"], args);
    }

    [Fact]
    public void BuildPrivilegedArguments_EmptyWhenNoneDeclared()
        => Assert.Empty(DockerRuntimeAdapter.BuildPrivilegedArguments(new RuntimeServiceProfileManifest { Type = "docker" }));

    [Fact]
    public void BuildHealthcheckArguments_ExecHealthcheck_EmitsAllDockerFlags()
    {
        var runtime = new RuntimeServiceProfileManifest
        {
            Type = "docker",
            Healthcheck = new RuntimeServiceHealthcheckManifest
            {
                Type = "exec",
                Command = "curl -f http://localhost:8080/health || exit 1",
                IntervalSeconds = 30,
                TimeoutSeconds = 5,
                Retries = 3,
                GracePeriodSeconds = 10,
            },
        };

        var args = DockerRuntimeAdapter.BuildHealthcheckArguments(runtime);

        Assert.Equal(
        [
            "--health-cmd", "curl -f http://localhost:8080/health || exit 1",
            "--health-interval", "30s",
            "--health-timeout", "5s",
            "--health-retries", "3",
            "--health-start-period", "10s",
        ], args);
    }

    [Fact]
    public void BuildHealthcheckArguments_ExecWithoutTuning_EmitsOnlyCommand()
        => Assert.Equal(
            ["--health-cmd", "true"],
            DockerRuntimeAdapter.BuildHealthcheckArguments(new RuntimeServiceProfileManifest
            {
                Type = "docker",
                Healthcheck = new RuntimeServiceHealthcheckManifest { Type = "exec", Command = "true" },
            }));

    [Theory]
    [InlineData("none")]
    [InlineData("http")]
    public void BuildHealthcheckArguments_NonExecType_EmitsNothing(string type)
        => Assert.Empty(DockerRuntimeAdapter.BuildHealthcheckArguments(new RuntimeServiceProfileManifest
        {
            Type = "docker",
            Healthcheck = new RuntimeServiceHealthcheckManifest { Type = type, Command = "true" },
        }));

    [Fact]
    public void BuildHealthcheckArguments_NoHealthcheck_EmitsNothing()
        => Assert.Empty(DockerRuntimeAdapter.BuildHealthcheckArguments(new RuntimeServiceProfileManifest { Type = "docker" }));

    [Theory]
    [InlineData("NET_ADMIN", "NET_ADMIN")]
    [InlineData("net_admin", "NET_ADMIN")]
    [InlineData("CAP_NET_ADMIN", "NET_ADMIN")]
    [InlineData("  cap_sys_time ", "SYS_TIME")]
    public void LinuxCapabilities_Normalize_StripsPrefixAndUppercases(string input, string expected)
        => Assert.Equal(expected, LinuxCapabilities.Normalize(input));

    [Fact]
    public void BuildNetworkName_DefaultInstance_DerivesStableDockerSafeName()
        => Assert.Equal("hosty-com-example-app-net", DockerRuntimeAdapter.BuildNetworkName("", "com.example.app"));

    [Fact]
    public void BuildNetworkName_ScopedInstance_PrefixesTheInstanceScope()
        => Assert.Equal(
            "hosty-0123456789ab-com-example-app-net",
            DockerRuntimeAdapter.BuildNetworkName("0123456789abcdef0123456789abcdef", "com.example.app"));

    [Fact]
    public void BuildContainerName_DefaultInstance_KeepsLegacyUnscopedName()
        => Assert.Equal(
            "hosty-com-example-app-web",
            DockerRuntimeAdapter.BuildContainerName("", "com.example.app", "web"));

    [Fact]
    public void BuildContainerName_ScopedInstance_PrefixesTheInstanceScope()
        => Assert.Equal(
            "hosty-0123456789ab-com-example-app-web",
            DockerRuntimeAdapter.BuildContainerName("0123456789abcdef0123456789abcdef", "com.example.app", "web"));

    [Fact]
    public void RequiresUserNetwork_OnlyWhenAServiceDependsOnAnother()
    {
        var api = new RuntimeSelectedService("api", [], new RuntimeServiceProfileManifest { Type = "docker" }, null, "image");
        var web = new RuntimeSelectedService("web", [new RuntimeServiceDependency("api", null)], new RuntimeServiceProfileManifest { Type = "docker" }, null, "image");

        Assert.False(DockerRuntimeAdapter.RequiresUserNetwork([api]));
        Assert.True(DockerRuntimeAdapter.RequiresUserNetwork([api, web]));
    }

    [Theory]
    // "rolling" was removed; a record that persisted it before the removal surfaces as pinned.
    [InlineData("rolling", "pinned")]
    [InlineData("Rolling", "pinned")]
    [InlineData("pinned", "pinned")]
    [InlineData(null, "pinned")]
    [InlineData("", "pinned")]
    [InlineData("anything-else", "pinned")]
    public void ResolveUpdatePolicy_AlwaysPinned(string? input, string expected)
        => Assert.Equal(expected, DockerRuntimeAdapter.ResolveUpdatePolicy(input));

    [Fact]
    public void ParsePullDigest_ExtractsDigestLine()
    {
        var digest = "sha256:" + new string('a', 64);
        var output = $"latest: Pulling from example/app\nfoo: Pull complete\nDigest: {digest}\nStatus: Downloaded newer image";

        Assert.Equal(digest, DockerRuntimeAdapter.ParsePullDigest(output));
    }

    [Fact]
    public void ParsePullDigest_ReturnsNullWhenNoDigestLine()
        => Assert.Null(DockerRuntimeAdapter.ParsePullDigest("Status: Image is up to date for example/app:latest"));

    [Fact]
    public void ParseRepoDigest_ExtractsShaFromRepoDigestReference()
    {
        var digest = "sha256:" + new string('b', 64);

        Assert.Equal(digest, DockerRuntimeAdapter.ParseRepoDigest($"ghcr.io/example/app@{digest}"));
    }

    [Theory]
    [InlineData("<no value>")]
    [InlineData("")]
    [InlineData("ghcr.io/example/app@sha256:short")]
    public void ParseRepoDigest_ReturnsNullForUnusableValues(string value)
        => Assert.Null(DockerRuntimeAdapter.ParseRepoDigest(value));

    [Fact]
    public void ParseManifestInspectDigest_ReadsDescriptorDigestFromObject()
    {
        var digest = "sha256:" + new string('c', 64);

        Assert.Equal(digest, DockerRuntimeAdapter.ParseManifestInspectDigest("{\"Descriptor\":{\"digest\":\"" + digest + "\"}}"));
    }

    [Theory]
    [InlineData("[{\"Descriptor\":{\"digest\":\"sha256:x\"}}]")]
    [InlineData("not json")]
    [InlineData("{}")]
    public void ParseManifestInspectDigest_ReturnsNullForListOrInvalid(string json)
        => Assert.Null(DockerRuntimeAdapter.ParseManifestInspectDigest(json));

    [Fact]
    public void ParseContainerInspect_ParsesTabSeparatedFields()
    {
        var info = DockerRuntimeAdapter.ParseContainerInspect("running\t4321\t0\tsha256:imageid\tghcr.io/example/app@sha256:abc");

        Assert.Equal("running", info.Status);
        Assert.Equal(4321, info.Pid);
        Assert.Equal(0, info.ExitCode);
        Assert.Equal("sha256:imageid", info.ImageId);
        Assert.Equal("ghcr.io/example/app@sha256:abc", info.ConfigImage);
    }

    [Fact]
    public void ParseContainerInspect_MapsNonRunningStateToStopped()
        => Assert.Equal("stopped", DockerRuntimeAdapter.ParseContainerInspect("exited\t0\t137\t\t").Status);

    [Fact]
    public void ParseContainerInspect_ParsesHealthRestartAndStartedAt()
    {
        var info = DockerRuntimeAdapter.ParseContainerInspect(
            "running\t4321\t0\tsha256:imageid\tghcr.io/example/app@sha256:abc\thealthy\t3\t2026-06-27T10:00:00Z");

        Assert.Equal("healthy", info.Health);
        Assert.Equal(3, info.RestartCount);
        Assert.Equal("2026-06-27T10:00:00Z", info.StartedAt);
    }

    [Fact]
    public void ParseContainerInspect_BlankHealthFieldMeansNoSignal()
    {
        var info = DockerRuntimeAdapter.ParseContainerInspect(
            "running\t4321\t0\tsha256:imageid\tghcr.io/example/app@sha256:abc\t\t0\t2026-06-27T10:00:00Z");

        Assert.Null(info.Health);
        Assert.Equal(0, info.RestartCount);
    }

    [Fact]
    public void ParseContainerInspect_NeverStartedTimestampIsNull()
        => Assert.Null(DockerRuntimeAdapter.ParseContainerInspect(
            "created\t0\t0\t\t\t\t0\t0001-01-01T00:00:00Z").StartedAt);

    [Theory]
    [InlineData("healthy", "healthy")]
    [InlineData("UNHEALTHY", "unhealthy")]
    [InlineData("starting", "starting")]
    [InlineData("", null)]
    [InlineData("none", null)]
    [InlineData("weird", null)]
    public void NormalizeHealth_MapsKnownStatusesAndNullsTheRest(string input, string? expected)
        => Assert.Equal(expected, DockerRuntimeAdapter.NormalizeHealth(input));

    [Fact]
    public void SummarizeHealthStatus_AllRunningHealthyOrNoHealthcheck_IsHealthy()
        => Assert.Equal("healthy", DockerRuntimeAdapter.SummarizeHealthStatus(
            [Svc("a", "running", "healthy"), Svc("b", "running", null)]));

    [Fact]
    public void SummarizeHealthStatus_RunningButUnhealthyHealthcheck_IsDegraded()
        => Assert.Equal("degraded", DockerRuntimeAdapter.SummarizeHealthStatus(
            [Svc("a", "running", "healthy"), Svc("b", "running", "unhealthy")]));

    [Fact]
    public void SummarizeHealthStatus_RunningButStarting_IsStarting()
        => Assert.Equal("starting", DockerRuntimeAdapter.SummarizeHealthStatus(
            [Svc("a", "running", "starting")]));

    [Fact]
    public void SummarizeHealthStatus_PartialLiveness_StaysUnhealthy()
        => Assert.Equal("unhealthy", DockerRuntimeAdapter.SummarizeHealthStatus(
            [Svc("a", "running", "healthy"), Svc("b", "stopped", null)]));

    [Fact]
    public void SummarizeHealthStatus_AllStopped_IsStopped()
        => Assert.Equal("stopped", DockerRuntimeAdapter.SummarizeHealthStatus(
            [Svc("a", "stopped", null)]));

    private static AppRuntimeServiceHealth Svc(string service, string status, string? health)
        => new(service, status, null, null, null, null, null, Health: health);

    [Fact]
    public async Task StartAsync_NoLock_PullsTagResolvesDigestAndRecordsLock()
    {
        var digest = "sha256:" + new string('a', 64);
        var runner = new FakeDockerCommandRunner(args =>
            args[0] == "pull"
                ? new DockerCommandResult(0, $"latest: Pulling from example/app\nDigest: {digest}\nStatus: Downloaded", "")
                : new DockerCommandResult(0, "", ""));

        var result = await CreateAdapter(runner).StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", locks: null)));

        Assert.True(runner.Ran("pull", "ghcr.io/example/app:latest"));
        Assert.Equal($"ghcr.io/example/app@{digest}", runner.Find("run")![^1]);
        Assert.Equal(digest, result.ArtifactLocks?["app"].ImageDigest);
        Assert.Equal("ghcr.io/example/app:latest", result.ArtifactLocks?["app"].ResolvedFromRef);
    }

    [Fact]
    public async Task StartAsync_NoLock_FallsBackToInspectWhenPullHasNoDigestLine()
    {
        var digest = "sha256:" + new string('e', 64);
        var runner = new FakeDockerCommandRunner(args => args[0] switch
        {
            "pull" => new DockerCommandResult(0, "Status: Image is up to date for ghcr.io/example/app:latest", ""),
            "inspect" => new DockerCommandResult(0, $"ghcr.io/example/app@{digest}", ""),
            _ => new DockerCommandResult(0, "", ""),
        });

        var result = await CreateAdapter(runner).StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", locks: null)));

        Assert.Equal(digest, result.ArtifactLocks?["app"].ImageDigest);
        Assert.Equal($"ghcr.io/example/app@{digest}", runner.Find("run")![^1]);
    }

    [Fact]
    public async Task StartAsync_NoLockPullFailsButImagePresentLocally_FallsBackToLocalDigest()
    {
        var digest = "sha256:" + new string('9', 64);
        var runner = new FakeDockerCommandRunner(args => args switch
        {
            ["pull", ..] => new DockerCommandResult(1, "", "network unreachable"),
            ["image", "inspect", ..] => new DockerCommandResult(0, "[{}]", ""),
            ["inspect", ..] => new DockerCommandResult(0, $"ghcr.io/example/app@{digest}", ""),
            _ => new DockerCommandResult(0, "", ""),
        });

        var result = await CreateAdapter(runner).StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", locks: null)));

        Assert.Equal(digest, result.ArtifactLocks?["app"].ImageDigest);
        Assert.Equal($"ghcr.io/example/app@{digest}", runner.Find("run")![^1]);
    }

    [Fact]
    public async Task StartAsync_NoLockPullFailsAndImageAbsent_Throws()
    {
        var runner = new FakeDockerCommandRunner(args => args switch
        {
            ["pull", ..] => new DockerCommandResult(1, "", "network unreachable"),
            ["image", "inspect", ..] => new DockerCommandResult(1, "", "No such image"),
            _ => new DockerCommandResult(0, "", ""),
        });

        await Assert.ThrowsAsync<AppLifecycleException>(() =>
            CreateAdapter(runner).StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", locks: null))));
    }

    [Fact]
    public async Task StartAsync_PinnedWithLockPresentLocally_RunsLockWithoutPulling()
    {
        var digest = "sha256:" + new string('a', 64);
        var locks = LockMap(digest);
        // `image inspect` succeeding means the pinned image is already present, so nothing is pulled.
        var runner = new FakeDockerCommandRunner(args =>
            args is ["image", "inspect", ..] ? new DockerCommandResult(0, "[{}]", "") : new DockerCommandResult(0, "", ""));

        var result = await CreateAdapter(runner).StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", locks)));

        Assert.DoesNotContain(runner.Commands, command => command[0] == "pull");
        Assert.Equal($"ghcr.io/example/app@{digest}", runner.Find("run")![^1]);
        Assert.Equal(digest, result.ArtifactLocks?["app"].ImageDigest);
    }

    [Fact]
    public async Task StartAsync_PinnedWithLockMissingLocally_PullsByDigestNotTag()
    {
        var digest = "sha256:" + new string('a', 64);
        var runner = new FakeDockerCommandRunner(args =>
            args is ["image", "inspect", ..] ? new DockerCommandResult(1, "", "No such image") : new DockerCommandResult(0, "", ""));

        await CreateAdapter(runner).StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", LockMap(digest))));

        Assert.True(runner.Ran("pull", $"ghcr.io/example/app@{digest}"));
        Assert.False(runner.Ran("pull", "ghcr.io/example/app:latest"));
        Assert.Equal($"ghcr.io/example/app@{digest}", runner.Find("run")![^1]);
    }

    [Fact]
    public async Task StartAsync_PinnedWithNoLock_ResolvesTagAndBackfillsLock()
    {
        var digest = "sha256:" + new string('d', 64);
        var runner = new FakeDockerCommandRunner(args =>
            args[0] == "pull" ? new DockerCommandResult(0, $"Digest: {digest}\nStatus: Downloaded", "") : new DockerCommandResult(0, "", ""));

        var result = await CreateAdapter(runner).StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", locks: null)));

        Assert.True(runner.Ran("pull", "ghcr.io/example/app:latest"));
        Assert.Equal($"ghcr.io/example/app@{digest}", runner.Find("run")![^1]);
        Assert.Equal(digest, result.ArtifactLocks?["app"].ImageDigest);
    }

    [Fact]
    public async Task ResolveRemoteDigestAsync_PrefersImagetoolsDigest()
    {
        var digest = "sha256:" + new string('f', 64);
        var runner = new FakeDockerCommandRunner(args =>
            args[0] == "buildx" ? new DockerCommandResult(0, digest + "\n", "") : new DockerCommandResult(1, "", "unused"));

        var result = await CreateAdapter(runner).ResolveRemoteDigestAsync(new RuntimeDockerImage("ghcr.io/example/app", "latest"));

        Assert.Equal(digest, result);
    }

    [Fact]
    public async Task ResolveRemoteDigestAsync_FallsBackToManifestInspect()
    {
        var digest = "sha256:" + new string('0', 64);
        var runner = new FakeDockerCommandRunner(args => args[0] switch
        {
            "buildx" => new DockerCommandResult(1, "", "not supported"),
            "manifest" => new DockerCommandResult(0, "{\"Descriptor\":{\"digest\":\"" + digest + "\"}}", ""),
            _ => new DockerCommandResult(1, "", ""),
        });

        Assert.Equal(digest, await CreateAdapter(runner).ResolveRemoteDigestAsync(new RuntimeDockerImage("ghcr.io/example/app", "latest")));
    }

    [Fact]
    public async Task ResolveRemoteDigestAsync_ReturnsNullWhenRegistryUnreachable()
    {
        var runner = new FakeDockerCommandRunner(_ => new DockerCommandResult(1, "", "connection refused"));

        Assert.Null(await CreateAdapter(runner).ResolveRemoteDigestAsync(new RuntimeDockerImage("ghcr.io/example/app", "latest")));
    }

    [Fact]
    public async Task ResolveRemoteDigestAsync_LogsWhyBothRegistryProbesFailed()
    {
        // A null here reaches the operator as a bare "unknown" in an update plan or update-status row.
        // Without this warning the reason lives only in docker's stderr and is dropped, so a rate limit,
        // an auth failure and an unreachable registry are indistinguishable — and an intermittent one
        // looks like a digest randomly flapping between real and "unknown".
        var runner = new FakeDockerCommandRunner(args => args[0] switch
        {
            "buildx" => new DockerCommandResult(125, "", "ERROR: unknown flag: --format"),
            _ => new DockerCommandResult(1, "", "toomanyrequests: retry-after 60s"),
        });
        var logger = new CapturingLogger<DockerRuntimeAdapter>();

        Assert.Null(await CreateAdapter(runner, logger).ResolveRemoteDigestAsync(new RuntimeDockerImage("ghcr.io/example/app", "latest")));

        var warning = Assert.Single(logger.Warnings);
        Assert.Contains("ghcr.io/example/app:latest", warning, StringComparison.Ordinal);
        Assert.Contains("unknown flag: --format", warning, StringComparison.Ordinal);
        Assert.Contains("toomanyrequests", warning, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ResolveRemoteDigestAsync_LogsWhenAProbeSucceedsButYieldsNoDigest()
    {
        // Exit 0 with unparseable output is a different failure from a non-zero exit, and it used to be
        // just as silent: the old code returned null for any unparseable manifest-inspect payload.
        var runner = new FakeDockerCommandRunner(args => args[0] switch
        {
            "buildx" => new DockerCommandResult(1, "", "no builder"),
            _ => new DockerCommandResult(0, "{\"Descriptor\":{}}", ""),
        });
        var logger = new CapturingLogger<DockerRuntimeAdapter>();

        Assert.Null(await CreateAdapter(runner, logger).ResolveRemoteDigestAsync(new RuntimeDockerImage("ghcr.io/example/app", "latest")));

        Assert.Contains("<no digest in output>", Assert.Single(logger.Warnings), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ResolveRemoteDigestAsync_ReportsUnknownWhenAProbeThrowsUnexpectedly()
    {
        // "null when it cannot resolve" has to be total: BuildArtifactDigestChangesAsync calls this with
        // no try/catch of its own, so an escaping exception would fail the operator's whole update plan
        // instead of degrading one service to "unknown". The default runner funnels its own failures into
        // exit 127, but the runner is an injectable seam — the contract must not rest on that.
        var runner = new FakeDockerCommandRunner(_ => throw new IOException("broken pipe"));
        var logger = new CapturingLogger<DockerRuntimeAdapter>();

        Assert.Null(await CreateAdapter(runner, logger).ResolveRemoteDigestAsync(new RuntimeDockerImage("ghcr.io/example/app", "latest")));

        Assert.Contains("broken pipe", Assert.Single(logger.Warnings), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ResolveRemoteDigestAsync_LetsCancellationPropagate()
    {
        // An aborted request is not an unresolvable digest: swallowing it would report a phantom
        // "unknown" for an image nobody actually asked about any more.
        var runner = new FakeDockerCommandRunner(_ => throw new OperationCanceledException());

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => CreateAdapter(runner).ResolveRemoteDigestAsync(new RuntimeDockerImage("ghcr.io/example/app", "latest")));
    }

    [Fact]
    public async Task ResolveRemoteDigestAsync_PrefersTheRegistryProbeOverTheDockerCli()
    {
        // The whole point of the HTTP resolver: the same answer without paying for buildx, which is
        // roughly 7x the cost of a plain registry round-trip and dominates a fleet update check.
        var digest = "sha256:" + new string('b', 64);
        var runner = new FakeDockerCommandRunner();

        Assert.Equal(
            digest,
            await CreateAdapter(runner, registryDigestResolver: new StubRegistryDigestResolver(digest))
                .ResolveRemoteDigestAsync(new RuntimeDockerImage("ghcr.io/example/app", "latest")));

        Assert.Empty(runner.Commands);
    }

    [Fact]
    public async Task ResolveRemoteDigestAsync_FallsBackToTheDockerCliWhenTheRegistryProbeDeclines()
    {
        // A private registry the operator has `docker login`-ed to is reachable only through the CLI:
        // Core never reads those credentials, so the HTTP probe returns null and the CLI answers.
        var digest = "sha256:" + new string('c', 64);
        var runner = new FakeDockerCommandRunner(args =>
            args[0] == "buildx" ? new DockerCommandResult(0, digest + "\n", "") : new DockerCommandResult(1, "", ""));

        Assert.Equal(
            digest,
            await CreateAdapter(runner, registryDigestResolver: new StubRegistryDigestResolver(null))
                .ResolveRemoteDigestAsync(new RuntimeDockerImage("registry.internal.test/team/app", "latest")));

        Assert.Equal("buildx", Assert.Single(runner.Commands)[0]);
    }

    [Fact]
    public async Task ResolveRemoteDigestAsync_TimesOutToUnknownRatherThanHoldingItsProbeSlot()
    {
        // The shared docker runner's deadline is sized for `docker pull`, which is the wrong budget
        // for a metadata lookup: an unresponsive registry would otherwise pin this probe — and the
        // host-wide probe slot it holds — long past the point of usefulness. A registry that never
        // answers is an unresolvable digest, which is exactly what "unknown" means here.
        var runner = new BlockingDockerCommandRunner();
        var logger = new CapturingLogger<DockerRuntimeAdapter>();

        var digest = await CreateAdapter(runner, logger, digestProbeTimeout: TimeSpan.FromMilliseconds(150))
            .ResolveRemoteDigestAsync(new RuntimeDockerImage("ghcr.io/example/app", "latest"));

        Assert.Null(digest);
        Assert.Contains(logger.Warnings, warning => warning.Contains("timed out", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ResolveRemoteDigestAsync_DoesNotLogWhenResolutionSucceeds()
    {
        var digest = "sha256:" + new string('a', 64);
        var runner = new FakeDockerCommandRunner(args =>
            args[0] == "buildx" ? new DockerCommandResult(0, digest + "\n", "") : new DockerCommandResult(1, "", ""));
        var logger = new CapturingLogger<DockerRuntimeAdapter>();

        Assert.Equal(digest, await CreateAdapter(runner, logger).ResolveRemoteDigestAsync(new RuntimeDockerImage("ghcr.io/example/app", "latest")));

        // A fleet "Check updates" resolves every service of every app, so the healthy path must stay quiet.
        Assert.Empty(logger.Warnings);
    }

    [Fact]
    public void BuildTelemetryEnvironment_InjectsOtelWhenEnabledWithEndpoint()
    {
        var context = CreateTelemetryContext(enabled: true, sampleRatio: 0.25, endpoint: "http://localhost:4318");

        var env = DockerRuntimeAdapter.BuildTelemetryEnvironment(context, "app");

        Assert.Contains("OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318", env);
        Assert.Contains("OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf", env);
        Assert.Contains("OTEL_SERVICE_NAME=com.example.app", env);
        Assert.Contains("OTEL_RESOURCE_ATTRIBUTES=service.name=com.example.app,hosty.app.id=com.example.app,hosty.app.service=app", env);
        Assert.Contains("OTEL_TRACES_SAMPLER=parentbased_traceidratio", env);
        Assert.Contains("OTEL_TRACES_SAMPLER_ARG=0.25", env);
    }

    [Fact]
    public void BuildTelemetryEnvironment_PreservesSmallSampleRatio()
    {
        // A fixed "0.###" format would truncate this to "0" and silently disable traces.
        var context = CreateTelemetryContext(enabled: true, sampleRatio: 0.0005, endpoint: "http://localhost:4318");

        Assert.Contains("OTEL_TRACES_SAMPLER_ARG=0.0005", DockerRuntimeAdapter.BuildTelemetryEnvironment(context, "app"));
    }

    [Fact]
    public void BuildTelemetryEnvironment_EmptyWhenTelemetryDisabled()
    {
        var context = CreateTelemetryContext(enabled: false, sampleRatio: null, endpoint: "http://localhost:4318");

        Assert.Empty(DockerRuntimeAdapter.BuildTelemetryEnvironment(context, "app"));
    }

    [Fact]
    public void BuildTelemetryEnvironment_EmptyWhenNoCollectorEndpoint()
    {
        var context = CreateTelemetryContext(enabled: true, sampleRatio: null, endpoint: null);

        Assert.Empty(DockerRuntimeAdapter.BuildTelemetryEnvironment(context, "app"));
    }

    [Fact]
    public void TelemetrySettings_BuildEnvironment_UsesEndpointVerbatimForLocalCommand()
    {
        // The localCommand adapter passes the host-loopback collector endpoint unchanged — no
        // host.docker.internal rewrite (its process runs on the host, unlike a container).
        var settings = RuntimeTelemetrySettings.FromManifest(
            new RuntimeAppTelemetryManifest { Enabled = true, SampleRatio = 0.25 });

        var env = settings.BuildEnvironment("http://127.0.0.1:4318", "com.example.app", "engine");

        Assert.Contains(env, pair => pair.Key == "OTEL_EXPORTER_OTLP_ENDPOINT" && pair.Value == "http://127.0.0.1:4318");
        Assert.Contains(env, pair => pair.Key == "OTEL_EXPORTER_OTLP_PROTOCOL" && pair.Value == "http/protobuf");
        Assert.Contains(env, pair => pair.Key == "OTEL_SERVICE_NAME" && pair.Value == "com.example.app");
        Assert.Contains(env, pair => pair.Key == "OTEL_RESOURCE_ATTRIBUTES"
            && pair.Value == "service.name=com.example.app,hosty.app.id=com.example.app,hosty.app.service=engine");
        Assert.Contains(env, pair => pair.Key == "OTEL_TRACES_SAMPLER_ARG" && pair.Value == "0.25");
    }

    [Fact]
    public void TelemetrySettings_BuildEnvironment_EmptyWhenDisabledOrNoEndpoint()
    {
        var enabled = RuntimeTelemetrySettings.FromManifest(new RuntimeAppTelemetryManifest { Enabled = true });
        Assert.Empty(enabled.BuildEnvironment(null, "com.example.app", "engine"));
        Assert.Empty(enabled.BuildEnvironment("   ", "com.example.app", "engine"));

        var disabled = RuntimeTelemetrySettings.FromManifest(new RuntimeAppTelemetryManifest { Enabled = false });
        Assert.Empty(disabled.BuildEnvironment("http://127.0.0.1:4318", "com.example.app", "engine"));
    }

    private static RuntimeLifecycleContext CreateTelemetryContext(bool enabled, double? sampleRatio, string? endpoint)
    {
        var service = new RuntimeSelectedService(
            "app",
            [],
            new RuntimeServiceProfileManifest { Type = "docker" },
            new RuntimeDockerImage("ghcr.io/example/app", "latest"),
            "image");
        var manifest = new RuntimeAppManifest
        {
            SchemaVersion = "app.0.1",
            Id = "com.example.app",
            Name = "App",
            Version = "1.0.0",
            Telemetry = new RuntimeAppTelemetryManifest { Enabled = enabled, SampleRatio = sampleRatio },
        };
        var profile = new RuntimeProfileManifest { Key = "docker", Type = "docker", Default = true };
        var selection = new RuntimeAppManifestSelection(manifest, "/tmp/manifest.json", "digest", profile, [service], null, "{}", null);
        var app = CreateDockerAppRecord(updatePolicy: null, locks: null);
        return new RuntimeLifecycleContext(app, selection, "/tmp/app", "/tmp/app/data", new Dictionary<string, string>(), [], endpoint);
    }

    private static AppServiceTokenService CreateTokenService(byte[]? key = null)
        => new(new AppServiceSigningKey(key ?? "test-control-secret"u8.ToArray()));

    private static DockerRuntimeAdapter CreateAdapter(
        IDockerCommandRunner runner,
        ILogger<DockerRuntimeAdapter>? logger = null,
        AppServiceTokenService? serviceTokens = null,
        TimeSpan? digestProbeTimeout = null,
        IRegistryDigestResolver? registryDigestResolver = null,
        string instanceId = "")
        => new(
            CreateConfig(corePort: 7070, listenUrl: "http://localhost:7070", corePublicOrigin: null, instanceId),
            serviceTokens ?? CreateTokenService(),
            logger ?? Microsoft.Extensions.Logging.Abstractions.NullLogger<DockerRuntimeAdapter>.Instance,
            runner,
            digestProbeTimeout,
            registryDigestResolver);

    // Minimal warning capture: the adapter's diagnostics are the product here, so a test must be able to
    // assert what an operator would actually read in core.log.
    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Warnings { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        // Warning+ only: this captures nothing else, so admitting lower levels would just make callers
        // format messages the test then discards.
        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Warning;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
            {
                return;
            }

            // Providers render the exception beneath the message, so fold it in — a test asserting what
            // an operator reads should see both halves.
            var message = formatter(state, exception);
            Warnings.Add(exception is null ? message : $"{message} {exception}");
        }
    }

    [Fact]
    public async Task StartAsync_BindsCacheTargetAndInjectsItsEnvironment()
    {
        var digest = "sha256:" + new string('b', 64);
        var runner = new FakeDockerCommandRunner();
        var appRoot = Path.Combine(Path.GetTempPath(), $"hosty-docker-cache-test-{Guid.NewGuid():N}");
        try
        {
            var context = CreateDockerContext(CreateDockerAppRecord("pinned", LockMap(digest))) with
            {
                AppRoot = appRoot,
                AppDataPath = Path.Combine(appRoot, "data"),
                AppCachePath = Path.Combine(appRoot, "cache"),
            };
            context = context with
            {
                Manifest = context.Manifest with
                {
                    CacheTarget = new RuntimeAppDataTarget
                    {
                        Runtime = "docker",
                        Service = "app",
                        ContainerPath = "/app/cache",
                        Environment = "HOSTY_APP_CACHE_DIR",
                    },
                },
            };

            await CreateAdapter(runner).StartAsync(context);

            var run = runner.Find("run");
            Assert.NotNull(run);
            var arguments = string.Join(' ', run);
            Assert.Contains($"-v {Path.Combine(appRoot, "cache")}:/app/cache", arguments, StringComparison.Ordinal);
            Assert.Contains("-e HOSTY_APP_CACHE_DIR=/app/cache", arguments, StringComparison.Ordinal);
            Assert.True(Directory.Exists(Path.Combine(appRoot, "cache")));
        }
        finally
        {
            if (Directory.Exists(appRoot))
            {
                Directory.Delete(appRoot, recursive: true);
            }
        }
    }

    private static RuntimeLifecycleContext CreateDockerContext(AppRecord app)
    {
        var service = new RuntimeSelectedService(
            "app",
            [],
            new RuntimeServiceProfileManifest { Type = "docker" },
            new RuntimeDockerImage("ghcr.io/example/app", "latest"),
            "image");
        var manifest = new RuntimeAppManifest { SchemaVersion = "app.0.1", Id = "com.example.app", Name = "App", Version = "1.0.0" };
        var profile = new RuntimeProfileManifest { Key = "docker", Type = "docker", Default = true };
        var selection = new RuntimeAppManifestSelection(manifest, "/tmp/manifest.json", "digest", profile, [service], null, "{}", null);
        return new RuntimeLifecycleContext(app, selection, "/tmp/app", "/tmp/app/data", new Dictionary<string, string>(), []);
    }

    private static IReadOnlyDictionary<string, ArtifactLock> LockMap(string digest)
        => new Dictionary<string, ArtifactLock>
        {
            ["app"] = new("image", digest, "ghcr.io/example/app:latest", null, null, DateTimeOffset.UtcNow),
        };

    private static AppRecord CreateDockerAppRecord(string? updatePolicy, IReadOnlyDictionary<string, ArtifactLock>? locks)
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
            SelectedRuntime: "docker",
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
            UpdatedAt: DateTimeOffset.UtcNow,
            ArtifactLocks: locks,
            UpdatePolicy: updatePolicy);

    [Fact]
    public async Task StartAsync_OwnedContainerRunningWithMatchingImage_AdoptsWithoutRecreate()
    {
        // A keep-apps Core restart leaves this container running; the new Core's start must adopt it
        // (image matches the lock, baked service token still validates) instead of docker rm -f +
        // docker run, so the app never blips.
        var digest = "sha256:" + new string('a', 64);
        var serviceTokens = CreateTokenService();
        var token = serviceTokens.CreateToken("com.example.app");
        var runner = new FakeDockerCommandRunner(args =>
            args is ["inspect", "--format", var fmt, ..] && fmt.Contains("State.Running", StringComparison.Ordinal)
                ? new DockerCommandResult(0, $"true::com.example.app::::ghcr.io/example/app@{digest}::HOSTY_APP_ID=com.example.app\nHOSTY_APP_SERVICE_TOKEN={token}\nPATH=/usr/bin\n", "")
                : new DockerCommandResult(0, "", ""));

        var result = await CreateAdapter(runner, serviceTokens: serviceTokens)
            .StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", LockMap(digest))));

        // No recreate churn: nothing pulled, run, or removed.
        Assert.DoesNotContain(runner.Commands, command => command[0] is "run" or "pull" or "rm");
        Assert.Equal("running", result.RuntimeState);
        // The lock is preserved (adoption reuses the existing one; it never re-resolves the tag).
        Assert.Equal(digest, result.ArtifactLocks?["app"].ImageDigest);
    }

    [Fact]
    public async Task StartAsync_ScopedInstance_AdoptsItsOwnLabelledContainer()
    {
        // A non-default instance adopts a running container that carries ITS hosty.instance label —
        // keep-apps restarts stay non-disruptive for secondary roots too.
        const string instanceId = "aabbccddeeff00112233445566778899";
        var digest = "sha256:" + new string('a', 64);
        var serviceTokens = CreateTokenService();
        var token = serviceTokens.CreateToken("com.example.app");
        var runner = new FakeDockerCommandRunner(args =>
            args is ["inspect", "--format", var fmt, ..] && fmt.Contains("State.Running", StringComparison.Ordinal)
                ? new DockerCommandResult(0, $"true::com.example.app::{instanceId}::ghcr.io/example/app@{digest}::HOSTY_APP_SERVICE_TOKEN={token}\n", "")
                : new DockerCommandResult(0, "", ""));

        var result = await CreateAdapter(runner, serviceTokens: serviceTokens, instanceId: instanceId)
            .StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", LockMap(digest))));

        Assert.DoesNotContain(runner.Commands, command => command[0] is "run" or "pull" or "rm");
        Assert.Equal("running", result.RuntimeState);
        // The adopt inspect went to the instance-scoped name.
        Assert.Contains("hosty-aabbccddeeff-com-example-app-app", runner.Find("inspect")!);
    }

    [Fact]
    public async Task StartAsync_ContainerOfAnotherInstance_IsNeitherAdoptedNorRemoved()
    {
        // The cross-instance guard: whatever answers to this adapter's container name carries the
        // DEFAULT instance's labels (empty hosty.instance), while this adapter runs a scoped
        // instance. Adoption must fall through AND the recreate path must refuse the rm -f — a
        // second-root Core adopting or destroying the default root's container is the disaster
        // instance identity exists to prevent.
        const string instanceId = "aabbccddeeff00112233445566778899";
        var digest = "sha256:" + new string('a', 64);
        var serviceTokens = CreateTokenService();
        var token = serviceTokens.CreateToken("com.example.app");
        var runner = new FakeDockerCommandRunner(args =>
        {
            if (args is ["inspect", "--format", var fmt, ..])
            {
                if (fmt.Contains("State.Running", StringComparison.Ordinal))
                {
                    return new DockerCommandResult(0, $"true::com.example.app::::ghcr.io/example/app@{digest}::HOSTY_APP_SERVICE_TOKEN={token}\n", "");
                }

                if (fmt.Contains("hosty.app.id", StringComparison.Ordinal))
                {
                    return new DockerCommandResult(0, "com.example.app\t\n", "");
                }
            }

            return args is ["image", "inspect", ..]
                ? new DockerCommandResult(0, "[{}]", "")
                : new DockerCommandResult(0, "", "");
        });

        await CreateAdapter(runner, serviceTokens: serviceTokens, instanceId: instanceId)
            .StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", LockMap(digest))));

        Assert.DoesNotContain(runner.Commands, command => command[0] == "rm");
        // The recreate targets the scoped name and stamps the instance label, so the foreign
        // container stays untouched (docker itself surfaces the name conflict).
        var run = runner.Find("run")!;
        Assert.Contains("hosty-aabbccddeeff-com-example-app-app", run);
        Assert.Contains($"hosty.instance={instanceId}", run);
    }

    [Fact]
    public async Task StartAsync_DefaultInstance_DoesNotRemoveAnotherInstancesContainer()
    {
        // The reverse direction: the default root's Core meets a container labelled for a secondary
        // instance under its (unscoped) name. Same rule — leave it alone.
        var digest = "sha256:" + new string('a', 64);
        var serviceTokens = CreateTokenService();
        var token = serviceTokens.CreateToken("com.example.app");
        var runner = new FakeDockerCommandRunner(args =>
        {
            if (args is ["inspect", "--format", var fmt, ..])
            {
                if (fmt.Contains("State.Running", StringComparison.Ordinal))
                {
                    return new DockerCommandResult(0, $"true::com.example.app::bbbb::ghcr.io/example/app@{digest}::HOSTY_APP_SERVICE_TOKEN={token}\n", "");
                }

                if (fmt.Contains("hosty.app.id", StringComparison.Ordinal))
                {
                    return new DockerCommandResult(0, "com.example.app\tbbbb\n", "");
                }
            }

            return args is ["image", "inspect", ..]
                ? new DockerCommandResult(0, "[{}]", "")
                : new DockerCommandResult(0, "", "");
        });

        await CreateAdapter(runner, serviceTokens: serviceTokens)
            .StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", LockMap(digest))));

        Assert.DoesNotContain(runner.Commands, command => command[0] == "rm");
        // The default instance stamps no hosty.instance label — its containers must stay
        // byte-for-byte what earlier Cores produced.
        Assert.DoesNotContain(runner.Find("run")!, argument => argument.StartsWith("hosty.instance=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ListRunningAppIdsAsync_ReportsOnlyTheOwnInstancesContainers()
    {
        // docker ps cannot filter on "label absent" (the default instance's containers), so the
        // instance is a post-filter on the printed label. A second-root Core must not see the
        // default root's apps as its own — the reconcile sweep would flip their records.
        var runner = new FakeDockerCommandRunner(args =>
            args is ["ps", ..]
                ? new DockerCommandResult(0, "com.example.app\t\ncom.other.app\tbbbb\n", "")
                : new DockerCommandResult(0, "", ""));

        var defaultInstance = await CreateAdapter(runner).ListRunningAppIdsAsync();
        Assert.Equal(["com.example.app"], defaultInstance.Order());

        var scopedInstance = await CreateAdapter(runner, instanceId: "bbbb").ListRunningAppIdsAsync();
        Assert.Equal(["com.other.app"], scopedInstance.Order());
    }

    [Fact]
    public async Task StartAsync_OwnedContainerRunningWithStaleServiceToken_Recreates()
    {
        // The container matches the lock's image, but its baked HOSTY_APP_SERVICE_TOKEN was signed by
        // a different key (minted before the key became durable, or after a rotation). Adopting it
        // would leave every app→Core callback 401ing, so the adapter must recreate instead.
        var digest = "sha256:" + new string('a', 64);
        var staleToken = CreateTokenService("stale-old-secret"u8.ToArray()).CreateToken("com.example.app");
        var runner = new FakeDockerCommandRunner(args =>
        {
            if (args is ["inspect", "--format", var fmt, ..])
            {
                if (fmt.Contains("State.Running", StringComparison.Ordinal))
                {
                    return new DockerCommandResult(0, $"true::com.example.app::::ghcr.io/example/app@{digest}::HOSTY_APP_SERVICE_TOKEN={staleToken}\n", "");
                }

                if (fmt.Contains("hosty.app.id", StringComparison.Ordinal))
                {
                    return new DockerCommandResult(0, "com.example.app", "");
                }
            }

            return args is ["image", "inspect", ..]
                ? new DockerCommandResult(0, "[{}]", "")
                : new DockerCommandResult(0, "", "");
        });

        await CreateAdapter(runner).StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", LockMap(digest))));

        Assert.True(runner.Ran("rm", "-f", "hosty-com-example-app-app"));
        Assert.Equal($"ghcr.io/example/app@{digest}", runner.Find("run")![^1]);
    }

    [Fact]
    public async Task StartAsync_OwnedContainerRunningWithDifferentImage_Recreates()
    {
        // The running container is on a different digest than the lock pins, so it must be recreated
        // (adoption is image-matched, not "any running owned container"). The baked token is valid so
        // the image mismatch is the only reason to recreate.
        var digest = "sha256:" + new string('a', 64);
        var otherDigest = "sha256:" + new string('b', 64);
        var serviceTokens = CreateTokenService();
        var token = serviceTokens.CreateToken("com.example.app");
        var runner = new FakeDockerCommandRunner(args =>
        {
            if (args is ["inspect", "--format", var fmt, ..])
            {
                if (fmt.Contains("State.Running", StringComparison.Ordinal))
                {
                    return new DockerCommandResult(0, $"true::com.example.app::::ghcr.io/example/app@{otherDigest}::HOSTY_APP_SERVICE_TOKEN={token}\n", "");
                }

                if (fmt.Contains("hosty.app.id", StringComparison.Ordinal))
                {
                    return new DockerCommandResult(0, "com.example.app", "");
                }
            }

            return args is ["image", "inspect", ..]
                ? new DockerCommandResult(0, "[{}]", "")
                : new DockerCommandResult(0, "", "");
        });

        await CreateAdapter(runner).StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", LockMap(digest))));

        Assert.True(runner.Ran("rm", "-f", "hosty-com-example-app-app"));
        Assert.Equal($"ghcr.io/example/app@{digest}", runner.Find("run")![^1]);
    }

    [Fact]
    public async Task StartAsync_OwnedContainerNotRunning_Recreates()
    {
        // A stopped-but-present owned container is not adopted (only a live one is), so it is recreated.
        var digest = "sha256:" + new string('a', 64);
        var token = CreateTokenService().CreateToken("com.example.app");
        var runner = new FakeDockerCommandRunner(args =>
        {
            if (args is ["inspect", "--format", var fmt, ..])
            {
                if (fmt.Contains("State.Running", StringComparison.Ordinal))
                {
                    return new DockerCommandResult(0, $"false::com.example.app::::ghcr.io/example/app@{digest}::HOSTY_APP_SERVICE_TOKEN={token}\n", "");
                }

                if (fmt.Contains("hosty.app.id", StringComparison.Ordinal))
                {
                    return new DockerCommandResult(0, "com.example.app", "");
                }
            }

            return args is ["image", "inspect", ..]
                ? new DockerCommandResult(0, "[{}]", "")
                : new DockerCommandResult(0, "", "");
        });

        await CreateAdapter(runner).StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", LockMap(digest))));

        Assert.NotNull(runner.Find("run"));
        Assert.Equal($"ghcr.io/example/app@{digest}", runner.Find("run")![^1]);
    }

    [Fact]
    public async Task StartAsync_RunningContainerButNoLock_Recreates()
    {
        // Without a persisted digest lock there is nothing to match the running image against, so the
        // adopt fast-path is skipped entirely (no inspect short-circuit) and the app is (re)started.
        var digest = "sha256:" + new string('c', 64);
        var runner = new FakeDockerCommandRunner(args =>
            args[0] == "pull"
                ? new DockerCommandResult(0, $"Digest: {digest}\nStatus: Downloaded", "")
                : new DockerCommandResult(0, "", ""));

        await CreateAdapter(runner).StartAsync(CreateDockerContext(CreateDockerAppRecord("pinned", locks: null)));

        Assert.NotNull(runner.Find("run"));
    }

    [Fact]
    public async Task StartAsync_SettingsAndServiceToken_PassedViaEnvironmentNotArgv()
    {
        var runner = new FakeDockerCommandRunner();
        var app = CreateDockerAppRecord(updatePolicy: null, locks: null) with
        {
            Settings = new Dictionary<string, AppSettingValue>(StringComparer.Ordinal)
            {
                ["API_KEY"] = new("API_KEY", "string", "s3cr3t-value", Secret: true),
            },
        };

        await CreateAdapter(runner).StartAsync(CreateDockerContext(app));

        var run = runner.Find("run")!;
        // The value must never appear on the argv (ps/cmdline is readable by other local users) — only
        // the NAME is passed via -e, with the value delivered through the docker process environment.
        Assert.DoesNotContain(run, arg => arg.Contains("s3cr3t-value", StringComparison.Ordinal));
        Assert.Contains("API_KEY", run);
        Assert.DoesNotContain(run, arg => arg.StartsWith("HOSTY_APP_SERVICE_TOKEN=", StringComparison.Ordinal));

        var environment = runner.RunEnvironment();
        Assert.NotNull(environment);
        Assert.Equal("s3cr3t-value", environment!["API_KEY"]);
        Assert.True(environment.ContainsKey("HOSTY_APP_SERVICE_TOKEN"));
    }

    [Fact]
    public async Task StartAsync_ExistingContainerLabelledForAnotherApp_IsNotRemoved()
    {
        // Simulate a name-collision squatter: the container that shares this app's normalized name is
        // labelled for a different app. It must be left in place (C-M2), never force-removed.
        var runner = new FakeDockerCommandRunner(args =>
            args is ["inspect", "--format", _, ..] && args[2].Contains("hosty.app.id", StringComparison.Ordinal)
                ? new DockerCommandResult(0, "some.other.app", "")
                : new DockerCommandResult(0, "", ""));

        await CreateAdapter(runner).StartAsync(CreateDockerContext(CreateDockerAppRecord(updatePolicy: null, locks: null)));

        Assert.False(runner.Ran("rm", "-f", "hosty-com-example-app-app"));
    }

    [Fact]
    public async Task StartAsync_PartialMultiServiceStart_UnwindsStartedContainers()
    {
        var running = new HashSet<string>(StringComparer.Ordinal);
        var runner = new FakeDockerCommandRunner(args =>
        {
            switch (args[0])
            {
                case "run":
                    var runName = args[args.ToList().IndexOf("--name") + 1];
                    if (runName.EndsWith("-worker", StringComparison.Ordinal))
                    {
                        return new DockerCommandResult(1, "", "worker failed to start");
                    }

                    running.Add(runName);
                    return new DockerCommandResult(0, "", "");
                case "inspect" when args[2].Contains("hosty.app.id", StringComparison.Ordinal):
                    var name = args[^1];
                    return running.Contains(name)
                        ? new DockerCommandResult(0, "com.example.app", "")
                        : new DockerCommandResult(1, "", "no such container");
                case "rm":
                    running.Remove(args[^1]);
                    return new DockerCommandResult(0, "", "");
                default:
                    return new DockerCommandResult(0, "", "");
            }
        });

        await Assert.ThrowsAsync<AppLifecycleException>(() =>
            CreateAdapter(runner).StartAsync(CreateMultiServiceDockerContext("app", "worker")));

        // The successfully-started "app" container must be unwound so a failed multi-service start
        // leaves nothing running (C-H5). BuildContainerName normalizes dots to dashes.
        Assert.Empty(running);
        Assert.True(runner.Ran("rm", "-f", "hosty-com-example-app-app"));
    }

    [Fact]
    public async Task StopAsync_ContainerStillRunningAfterStop_Throws()
    {
        var runner = new FakeDockerCommandRunner(args =>
            args is ["inspect", "--format", "{{.State.Running}}", ..]
                ? new DockerCommandResult(0, "true", "")
                : new DockerCommandResult(0, "", ""));

        var ex = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            CreateAdapter(runner).StopAsync(CreateDockerContext(CreateDockerAppRecord(updatePolicy: null, locks: null))));

        Assert.Equal("docker_stop_incomplete", ex.Code);
    }

    [Fact]
    public async Task StopAsync_ContainerStopped_ReturnsStopped()
    {
        var runner = new FakeDockerCommandRunner(args =>
            args is ["inspect", "--format", "{{.State.Running}}", ..]
                ? new DockerCommandResult(0, "false", "")
                : new DockerCommandResult(0, "", ""));

        var result = await CreateAdapter(runner).StopAsync(CreateDockerContext(CreateDockerAppRecord(updatePolicy: null, locks: null)));

        Assert.Equal("stopped", result.RuntimeState);
    }

    [Fact]
    public async Task ListRunningAppIdsAsync_ParsesDistinctLabelledAppIds()
    {
        var runner = new FakeDockerCommandRunner(args =>
            args[0] == "ps" ? new DockerCommandResult(0, "app.one\napp.two\napp.one\n", "") : new DockerCommandResult(0, "", ""));

        var running = await CreateAdapter(runner).ListRunningAppIdsAsync();

        Assert.Equal(new HashSet<string> { "app.one", "app.two" }, running);
    }

    [Fact]
    public async Task GetHealthAsync_InspectsEveryServiceContainerInOneCall()
    {
        // One spawn per app, not per service: this runs for every believed-running app on every
        // supervision tick, so a per-service call made steady-state churn scale with container count.
        var runner = new FakeDockerCommandRunner(args => args switch
        {
            ["inspect", "--format", var format, ..] when format.Contains("State.Status", StringComparison.Ordinal) =>
                new DockerCommandResult(0, string.Join('\n',
                    ContainerInspectLine("hosty-com-example-app-app", "running", health: "healthy"),
                    ContainerInspectLine("hosty-com-example-app-worker", "running", health: "")), ""),
            _ => new DockerCommandResult(0, "", ""),
        });

        var health = await CreateAdapter(runner).GetHealthAsync(CreateMultiServiceDockerContext("app", "worker"));

        Assert.Equal("healthy", health.Status);
        Assert.Equal(["app", "worker"], health.Services.Select(service => service.Service));
        Assert.All(health.Services, service => Assert.Equal("running", service.Status));
        var containerInspects = runner.Commands.Count(command =>
            command is ["inspect", "--format", var format, ..] && format.Contains("State.Status", StringComparison.Ordinal));
        Assert.Equal(1, containerInspects);
    }

    [Fact]
    public async Task GetHealthAsync_MapsLinesByNameSoAMissingContainerReadsStopped()
    {
        // docker prints a line only for the containers that exist and exits non-zero for the rest, so
        // the batch is mapped back by the {{.Name}} field rather than by position. Absence is the
        // "stopped" answer — the non-zero exit must not discard the good line that came with it.
        var runner = new FakeDockerCommandRunner(args => args switch
        {
            ["inspect", "--format", var format, ..] when format.Contains("State.Status", StringComparison.Ordinal) =>
                new DockerCommandResult(1, ContainerInspectLine("hosty-com-example-app-worker", "running"), "No such object: hosty-com-example-app-app"),
            _ => new DockerCommandResult(0, "", ""),
        });

        var health = await CreateAdapter(runner).GetHealthAsync(CreateMultiServiceDockerContext("app", "worker"));

        Assert.Equal("unhealthy", health.Status);
        Assert.Equal("stopped", health.Services.Single(service => service.Service == "app").Status);
        Assert.Equal("running", health.Services.Single(service => service.Service == "worker").Status);
    }

    [Fact]
    public async Task GetHealthAsync_ResolvesImageRepoDigestOncePerImageAcrossCalls()
    {
        // An image id is the digest of that image's own config, so the mapping never changes; asking
        // docker for it again on every tick was pure spawn cost.
        var runner = new FakeDockerCommandRunner(args => args switch
        {
            ["inspect", "--format", var format, ..] when format.Contains("State.Status", StringComparison.Ordinal) =>
                new DockerCommandResult(0, ContainerInspectLine("hosty-com-example-app-app", "running"), ""),
            ["inspect", "--format", var format, ..] when format.Contains("RepoDigests", StringComparison.Ordinal) =>
                new DockerCommandResult(0, "sha256:image-id\tghcr.io/example/app@sha256:deadbeef", ""),
            _ => new DockerCommandResult(0, "", ""),
        });
        var adapter = CreateAdapter(runner);
        var context = CreateMultiServiceDockerContext("app");

        var first = await adapter.GetHealthAsync(context);
        var second = await adapter.GetHealthAsync(context);

        Assert.Equal("ghcr.io/example/app@sha256:deadbeef", first.Services.Single().Image);
        Assert.Equal("ghcr.io/example/app@sha256:deadbeef", second.Services.Single().Image);
        var imageInspects = runner.Commands.Count(command =>
            command is ["inspect", "--format", var format, ..] && format.Contains("RepoDigests", StringComparison.Ordinal));
        Assert.Equal(1, imageInspects);
    }

    // One line of the batched container-inspect format: name, status, pid, exit code, image id,
    // config image, health, restart count, started at.
    private static string ContainerInspectLine(string containerName, string status, string health = "")
        => string.Join('\t',
            $"/{containerName}",
            status,
            "1234",
            "0",
            "sha256:image-id",
            "ghcr.io/example/app:latest",
            health,
            "0",
            "2026-08-26T00:00:00Z");

    private static RuntimeLifecycleContext CreateMultiServiceDockerContext(params string[] serviceKeys)
    {
        var services = serviceKeys
            .Select(key => new RuntimeSelectedService(
                key,
                [],
                new RuntimeServiceProfileManifest { Type = "docker" },
                new RuntimeDockerImage("ghcr.io/example/app", "latest"),
                "image"))
            .ToArray();
        var manifest = new RuntimeAppManifest { SchemaVersion = "app.0.1", Id = "com.example.app", Name = "App", Version = "1.0.0" };
        var profile = new RuntimeProfileManifest { Key = "docker", Type = "docker", Default = true };
        var selection = new RuntimeAppManifestSelection(manifest, "/tmp/manifest.json", "digest", profile, services, null, "{}", null);
        return new RuntimeLifecycleContext(
            CreateDockerAppRecord(updatePolicy: null, locks: null),
            selection,
            "/tmp/app",
            "/tmp/app/data",
            new Dictionary<string, string>(),
            []);
    }

    // Fixed verdict from the HTTP registry probe: a digest, or null meaning "fall back to the CLI".
    private sealed class StubRegistryDigestResolver(string? digest) : IRegistryDigestResolver
    {
        public Task<string?> TryResolveDigestAsync(RuntimeDockerImage image, CancellationToken cancellationToken = default)
            => Task.FromResult(digest);
    }

    // Stands in for a registry that accepts the connection and then never answers: the command hangs
    // until its caller's token is cancelled, which is what the probe deadline exists to do.
    private sealed class BlockingDockerCommandRunner : IDockerCommandRunner
    {
        public async Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment = null, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            throw new InvalidOperationException("Unreachable: the infinite delay only ever ends in cancellation.");
        }
    }

    private sealed class FakeDockerCommandRunner(Func<IReadOnlyList<string>, DockerCommandResult>? responder = null)
        : IDockerCommandRunner
    {
        private readonly Func<IReadOnlyList<string>, DockerCommandResult> responder =
            responder ?? (_ => new DockerCommandResult(0, "", ""));

        public List<IReadOnlyList<string>> Commands { get; } = [];

        // Environment injected into the docker process on the matching call (C-M5); null when none.
        public List<IReadOnlyDictionary<string, string>?> Environments { get; } = [];

        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment = null, CancellationToken cancellationToken = default)
        {
            Commands.Add(args.ToArray());
            Environments.Add(environment);
            return Task.FromResult(responder(args));
        }

        // The environment passed alongside the first `run` command.
        public IReadOnlyDictionary<string, string>? RunEnvironment()
        {
            var index = Commands.FindIndex(command => command.Count > 0 && command[0] == "run");
            return index >= 0 ? Environments[index] : null;
        }

        public bool Ran(params string[] prefix) => Commands.Any(command => StartsWith(command, prefix));

        public IReadOnlyList<string>? Find(params string[] prefix) => Commands.FirstOrDefault(command => StartsWith(command, prefix));

        private static bool StartsWith(IReadOnlyList<string> command, string[] prefix)
            => prefix.Length <= command.Count && !prefix.Where((part, index) => command[index] != part).Any();
    }

    private static HostyCoreRuntimeConfig CreateConfig(int corePort, string listenUrl, string? corePublicOrigin, string instanceId = "")
        => new(
            DataRoot: "/tmp/hosty",
            RunDirectory: "/tmp/hosty/core/run",
            ControlDiscoveryPath: "/tmp/hosty/core/run/control.json",
            CorePort: corePort,
            ListenUrl: listenUrl,
            CorePublicOrigin: corePublicOrigin,
            RuntimePublicHost: "localhost",
            ShellSourceOverridePath: null,
            ShellAutostart: false,
            InstanceId: instanceId);
}
