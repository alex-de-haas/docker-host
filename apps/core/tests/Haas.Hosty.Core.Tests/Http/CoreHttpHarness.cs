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
//   - the runtime config is handed to ConfigureServices instead of being read from the process
//     environment, rooted at a fresh temp dir, so tests never touch a real installation and never race
//     the env: the whole suite shares one process, and the config-parsing tests set HOSTY_CORE_* on it
//     (HOSTY_CORE_PORT=65536, among others) while these classes boot in parallel — a harness that read
//     env at startup failed on the invalid value that another test was mid-way through setting;
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

    /// <summary>Boots the pipeline. Pass a clock to control time — used by tests that need a token to
    /// expire; omitted everywhere else, so the default stays the real clock.</summary>
    internal static async Task<CoreHttpHarness> StartAsync(IClock? clock = null)
    {
        var dataRoot = Path.Combine(Path.GetTempPath(), $"hosty-core-http-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dataRoot);

        // Rooted at the temp dir: everything downstream (CoreDataPaths, stores) resolves
        // HostyCoreRuntimeConfig from DI, so this reroutes all state.
        var builder = WebApplication.CreateSlimBuilder();
        HostyCoreApplication.ConfigureServices(builder, new HostyCoreRuntimeConfig(
            DataRoot: dataRoot,
            RunDirectory: Path.Combine(dataRoot, "core", "run"),
            ControlDiscoveryPath: Path.Combine(dataRoot, "core", "run", "control.json"),
            CorePort: 7070,
            ListenUrl: "http://localhost:7070",
            CorePublicOrigin: "http://localhost:7070",
            RuntimePublicHost: "127.0.0.1",
            ShellSourceOverridePath: null,
            ShellAutostart: false));

        if (clock is not null)
        {
            builder.Services.RemoveAll<IClock>();
            builder.Services.AddSingleton(clock);
        }

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
