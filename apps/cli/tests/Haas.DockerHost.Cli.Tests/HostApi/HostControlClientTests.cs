using System.Net;
using System.Text;
using Haas.DockerHost.Cli;
using Haas.DockerHost.Cli.HostApi;

namespace Haas.DockerHost.Cli.Tests.HostApi;

public sealed class HostControlClientTests
{
    [Fact]
    public async Task CreateInstallPlanAsync_SendsExpectedControlRequest()
    {
        var handler = new CapturingHandler(
            HttpStatusCode.OK,
            """
            {
              "plan": {
                "metadataUrl": "https://modules.example/reports.json",
                "metadataDigest": "sha256:meta",
                "planDigest": "sha256:plan",
                "module": {
                  "id": "com.acme.reports",
                  "name": "Reports",
                  "version": "1.0.0"
                }
              }
            }
            """);
        using var client = CreateClient(handler);

        var response = await client.CreateInstallPlanAsync("https://modules.example/reports.json");

        Assert.True(response.IsSuccess);
        Assert.NotNull(response.Body?.Plan);
        Assert.Equal(HttpMethod.Post, handler.Request?.Method);
        Assert.Equal("/control/v1/modules/install/plan", handler.Request?.RequestUri?.AbsolutePath);
        Assert.Contains("\"manifestUrl\":\"https://modules.example/reports.json\"", handler.Body);
        Assert.Contains("\"metadataUrl\":\"https://modules.example/reports.json\"", handler.Body);
        Assert.Equal(CommandLine.Version, handler.Request?.Headers.GetValues("X-Docker-Host-Cli-Version").Single());
        Assert.Equal(HostControlClient.ContractVersion, handler.Request?.Headers.GetValues("X-Docker-Host-Control-Contract-Version").Single());
        Assert.Equal("test-secret", handler.Request?.Headers.GetValues("X-Docker-Host-Control-Secret").Single());
        Assert.False(handler.Request?.Headers.Contains("Authorization"));
    }

    [Fact]
    public async Task ListAppsAsync_ParsesSystemAndRuntimeAppSummaries()
    {
        var handler = new CapturingHandler(
            HttpStatusCode.OK,
            """
            {
              "apps": [
                {
                  "id": "hosty.shell",
                  "kind": "system",
                  "system": true,
                  "source": "system",
                  "moduleId": "hosty.shell",
                  "displayName": "Hosty Shell",
                  "version": "bundled",
                  "status": "available",
                  "selectedRuntime": "host-core",
                  "capabilities": ["open", "update"]
                }
              ]
            }
            """);
        using var client = CreateClient(handler);

        var response = await client.ListAppsAsync();

        var app = Assert.Single(response.Body?.Apps ?? []);
        Assert.Equal("hosty.shell", app.Id);
        Assert.Equal("system", app.Kind);
        Assert.True(app.System);
        Assert.Equal("host-core", app.SelectedRuntime);
        Assert.Equal(["open", "update"], app.Capabilities);
    }

    [Fact]
    public async Task ListModulesAsync_ParsesModuleSummaries()
    {
        var handler = new CapturingHandler(
            HttpStatusCode.OK,
            """
            {
              "modules": [
                {
                  "id": "com.acme.reports",
                  "name": "Reports",
                  "version": "1.0.0",
                  "operationStatus": "installed",
                  "containers": [
                    {
                      "key": "web",
                      "image": {
                        "repository": "ghcr.io/acme/reports",
                        "tag": "1.0.0",
                        "reference": "ghcr.io/acme/reports:1.0.0"
                      }
                    }
                  ],
                  "runtimeStatus": {
                    "state": "running",
                    "containerName": "mod-com-acme-reports"
                  }
                }
              ]
            }
            """);
        using var client = CreateClient(handler);

        var response = await client.ListModulesAsync();

        var module = Assert.Single(response.Body?.Modules ?? []);
        Assert.Equal("com.acme.reports", module.Id);
        Assert.Equal("running", module.RuntimeStatus?.State);
        var container = Assert.Single(module.Containers);
        Assert.Equal("web", container.Key);
        Assert.Equal("1.0.0", container.Image?.Tag);
        Assert.Equal("ghcr.io/acme/reports:1.0.0", container.Image?.Reference);
    }

    [Fact]
    public async Task AppBackupAsync_UsesAppBackupControlRoutes()
    {
        var handler = new CapturingHandler(
            HttpStatusCode.OK,
            """
            {
              "backups": [
                {
                  "id": "2026-06-01T12-00-00Z_manual",
                  "appId": "com.acme.reports",
                  "reason": "manual",
                  "createdAt": "2026-06-01T12:00:00Z",
                  "archivePath": "/data/backups/com.acme.reports/backup.zip",
                  "archiveDigest": "sha256:archive",
                  "archiveBytes": 123,
                  "fileCount": 2
                }
              ]
            }
            """);
        using var client = CreateClient(handler);

        var response = await client.ListAppBackupsAsync("com.acme/reports");

        var backup = Assert.Single(response.Body?.Backups ?? []);
        Assert.Equal("manual", backup.Reason);
        Assert.Equal(123, backup.ArchiveBytes);
        Assert.Equal(HttpMethod.Get, handler.Request?.Method);
        Assert.Equal("/control/v1/apps/com.acme%2Freports/backups", handler.Request?.RequestUri?.AbsolutePath);
    }

    [Fact]
    public async Task RestoreAppBackupAsync_SendsConfirmationBody()
    {
        var handler = new CapturingHandler(
            HttpStatusCode.OK,
            """
            {
              "restored": {
                "id": "backup-one",
                "appId": "com.acme.reports",
                "reason": "manual",
                "createdAt": "2026-06-01T12:00:00Z",
                "archivePath": "/data/backups/com.acme.reports/backup.zip",
                "archiveDigest": "sha256:archive",
                "archiveBytes": 123,
                "fileCount": 2
              }
            }
            """);
        using var client = CreateClient(handler);

        var response = await client.RestoreAppBackupAsync("com.acme.reports", "backup/one", new AppRestoreRequest
        {
            Confirmed = true,
            StopBeforeRestore = true,
            CreatePreRestoreBackup = true,
        });

        Assert.Equal("backup-one", response.Body?.Restored?.Id);
        Assert.Equal(HttpMethod.Post, handler.Request?.Method);
        Assert.Equal("/control/v1/apps/com.acme.reports/backups/backup%2Fone/restore", handler.Request?.RequestUri?.AbsolutePath);
        Assert.Contains("\"confirmed\":true", handler.Body);
        Assert.Contains("\"stopBeforeRestore\":true", handler.Body);
        Assert.Contains("\"createPreRestoreBackup\":true", handler.Body);
    }

    [Fact]
    public async Task ListModulesAsync_InvalidJson_ThrowsHostApiException()
    {
        var handler = new CapturingHandler(HttpStatusCode.OK, "{");
        using var client = CreateClient(handler);

        var exception = await Assert.ThrowsAsync<HostApiException>(() => client.ListModulesAsync());

        Assert.Equal("list modules", exception.Operation);
        Assert.Equal(HttpStatusCode.OK, exception.StatusCode);
    }

    [Fact]
    public async Task RevokeUserInvitationAsync_SendsExpectedControlRequest()
    {
        var handler = new CapturingHandler(
            HttpStatusCode.OK,
            """
            {
              "revoked": true
            }
            """);
        using var client = CreateClient(handler);

        var response = await client.RevokeUserInvitationAsync("invite/one");

        Assert.True(response.IsSuccess);
        Assert.True(response.Body?.Revoked);
        Assert.Equal(HttpMethod.Delete, handler.Request?.Method);
        Assert.Equal("/control/v1/auth/invitations/invite%2Fone", handler.Request?.RequestUri?.AbsolutePath);
    }

    private static HostControlClient CreateClient(HttpMessageHandler handler)
        => new(new HttpClient(handler)
        {
            BaseAddress = new Uri("http://localhost:3000/control/v1/"),
        }, "test-secret");

    private sealed class CapturingHandler(HttpStatusCode statusCode, string responseBody) : HttpMessageHandler
    {
        public HttpRequestMessage? Request { get; private set; }

        public string Body { get; private set; } = "";

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Request = request;
            Body = request.Content is null
                ? ""
                : await request.Content.ReadAsStringAsync(cancellationToken);

            return new HttpResponseMessage(statusCode)
            {
                Content = new StringContent(responseBody, Encoding.UTF8, "application/json"),
            };
        }
    }
}
