using System.Net;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core.Tests;

public sealed class UserConnectionTests
{
    private static readonly CancellationToken Ct = CancellationToken.None;
    private const string DeviceJson = """{"device_code":"opaque-secret","user_code":"ABCD-EFGH","expires_in":900,"interval":5}""";
    private const string IdentityJson = """{"id":42,"login":"octocat"}""";

    [Theory]
    [InlineData(null, "Ov23liDBHP5MgRKVV30I")]
    [InlineData("  ", "Ov23liDBHP5MgRKVV30I")]
    [InlineData(" custom-client ", "custom-client")]
    public async Task GitHubUsesDefaultOrCustomRegistrationAndRetainsItForRenewal(string? configured, string expected)
    {
        using var f = await Fixture.Create(configured, null);
        var profile = await f.Service.ProfileAsync("alice", Ct);
        Assert.Equal("github", Assert.Single(profile.Providers).Id);
        f.Http.Json(DeviceJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new(null, "github"), Ct);
        Assert.Contains($"client_id={expected}", f.Http.Calls[0].Body);
        Assert.Contains("scope=public_repo", f.Http.Calls[0].Body);
        f.Http.Json("""{"access_token":"first","refresh_token":"refresh","expires_in":1}"""); f.Http.Json(IdentityJson);
        f.Clock.Advance(5);
        var connected = (await f.Service.PollAsync("alice", attempt.Id, Ct)).Connection!;
        Assert.Equal("octocat", connected.Label);
        Assert.Equal(expected, Assert.Single((await f.Users.ReadAsync()).ProviderConnections!).ClientId);
        f.Config["ProviderConnections:GitHubClientId"] = "replacement-client";
        f.Http.Json("""{"access_token":"renewed","expires_in":3600}"""); f.Http.Json(IdentityJson);
        await f.Service.CheckAsync("alice", connected.Id, Ct);
        Assert.Contains($"client_id={expected}", f.Http.Calls[3].Body);
        Assert.All(f.Http.Calls, call => Assert.DoesNotContain("client_secret", call.Body));
    }

    [Theory]
    [InlineData(null, "octocat")]
    [InlineData("  ", "octocat")]
    [InlineData(" Personal ", "Personal")]
    public async Task PatConnectionUsesVerifiedAccountNameUnlessOverridden(string? label, string expected)
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var connection = await f.Service.AddPatAsync("alice", new(label, "github", Token: "secret"), Ct);
        Assert.Equal(expected, connection.Label);
        await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.RenameAsync("alice", connection.Id, "", Ct));
    }

    [Fact]
    public async Task MultipleAccountsAreOwnerScopedPersistedAndNeverReturnedAsSecrets()
    {
        using var f = await Fixture.Create();
        f.Http.Json(IdentityJson); f.Http.Json("""{"id":43,"login":"work"}""");
        var one = await f.Service.AddPatAsync("alice", new("Personal", "github", Token: "private-token-one"), Ct);
        var two = await f.Service.AddPatAsync("alice", new("Work", "github", Token: "private-token-two"), Ct);
        Assert.NotEqual(one.Id, two.Id);
        Assert.Empty((await f.Service.ProfileAsync("bob", Ct)).Connections);
        Assert.Equal(404, (await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.RenameAsync("bob", one.Id, "Stolen", Ct))).Status);
        await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.DisconnectAsync("bob", one.Id, Ct));
        Assert.Equal(2, (await f.Service.ProfileAsync("alice", Ct)).Connections.Length);
        var json = JsonSerializer.Serialize(await f.Service.ProfileAsync("alice", Ct), CoreJsonSerializerContext.Default.UserProfileResponse);
        Assert.DoesNotContain("private-token", json);
        Assert.DoesNotContain("private-token", await File.ReadAllTextAsync(f.Paths.AuditLogPath));
        var reopened = new UserDirectoryStore(f.Paths);
        Assert.Equal(2, (await reopened.ReadAsync()).ProviderConnections!.Count);
        if (!OperatingSystem.IsWindows())
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(f.Paths.AuthRoot, "state.json")));
        await f.Service.DisconnectAsync("alice", one.Id, Ct);
        Assert.Equal(two.Id, Assert.Single((await reopened.ReadAsync()).ProviderConnections!).Id);
    }

    [Fact]
    public async Task DeviceFlowObeysIntervalsSlowDownAndStoresVerifiedIdentity()
    {
        using var f = await Fixture.Create();
        f.Http.Json(DeviceJson); f.Http.Json("""{"error":"slow_down"}""", HttpStatusCode.BadRequest);
        f.Http.Json("""{"error":"authorization_pending"}""", HttpStatusCode.BadRequest);
        f.Http.Json("""{"access_token":"device-token","refresh_token":"refresh-secret","expires_in":3600}"""); f.Http.Json(IdentityJson);
        var attempt = await f.Service.StartDeviceAsync("alice", "browser", new("Personal", "github"), Ct);
        Assert.Equal("https://github.com/login/device", attempt.VerificationUri);
        Assert.Single(f.Http.Calls);
        await f.Service.PollAsync("alice", attempt.Id, Ct);
        Assert.Single(f.Http.Calls);
        f.Clock.Advance(5);
        var slow = await f.Service.PollAsync("alice", attempt.Id, Ct);
        Assert.Equal(10, slow.Interval);
        f.Clock.Advance(5); await f.Service.PollAsync("alice", attempt.Id, Ct);
        Assert.Equal(2, f.Http.Calls.Count);
        f.Clock.Advance(5); Assert.Equal("pending", (await f.Service.PollAsync("alice", attempt.Id, Ct)).Status);
        f.Clock.Advance(10);
        var done = await f.Service.PollAsync("alice", attempt.Id, Ct);
        Assert.Equal("connected", done.Status); Assert.Equal("42", done.Connection!.AccountId);
        Assert.Equal("device-token", Assert.Single((await f.Users.ReadAsync()).ProviderConnections!).AccessToken);
        Assert.Equal(404, (await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.PollAsync("alice", attempt.Id, Ct))).Status);
        Assert.All(f.Http.Calls, call => Assert.DoesNotContain("client_secret", call.Body));
        Assert.Contains("grant_type=urn", f.Http.Calls[1].Body);
    }

    [Theory]
    [InlineData("cancel")]
    [InlineData("expire")]
    [InlineData("logout")]
    [InlineData("disable")]
    public async Task PendingAttemptsCannotOutliveTheirAuthorization(string operation)
    {
        using var f = await Fixture.Create(); f.Http.Json(DeviceJson);
        var p = await f.Service.StartDeviceAsync("alice", "browser", new("Personal", "github"), Ct);
        await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.PollAsync("bob", p.Id, Ct));
        switch (operation)
        {
            case "cancel": await f.Service.CancelAsync("alice", p.Id, Ct); break;
            case "expire": f.Clock.Advance(901); break;
            case "logout": await f.Users.UpdateAsync(s => s with { Sessions = [] }); break;
            case "disable": await f.Users.UpdateAsync(s => s with { Users = s.Users.Select(u => u.Id == "alice" ? u with { Disabled = true } : u).ToArray() }); break;
        }
        await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.PollAsync("alice", p.Id, Ct));
        Assert.Single(f.Http.Calls); Assert.Empty((await f.Users.ReadAsync()).ProviderConnections ?? []);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UserRemovalOrDisableDuringIdentityLookupCannotResurrectCredentials(bool disable)
    {
        using var f = await Fixture.Create();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Http.Enqueue(async _ => { entered.SetResult(); await released.Task; return Reply(IdentityJson); });
        var adding = f.Service.AddPatAsync("alice", new("Work", "github", Token: "secret"), Ct);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await f.Users.UpdateAsync(s => s with { Users = disable ? s.Users.Select(u => u.Id == "alice" ? u with { Disabled = true } : u).ToArray() : s.Users.Where(u => u.Id != "alice").ToArray() });
        released.SetResult();
        Assert.Equal(403, (await Assert.ThrowsAsync<UserConnectionException>(() => adding)).Status);
        Assert.Empty((await f.Users.ReadAsync()).ProviderConnections ?? []);
    }

    [Fact]
    public async Task RotationIsPersistedEvenWhenIdentityVerificationFails()
    {
        using var f = await Fixture.Create();
        f.Http.Json(DeviceJson); f.Http.Json("""{"access_token":"old-token","refresh_token":"old-refresh","expires_in":1}"""); f.Http.Json(IdentityJson);
        var p = await f.Service.StartDeviceAsync("alice", "browser", new("Work", "github"), Ct);
        f.Clock.Advance(5); var c = (await f.Service.PollAsync("alice", p.Id, Ct)).Connection!;
        f.Http.Json("""{"access_token":"rotated-token","refresh_token":"rotated-refresh","expires_in":3600}""");
        f.Http.Json("provider failure", HttpStatusCode.ServiceUnavailable);
        await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.CheckAsync("alice", c.Id, Ct));
        var saved = Assert.Single((await f.Users.ReadAsync()).ProviderConnections!);
        Assert.Equal("rotated-token", saved.AccessToken); Assert.Equal("rotated-refresh", saved.RefreshToken); Assert.Equal("unavailable", saved.Status);
        f.Http.Json(IdentityJson);
        Assert.Equal("connected", (await f.Service.CheckAsync("alice", c.Id, Ct)).Status);
        Assert.Equal("Bearer rotated-token", f.Http.Calls.Last().Authorization);
    }

    [Fact]
    public async Task UnsupportedProviderRetainsLegacyAccountsUntilOwnerDisconnects()
    {
        using var f = await Fixture.Create();
        var now = f.Clock.UtcNow;
        var legacy = new UserProviderConnection("legacy", "alice", "Work", "azure-devops", "team", "tenant", "account", "Alice",
            "device", "legacy-secret", "legacy-refresh", now.AddHours(1), "old-registration", now, now, "connected", "revision");
        await f.Users.UpdateAsync(s => s with { ProviderConnections = [legacy] });
        var profile = await f.Service.ProfileAsync("alice", Ct);
        Assert.Equal("github", Assert.Single(profile.Providers).Id);
        Assert.Equal("unsupported", Assert.Single(profile.Connections).Status);
        Assert.DoesNotContain("legacy-secret", CoreJson.Text(profile));
        Assert.Equal("provider_unsupported", (await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.CheckAsync("alice", "legacy", Ct))).Code);
        Assert.Equal("provider_unsupported", (await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.UseForSourceAsync("alice", "legacy", _ => Task.FromResult(true), Ct))).Code);
        Assert.Equal("provider_unsupported", (await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.AddPatAsync("alice", new("Work", "azure-devops", "team", Token: "secret"), Ct))).Code);
        Assert.Equal("provider_unsupported", (await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.StartDeviceAsync("alice", "browser", new("Work", "azure-devops", "team"), Ct))).Code);
        Assert.Equal(legacy, Assert.Single((await f.Users.ReadAsync()).ProviderConnections!));
        Assert.Empty(f.Http.Calls);
        await f.Service.DisconnectAsync("alice", "legacy", Ct);
        Assert.Empty((await f.Users.ReadAsync()).ProviderConnections!);
    }

    [Theory]
    [InlineData("[]", 200)]
    [InlineData("not json", 200)]
    [InlineData("{}", 200)]
    [InlineData("{}", 302)]
    [InlineData("{\"error_description\":\"SECRET\"}", 403)]
    public async Task InvalidProviderResponsesAreSanitized(string body, int status)
    {
        using var f = await Fixture.Create(); f.Http.Json(body, (HttpStatusCode)status);
        var error = await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.AddPatAsync("alice", new("Work", "github", Token: "secret"), Ct));
        Assert.DoesNotContain("SECRET", error.Message);
        Assert.Empty((await f.Users.ReadAsync()).ProviderConnections ?? []);
    }

    [Fact]
    public async Task AttemptsAreBoundedAndProviderDenialIsTerminal()
    {
        using var f = await Fixture.Create();
        for (var i = 0; i < 3; i++) f.Http.Json(DeviceJson);
        var attempts = new List<UserDeviceResponse>();
        for (var i = 0; i < 3; i++) attempts.Add(await f.Service.StartDeviceAsync("alice", "browser", new("Work", "github"), Ct));
        Assert.Equal("connection_attempt_limit", (await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.StartDeviceAsync("alice", "browser", new("Fourth", "github"), Ct))).Code);
        f.Http.Json("""{"error":"access_denied","error_description":"secret provider text"}""", HttpStatusCode.BadRequest);
        f.Clock.Advance(5);
        Assert.Equal("connection_declined", (await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.PollAsync("alice", attempts[0].Id, Ct))).Code);
        Assert.Equal(404, (await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.PollAsync("alice", attempts[0].Id, Ct))).Status);
    }

    [Fact]
    public async Task LoggedOutAttemptsDoNotBlockAReplacementBrowserSession()
    {
        using var f = await Fixture.Create();
        for (var i = 0; i < 4; i++) f.Http.Json(DeviceJson);
        for (var i = 0; i < 3; i++) await f.Service.StartDeviceAsync("alice", "browser", new("Work", "github"), Ct);
        await f.Users.UpdateAsync(s => s with { Sessions = [new("replacement", "alice", f.Clock.UtcNow, f.Clock.UtcNow.AddHours(1), null, f.Clock.UtcNow)] });
        Assert.Equal("pending", (await f.Service.StartDeviceAsync("alice", "replacement", new("New session", "github"), Ct)).Status);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OversizedProviderBodyIsSanitized(bool streamed)
    {
        using var f = await Fixture.Create();
        var body = Encoding.UTF8.GetBytes("{\"id\":42,\"login\":\"octocat\",\"extra\":\"" + new string('x', 1024 * 1024) + "\"}");
        using var directContent = streamed ? (HttpContent)new UnknownLengthContent(body) : new ByteArrayContent(body);
        // .NET 10 uses HttpRequestException for this limit, already sanitized by the provider adapter.
        await Assert.ThrowsAsync<HttpRequestException>(() => directContent.LoadIntoBufferAsync(1024 * 1024));
        f.Http.Enqueue(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = streamed ? new UnknownLengthContent(body) : new ByteArrayContent(body),
        }));
        var error = await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.AddPatAsync("alice", new("Work", "github", Token: "secret"), Ct));
        Assert.Equal("provider_unavailable", error.Code);
        Assert.Equal(502, error.Status);
        Assert.Empty((await f.Users.ReadAsync()).ProviderConnections ?? []);
    }

    [Fact]
    public async Task MissingOrForeignDisconnectDoesNotFabricateAuditEvents()
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson);
        var c = await f.Service.AddPatAsync("alice", new("Work", "github", Token: "secret"), Ct);
        var before = await File.ReadAllTextAsync(f.Paths.AuditLogPath);
        foreach (var (owner, id) in new[] { ("bob", c.Id), ("alice", "arbitrary-id") })
            Assert.Equal(404, (await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.DisconnectAsync(owner, id, Ct))).Status);
        Assert.Equal(before, await File.ReadAllTextAsync(f.Paths.AuditLogPath));
        await f.Service.DisconnectAsync("alice", c.Id, Ct);
        var after = await File.ReadAllTextAsync(f.Paths.AuditLogPath);
        Assert.Contains("auth.connection.disconnected", after);
        await Assert.ThrowsAsync<UserConnectionException>(() => f.Service.DisconnectAsync("alice", c.Id, Ct));
        Assert.Equal(after, await File.ReadAllTextAsync(f.Paths.AuditLogPath));
    }

    [Fact]
    public async Task SlowProviderDoesNotBlockOtherUsersAndSameOwnerDisconnectWaits()
    {
        using var f = await Fixture.Create(); f.Http.Json(IdentityJson); f.Http.Json(IdentityJson);
        var alice = await f.Service.AddPatAsync("alice", new("Alice", "github", Token: "alice-secret"), Ct);
        var bob = await f.Service.AddPatAsync("bob", new("Bob", "github", Token: "bob-secret"), Ct);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Http.Enqueue(async _ => { entered.SetResult(); await release.Task; return Reply(IdentityJson); });
        var checking = f.Service.CheckAsync("alice", alice.Id, Ct);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var removingAlice = f.Service.DisconnectAsync("alice", alice.Id, Ct);
        try
        {
            await f.Service.RenameAsync("bob", bob.Id, "Renamed", Ct).WaitAsync(TimeSpan.FromSeconds(5));
            await f.Service.DisconnectAsync("bob", bob.Id, Ct).WaitAsync(TimeSpan.FromSeconds(5));
            f.Http.Json(IdentityJson);
            await f.Service.AddPatAsync("bob", new("Another", "github", Token: "bob-next"), Ct).WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(removingAlice.IsCompleted);
        }
        finally { release.SetResult(); await checking; await removingAlice; }
        Assert.Empty((await f.Service.ProfileAsync("alice", Ct)).Connections);
        Assert.Single((await f.Service.ProfileAsync("bob", Ct)).Connections);
    }

    [Fact]
    public async Task ConcurrentStartsReserveGlobalCapacityAndCancellationReleasesIt()
    {
        using var f = await Fixture.Create();
        var now = f.Clock.UtcNow;
        await f.Users.UpdateAsync(s => s with
        {
            Users = Enumerable.Range(0, 257).Select(i => new HostUserRecord($"user-{i}", null, "User", "host.user", false, now, now)).ToArray(),
            Sessions = Enumerable.Range(0, 257).Select(i => new AuthSessionRecord($"session-{i}", $"user-{i}", now, now.AddHours(1), null, now)).ToArray(),
        });
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        for (var i = 0; i < 256; i++) f.Http.Enqueue(async _ => { await release.Task; return Reply(DeviceJson); });
        var starting = Enumerable.Range(0, 256).Select(i => f.Service.StartDeviceAsync($"user-{i}", $"session-{i}", new("Work", "github"), Ct)).ToArray();
        UserDeviceResponse[] attempts;
        try
        {
            var error = await Assert.ThrowsAsync<UserConnectionException>(() =>
                f.Service.StartDeviceAsync("user-256", "session-256", new("Overflow", "github"), Ct).WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal("connection_attempt_limit", error.Code);
        }
        finally { release.SetResult(); attempts = await Task.WhenAll(starting); }
        await f.Service.CancelAsync("user-0", attempts[0].Id, Ct);
        f.Http.Json(DeviceJson);
        Assert.Equal("pending", (await f.Service.StartDeviceAsync("user-256", "session-256", new("Available", "github"), Ct)).Status);
    }

    private sealed class UnknownLengthContent(byte[] bytes) : HttpContent
    {
        protected override bool TryComputeLength(out long length) { length = 0; return false; }
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => stream.WriteAsync(bytes).AsTask();
    }

    private static HttpResponseMessage Reply(string json, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    private sealed record Call(Uri Uri, string Body, string? Authorization);
    private sealed class FakeHttp : HttpMessageHandler
    {
        public List<Call> Calls { get; } = [];
        private readonly Queue<Func<HttpRequestMessage, Task<HttpResponseMessage>>> responses = new();
        public void Json(string json, HttpStatusCode status = HttpStatusCode.OK) => Enqueue(_ => Task.FromResult(Reply(json, status)));
        public void Enqueue(Func<HttpRequestMessage, Task<HttpResponseMessage>> response) => responses.Enqueue(response);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
            Func<HttpRequestMessage, Task<HttpResponseMessage>> response;
            lock (responses)
            {
                Calls.Add(new(request.RequestUri!, body, request.Headers.Authorization?.ToString()));
                response = responses.Dequeue();
            }
            return await response(request);
        }
    }
    private sealed class Clock : IClock
    {
        public DateTimeOffset UtcNow { get; private set; } = DateTimeOffset.Parse("2026-09-28T10:00:00Z");
        public void Advance(int seconds) => UtcNow = UtcNow.AddSeconds(seconds);
    }
    private sealed class Fixture : IDisposable
    {
        public required CoreDataPaths Paths { get; init; }
        public required UserDirectoryStore Users { get; init; }
        public required UserConnectionService Service { get; init; }
        public required FakeHttp Http { get; init; }
        public required Clock Clock { get; init; }
        public required HttpClient Client { get; init; }
        public required IConfigurationRoot Config { get; init; }
        public static async Task<Fixture> Create(string? gitHubClientId = "github-client", string? entraClientId = "entra-client")
        {
            var root = Path.Combine(Path.GetTempPath(), "hosty-connections-" + Guid.NewGuid().ToString("N"));
            var paths = new CoreDataPaths(root, Path.Combine(root, "core"), Path.Combine(root, "apps"), Path.Combine(root, "backups"), Path.Combine(root, "sources"), Path.Combine(root, "core", "auth"), Path.Combine(root, "core", "audit.ndjson"));
            var clock = new Clock(); var users = new UserDirectoryStore(paths); var http = new FakeHttp(); var client = new HttpClient(http);
            var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["ProviderConnections:GitHubClientId"] = gitHubClientId, ["ProviderConnections:EntraClientId"] = entraClientId }).Build();
            var runtime = new HostyCoreRuntimeConfig(root, Path.Combine(root, "run"), Path.Combine(root, "control.json"), 7070, "http://localhost:7070", "http://localhost:7070", "localhost", null, false);
            var (_, settings) = CoreOriginTestFactory.Create(runtime, paths);
            var now = clock.UtcNow;
            await users.WriteAsync(new UserDirectoryState(1,
                [new("alice", "alice@example.test", "Alice", "host.user", false, now, now), new("bob", "bob@example.test", "Bob", "host.user", false, now, now)], [], [],
                [new("browser", "alice", now, now.AddHours(1), null, now)]));
            return new() { Paths = paths, Users = users, Http = http, Clock = clock, Client = client, Config = config,
                Service = new(users, new([new GitHubSourceProvider(client, config, clock)]), clock, new(paths), settings) };
        }
        public void Dispose() { Client.Dispose(); Directory.Delete(Paths.DataRoot, true); }
    }
}
