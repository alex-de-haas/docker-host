using System.Diagnostics;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [DockerDevelopmentFact]
    public async Task Harness_ProductionDockerRunsCoreOwnedWorkerAndFinishesSandbox()
    {
        if (Environment.GetEnvironmentVariable("HOSTY_TEST_HARNESS_RECOVERY_ROOT") is { Length: > 0 } recoveryRoot)
        {
            await RecoverHarnessAcceptanceAsync(recoveryRoot);
            return;
        }
        var f = await LifecycleFixture.CreateAsync();
        var repository = new DirectoryInfo(AppContext.BaseDirectory);
        while (repository is not null && !File.Exists(Path.Combine(repository.FullName, "Directory.Build.props"))) repository = repository.Parent;
        var config = new HostyCoreRuntimeConfig(f.Root, f.Root + "/run", f.Root + "/control.json", 3001,
            "http://127.0.0.1:3001", null, "127.0.0.1", null, false, InstanceId: Guid.NewGuid().ToString("N"));
        using var services = new ServiceCollection().AddHttpClient().BuildServiceProvider();
        var docker = new ProcessDockerCommandRunner();
        var store = new CoreEnvironmentStore(f.Paths);
        var runtime = new CoreEnvironmentRuntime(config, docker, services.GetRequiredService<IHttpClientFactory>(), NullLogger<CoreEnvironmentRuntime>.Instance);
        var environments = new CoreEnvironmentService(store, runtime, new SystemClock());
        var access = new CoreEnvironmentAccess(store, environments);
        var actor = new SandboxActor("runtime-acceptance");
        CoreEnvironmentView? child = null;
        var finished = false;
        Func<string, Task>? operatorAcceptance = null;
        try
        {
            child = await environments.CreateAsync(actor, new(Guid.NewGuid().ToString(), "Harness production runtime acceptance",
                Mode: "source", ProjectPath: Path.Combine(repository!.FullName, "apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj"),
                Limits: new CoreEnvironmentLimits(MemoryBytes: 8589934592, Cpus: 4, Pids: 1024)), default);
            child = await environments.CommandAsync(actor, child.Id, "start", new(Guid.NewGuid().ToString(), child.Revision), default);
            Assert.True(child.State == "running", child.Error);
            var password = "Runtime-test-" + Guid.NewGuid().ToString("N") + "!";
            var setup = await access.SetupAsync(actor, child.Id, new("runtime-test@example.test", "Runtime acceptance", password), default);
            Assert.Equal(200, setup.Status);
            var dataRoot = child.DataRoot!;
            async Task<string> Cli(params string[] arguments)
            {
                var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("HOSTY_TEST_HOSTY_CLI") ?? "hosty");
                start.ArgumentList.Add("--data-root"); start.ArgumentList.Add(dataRoot);
                foreach (var argument in arguments) start.ArgumentList.Add(argument);
                var result = await ProcessRunner.RunAsync(start, TimeSpan.FromMinutes(4), default, 32768);
                Assert.True(!result.TimedOut && result.ExitCode == 0, result.StandardOutput + result.StandardError);
                return result.StandardOutput;
            }
            await Cli("apps", "install", Path.Combine(repository.FullName, "apps/harness/manifest.json"));
            await Cli("apps", "start", "hosty.harness");
            var childConfig = config with { DataRoot = dataRoot };
            var childPaths = CoreDataPaths.FromConfig(childConfig);
            var childApps = new AppRegistryStore(childPaths);
            var harness = (await childApps.GetAppAsync("hosty.harness"))!;
            Assert.Equal("docker", harness.SelectedRuntime);
            Assert.Contains(CoreAppPermissions.Sources, harness.GrantedCorePermissions!);
            var coordinator = DockerRuntimeAdapter.BuildContainerName(child.Id, harness.Id, "api");
            var appRoot = Path.Combine(MountPathPolicy.ResolveRealPath(dataRoot), "apps", harness.Id);
            var generation = Guid.NewGuid().ToString("D");
            var owner = new WorkspaceOwner(harness.Id, harness.InstalledAt, "isolated-transport-fixture", "transport-check");
            var workspaces = new DevelopmentWorkspaceService(childPaths, childApps, new SystemClock());
            var bindings = await workspaces.WorkerBindingsAsync(owner, default);
            // This transport fixture is synthetic and tests no user identity. Ordinary child setup
            // and password login above use the real public contracts; workspace auth has its own tests.
            await JsonStorage.WriteAsync(Path.Combine(childPaths.CoreRoot, "development", "worker-leases", generation + ".json"),
                new DevelopmentWorkerLease(owner, generation, true));
            var cwd = Path.Combine(appRoot, "cache", "sessions", "transport-check", "workspace");
            Directory.CreateDirectory(cwd);
            var probe = Path.Combine(appRoot, "cache", "runtime-probe.mjs");
            var prefix = $"const generation={JsonSerializer.Serialize(generation)}, bindings={CoreJson.Text(bindings)}, cwd={JsonSerializer.Serialize(cwd)};\n";
            await File.WriteAllTextAsync(probe, prefix + """
                import assert from 'node:assert/strict';
                import { loadConfig } from '/repo/apps/harness/src/config.ts';
                import { SharedDockerWorker } from '/repo/apps/harness/src/runtime/worker.ts';
                import { CoreWorkerCommands } from '/repo/apps/harness/src/runtime/core-worker.ts';
                const config = loadConfig();
                const worker = new SharedDockerWorker(config.dataDir, config.cacheDir,
                  new CoreWorkerCommands(config.coreOrigin, config.appId, config.serviceToken));
                let successful = false;
                try {
                  worker.claim('transport-check');
                  const transport = await worker.prepare('transport-check', generation, bindings, cwd, [], async () => {});
                  for (const provider of ['codex', 'claude']) {
                    await new Promise((resolve, reject) => {
                      const child = transport.spawn(provider, ['--version'], { cwd, env: {} });
                      let text = '';
                      child.stdout.on('data', bytes => { text += bytes; });
                      child.stderr.on('data', bytes => { text += bytes; });
                      child.on('error', reject);
                      child.on('close', code => code === 0 && text.length ? resolve() : reject(new Error(provider + ': ' + code + ' ' + text)));
                      child.stdin.end();
                    });
                  }
                  // Use the real SDK protocol, without a model prompt or provider credentials.
                  const { createRequire } = await import('node:module');
                  const require = createRequire('/repo/apps/harness/package.json');
                  const { query } = await import(require.resolve('@anthropic-ai/claude-agent-sdk'));
                  let finishInput, timeout;
                  const input = (async function* () { await new Promise(resolve => { finishInput = resolve; }); })();
                  const sdk = query({ prompt: input, options: {
                    cwd, env: { CLAUDE_CONFIG_DIR: cwd + '/claude' }, settingSources: [],
                    pathToClaudeCodeExecutable: '/opt/hosty-worker/claude',
                    spawnClaudeCodeProcess: args => transport.spawn('claude', args.args, { cwd: args.cwd ?? cwd, env: args.env }),
                  } });
                  try {
                    await Promise.race([(async () => {
                      assert.ok(await sdk.initializationResult());
                      await new Promise(resolve => setTimeout(resolve, 10000));
                      assert.ok(await sdk.reinitialize());
                    })(), new Promise((_, reject) => {
                      timeout = setTimeout(() => reject(new Error('Idle SDK transport timed out')), 45000);
                    })]);
                  } finally { clearTimeout(timeout); finishInput?.(); sdk.close(); }
                  assert.ok((await worker.sample()).memoryBytes > 0);
                  assert.ok(await worker.diskUsage() >= 0);
                  console.log('Both provider transports and accounting passed.');
                  successful = true;
                } finally {
                  if (!successful) await worker.stop();
                  // Leave the successful generation for Core's application Stop to terminate.
                }
                """);
            var probeResult = await docker.RunAsync(["exec", coordinator, "node", "--import", "tsx", probe]);
            Assert.True(probeResult.ExitCode == 0, probeResult.StandardOutput + probeResult.StandardError);
            var workerName = $"hosty-agent-{bindings.InstanceId[..12]}-{bindings.InstallationId[..12]}-{generation}";
            var workerInspection = await docker.RunAsync(["inspect", workerName]);
            using (var inspected = JsonDocument.Parse(workerInspection.StandardOutput))
            {
                var container = inspected.RootElement[0];
                Assert.Equal(child.Id, container.GetProperty("Config").GetProperty("Labels").GetProperty("hosty.instance").GetString());
                Assert.Equal("agent-worker", container.GetProperty("Config").GetProperty("Labels").GetProperty("hosty.app.service").GetString());
                Assert.Equal(2147483648, container.GetProperty("HostConfig").GetProperty("Memory").GetInt64());
                Assert.Equal(256, container.GetProperty("HostConfig").GetProperty("PidsLimit").GetInt64());
            }
            var writer = Path.Combine(cwd, "detached-writer");
            var writerStart = await docker.RunAsync(["exec", "-d", workerName, "sh", "-c",
                "while true; do date +%s >> $1; sleep .1; done", "probe", writer]);
            Assert.Equal(0, writerStart.ExitCode);
            await Task.Delay(500);
            // A coordinator crash must not hide its still-running detached worker from Core Stop.
            Assert.Equal(0, (await docker.RunAsync(["kill", coordinator])).ExitCode);
            var liveWorker = await docker.RunAsync(["inspect", "--format", "{{.State.Running}}", workerName]);
            Assert.Equal("true", liveWorker.StandardOutput.Trim());
            await Cli("apps", "stop", harness.Id);
            var size = new FileInfo(writer).Length;
            await Task.Delay(500);
            Assert.Equal(size, new FileInfo(writer).Length);
            var removed = await docker.RunAsync(["ps", "-a", "--filter", $"name=^/{workerName}$", "--format", "{{.ID}}"]);
            Assert.Equal(0, removed.ExitCode); Assert.Empty(removed.StandardOutput.Trim());
            Assert.True((await JsonStorage.ReadAsync<DevelopmentWorkerLease>(
                Path.Combine(childPaths.CoreRoot, "development", "worker-leases", generation + ".json")))!.Active);
            await workspaces.WorkerLeaseAsync(owner, new(generation, false), default);
            // Clear this synthetic fixture only after the real coordinator has stopped. An
            // independent writer cannot clear a running coordinator's cached ownership state.
            var clearFixture = new ProcessStartInfo("node") { WorkingDirectory = repository.FullName };
            foreach (var argument in new[] { "--import", "tsx", "--input-type=module", "-e",
                "import { SharedDockerWorker } from './apps/harness/src/runtime/worker.ts'; const worker = new SharedDockerWorker(process.env.HOSTY_TEST_DATA, process.env.HOSTY_TEST_CACHE); await worker.load(); await worker.stop(); await worker.finish();" })
                clearFixture.ArgumentList.Add(argument);
            clearFixture.Environment["HOSTY_TEST_DATA"] = Path.Combine(appRoot, "data");
            clearFixture.Environment["HOSTY_TEST_CACHE"] = Path.Combine(appRoot, "cache");
            var cleared = await ProcessRunner.RunAsync(clearFixture, TimeSpan.FromSeconds(30), default);
            Assert.True(cleared.ExitCode == 0, cleared.StandardError);
            await Cli("apps", "start", harness.Id);
            var sentinel = Path.Combine(appRoot, "data", "runtime-switch-sentinel");
            await File.WriteAllTextAsync(sentinel, "preserved");
            async Task<HttpClient> AppClient()
            {
                var actual = (await childApps.GetAppAsync(harness.Id))!;
                var endpoint = actual.Endpoints.Single(e => e.Key == "http").Url!;
                var verifier = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
                var challenge = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
                var authorization = await access.SendAsync(actor, child.Id, new("POST", "/api/apps/hosty.harness/launch-code",
                    JsonSerializer.SerializeToElement(new AppLaunchCodeRequest(endpoint.TrimEnd('/') + "/", challenge, "S256"))), default);
                Assert.True(authorization.Status == 200, "Core app authorization failed: " + authorization.Status);
                var origin = new UriBuilder(endpoint) { Host = "127.0.0.1", Path = "/" }.Uri;
                var client = new HttpClient(new HttpClientHandler { UseProxy = false }) { BaseAddress = origin, Timeout = TimeSpan.FromSeconds(30) };
                client.DefaultRequestHeaders.Add("Origin", origin.ToString().TrimEnd('/'));
                using var exchange = await client.PostAsJsonAsync("/api/app-code",
                    new { code = authorization.Body!.Value.GetProperty("code").GetString(), codeVerifier = verifier });
                Assert.True(exchange.IsSuccessStatusCode, "Harness app-code exchange failed: " + exchange.StatusCode);
                var grant = await exchange.Content.ReadFromJsonAsync<JsonElement>();
                client.DefaultRequestHeaders.Authorization = new("Bearer", grant.GetProperty("accessToken").GetString());
                return client;
            }
            async Task AssertProfile(string profile)
            {
                var actual = (await childApps.GetAppAsync(harness.Id))!;
                Assert.Equal(profile, actual.SelectedRuntime);
                Assert.Equal("running", actual.RuntimeState);
                using var client = await AppClient();
                using var response = await client.GetAsync("/api/runtime");
                Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
                using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
                Assert.Equal(profile == "docker" ? "docker" : "native", body.RootElement.GetProperty("defaultMode").GetString());
                Assert.True(body.RootElement.GetProperty("managed").GetBoolean());
                Assert.Equal("preserved", await File.ReadAllTextAsync(sentinel));
            }
            // Optional operator-owned acceptance script. It runs only when explicitly supplied;
            // ordinary tests never discover or copy real provider credentials.
            async Task AcceptanceHook(string stage)
            {
                if (Environment.GetEnvironmentVariable("HOSTY_TEST_HARNESS_ACCEPTANCE_HOOK") is not { Length: > 0 } hook) return;
                Assert.True(Path.IsPathFullyQualified(hook) && File.Exists(hook));
                using var client = stage == "cleanup" ? null : await AppClient();
                var start = new ProcessStartInfo("node");
                start.ArgumentList.Add(hook);
                start.Environment["HOSTY_TEST_APP_ORIGIN"] = client?.BaseAddress!.ToString() ?? "";
                start.Environment["HOSTY_TEST_APP_TOKEN"] = client?.DefaultRequestHeaders.Authorization!.Parameter ?? "";
                start.Environment["HOSTY_TEST_APP_ROOT"] = appRoot;
                start.Environment["HOSTY_TEST_COORDINATOR"] = coordinator;
                start.Environment["HOSTY_TEST_CORE_ORIGIN"] = $"http://localhost:{child.Port}";
                start.Environment["HOSTY_TEST_CORE_PASSWORD"] = password;
                start.Environment["HOSTY_TEST_STAGE"] = stage;
                var result = await ProcessRunner.RunAsync(start, TimeSpan.FromMinutes(15), default, 16384);
                Assert.True(!result.TimedOut && result.ExitCode == 0, "Operator acceptance hook failed: " + result.StandardOutput + result.StandardError);
            }
            operatorAcceptance = AcceptanceHook;
            await AssertProfile("docker");
            await AcceptanceHook("initial-docker");
            foreach (var profile in new[] { "local", "docker" })
            {
                var plan = await access.SendAsync(actor, child.Id, new("POST", "/api/apps/hosty.harness/switch-runtime/plan",
                    JsonSerializer.SerializeToElement(new AppRuntimeSwitchPlanRequest(profile))), default);
                Assert.True(plan.Status == 200, plan.Body?.ToString());
                var digest = plan.Body!.Value.GetProperty("planDigest").GetString()!;
                var switched = await access.SendAsync(actor, child.Id, new("POST", "/api/apps/hosty.harness/switch-runtime",
                    JsonSerializer.SerializeToElement(new AppRuntimeSwitchApplyRequest(profile, digest))), default);
                Assert.True(switched.Status == 200, switched.Body?.ToString());
                await AssertProfile(profile);
                await Cli("apps", "restart", harness.Id);
                await AssertProfile(profile);
                await AcceptanceHook("resumed-" + profile);
            }
            await Cli("apps", "stop", harness.Id);
            Assert.Equal("preserved", await File.ReadAllTextAsync(sentinel));
            await AcceptanceHook("cleanup");
            child = await environments.ReadAsync(actor, child.Id, default);
            var root = child.DataRoot!;
            child = await environments.CommandAsync(actor, child.Id, "finish", new(Guid.NewGuid().ToString(), child.Revision), default);
            Assert.True(child.State == "finished", child.Error);
            Assert.False(Directory.Exists(root));
            finished = true;
        }
        finally
        {
            if (operatorAcceptance is not null && !finished) await operatorAcceptance("cleanup");
            if (child is not null && !finished)
            {
                child = await environments.ReadAsync(actor, child.Id, default);
                child = await environments.CommandAsync(actor, child.Id, "finish", new(Guid.NewGuid().ToString(), child.Revision), default);
                finished = child.State == "finished";
                Assert.True(finished, "Test sandbox cleanup requires recovery: " + child.Error + " at " + f.Root);
            }
            if (child is null || finished) Directory.Delete(f.Root, recursive: true);
        }
    }

    // A failed operator hook can leave a durable Finish receipt. Recover only this fixture's
    // disposable root through the same owner and replay identity; never delete its resources by name.
    private static async Task RecoverHarnessAcceptanceAsync(string root)
    {
        root = MountPathPolicy.ResolveRealPath(root);
        Assert.Equal(MountPathPolicy.ResolveRealPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar), Path.GetDirectoryName(root));
        Assert.Matches("^hosty-core-lifecycle-tests-[a-f0-9]{32}$", Path.GetFileName(root));
        var config = new HostyCoreRuntimeConfig(root, root + "/run", root + "/control.json", 3001,
            "http://127.0.0.1:3001", null, "127.0.0.1", null, false, InstanceId: "acceptance-recovery");
        var store = new CoreEnvironmentStore(CoreDataPaths.FromConfig(config));
        using var services = new ServiceCollection().AddHttpClient().BuildServiceProvider();
        var runtime = new CoreEnvironmentRuntime(config, new ProcessDockerCommandRunner(),
            services.GetRequiredService<IHttpClientFactory>(), NullLogger<CoreEnvironmentRuntime>.Instance);
        var owner = new SandboxActor("runtime-acceptance");
        var environments = new CoreEnvironmentService(store, runtime, new SystemClock());
        foreach (var record in await store.ListAsync(default))
        {
            Assert.Equal(owner.UserId, record.Owner.UserId);
            Assert.Equal("Harness production runtime acceptance", record.Request.Label);
            if (record.State == "finished") continue;
            var operation = Assert.Single(record.Operations!, o => o.Kind == "finish");
            // Finish has only request ID and expected revision. Reconstruct exactly the journaled
            // request, checking its fingerprint instead of replacing an uncertain operation UUID.
            var input = Enumerable.Range(0, checked((int)record.Revision + 1))
                .Select(revision => new CoreEnvironmentCommand(operation.Id, revision))
                .Single(candidate => SandboxValidation.Hash("finish|" + CoreJson.Text(candidate)) == operation.Fingerprint);
            var result = await environments.CommandAsync(owner, record.Id, "finish", input, default);
            Assert.True(result.State == "finished", result.Error);
            Assert.False(Directory.Exists(store.Root(record.Id)));
        }
        Directory.Delete(root, recursive: true);
    }

}
