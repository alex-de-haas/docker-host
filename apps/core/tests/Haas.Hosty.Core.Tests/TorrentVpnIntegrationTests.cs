using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class TorrentVpnFactAttribute : FactAttribute
{
    public TorrentVpnFactAttribute()
    {
        if (new[] { "HOSTY_TEST_TORRENT_SOURCE", "HOSTY_TEST_TORRENT_VPN", "HOSTY_TEST_TORRENT_METADATA" }
            .Any(key => string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key))))
            Skip = "Requires an authorized test VPN folder, companion source, and a legal test .torrent; see the mixed runtimes plan.";
    }
}

public sealed partial class CoreLifecycleServiceTests
{
    [TorrentVpnFact]
    public async Task Torrent_DevelopmentTransfersThroughVpnAndFailsClosedOnTunnelLoss()
    {
        var source = Environment.GetEnvironmentVariable("HOSTY_TEST_TORRENT_SOURCE")!;
        var vpn = Environment.GetEnvironmentVariable("HOSTY_TEST_TORRENT_VPN")!;
        var metadata = await File.ReadAllBytesAsync(Environment.GetEnvironmentVariable("HOSTY_TEST_TORRENT_METADATA")!);
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        var root = fixture.Root;
        var downloads = root + "-downloads";
        var config = new HostyCoreRuntimeConfig(root, root + "/run", root + "/control.json", 3001,
            "http://127.0.0.1:3001", null, "127.0.0.1", null, false, InstanceId: Guid.NewGuid().ToString("N"));
        var tokens = new AppServiceTokenService(new AppServiceSigningKey("torrent-vpn-test-key"u8.ToArray()));
        var docker = new DockerRuntimeAdapter(config, tokens, NullLogger<DockerRuntimeAdapter>.Instance);
        var lifecycle = new CoreLifecycleService(fixture.Paths, fixture.Apps, fixture.Manifests, fixture.Backups,
            fixture.Sources, [docker], new NoopIngressController(), NullLogger<CoreLifecycleService>.Instance,
            portAllocator: new RuntimePortAllocator(config));
        const string appId = "com.haas.torrent-engine";
        var container = DockerRuntimeAdapter.BuildContainerName(config.InstanceId, appId, "engine");
        Assert.NotEqual("hosty-com-haas-torrent-engine-engine", container);
        var runner = new ProcessDockerCommandRunner();
        async Task<string> Exec(params string[] args)
        {
            var command = args[0] == "-d" ? new[] { "exec", "-d", container }.Concat(args.Skip(1)).ToArray() : ["exec", container, .. args];
            var result = await runner.RunAsync(command, null, default);
            Assert.True(result.ExitCode == 0, result.StandardError);
            return result.StandardOutput.Trim();
        }
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        string origin = "";
        async Task<JsonElement> Get(string path)
        {
            using var response = await http.GetAsync(origin + path);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadFromJsonAsync<JsonElement>();
        }
        async Task<JsonElement> Wait(string path, Func<JsonElement, bool> predicate, int seconds)
        {
            JsonElement last = default;
            var until = DateTime.UtcNow.AddSeconds(seconds);
            while (DateTime.UtcNow < until)
            {
                try { last = await Get(path); if (predicate(last)) return last; }
                catch (HttpRequestException) { }
                catch (TaskCanceledException) { }
                await Task.Delay(1000);
            }
            // Only transfer/health state is included; VPN responses can contain private addresses.
            throw new InvalidOperationException($"Timed out waiting for {path}: " +
                (path == "/vpn" ? "VPN state did not satisfy the condition" : last.ToString()));
        }
        try
        {
            await lifecycle.InstallAsync(new(Path.Combine(source, "manifest.json"), "dev"));
            Directory.CreateDirectory(downloads);
            await lifecycle.ConfigureMountsAsync(appId, new([new("downloads", "acceptance", downloads), new("vpn", "acceptance", vpn)]));
            await lifecycle.StartAsync(appId);
            var app = (await fixture.Apps.GetAppAsync(appId))!;
            origin = Assert.Single(app.Endpoints).Url!.TrimEnd('/');
            await Wait("/healthz", value => value.GetProperty("status").GetString() == "ok", 120);
            await Wait("/vpn", value => value.GetProperty("connected").GetBoolean(), 90);
            Assert.Contains("dev tun0", await Exec("ip", "route", "get", "1.1.1.1"));
            Console.WriteLine("VPN acceptance: source runtime ready, public route uses tun0.");
            // Test-only observer installed in the disposable SDK container, never in app images.
            await Exec("sh", "-ec", "timeout 90 apt-get update -qq && timeout 90 apt-get install -y -qq --no-install-recommends tcpdump");

            using var add = await http.PostAsJsonAsync(origin + "/downloads", new
            {
                torrentBase64 = Convert.ToBase64String(metadata), mountLabel = "acceptance", savePath = "sample",
                maxDownloadRate = 512 * 1024, maxUploadRate = 16 * 1024, autoStart = true,
            });
            add.EnsureSuccessStatusCode();
            var descriptor = await add.Content.ReadFromJsonAsync<JsonElement>();
            var path = "/downloads/" + descriptor.GetProperty("infoHash").GetString();
            var transferred = await Wait(path, value => value.GetProperty("completePieces").GetInt32() >= 2
                && value.GetProperty("downloadedBytes").GetInt64() >= 1024 * 1024, 180);
            Console.WriteLine($"VPN acceptance: received {transferred.GetProperty("downloadedBytes")} bytes, " +
                $"verified {transferred.GetProperty("completePieces")} pieces, {transferred.GetProperty("peers")} peers.");

            // A TCP connection opened through the tunnel must not migrate onto the bridge after loss.
            // This final-stage guard records and drops any such attempted leak, even with a broken
            // production OUTPUT policy, so the acceptance test itself cannot expose peer traffic.
            await Exec("sh", "-ec", "ip -4 -o addr show tun0 | awk '{print $4}' | cut -d/ -f1 > /tmp/acceptance-tunnel-ip; " +
                "iptables -t mangle -N ACCEPTANCE_GUARD; " +
                "iptables -t mangle -A ACCEPTANCE_GUARD -j DROP; " +
                "iptables -t mangle -A POSTROUTING -o eth0 -s \"$(cat /tmp/acceptance-tunnel-ip)\" -j ACCEPTANCE_GUARD");
            await Exec("-d", "sh", "-ec", "echo $$ > /tmp/acceptance-capture.pid; " +
                "exec tcpdump -i eth0 -n -s 96 -U -w /tmp/acceptance.pcap " +
                "\"src host $(cat /tmp/acceptance-tunnel-ip) or (host 1.1.1.1 and port 80) or tcp port 8080\" " +
                "> /tmp/acceptance-capture.log 2>&1");
            await Exec("sh", "-ec", "for i in 1 2 3 4 5; do grep -q 'listening on eth0' /tmp/acceptance-capture.log && exit 0; sleep 1; done; exit 1");
            await Exec("-d", "bash", "-c", "exec 3<>/dev/tcp/1.1.1.1/80 || exit 1; " +
                "printf 'GET / HTTP/1.1\\r\\nHost: one.one.one.one\\r\\nX-Acceptance: ' >&3; " +
                "touch /tmp/acceptance-connected; " +
                "for i in {1..60}; do test -f /tmp/acceptance-send && break; sleep 1; done; " +
                "printf 'tunnel-loss\\r\\n\\r\\n' >&3; sleep 10");
            bool connected = false;
            for (int i = 0; i < 15; i++)
            {
                connected = await Exec("sh", "-c", "test -f /tmp/acceptance-connected && echo yes || echo no") == "yes";
                if (connected) break;
                await Task.Delay(1000);
            }
            Assert.True(connected, "The pre-existing TCP canary did not connect through the VPN.");
            await Exec("sh", "-ec", "kill -STOP \"$(cat /run/vpn/openvpn.pid)\"; ip link set tun0 down; " +
                "ip route flush dev tun0; touch /tmp/acceptance-send");
            await Wait("/vpn", value => !value.GetProperty("connected").GetBoolean(), 15);
            await Wait(path, value => value.GetProperty("engineState").GetString() == "Paused", 20);
            var before = (await Get(path)).GetProperty("downloadedBytes").GetInt64();
            var escape = await runner.RunAsync(["exec", container, "timeout", "3", "bash", "-c", "echo test > /dev/tcp/1.1.1.1/80"], null, default);
            Assert.NotEqual(0, escape.ExitCode);
            await Task.Delay(5000);
            Assert.Equal(before, (await Get(path)).GetProperty("downloadedBytes").GetInt64());
            var guard = await Exec("iptables", "-t", "mangle", "-L", "ACCEPTANCE_GUARD", "-n", "-v", "-x");
            var dropped = guard.Split('\n').Single(line => line.Contains("DROP")).Split(' ', StringSplitOptions.RemoveEmptyEntries)[0];
            Assert.Equal("0", dropped);
            await Exec("sh", "-ec", "kill -INT \"$(cat /tmp/acceptance-capture.pid)\"; " +
                "for i in 1 2 3 4 5; do grep -q 'packets captured' /tmp/acceptance-capture.log && exit 0; sleep 1; done; exit 1");
            var capturedControl = await Exec("sh", "-ec", "tcpdump -nn -r /tmp/acceptance.pcap 'tcp port 8080' 2>/dev/null | wc -l");
            Assert.True(int.Parse(capturedControl) > 0, "The bridge observer must see control traffic as a positive control.");
            var capturedLeaks = await Exec("sh", "-ec", "tcpdump -nn -r /tmp/acceptance.pcap " +
                "\"src host $(cat /tmp/acceptance-tunnel-ip) or (host 1.1.1.1 and port 80)\" 2>/dev/null | wc -l");
            Assert.Equal("0", capturedLeaks);
            Console.WriteLine("VPN acceptance: tunnel loss paused transfer, fresh egress blocked, guard and eth0 capture saw zero leaks.");

            await Exec("sh", "-ec", "kill -CONT \"$(cat /run/vpn/openvpn.pid)\"; kill -TERM \"$(cat /run/vpn/openvpn.pid)\"");
            await Wait("/vpn", value => value.GetProperty("connected").GetBoolean(), 90);
            await Wait(path, value => value.GetProperty("downloadedBytes").GetInt64() > before + 256 * 1024, 120);
            Console.WriteLine("VPN acceptance: tunnel recovery automatically resumed payload transfer.");
        }
        finally
        {
            var app = await fixture.Apps.GetAppAsync(appId);
            if (app is not null)
                await docker.RemoveAsync(new(app, await fixture.Manifests.LoadAsync(app.ManifestPath!, "dev"), Path.Combine(fixture.Paths.AppsRoot, appId),
                    Path.Combine(fixture.Paths.AppsRoot, appId, "data"), new Dictionary<string, string>(), [], SourceRoot: source));
            Directory.Delete(root, recursive: true);
            if (Directory.Exists(downloads)) Directory.Delete(downloads, recursive: true);
            // The operator's read-only VPN folder is never changed or deleted.
        }
    }
}
