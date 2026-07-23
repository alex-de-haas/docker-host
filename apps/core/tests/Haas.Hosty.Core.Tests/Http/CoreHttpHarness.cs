using Haas.Hosty.Core;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;

namespace Haas.Hosty.Core.Tests.Http;

// Boots the real Core HTTP pipeline in-memory (TestServer) so endpoint authorization can be exercised
// over actual requests instead of parsed out of source (A4). It runs the same ConfigureServices /
// MapEndpoints the production entry point does, so a route added or an auth guard dropped is reflected
// here without touching the harness.
//
// Two production concerns are rewired for the test host, neither of which affects the request pipeline
// under test:
//   - the data root is pointed at a fresh temp dir (the env-derived config singleton is replaced), so
//     tests never touch a real installation and run in parallel without an env race;
//   - background IHostedService registrations (docker stats, the supervisor, schedulers, control-file
//     writer, cloudflared) are removed — they do host/process I/O irrelevant to serving a request.
public sealed class CoreHttpHarness : IAsyncDisposable
{
    private readonly WebApplication app;
    private readonly string dataRoot;

    private CoreHttpHarness(WebApplication app, string dataRoot)
    {
        this.app = app;
        this.dataRoot = dataRoot;
    }

    public IServiceProvider Services => app.Services;

    public HttpClient CreateClient() => app.GetTestClient();

    public static async Task<CoreHttpHarness> StartAsync()
    {
        var dataRoot = Path.Combine(Path.GetTempPath(), $"hosty-core-http-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dataRoot);

        var builder = WebApplication.CreateSlimBuilder();
        HostyCoreApplication.ConfigureServices(builder);

        // Replace the env-derived config with one rooted at the temp dir. Everything downstream
        // (CoreDataPaths, stores) resolves HostyCoreRuntimeConfig from DI, so this reroutes all state.
        builder.Services.RemoveAll<HostyCoreRuntimeConfig>();
        builder.Services.AddSingleton(new HostyCoreRuntimeConfig(
            DataRoot: dataRoot,
            RunDirectory: Path.Combine(dataRoot, "core", "run"),
            ControlDiscoveryPath: Path.Combine(dataRoot, "core", "run", "control.json"),
            CorePort: 7070,
            ListenUrl: "http://localhost:7070",
            CorePublicOrigin: "http://localhost:7070",
            RuntimePublicHost: "127.0.0.1",
            ShellSourceOverridePath: null,
            ShellAutostart: false));

        builder.Services.RemoveAll<IHostedService>();
        builder.WebHost.UseTestServer();

        var app = builder.Build();
        HostyCoreApplication.MapEndpoints(app);
        await app.StartAsync();
        return new CoreHttpHarness(app, dataRoot);
    }

    public async ValueTask DisposeAsync()
    {
        await app.DisposeAsync();
        try
        {
            Directory.Delete(dataRoot, recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }
}
