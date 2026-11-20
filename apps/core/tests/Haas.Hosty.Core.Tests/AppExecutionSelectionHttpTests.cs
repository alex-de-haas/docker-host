using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Haas.Hosty.Core;
using Haas.Hosty.Core.Tests.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecutionTargets_PublicReplayReportsFailedSelectionAfterIndependentRepair(bool group)
    {
        const string appId = "test.created";
        const string session = "workspace-operator";
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync(appId);
        await using var host = await CoreHttpHarness.StartAsync(f.Clock, services =>
        {
            services.AddSingleton(f.Paths);
            services.AddSingleton(f.Apps);
            services.AddSingleton(f.Service);
            services.AddSingleton(workspaces);
        });
        var now = f.Clock.UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new(owner.UserId, "operator@example.test", "Operator", "host.admin", false, now, now)], [], [],
            [new(session, owner.UserId, now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost")]));
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", $"hosty_session={session}; hosty_csrf=selection");
        client.DefaultRequestHeaders.Add("X-Hosty-CSRF", "selection");
        var route = group ? $"/api/development/workspaces/{tree.WorkspaceId}/execution-target" : $"/api/apps/{appId}/execution-target";
        var selection = new AppExecutionTargetRequest(Guid.NewGuid().ToString("D"), "workspace",
            WorkspaceId: group ? null : tree.WorkspaceId, WorktreeId: group ? null : tree.Id);
        var worker = host.Services.GetRequiredService<AppExecutionTargetService>();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        f.Adapter.StartProbe = () => throw new AppLifecycleException("runtime_start_failed", "Workspace build failed.");
        f.Adapter.Health = context => new("unhealthy", context.Manifest.Services.Select(s => ServiceHealth(s.Key, "exited", exitCode: 1)).ToArray());
        await worker.StartAsync(timeout.Token);
        try
        {
            async Task<JsonNode> Submit()
            {
                using var response = await client.PostAsJsonAsync(route, selection, CoreJson.TypeInfo<AppExecutionTargetRequest>(), timeout.Token);
                Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync(timeout.Token));
                return JsonNode.Parse(await response.Content.ReadAsStringAsync(timeout.Token))!;
            }
            void AssertFailure(JsonNode result)
            {
                Assert.Equal(selection.RequestId, (string?)result["requestId"]);
                Assert.Equal("failed", (string?)result["state"]);
                var child = group ? Assert.Single(result["apps"]!.AsArray())! : result;
                if (group) Assert.Equal(appId, (string?)child["appId"]);
                Assert.Equal("failed", (string?)child["state"]);
                Assert.Equal("dev_workspace_start_failed", (string?)child["code"]);
                Assert.Contains("Workspace build failed", (string?)child["error"]);
            }

            Assert.Equal("running", (string?)(await Submit())["state"]);
            JsonNode status;
            do
            {
                status = JsonNode.Parse(await client.GetStringAsync(route + "/" + selection.RequestId, timeout.Token))!;
                if ((string?)status["state"] == "running") await Task.Delay(20, timeout.Token);
            } while ((string?)status["state"] == "running");
            AssertFailure(status);
            Assert.Equal(tree.Id, (await f.Service.GetDevModeAsync(appId)).WorktreeId);

            f.Adapter.StartProbe = null;
            f.Adapter.Health = null;
            await f.Service.StartAsync(appId);
            var starts = f.Adapter.StartCount;
            var stops = f.Adapter.StopCount;
            var replay = await Submit();
            AssertFailure(replay);
            Assert.Equal("running", (await f.Apps.GetAppAsync(appId))!.RuntimeState);
            Assert.Equal(starts, f.Adapter.StartCount);
            Assert.Equal(stops, f.Adapter.StopCount);
            Assert.Single(await f.Backups.ListBackupsAsync(appId));
        }
        finally { await worker.StopAsync(CancellationToken.None); }
    }
}
