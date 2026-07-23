using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Cli;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class AppsCommandTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public AppsCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-apps-command-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task SourceResolveAsync_SendsExpectedControlRequest()
    {
        using var server = new FakeCoreServer("""
            {
              "appId": "com.haas.demo-app",
              "source": {
                "type": "git",
                "repository": ".",
                "resolvedRef": "main",
                "commit": "abc123",
                "managedCheckoutPath": "/tmp/hosty/sources/com.haas.demo-app",
                "updatedAt": "2026-06-03T12:00:00Z"
              }
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "source-resolve",
            "com.haas.demo-app",
            "--branch",
            "main",
            "--fetch",
            "--format",
            "json",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/apps/com.haas.demo-app/source/resolve", server.PathAndQuery);
        Assert.Equal("test-secret", server.Headers["X-Hosty-Test-Control"]);
        using var body = JsonDocument.Parse(server.Body);
        Assert.Equal("main", body.RootElement.GetProperty("branch").GetString());
        Assert.True(body.RootElement.GetProperty("fetch").GetBoolean());
        Assert.Contains("\"commit\":\"abc123\"", output.ToString());
    }

    [Fact]
    public async Task SourceOverrideAsync_ResolvesPathAndSendsExpectedControlRequest()
    {
        var overridePath = Path.Combine(rootDirectory, "worktree");
        Directory.CreateDirectory(overridePath);
        using var server = new FakeCoreServer($$"""
            {
              "appId": "com.haas.demo-app",
              "source": {
                "type": "git",
                "repository": ".",
                "commit": "def456",
                "managedCheckoutPath": "{{JsonEscape(Path.Combine(rootDirectory, "sources", "com.haas.demo-app"))}}",
                "localOverridePath": "{{JsonEscape(overridePath)}}",
                "updatedAt": "2026-06-03T12:00:00Z"
              }
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "source-override",
            "com.haas.demo-app",
            "--path",
            overridePath,
            "--commit",
            "def456",
            "--format",
            "json",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/apps/com.haas.demo-app/source/override", server.PathAndQuery);
        using var body = JsonDocument.Parse(server.Body);
        Assert.Equal(overridePath, body.RootElement.GetProperty("path").GetString());
        Assert.Equal("def456", body.RootElement.GetProperty("commit").GetString());
        Assert.Contains("\"commit\":\"def456\"", output.ToString());
    }

    [Fact]
    public async Task SourceClearOverrideAsync_UsesDeleteControlRoute()
    {
        using var server = new FakeCoreServer("""
            {
              "appId": "com.haas.demo-app",
              "source": {
                "type": "git",
                "repository": ".",
                "resolvedRef": "main",
                "commit": "abc123",
                "managedCheckoutPath": "/tmp/hosty/sources/com.haas.demo-app",
                "updatedAt": "2026-06-03T12:00:00Z"
              }
            }
            """);
        WriteCoreDiscovery(server);
        var (console, _) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "source-clear-override",
            "com.haas.demo-app",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("DELETE", server.Method);
        Assert.Equal("/control/v1/apps/com.haas.demo-app/source/override", server.PathAndQuery);
        Assert.Equal("", server.Body);
    }

    [Fact]
    public async Task InstallAsync_PreservesRemoteManifestUrl()
    {
        const string manifestUrl = "https://github.com/alex-de-haas/project-manager/releases/download/latest/manifest.json";
        using var server = new FakeCoreServer("""
            {
              "appId": "com.haas.project-manager",
              "displayName": "Project Manager",
              "action": "install",
              "planId": "instp_0011223344556677",
              "targetVersion": "1.0.0",
              "targetRuntime": "default",
              "targetRuntimeType": "docker",
              "manifestPath": "https://example.test/manifest.json",
              "targetManifestDigest": "abc123",
              "defaultAutostart": true,
              "system": false,
              "runtimeProfiles": [],
              "settings": []
            }
            """,
            """
            {
              "app": {
                "id": "com.haas.project-manager",
                "displayName": "Project Manager",
                "version": "1.0.0",
                "kind": "runtime",
                "system": false,
                "source": "manifest",
                "selectedRuntime": "default",
                "operationStatus": "installed",
                "runtimeState": "stopped",
                "capabilities": []
              },
              "backup": null,
              "status": "installed"
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "install",
            manifestUrl,
            "--runtime",
            "default",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal(2, server.Requests.Count);
        Assert.Equal("/control/v1/apps/install/plan", server.Requests[0].PathAndQuery);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/apps/install", server.PathAndQuery);
        using var body = JsonDocument.Parse(server.Body);
        Assert.Equal(manifestUrl, body.RootElement.GetProperty("manifestPath").GetString());
        Assert.Equal("default", body.RootElement.GetProperty("selectedRuntime").GetString());
        // The apply is bound to the reviewed plan: the id from the plan response is echoed back.
        Assert.Equal("instp_0011223344556677", body.RootElement.GetProperty("planId").GetString());
        Assert.Contains("com.haas.project-manager", output.ToString());
    }

    [Fact]
    public async Task InstallAsync_SendsLocalDirectoryReference()
    {
        var appDirectory = Path.Combine(rootDirectory, "runtime-app");
        Directory.CreateDirectory(appDirectory);
        using var server = new FakeCoreServer("""
            {
              "appId": "com.haas.local-app",
              "displayName": "Project Manager",
              "action": "install",
              "planId": "instp_0011223344556677",
              "targetVersion": "1.0.0",
              "targetRuntime": "dev",
              "targetRuntimeType": "docker",
              "manifestPath": "/tmp/runtime-app",
              "targetManifestDigest": "abc123",
              "defaultAutostart": true,
              "system": false,
              "runtimeProfiles": [],
              "settings": []
            }
            """,
            """
            {
              "app": {
                "id": "com.haas.local-app",
                "displayName": "Local App",
                "version": "1.0.0",
                "kind": "runtime",
                "system": false,
                "source": "manifest",
                "selectedRuntime": "dev",
                "operationStatus": "installed",
                "runtimeState": "stopped",
                "capabilities": []
              },
              "backup": null,
              "status": "installed"
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "install",
            appDirectory,
            "--runtime",
            "dev",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal(2, server.Requests.Count);
        Assert.Equal("/control/v1/apps/install/plan", server.Requests[0].PathAndQuery);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/apps/install", server.PathAndQuery);
        using var body = JsonDocument.Parse(server.Body);
        Assert.Equal(appDirectory, body.RootElement.GetProperty("manifestPath").GetString());
        Assert.Equal("dev", body.RootElement.GetProperty("selectedRuntime").GetString());
        Assert.Equal("instp_0011223344556677", body.RootElement.GetProperty("planId").GetString());
        Assert.Contains("com.haas.local-app", output.ToString());
    }

    [Fact]
    public async Task BackupDeleteAsync_UsesDeleteControlRoute()
    {
        using var server = new FakeCoreServer("""
            {
              "deleted": true
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "backup",
            "delete",
            "com.haas.demo-app",
            "backup-one",
            "--yes",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("DELETE", server.Method);
        Assert.Equal("/control/v1/apps/com.haas.demo-app/backups/backup-one", server.PathAndQuery);
        Assert.Contains("backup-one", output.ToString());
    }

    [Fact]
    public async Task BackupDeleteAsync_RequiresConfirmationBeforeCallingCore()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "backup",
            "delete",
            "com.haas.demo-app",
            "backup-one",
        ], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("requires --yes", output.ToString());
    }

    [Fact]
    public async Task BackupCleanupPlanAsync_UsesCleanupPlanRoute()
    {
        using var server = new FakeCoreServer("""
            {
              "appId": "com.haas.demo-app",
              "planDigest": "digest-one",
              "createdAt": "2026-06-03T12:00:00Z",
              "policy": {
                "rules": {
                  "pre-update": {
                    "keepLast": 5
                  }
                },
                "deleteOnlyKnownBackup": false
              },
              "candidates": [
                {
                  "appId": "com.haas.demo-app",
                  "backupId": "old-pre-update",
                  "reason": "pre-update",
                  "cleanupReason": "retention-keep-last-5",
                  "createdAt": "2026-06-01T12:00:00Z",
                  "archivePath": "/tmp/backups/old-pre-update.zip",
                  "metadataPath": "/tmp/backups/old-pre-update.json",
                  "archiveSha256": "abc123",
                  "archiveSize": 123,
                  "automatic": true
                }
              ]
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "backups",
            "prune-plan",
            "com.haas.demo-app",
            "--format",
            "json",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("GET", server.Method);
        Assert.Equal("/control/v1/apps/com.haas.demo-app/backups/cleanup/plan", server.PathAndQuery);
        Assert.Contains("digest-one", output.ToString());
    }

    [Fact]
    public async Task BackupCleanupAsync_UsesCleanupApplyRoute()
    {
        using var server = new FakeCoreServer("""
            {
              "planDigest": "digest-one",
              "deleted": [
                {
                  "appId": "com.haas.demo-app",
                  "backupId": "old-pre-update",
                  "reason": "pre-update",
                  "cleanupReason": "retention-keep-last-5",
                  "createdAt": "2026-06-01T12:00:00Z",
                  "archivePath": "/tmp/backups/old-pre-update.zip",
                  "metadataPath": "/tmp/backups/old-pre-update.json",
                  "archiveSha256": "abc123",
                  "archiveSize": 123,
                  "automatic": true
                }
              ],
              "skipped": []
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "backups",
            "prune",
            "com.haas.demo-app",
            "--plan-digest",
            "digest-one",
            "--yes",
            "--format",
            "json",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/apps/com.haas.demo-app/backups/cleanup", server.PathAndQuery);
        Assert.Contains("\"planDigest\":\"digest-one\"", server.Body);
        Assert.Contains("old-pre-update", output.ToString());
    }

    [Fact]
    public async Task SwitchRuntimePlanAsync_RendersPlanChanges()
    {
        using var server = new FakeCoreServer("""
            {
              "appId": "com.haas.demo-app",
              "currentRuntime": "docker",
              "targetRuntime": "dev",
              "targetRuntimeType": "localCommand",
              "planDigest": "abc123",
              "automaticBackup": true,
              "changes": [
                "runtime:docker->dev",
                "image:web:ghcr.io/example/demo:1.0.0->none"
              ]
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "switch-runtime-plan",
            "com.haas.demo-app",
            "--runtime",
            "dev",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/apps/com.haas.demo-app/switch-runtime/plan", server.PathAndQuery);
        using var body = JsonDocument.Parse(server.Body);
        Assert.Equal("dev", body.RootElement.GetProperty("targetRuntime").GetString());
        Assert.Contains("image:web:ghcr.io/example/demo:1.0.0->none", output.ToString());
    }

    [Fact]
    public async Task HealthAsync_UsesHealthRouteAndRendersServices()
    {
        using var server = new FakeCoreServer("""
            {
              "appId": "com.haas.demo-app",
              "runtime": "dev",
              "runtimeType": "localCommand",
              "status": "healthy",
              "services": [
                {
                  "service": "web",
                  "status": "running",
                  "processId": 1234,
                  "logPath": "/tmp/hosty/apps/com.haas.demo-app/logs/web.log",
                  "workingDirectory": "/tmp/demo"
                }
              ]
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "health",
            "com.haas.demo-app",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("GET", server.Method);
        Assert.Equal("/control/v1/apps/com.haas.demo-app/health", server.PathAndQuery);
        Assert.Contains("healthy", output.ToString());
        Assert.Contains("web", output.ToString());
    }

    [Fact]
    public async Task MountsAsync_ListsSlotsAndBindingsFromAppsResponse()
    {
        using var server = new FakeCoreServer("""
            {
              "apps": [
                {
                  "id": "com.haas.demo-app",
                  "displayName": "Demo App",
                  "version": "1.0.0",
                  "kind": "runtime",
                  "system": false,
                  "source": "manifest",
                  "selectedRuntime": "docker",
                  "autostart": true,
                  "operationStatus": "installed",
                  "runtimeState": "stopped",
                  "capabilities": [],
                  "mounts": [
                    {
                      "key": "catalogRoots",
                      "mode": "rw",
                      "multiple": true,
                      "required": true,
                      "service": "api",
                      "bindings": [
                        { "label": "movies", "hostPath": "/srv/movies", "containerPath": "/mnt/catalogRoots/movies" }
                      ]
                    }
                  ]
                }
              ]
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["apps", "mounts", "com.haas.demo-app"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("GET", server.Method);
        Assert.Equal("/control/v1/apps", server.PathAndQuery);
        Assert.Contains("catalogRoots", output.ToString());
        Assert.Contains("/mnt/catalogRoots/movies", output.ToString());
    }

    [Fact]
    public async Task MountsSetAsync_SendsExpectedControlRequest()
    {
        using var server = new FakeCoreServer("""
            {
              "app": {
                "id": "com.haas.demo-app",
                "displayName": "Demo App",
                "version": "1.0.0",
                "kind": "runtime",
                "system": false,
                "source": "manifest",
                "selectedRuntime": "docker",
                "operationStatus": "configured",
                "runtimeState": "stopped",
                "capabilities": [],
                "mounts": [
                  {
                    "key": "catalogRoots",
                    "mode": "rw",
                    "multiple": true,
                    "required": true,
                    "service": "api",
                    "bindings": [
                      { "label": "movies", "hostPath": "/srv/movies", "containerPath": "/mnt/catalogRoots/movies" }
                    ]
                  }
                ]
              },
              "backup": null,
              "status": "configured"
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "mounts",
            "set",
            "com.haas.demo-app",
            "--mount",
            "catalogRoots=movies=/srv/movies",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/apps/com.haas.demo-app/mounts", server.PathAndQuery);
        using var body = JsonDocument.Parse(server.Body);
        var binding = body.RootElement.GetProperty("mounts")[0];
        Assert.Equal("catalogRoots", binding.GetProperty("key").GetString());
        Assert.Equal("movies", binding.GetProperty("label").GetString());
        Assert.Equal("/srv/movies", binding.GetProperty("hostPath").GetString());
        Assert.Contains("/mnt/catalogRoots/movies", output.ToString());
    }

    [Fact]
    public async Task MountsSetAsync_SendsGlobalRefBinding()
    {
        using var server = new FakeCoreServer("""
            {
              "app": {
                "id": "com.haas.demo-app",
                "displayName": "Demo App",
                "version": "1.0.0",
                "kind": "runtime",
                "system": false,
                "source": "manifest",
                "selectedRuntime": "docker",
                "operationStatus": "configured",
                "runtimeState": "stopped",
                "capabilities": [],
                "mounts": []
              },
              "backup": null,
              "status": "configured"
            }
            """);
        WriteCoreDiscovery(server);
        var (console, _) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "mounts",
            "set",
            "com.haas.demo-app",
            "--ref",
            "catalogRoots=media",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("/control/v1/apps/com.haas.demo-app/mounts", server.PathAndQuery);
        using var body = JsonDocument.Parse(server.Body);
        var binding = body.RootElement.GetProperty("mounts")[0];
        Assert.Equal("catalogRoots", binding.GetProperty("key").GetString());
        Assert.Equal("media", binding.GetProperty("globalMountName").GetString());
    }

    [Fact]
    public async Task MountsClearAsync_SendsEmptyMountsList()
    {
        using var server = new FakeCoreServer("""
            {
              "app": {
                "id": "com.haas.demo-app",
                "displayName": "Demo App",
                "version": "1.0.0",
                "kind": "runtime",
                "system": false,
                "source": "manifest",
                "selectedRuntime": "docker",
                "operationStatus": "configured",
                "runtimeState": "stopped",
                "capabilities": [],
                "mounts": []
              },
              "backup": null,
              "status": "configured"
            }
            """);
        WriteCoreDiscovery(server);
        var (console, _) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["apps", "mounts", "clear", "com.haas.demo-app"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/apps/com.haas.demo-app/mounts", server.PathAndQuery);
        using var body = JsonDocument.Parse(server.Body);
        Assert.Equal(0, body.RootElement.GetProperty("mounts").GetArrayLength());
    }

    [Fact]
    public async Task MountsSetAsync_RejectsMalformedMountSpecBeforeCallingCore()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "mounts",
            "set",
            "com.haas.demo-app",
            "--mount",
            "catalogRoots:/srv/movies",
        ], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("<key>=<label>=<host-path>", output.ToString());
    }

    [Fact]
    public async Task SourceResolveAsync_RejectsAmbiguousRefsBeforeCallingCore()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "apps",
            "source-resolve",
            "com.haas.demo-app",
            "--branch",
            "main",
            "--tag",
            "v1.0.0",
        ], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("accepts only one of --branch, --tag, or --commit", output.ToString());
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }

    private void WriteCoreDiscovery(FakeCoreServer server)
    {
        var runDirectory = Path.Combine(rootDirectory, "core", "run");
        Directory.CreateDirectory(runDirectory);
        File.WriteAllText(
            Path.Combine(runDirectory, "control.json"),
            JsonSerializer.Serialize(new
            {
                controlBaseUrl = server.ControlBaseUrl,
                requiredHeaders = new Dictionary<string, string>
                {
                    ["X-Hosty-Test-Control"] = "test-secret",
                },
            }));
    }

    private static (IAnsiConsole Console, StringWriter Output) CreateConsole()
    {
        var output = new StringWriter();
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Out = new AnsiConsoleOutput(output),
            Interactive = InteractionSupport.No,
        });
        return (console, output);
    }

    private static string JsonEscape(string value)
        => value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal);

    private sealed class FakeCoreServer : IDisposable
    {
        private readonly TcpListener listener;
        private readonly Task serverTask;
        private readonly string[] responses;

        // One canned response per expected request, served in order. Existing single-request tests
        // pass one body and keep their exact behavior; the plan-then-apply install flow passes two.
        public FakeCoreServer(params string[] responses)
        {
            this.responses = responses;
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            ControlBaseUrl = $"http://127.0.0.1:{port}/control/v1";
            serverTask = Task.Run(HandleRequestsAsync);
        }

        public string ControlBaseUrl { get; }

        public string Method { get; private set; } = "";

        public string PathAndQuery { get; private set; } = "";

        public string Body { get; private set; } = "";

        public Dictionary<string, string> Headers { get; } = new(StringComparer.OrdinalIgnoreCase);

        // Every request in arrival order; Method/PathAndQuery/Body above mirror the last one.
        public List<(string Method, string PathAndQuery, string Body)> Requests { get; } = [];

        public async Task WaitForRequestAsync()
        {
            var completed = await Task.WhenAny(serverTask, Task.Delay(TimeSpan.FromSeconds(5)));
            Assert.Same(serverTask, completed);
            await serverTask;
        }

        public void Dispose()
        {
            listener.Stop();
        }

        private async Task HandleRequestsAsync()
        {
            foreach (var responseBody in responses)
            {
                await HandleOneRequestAsync(responseBody);
            }
        }

        private async Task HandleOneRequestAsync(string responseBody)
        {
            try
            {
                using var client = await listener.AcceptTcpClientAsync();
                await using var stream = client.GetStream();
                using var reader = new StreamReader(
                    stream,
                    Encoding.UTF8,
                    detectEncodingFromByteOrderMarks: false,
                    bufferSize: 4096,
                    leaveOpen: true);
                var requestLine = await reader.ReadLineAsync() ?? "";
                var requestParts = requestLine.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                Method = requestParts.ElementAtOrDefault(0) ?? "";
                PathAndQuery = requestParts.ElementAtOrDefault(1) ?? "";

                var contentLength = 0;
                var isChunked = false;
                string? line;
                while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync()))
                {
                    var separator = line.IndexOf(':', StringComparison.Ordinal);
                    if (separator <= 0)
                    {
                        continue;
                    }

                    var key = line[..separator].Trim();
                    var value = line[(separator + 1)..].Trim();
                    Headers[key] = value;
                    if (string.Equals(key, "Content-Length", StringComparison.OrdinalIgnoreCase))
                    {
                        _ = int.TryParse(value, out contentLength);
                    }
                    else if (
                        string.Equals(key, "Transfer-Encoding", StringComparison.OrdinalIgnoreCase) &&
                        value.Contains("chunked", StringComparison.OrdinalIgnoreCase))
                    {
                        isChunked = true;
                    }
                }

                if (contentLength > 0)
                {
                    var buffer = new char[contentLength];
                    var offset = 0;
                    while (offset < contentLength)
                    {
                        var read = await reader.ReadAsync(buffer.AsMemory(offset, contentLength - offset));
                        if (read == 0)
                        {
                            break;
                        }

                        offset += read;
                    }

                    Body = new string(buffer, 0, offset);
                }
                else if (isChunked)
                {
                    var body = new StringBuilder();
                    while (true)
                    {
                        var chunkSizeLine = await reader.ReadLineAsync();
                        if (chunkSizeLine is null)
                        {
                            break;
                        }

                        var sizeToken = chunkSizeLine.Split(';', 2)[0];
                        if (!int.TryParse(sizeToken, System.Globalization.NumberStyles.HexNumber, null, out var chunkSize))
                        {
                            break;
                        }

                        if (chunkSize == 0)
                        {
                            _ = await reader.ReadLineAsync();
                            break;
                        }

                        var chunk = new char[chunkSize];
                        var offset = 0;
                        while (offset < chunkSize)
                        {
                            var read = await reader.ReadAsync(chunk.AsMemory(offset, chunkSize - offset));
                            if (read == 0)
                            {
                                break;
                            }

                            offset += read;
                        }

                        body.Append(chunk, 0, offset);
                        _ = await reader.ReadLineAsync();
                    }

                    Body = body.ToString();
                }

                Requests.Add((Method, PathAndQuery, Body));
                var payload = Encoding.UTF8.GetBytes(responseBody);
                var responseHeader = Encoding.ASCII.GetBytes(
                    $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {payload.Length}\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(responseHeader);
                await stream.WriteAsync(payload);
            }
            catch (ObjectDisposedException)
            {
            }
        }
    }
}
